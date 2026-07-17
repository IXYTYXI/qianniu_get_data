const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { importBarrageToFeishu } = require('./feishu');
const { findRowByLiveId } = require('./browser');

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
    this.downloadTasks = new Set();
    this.suppressAutoDownloadHandler = false;

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
      if (this.suppressAutoDownloadHandler) return;
      await this.handleDownload(download, page);
    });
  }

  async waitForAllDownloads() {
    if (this.downloadTasks.size === 0) return;
    console.log(`  等待下载完成（${this.downloadTasks.size} 个任务）...`);
    await Promise.all([...this.downloadTasks]);
  }

  async handleDownload(download, page) {
    const task = this._handleDownload(download, page);
    this.downloadTasks.add(task);
    try {
      await task;
    } finally {
      this.downloadTasks.delete(task);
    }
  }

  async _handleDownload(download, page) {
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

  async describeLocator(locator) {
    const text = ((await locator.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 80) || '(无文本)';
  }

  async clickWhenReady(locator, label, options = {}) {
    const visible = await locator.isVisible({ timeout: options.timeout || 5000 }).catch(() => false);
    if (!visible) {
      console.log(`  跳过: 未找到 ${label}`);
      return false;
    }

    const text = await this.describeLocator(locator);
    if (options.skipIf?.test(text)) {
      console.log(`  跳过: ${label} 当前状态「${text}」，无需点击`);
      return false;
    }
    if (options.requireText && !options.requireText.test(text)) {
      console.log(`  跳过: ${label} 文案不符「${text}」`);
      return false;
    }

    console.log(`  确认点击: ${label} → 「${text}」`);
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click();
    if (options.waitMs) await locator.page().waitForTimeout(options.waitMs);
    return true;
  }

  async processRow(liveId, rowText = '', seqIndex = 0) {
    console.log(`\n--- 处理直播 ${liveId} (${seqIndex + 1}) ---`);

    const row = await findRowByLiveId(this.page, liveId);
    if (!row) {
      console.log(`未找到直播行: ${liveId}`);
      return;
    }

    await row.scrollIntoViewIfNeeded();
    await this.page.waitForTimeout(500);

    const skipMoreMenu = this.options.mode === 'barrage-task';
    if (!skipMoreMenu) {
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
        await this.handleDropdownActions(liveId);
      } else {
        console.log('"..." 按钮未找到');
      }
    } else {
      console.log('barrage-task 模式: 跳过「...」菜单，直接进入中控台');
    }

    const controlBtn = row.locator(
      'button:has-text("中控台"), a:has-text("中控台"), span:has-text("中控台")'
    ).first();
    const btnCount = await controlBtn.count().catch(() => 0);
    if (btnCount && await controlBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await this.handleControlCenter(controlBtn, liveId, rowText);
    } else {
      console.log('未找到中控台按钮');
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
    if (this.options.mode === 'all' || this.options.mode === 'barrage' || this.options.mode === 'barrage-task') {
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
    const controlText = await this.describeLocator(controlBtn);
    console.log(`  确认点击: 中控台 → 「${controlText}」`);

    const [newPage] = await Promise.all([
      this.context.waitForEvent('page', { timeout: 10000 }).catch(() => null),
      controlBtn.click(),
    ]);

    const targetPage = newPage || this.page;
    if (newPage) {
      await newPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    }
    await targetPage.waitForTimeout(3000);

    const controlUrl = targetPage.url();
    console.log(`中控台页面: ${controlUrl}`);
    if (!controlUrl.includes(`id=${liveId}`)) {
      console.log(`  警告: 中控台 URL 与直播 ID ${liveId} 不一致，跳过后续操作`);
      if (newPage) await newPage.close();
      return;
    }

    await targetPage.screenshot({
      path: path.join(config.screenshotDir, `08-control-${liveId}.png`),
    });

    await this.closeBlockingDialogs(targetPage, '进入中控台后');

    if (this.options.mode === 'transcode' || this.options.mode === 'all' || this.options.mode === 'barrage-task') {
      await this.triggerTranscode(targetPage, liveId);
    }

    await this.closeBlockingDialogs(targetPage, '转码检查后');

    if (this.options.mode === 'all' || this.options.mode === 'barrage' || this.options.mode === 'barrage-task') {
      await this.exportBarrage(targetPage, liveId, rowText);
    }

    if (this.options.mode === 'all' || this.options.mode === 'video') {
      const dlBtn = targetPage.locator(
        'button:has-text("下载"), a:has-text("下载视频"), a:has-text("下载回放"), ' +
        'button:has-text("录制"), a:has-text("回放下载")'
      ).first();
      if (await dlBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        this.suppressAutoDownloadHandler = true;
        try {
          const [download] = await Promise.all([
            targetPage.waitForEvent('download', { timeout: config.videoDownloadTimeout || 600000 }).catch(() => null),
            this.clickWhenReady(dlBtn, '视频下载按钮'),
          ]);
          if (download) {
            await this.handleDownload(download, targetPage);
          }
          await this.waitForAllDownloads();
        } finally {
          this.suppressAutoDownloadHandler = false;
        }
      }
    }

    await this.waitForAllDownloads();
    if (newPage && !newPage.isClosed()) {
      await newPage.waitForTimeout(1000);
      await newPage.close();
    }
  }

  async closeBlockingDialogs(targetPage, stage = '') {
    const dialogSelectors = [
      '.el-dialog__wrapper',
      '.el-overlay-dialog',
      '[role="dialog"]',
    ];

    for (let round = 0; round < 5; round++) {
      let closed = false;
      for (const selector of dialogSelectors) {
        const dialogs = targetPage.locator(selector);
        const count = await dialogs.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const dialog = dialogs.nth(i);
          if (!(await dialog.isVisible({ timeout: 300 }).catch(() => false))) continue;

          const title = ((await dialog.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
          const titleText = title.slice(0, 40) || '未知弹窗';
          const closeBtn = dialog.locator('.el-dialog__headerbtn, .el-icon-close, button[aria-label="Close"]').first();
          if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
            console.log(`  关闭弹窗${stage ? `(${stage})` : ''}: ${titleText}`);
            await closeBtn.click();
            await targetPage.waitForTimeout(800);
            closed = true;
          }
        }
      }
      if (!closed) break;
    }

    const warmupDialog = targetPage.locator('.el-dialog__wrapper.robot-send, .el-dialog__wrapper')
      .filter({ hasText: '系统暖场评论' }).first();
    if (await warmupDialog.isVisible({ timeout: 500 }).catch(() => false)) {
      const closeBtn = warmupDialog.locator('.el-dialog__headerbtn').first();
      if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        console.log(`  关闭弹窗${stage ? `(${stage})` : ''}: 系统暖场评论`);
        await closeBtn.click();
        await targetPage.waitForTimeout(800);
      }
    }
  }

  async exportBarrage(targetPage, liveId, rowText = '') {
    console.log('导出弹幕...');
    await this.closeBlockingDialogs(targetPage, '弹幕导出前');

    const warmupDialog = targetPage.locator('.el-dialog__wrapper.robot-send, .el-dialog__wrapper')
      .filter({ hasText: '系统暖场评论' }).first();
    if (await warmupDialog.isVisible({ timeout: 500 }).catch(() => false)) {
      console.log('  「系统暖场评论」弹窗仍在，停止导出');
      await targetPage.screenshot({ path: path.join(config.screenshotDir, `barrage-blocked-${liveId}.png`) });
      return;
    }

    const chatPanel = targetPage.locator('.chat').first();
    if (!(await chatPanel.isVisible({ timeout: 5000 }).catch(() => false))) {
      console.log('  未找到右侧评论面板');
      await targetPage.screenshot({ path: path.join(config.screenshotDir, `barrage-missing-${liveId}.png`) });
      return;
    }

    await chatPanel.evaluate((el) => { el.scrollTop = el.scrollHeight; }).catch(() => {});
    await targetPage.waitForTimeout(800);

    // 评论区底部有 3 个 footer-t-btn，顺序固定：
    // [0] 系统暖场评论(机器人) [1] 全体禁言 [2] 导出评论(icon-chat-export)
    const exportBtn = chatPanel.locator(
      '.footer-t-btn:has(img[src*="icon-chat-export"]), img.footer-t-icon[src*="icon-chat-export"]'
    ).first();

    if (!(await exportBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
      console.log('  未找到导出图标 icon-chat-export，停止操作');
      await targetPage.screenshot({ path: path.join(config.screenshotDir, `barrage-missing-${liveId}.png`) });
      return;
    }

    const btnMeta = await exportBtn.evaluate((el) => ({
      tag: el.tagName,
      className: el.className,
      src: el.getAttribute?.('src') || el.querySelector?.('img')?.getAttribute('src') || '',
    }));
    console.log(`  确认导出按钮: ${btnMeta.tag}.${btnMeta.className} src=${btnMeta.src}`);

    this.pendingDownloads.set(targetPage, rowText);
    this.suppressAutoDownloadHandler = true;
    try {
      const [download] = await Promise.all([
        targetPage.waitForEvent('download', { timeout: 60000 }).catch(() => null),
        exportBtn.click(),
      ]);

      if (download) {
        await this.handleDownload(download, targetPage);
        await this.waitForAllDownloads();
      } else {
        console.log('  弹幕下载未触发，请查看截图');
        this.pendingDownloads.delete(targetPage);
      }
    } finally {
      this.suppressAutoDownloadHandler = false;
    }

    await targetPage.screenshot({ path: path.join(config.screenshotDir, `barrage-${liveId}.png`) });
  }

  async triggerTranscode(targetPage, liveId) {
    console.log('检查视频转码状态...');

    const replayDownload = targetPage.locator(
      '.nav-list li:has-text("回放下载"), .sidebar li:has-text("回放下载"), ' +
      '.left-nav :text-is("回放下载"), li.tabs:has-text("回放下载")'
    ).first();

    const opened = await this.clickWhenReady(replayDownload, '左侧「回放下载」菜单', { waitMs: 2000 });
    if (!opened) return;

    const dialog = targetPage.locator('.el-dialog__wrapper:visible').filter({ hasText: '下载视频' }).last();
    if (!(await dialog.isVisible({ timeout: 5000 }).catch(() => false))) {
      console.log('  未弹出「下载视频」对话框，停止转码操作');
      return;
    }

    const actionBtn = dialog.locator('.el-dialog__body button').first();
    const btnText = ((await actionBtn.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    console.log(`  转码按钮状态: 「${btnText}」`);

    if (/转码中|处理中|请稍后/.test(btnText)) {
      console.log(`  直播 ${liveId} 已在转码中，不点击`);
    } else if (/网页直接下载|下载MP4|下载.*视频/.test(btnText)) {
      console.log(`  视频已可下载（${btnText}），任务1仅触发转码不下载，跳过`);
    } else if (/转码|开始/.test(btnText)) {
      await this.clickWhenReady(actionBtn, '转码按钮', { waitMs: 2000 });
    } else {
      console.log('  未识别转码按钮状态，不点击');
    }

    await targetPage.screenshot({
      path: path.join(config.screenshotDir, `transcode-${liveId}.png`),
    });

    const closeBtn = dialog.locator('.el-dialog__headerbtn').first();
    await this.clickWhenReady(closeBtn, '关闭下载视频弹窗', { waitMs: 800 });
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
        const seenIds = new Set();
        const uniqueLives = [];
        for (const rowIndex of matches) {
          const text = await allRows.nth(rowIndex).textContent().catch(() => '');
          const id = text.match(/(\d{6})(?=\d{4}-\d{2}-\d{2})/)?.[1] || text.match(/(\d{6})/)?.[1];
          if (!id || seenIds.has(id)) continue;
          seenIds.add(id);
          uniqueLives.push({ id, rowText: text });
        }
        for (let i = 0; i < uniqueLives.length; i++) {
          await this.processRow(uniqueLives[i].id, uniqueLives[i].rowText, i);
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
        console.error('未登录且设置了 --skip-login，任务终止');
        await this.close();
        process.exit(1);
      }

      await this.navigateToCenter();
      await this.filterByDate();

      const { allRows, matches } = await this.findMatchingRows();
      const uniqueLives = [];
      const seenIds = new Set();
      for (const rowIndex of matches) {
        const text = await allRows.nth(rowIndex).textContent().catch(() => '');
        const id = text.match(/(\d{6})(?=\d{4}-\d{2}-\d{2})/)?.[1] || text.match(/(\d{6})/)?.[1];
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        uniqueLives.push({ id, rowText: text });
      }

      if (uniqueLives.length === 0) {
        console.log(`未找到 ${this.targetDate} 的直播记录`);
      } else {
        console.log(`去重后处理 ${uniqueLives.length} 场直播`);
        for (let i = 0; i < uniqueLives.length; i++) {
          await this.processRow(uniqueLives[i].id, uniqueLives[i].rowText, i);
        }
      }

      // barrage-task 只处理直播中心列表，不再额外跳转录播区域
      if (this.options.mode !== 'barrage-task') {
        await this.tryRecordingSection();
      }

      console.log('\n=== 下载流程完成 ===');
      if (this.downloadedFiles.length > 0) {
        console.log(`共下载 ${this.downloadedFiles.length} 个文件:`);
        this.downloadedFiles.forEach(f => console.log(`  ${f}`));
      } else {
        console.log('未自动下载到文件，请查看截图确认页面状态');
        console.log(`截图目录: ${config.screenshotDir}`);
      }

      // 等待所有下载任务完成后再关闭浏览器
      console.log('等待所有下载完成...');
      await this.waitForAllDownloads();
      await this.page.waitForTimeout(3000);

      await this.screenshot('99-final');
      await this.close();
      console.log('EXIT_CODE: 0');
      process.exit(0);
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
