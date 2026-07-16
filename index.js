const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { importBarrageToFeishu } = require('./feishu');

// ========== UTC+8 Timezone Helpers ==========

function getDateUTC8(offsetDays = 0) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const now = new Date();
  const adjusted = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  return formatter.format(adjusted);
}

function getYesterdayUTC8() {
  return getDateUTC8(-1);
}

function getTodayUTC8() {
  return getDateUTC8(0);
}

// ========== CLI Args ==========

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    date: 'yesterday',
    mode: 'all',
    waitMinutes: config.loginWaitMinutes,
    skipLogin: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--date': options.date = args[++i]; break;
      case '--mode': options.mode = args[++i]; break;
      case '--wait': options.waitMinutes = parseInt(args[++i], 10); break;
      case '--skip-login': options.skipLogin = true; break;
    }
  }
  return options;
}

// ========== Main Class ==========

class QianniuDownloader {
  constructor(options) {
    this.options = options;
    this.context = null;
    this.page = null;
    this.downloadedFiles = [];
    this.pendingDownloads = new Map();

    if (options.date === 'yesterday') {
      this.targetDate = getYesterdayUTC8();
    } else if (options.date === 'today') {
      this.targetDate = getTodayUTC8();
    } else {
      this.targetDate = options.date;
    }

    fs.mkdirSync(config.downloadDir, { recursive: true });
    fs.mkdirSync(config.screenshotDir, { recursive: true });
  }

  async launch() {
    console.log('=== 千牛直播下载工具 ===');
    console.log(`东八区今日: ${getTodayUTC8()}`);
    console.log(`目标日期: ${this.targetDate}`);
    console.log(`下载模式: ${this.options.mode}`);
    console.log();

    if (!config.chromePath) {
      throw new Error(
        '未找到 Chrome，请安装 Google Chrome 或设置 CHROME_PATH 环境变量指向 chrome.exe'
      );
    }

    this.context = await chromium.launchPersistentContext(config.userDataDir, {
      headless: false,
      executablePath: config.chromePath,
      viewport: { width: 1400, height: 900 },
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      acceptDownloads: true,
    });

    this.page = this.context.pages()[0] || await this.context.newPage();
    this.attachDownloadHandler(this.context);
  }

  attachDownloadHandler(context) {
    context.on('page', (page) => this.bindPageDownload(page));
    for (const page of context.pages()) {
      this.bindPageDownload(page);
    }
  }

  bindPageDownload(page) {
    page.on('download', async (download) => {
      await this.handleDownload(download, page);
    });
  }

  async handleDownload(download, page) {
    const filename = download.suggestedFilename();
    const savePath = path.join(config.downloadDir, filename);
    const hintText = this.pendingDownloads.get(page) || '';
    console.log(`  [下载中] ${filename}`);

    try {
      await download.saveAs(savePath);
      this.downloadedFiles.push(savePath);
      console.log(`  [完成] ${savePath}`);

      if (/\.xlsx?$/i.test(filename) && (
        this.options.mode === 'all' ||
        this.options.mode === 'barrage' ||
        this.options.mode === 'barrage-task'
      )) {
        await importBarrageToFeishu(savePath, hintText);
      }
    } catch (e) {
      console.log(`  [下载失败] ${filename}: ${e.message}`);
    } finally {
      this.pendingDownloads.delete(page);
    }
  }

  async waitForLogin() {
    // Try center URL directly first — session may still be valid
    console.log('尝试直接访问直播中心...');
    await this.page.goto(config.centerUrl, { timeout: config.navigationTimeout });
    await this.page.waitForTimeout(3000);

    const afterDirectUrl = this.page.url();
    if (!afterDirectUrl.includes('login') && !afterDirectUrl.includes('qiniulogin')) {
      console.log('已登录（会话有效），跳过登录步骤');
      await this.screenshot('02-already-logged-in');
      return true;
    }

    if (this.options.skipLogin) {
      console.log('--skip-login 已设置但未登录，退出');
      return false;
    }

    // Navigate to login page
    console.log(`打开登录页: ${config.loginUrl}`);
    await this.page.goto(config.loginUrl, { timeout: config.navigationTimeout });
    await this.screenshot('01-login-page');

    const waitMs = this.options.waitMinutes * 60 * 1000;
    console.log(`\n请在浏览器中登录，等待 ${this.options.waitMinutes} 分钟...\n`);

    try {
      await this.page.waitForURL(
        url => !url.toString().includes('qiniulogin') && !url.toString().includes('login'),
        { timeout: waitMs }
      );
      console.log('检测到登录成功！');
    } catch {
      console.log('登录等待超时，检查当前页面...');
      const currentUrl = this.page.url();
      if (currentUrl.includes('login')) {
        console.log('仍在登录页面，请手动完成登录后重新运行。');
        return false;
      }
    }

    await this.page.waitForTimeout(2000);
    await this.screenshot('02-after-login');
    return true;
  }

