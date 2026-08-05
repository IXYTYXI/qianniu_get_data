const path = require('path');
const fs = require('fs');
const config = require('./config');
const { importBarrageToFeishu, ensureFeishuConfigForDate, loadFeishuConfig } = require('./feishu');
const {
  clickAndSaveMp4Download,
  findDialogActionButton,
  findLocalVideo,
} = require('./download-video');
const { findRowByLiveId, waitForLogin: waitForBrowserLogin, dismissBlockingOverlays, findLiveRows, filterByDate: browserFilterByDate, launchBrowser } = require('./browser');

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
    this.videoDownloadPromises = [];
    this.listSearchOptions = { dateFilterApplied: false };
    this.ownsContext = true;

    if (options.context && options.page) {
      this.context = options.context;
      this.page = options.page;
      this.ownsContext = false;
    }

    if (options.date === 'yesterday') {
      this.targetDate = getYesterdayUTC8();
    } else if (options.date === 'today') {
      this.targetDate = getTodayUTC8();
    } else {
      this.targetDate = options.date;
    }

    fs.mkdirSync(config.downloadDir, { recursive: true });
    fs.mkdirSync(config.videoDownloadDir, { recursive: true });
    fs.mkdirSync(config.screenshotDir, { recursive: true });
  }

  buildLiveMeta(liveId, rowText = '') {
    const timeMatch = rowText.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    return {
      id: liveId,
      date: (timeMatch?.[0] || this.targetDate).slice(0, 10),
      name: (rowText.match(/【[^】]+】[^0-9]*/)?.[0] || '').trim(),
      rowText,
    };
  }

  async launch() {
    console.log('=== 千牛直播下载工具 ===');
    console.log(`东八区今日: ${getTodayUTC8()}`);
    console.log(`目标日期: ${this.targetDate}`);
    console.log(`下载模式: ${this.options.mode}`);
    console.log();

    const headlessEnv = process.env.PLAYWRIGHT_HEADLESS;
    const headless = headlessEnv != null
      ? (headlessEnv === '1' || headlessEnv === 'true')
      : false;

    ({ context: this.context, page: this.page } = await launchBrowser({ headless }));
    this.attachDownloadHandler(this.context);
  }

  attachDownloadHandler(context) {
    if (context._qianniuDownloadBound) return;
    context._qianniuDownloadBound = true;
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
    const pending = this.pendingDownloads.get(page);
    const hintText = typeof pending === 'string' ? pending : (pending?.rowText || '');
    const liveId = typeof pending === 'object' ? pending?.liveId : null;
    const uniqueFilename = liveId
      ? `${liveId}_${filename}`
      : filename;
    const savePath = path.join(config.downloadDir, uniqueFilename);
    console.log(`  [下载中] ${uniqueFilename}`);

    try {
      await download.saveAs(savePath);
      this.downloadedFiles.push(savePath);
      console.log(`  [完成] ${savePath}`);

      if (/\.xlsx?$/i.test(filename) && (
        this.options.mode === 'all' ||
        this.options.mode === 'barrage' ||
        this.options.mode === 'barrage-task'
      )) {
        try {
          await importBarrageToFeishu(savePath, hintText, { liveId });
        } catch (e) {
          console.log(`  [上传飞书失败] ${filename}: ${e.message}`);
        }
        return;
      }
    } catch (e) {
      console.log(`  [下载失败] ${filename}: ${e.message}`);
    } finally {
      this.pendingDownloads.delete(page);
    }
  }

  async waitForLogin() {
    return waitForBrowserLogin(this.page, {
      ...this.options,
      onLoginPage: async () => {
        await this.screenshot('01-login-page');
      },
    });
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
    await dismissBlockingOverlays(this.page, '直播中心');
    await this.screenshot('03-center');
  }

  async filterByDate() {
    console.log(`\n按日期筛选: ${this.targetDate}`);
    const result = await browserFilterByDate(this.page, this.targetDate);
    this.listSearchOptions = { dateFilterApplied: result.applied };
    if (!result.applied) {
      console.log('未找到日期筛选器，将直接扫描表格行');
    }
    await dismissBlockingOverlays(this.page, '筛选后');
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

    const row = await findRowByLiveId(this.page, liveId, this.listSearchOptions);
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
      await this.triggerReplayAction(targetPage, this.buildLiveMeta(liveId, rowText));
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
    } else if (!newPage) {
      // 中控台在同一标签打开，必须回到列表才能处理下一场
      console.log('  返回直播中心列表...');
      await this.page.goto(config.centerUrl, { timeout: config.navigationTimeout });
      await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await this.page.waitForTimeout(1500);
      await dismissBlockingOverlays(this.page, '返回列表');
    }
  }

  async closeBlockingDialogs(targetPage, stage = '') {
    await dismissBlockingOverlays(targetPage, stage);
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

    this.pendingDownloads.set(targetPage, { rowText, liveId });
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

  async triggerReplayAction(targetPage, live) {
    console.log('检查视频转码/下载状态...');

    const replayDownload = targetPage.locator(
      '.nav-list li:has-text("回放下载"), .sidebar li:has-text("回放下载"), ' +
      '.left-nav :text-is("回放下载"), li.tabs:has-text("回放下载")'
    ).first();

    const opened = await this.clickWhenReady(replayDownload, '左侧「回放下载」菜单', { waitMs: 2000 });
    if (!opened) return;

    const dialog = targetPage.locator('.el-dialog__wrapper:visible').filter({ hasText: '下载视频' }).last();
    if (!(await dialog.isVisible({ timeout: 5000 }).catch(() => false))) {
      console.log('  未弹出「下载视频」对话框，停止回放操作');
      return;
    }

    const action = await findDialogActionButton(dialog);
    if (!action) {
      console.log('  下载对话框内未找到可操作按钮');
      return;
    }
    const { actionBtn, btnText } = action;
    console.log(`  回放按钮状态: 「${btnText}」`);

    const closeBtn = dialog.locator('.el-dialog__headerbtn').first();
    const closeDialog = async () => {
      await this.clickWhenReady(closeBtn, '关闭下载视频弹窗', { waitMs: 800 });
    };

    if (/转码中|处理中|请稍后/.test(btnText)) {
      console.log(`  直播 ${live.id} 已在转码中，不点击`);
      await closeDialog();
    } else if (/网页直接下载|下载MP4|下载.*视频/.test(btnText)) {
      if (this.options.mode === 'barrage-task') {
        const existingPath = findLocalVideo(live);
        if (existingPath) {
          const sizeMb = (fs.statSync(existingPath).size / 1024 / 1024).toFixed(1);
          console.log(`  视频已可下载，本地已有，跳过: ${existingPath} (${sizeMb} MB)`);
          await closeDialog();
        } else {
          console.log(`  视频已可下载（${btnText}），弹窗内直接点击下载，继续导弹幕...`);
          const result = await clickAndSaveMp4Download(targetPage, live, dialog, actionBtn, btnText);
          if (result.promise) {
            this.videoDownloadPromises.push(result.promise);
          } else if (result.status === 'downloaded' && result.filePath) {
            console.log(`  视频已在本地: ${result.filePath}`);
          } else if (result.error) {
            console.log(`  视频下载未成功: ${result.error}`);
          }
        }
      } else {
        console.log(`  视频已可下载（${btnText}），当前模式不下载，跳过`);
        await closeDialog();
      }
    } else if (/转码|开始/.test(btnText)) {
      await this.clickWhenReady(actionBtn, '转码按钮', { waitMs: 2000 });
      await closeDialog();
    } else {
      console.log('  未识别按钮状态，不点击');
      await closeDialog();
    }

    await targetPage.screenshot({
      path: path.join(config.screenshotDir, `transcode-${live.id}.png`),
    });
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

  async ensureBrowser() {
    if (this.page && this.context) {
      this.attachDownloadHandler(this.context);
      return;
    }
    await this.launch();
  }

  async runCore({ manageSession = true } = {}) {
    const shouldClose = manageSession && this.ownsContext;

    if (manageSession && this.ownsContext) {
      await this.ensureBrowser();
      const loggedIn = await this.waitForLogin();
      if (!loggedIn) {
        return { ok: false, reason: 'not_logged_in' };
      }
    }

    await ensureFeishuConfigForDate(this.targetDate);

    let feishuConfig;
    try {
      feishuConfig = loadFeishuConfig();
    } catch {
      feishuConfig = null;
    }

    await this.navigateToCenter();
    await this.filterByDate();

    const lives = await findLiveRows(this.page, this.targetDate, {
      ...this.listSearchOptions,
      feishuConfig,
    });
    const uniqueLives = lives.map((live) => ({ id: live.id, rowText: live.rowText || '' }));

    if (uniqueLives.length === 0) {
      console.log(`未找到 ${this.targetDate} 的直播记录`);
    } else {
      console.log(`\n=== 阶段1：逐场「点转码 → 导弹幕 → 上传飞书」（共 ${uniqueLives.length} 场）===`);
      console.log(`去重后处理 ${uniqueLives.length} 场直播`);
      for (let i = 0; i < uniqueLives.length; i++) {
        await this.processRow(uniqueLives[i].id, uniqueLives[i].rowText, i);
      }
    }

    if (this.options.mode !== 'barrage-task') {
      await this.tryRecordingSection();
    }

    console.log('\n=== 下载流程完成 ===');
    if (this.downloadedFiles.length > 0) {
      console.log(`共下载 ${this.downloadedFiles.length} 个文件:`);
      this.downloadedFiles.forEach((f) => console.log(`  ${f}`));
    } else {
      console.log('未自动下载到文件，请查看截图确认页面状态');
      console.log(`截图目录: ${config.screenshotDir}`);
    }

    console.log('等待所有下载完成...');
    await this.waitForAllDownloads();
    if (this.videoDownloadPromises.length > 0) {
      console.log(`等待 ${this.videoDownloadPromises.length} 个视频后台下载...`);
      await Promise.all(this.videoDownloadPromises);
    }
    await this.page.waitForTimeout(1000);

    if (shouldClose) {
      await this.screenshot('99-final');
      await this.close();
    }

    return { ok: true, liveCount: uniqueLives.length, downloaded: this.downloadedFiles.length };
  }

  async run() {
    try {
      const result = await this.runCore({ manageSession: true });
      if (!result.ok) {
        console.error('未登录且设置了 --skip-login，任务终止');
        await this.close();
        process.exit(1);
      }
      console.log('EXIT_CODE: 0');
      process.exit(0);
    } catch (error) {
      console.error('错误:', error.message);
      await this.screenshot('99-error').catch(() => {});
      throw error;
    }
  }

  async close() {
    if (this.ownsContext && this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
    }
  }
}

module.exports = { QianniuDownloader, parseArgs, getYesterdayUTC8, getTodayUTC8 };

if (require.main === module) {
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
}