  async navigateToCenter() {
    const currentUrl = this.page.url();
    console.log(`当前页面: ${currentUrl}`);

    if (!currentUrl.includes('/livestream/center')) {
      console.log('导航到直播中心...');
      await this.page.goto(config.centerUrl, { timeout: config.navigationTimeout });
    }

    await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await this.page.waitForTimeout(2000);
    await this.screenshot('03-center');
  }

  async filterByDate() {
    console.log(`\n按日期筛选: ${this.targetDate}`);

    // The screenshot shows date range inputs: 开始日期 至 结束日期
    const startInput = this.page.locator(
      'input[placeholder*="开始日期"], input[placeholder*="开始时间"], input[placeholder*="Start"]'
    ).first();
    const endInput = this.page.locator(
      'input[placeholder*="结束日期"], input[placeholder*="结束时间"], input[placeholder*="End"]'
    ).first();

    const hasDateFilter = await startInput.isVisible({ timeout: 5000 }).catch(() => false);

    if (hasDateFilter) {
      console.log('找到日期筛选器，填入日期...');

      await startInput.click();
      await this.page.waitForTimeout(500);
      await startInput.fill(this.targetDate);
      await this.page.waitForTimeout(500);

      await endInput.click();
      await this.page.waitForTimeout(500);
      await endInput.fill(this.targetDate);
      await endInput.press('Enter');
      await this.page.waitForTimeout(1000);

      // Click search button if visible
      const searchBtn = this.page.locator(
        'button:has-text("搜索"), button:has-text("查询"), span:has-text("搜索")'
      ).first();
      if (await searchBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await searchBtn.click();
      }

      await this.page.waitForTimeout(3000);
    } else {
      console.log('未找到日期筛选器，将直接扫描表格行');
    }

    await this.screenshot('04-filtered');
  }

  async findMatchingRows() {
    // The table rows contain "开播时间" like "2026-07-14 08:02:08"
    const allRows = this.page.locator(
      'table tbody tr, .ant-table-tbody tr, .el-table__body-wrapper tr'
    );
    const rowCount = await allRows.count();
    console.log(`表格共 ${rowCount} 行`);

    const matches = [];
    for (let i = 0; i < rowCount; i++) {
      const text = await allRows.nth(i).textContent().catch(() => '');
      if (text.includes(this.targetDate)) {
        const nameMatch = text.match(/【.*?】.*?(?=\d{6})/);
        const idMatch = text.match(/(\d{6})/);
        console.log(`  匹配行 ${i}: ID=${idMatch?.[1] || '?'} ${nameMatch?.[0]?.trim() || ''}`);
        matches.push(i);
      }
    }

    console.log(`找到 ${matches.length} 个匹配 ${this.targetDate} 的直播`);
    return { allRows, matches };
  }

  async processRow(allRows, rowIndex, seqIndex) {
    const row = allRows.nth(rowIndex);
    const text = await row.textContent().catch(() => '');
    const idMatch = text.match(/(\d{6})/);
    const liveId = idMatch?.[1] || rowIndex;
    console.log(`\n--- 处理直播 ${liveId} (${seqIndex + 1}) ---`);

    // From the screenshot, operations column has: 去开播 | 中控台 | 观看链接 | ...
    // The "..." is a dropdown trigger with more options

    // Try the "..." more-options button first
    const moreBtn = row.locator(
      'a:has-text("…"), span:has-text("…"), ' +
      'a:has-text("..."), span:has-text("..."), ' +
      '.ant-dropdown-trigger, ' +
      'button[class*="more"], a[class*="more"], ' +
      'i[class*="more"], i[class*="ellipsis"]'
    ).first();

    if (await moreBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('点击更多操作...');
      await moreBtn.click();
      await this.page.waitForTimeout(1500);
      await this.screenshot(`05-menu-${liveId}`);

      // Look for video/barrage options in the dropdown
      await this.handleDropdownActions(liveId);
    } else {
      console.log('"..." 按钮未找到，尝试中控台入口...');
    }

    // Also try the "中控台" link (control center) for more download options
    const controlBtn = row.locator('button:has-text("中控台"), a:has-text("中控台")').first();
    if (await controlBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await row.scrollIntoViewIfNeeded();
      await this.handleControlCenter(controlBtn, liveId, text);
    }
  }

  async handleDropdownActions(liveId) {
    // Check for video download in dropdown
    if (this.options.mode === 'all' || this.options.mode === 'video') {
      const videoOpt = this.page.locator(
        'li:visible:has-text("下载"), a:visible:has-text("下载视频"), ' +
        'li:visible:has-text("视频"), a:visible:has-text("回放"), ' +
        'span:visible:has-text("下载"), div:visible:has-text("下载视频")'
      ).first();
      if (await videoOpt.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('找到视频下载选项');
        await videoOpt.click();
        await this.page.waitForTimeout(5000);
        await this.screenshot(`06-video-${liveId}`);
      } else {
        console.log('下拉菜单中未找到视频下载选项');
      }
    }

    // Check for barrage export in dropdown
    if (this.options.mode === 'all' || this.options.mode === 'barrage') {
      const barrageOpt = this.page.locator(
        'li:visible:has-text("弹幕"), a:visible:has-text("弹幕"), ' +
        'li:visible:has-text("导出"), span:visible:has-text("弹幕"), ' +
        'div:visible:has-text("弹幕导出")'
      ).first();
      if (await barrageOpt.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('找到弹幕导出选项');
        await barrageOpt.click();
        await this.page.waitForTimeout(5000);
        await this.screenshot(`07-barrage-${liveId}`);
      } else {
        console.log('下拉菜单中未找到弹幕导出选项');
      }
    }

    // Close dropdown by pressing Escape
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(500);
  }

  async handleControlCenter(controlBtn, liveId, rowText = '') {
    console.log('打开中控台...');

    const [newPage] = await Promise.all([
      this.context.waitForEvent('page', { timeout: 10000 }).catch(() => null),
      controlBtn.click({ force: true }),
    ]);

    const targetPage = newPage || this.page;
    if (newPage) {
      await newPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    }
    await targetPage.waitForTimeout(2000);

    const controlUrl = targetPage.url();
    console.log(`中控台页面: ${controlUrl}`);
    await targetPage.screenshot({
      path: path.join(config.screenshotDir, `08-control-${liveId}.png`),
    });

    if (this.options.mode === 'transcode' || this.options.mode === 'all' || this.options.mode === 'barrage-task') {
      await this.triggerTranscode(targetPage, liveId);
    }

    if (this.options.mode === 'all' || this.options.mode === 'barrage' || this.options.mode === 'barrage-task') {
      await this.exportBarrage(targetPage, liveId, rowText);
    }

    if (this.options.mode === 'all' || this.options.mode === 'video') {
      const dlBtn = targetPage.locator(
        'button:has-text("下载"), a:has-text("下载视频"), a:has-text("下载回放"), ' +
        'button:has-text("录制"), a:has-text("回放下载")'
      ).first();
      if (await dlBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log('中控台找到视频下载按钮');
        await dlBtn.click();
        await targetPage.waitForTimeout(5000);
      }
    }

    if (newPage) {
      await newPage.close();
    }
  }

  async exportBarrage(targetPage, liveId, rowText = '') {
    console.log('导出弹幕...');

    const exportBtn = targetPage.locator(
      '.chat span:has-text("导出所有评论消息") .footer-t-btn, ' +
      '.chat .footer-t-btn:has(img.footer-t-icon)'
    ).first();

    if (!(await exportBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
      console.log('未找到弹幕导出按钮');
      return;
    }

    this.pendingDownloads.set(targetPage, rowText);
    const [download] = await Promise.all([
      targetPage.waitForEvent('download', { timeout: 30000 }).catch(() => null),
      exportBtn.click(),
    ]);

    if (download) {
      await this.handleDownload(download, targetPage);
    } else {
      console.log('弹幕下载未触发，请检查页面状态');
      this.pendingDownloads.delete(targetPage);
    }

    await targetPage.screenshot({ path: path.join(config.screenshotDir, `barrage-${liveId}.png`) });
  }

  async triggerTranscode(targetPage, liveId) {
    console.log('触发视频转码...');

    const replayDownload = targetPage.locator('li.tabs:has-text("回放下载"), span:has-text("回放下载")').first();
    if (!(await replayDownload.isVisible({ timeout: 5000 }).catch(() => false))) {
      console.log('未找到「回放下载」菜单');
      return;
    }

    await replayDownload.click();
    await targetPage.waitForTimeout(2000);

    const dialog = targetPage.locator('.el-dialog__wrapper').filter({ hasText: '下载视频' }).last();
    const actionBtn = dialog.locator('.el-dialog__body button').first();
    const btnText = (await actionBtn.textContent().catch(() => '')) || '';

    if (btnText.includes('转码中')) {
      console.log(`直播 ${liveId} 已在转码中`);
    } else if (btnText) {
      console.log(`点击转码按钮: ${btnText.trim()}`);
      await actionBtn.click();
      await targetPage.waitForTimeout(2000);
    } else {
      console.log('未找到转码按钮');
    }

    await targetPage.screenshot({
      path: path.join(config.screenshotDir, `transcode-${liveId}.png`),
    });

    const closeBtn = dialog.locator('.el-dialog__headerbtn').first();
    if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await closeBtn.click();
    }
    await targetPage.waitForTimeout(500);
  }

  async tryRecordingSection() {
    console.log('\n=== 检查录播区域 ===');

    // Navigate to 录播 > 我的录播 in the sidebar
    const recordingLink = this.page.locator(
      'a:has-text("录播"), span:has-text("录播"), li:has-text("录播")'
    ).first();

    if (await recordingLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await recordingLink.click();
      await this.page.waitForTimeout(1500);

      const myRecording = this.page.locator(
        'a:has-text("我的录播"), span:has-text("我的录播")'
      ).first();
      if (await myRecording.isVisible({ timeout: 3000 }).catch(() => false)) {
        await myRecording.click();
        await this.page.waitForTimeout(3000);
        await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await this.screenshot('09-recordings');
        console.log('已进入录播页面');

        // Find recordings matching target date
        const { allRows, matches } = await this.findMatchingRows();
        if (matches.length > 0) {
          for (let i = 0; i < matches.length; i++) {
            await this.processRow(allRows, matches[i], i);
          }
        }
      }
    } else {
      console.log('未找到录播侧边栏入口');
    }
  }

  async screenshot(name) {
    const filePath = path.join(config.screenshotDir, `${name}.png`);
    try {
      await this.page.screenshot({ path: filePath, fullPage: false });
    } catch {}
  }

  async run() {
    try {
      await this.launch();

      const loggedIn = await this.waitForLogin();
      if (!loggedIn) {
        console.log('登录未完成，退出。');
        return;
      }

      await this.navigateToCenter();
      await this.filterByDate();

      const { allRows, matches } = await this.findMatchingRows();
      const uniqueMatches = [];
      const seenIds = new Set();
      for (const rowIndex of matches) {
        const text = await allRows.nth(rowIndex).textContent().catch(() => '');
        const id = text.match(/(\d{6})/)?.[1];
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        uniqueMatches.push(rowIndex);
      }

      if (uniqueMatches.length === 0) {
        console.log(`未找到 ${this.targetDate} 的直播记录`);
      } else {
        console.log(`去重后处理 ${uniqueMatches.length} 场直播`);
        for (let i = 0; i < uniqueMatches.length; i++) {
          await this.processRow(allRows, uniqueMatches[i], i);
        }
      }

      // Also check the recording section
      await this.tryRecordingSection();

      console.log('\n=== 下载流程完成 ===');
      if (this.downloadedFiles.length > 0) {
        console.log(`共下载 ${this.downloadedFiles.length} 个文件:`);
        this.downloadedFiles.forEach(f => console.log(`  ${f}`));
      } else {
        console.log('未自动下载到文件，请查看截图确认页面状态');
        console.log(`截图目录: ${config.screenshotDir}`);
      }

      // Wait for any pending downloads
      console.log('等待下载完成 (30秒)...');
      await this.page.waitForTimeout(30000);

      await this.screenshot('99-final');
      await this.close();
    } catch (error) {
      console.error('错误:', error.message);
      await this.screenshot('99-error').catch(() => {});
      throw error;
    }
  }

  async close() {
    if (this.context) await this.context.close();
  }
}

const options = parseArgs();
const downloader = new QianniuDownloader(options);

process.on('SIGINT', async () => {
  console.log('\n关闭浏览器...');
  await downloader.close();
  process.exit(0);
});

downloader.run().catch(async (err) => {
  console.error('致命错误:', err);
  await downloader.close();
  process.exit(1);
});
