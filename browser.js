const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const config = require('./config');
const { getTodayUTC8, buildCenterFilterRange } = require('./dates');

function ensureChromeProfileFree(profileDir = config.userDataDir) {
  const profile = profileDir;
  fs.mkdirSync(profile, { recursive: true });

  if (process.platform === 'win32') {
    const escaped = profile.replace(/'/g, "''");
    try {
      execSync(
        'powershell -NoProfile -Command '
        + `"Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" `
        + `| Where-Object { $_.CommandLine -like '*${escaped}*' } `
        + `| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'ignore', timeout: 15000 }
      );
    } catch {
      // no running chrome
    }
  } else {
    try {
      execSync(`pkill -f "user-data-dir=${profile}"`, { stdio: 'ignore' });
    } catch {
      // no running chrome
    }
  }

  const removedLocks = [];
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const lockPath = path.join(profile, name);
    try {
      fs.lstatSync(lockPath);
      fs.unlinkSync(lockPath);
      removedLocks.push(name);
    } catch {
      // not present
    }
  }

  if (removedLocks.length > 0) {
    console.log(`Chrome Profile 启动前清理: 已删除锁文件 ${removedLocks.join(', ')}`);
  }
}

async function launchBrowser() {
  if (!config.chromePath) {
    throw new Error('未找到 Chrome，请安装 Google Chrome 或设置 CHROME_PATH 环境变量');
  }

  fs.mkdirSync(config.downloadDir, { recursive: true });
  fs.mkdirSync(config.videoDownloadDir, { recursive: true });
  fs.mkdirSync(config.screenshotDir, { recursive: true });

  const headless = process.env.PLAYWRIGHT_HEADLESS === '1' || process.env.PLAYWRIGHT_HEADLESS === 'true';
  const userDataDir = process.env.CHROME_USER_DATA_DIR || config.userDataDir;

  ensureChromeProfileFree(userDataDir);
  await new Promise((r) => setTimeout(r, 1500));

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    executablePath: config.chromePath,
    viewport: { width: 1400, height: 900 },
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    acceptDownloads: true,
  });

  const page = context.pages()[0] || await context.newPage();
  return { context, page };
}

async function dismissBlockingOverlays(page, stage = '') {
  const suffix = stage ? `(${stage})` : '';
  const dismissTexts = ['知道了', '我知道了', '下次再说', '不再提示', '不再提醒', '关闭', '跳过'];

  for (let round = 0; round < 5; round++) {
    let acted = false;

    for (const text of dismissTexts) {
      const btn = page.locator(
        `button:visible:has-text("${text}"), .el-message-box__btns button:has-text("${text}")`
      ).first();
      if (await btn.isVisible({ timeout: 200 }).catch(() => false)) {
        console.log(`  关闭通知${suffix}: ${text}`);
        await btn.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);
        acted = true;
        break;
      }
    }

    const closeIcon = page.locator('.el-notification__closeBtn, .ant-modal-close, .ant-notification-notice-close').first();
    if (!acted && await closeIcon.isVisible({ timeout: 200 }).catch(() => false)) {
      console.log(`  关闭通知${suffix}: 关闭图标`);
      await closeIcon.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
      acted = true;
    }

    const remindDialog = page.locator('.el-dialog__wrapper.dialog-remind, .dialog-remind').first();
    if (await remindDialog.isVisible({ timeout: 500 }).catch(() => false)) {
      const knowBtn = remindDialog.locator(
        'button:has-text("知道了"), button:has-text("我知道了"), .el-dialog__footer button'
      ).first();
      if (await knowBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        console.log(`  关闭通知${suffix}: dialog-remind`);
        await knowBtn.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(800);
        acted = true;
      } else {
        const closeBtn = remindDialog.locator('.el-dialog__headerbtn').first();
        if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
          console.log(`  关闭弹窗${suffix}: dialog-remind`);
          await closeBtn.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(800);
          acted = true;
        }
      }
    }

    const dialogSelectors = [
      '.el-dialog__wrapper',
      '.el-overlay-dialog',
      '[role="dialog"]',
    ];

    for (const selector of dialogSelectors) {
      const dialogs = page.locator(selector);
      const count = await dialogs.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const dialog = dialogs.nth(i);
        if (!(await dialog.isVisible({ timeout: 300 }).catch(() => false))) continue;

        const title = ((await dialog.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        if (/下载视频/.test(title)) continue;

        const titleText = title.slice(0, 40) || '未知弹窗';
        const closeBtn = dialog.locator(
          '.el-dialog__headerbtn, .el-icon-close, button[aria-label="Close"]'
        ).first();
        if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
          console.log(`  关闭弹窗${suffix}: ${titleText}`);
          await closeBtn.click();
          await page.waitForTimeout(800);
          acted = true;
        }
      }
    }

    const warmupDialog = page.locator('.el-dialog__wrapper.robot-send, .el-dialog__wrapper')
      .filter({ hasText: '系统暖场评论' }).first();
    if (await warmupDialog.isVisible({ timeout: 500 }).catch(() => false)) {
      const closeBtn = warmupDialog.locator('.el-dialog__headerbtn').first();
      if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        console.log(`  关闭弹窗${suffix}: 系统暖场评论`);
        await closeBtn.click();
        await page.waitForTimeout(800);
        acted = true;
      }
    }

    if (!acted) break;
  }
}

async function attemptLoginPageActions(page) {
  const url = page.url();
  if (!url.includes('login') && !url.includes('qiniulogin')) return false;

  await dismissBlockingOverlays(page, '登录页');

  const phone = process.env.QIANNIU_PHONE || process.env.QIANNIU_USERNAME;
  const password = process.env.QIANNIU_PASSWORD;
  if (phone) {
    const phoneInput = page.locator(
      'input[type="tel"], input[placeholder*="手机"], input[placeholder*="账号"], input[name*="phone"], input[name*="mobile"]'
    ).first();
    if (await phoneInput.isVisible({ timeout: 1500 }).catch(() => false)) {
      await phoneInput.fill(phone);
    }
  }
  if (password) {
    const pwdInput = page.locator('input[type="password"]').first();
    if (await pwdInput.isVisible({ timeout: 1500 }).catch(() => false)) {
      await pwdInput.fill(password);
    }
  }

  const loginBtn = page.locator(
    'button:visible:has-text("登录"), ' +
    'button:visible:has-text("立即登录"), ' +
    'a:visible:has-text("登录"), ' +
    'button.login-btn:visible, ' +
    'input[type="submit"]:visible'
  ).first();

  if (await loginBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log('  自动点击「登录」按钮...');
    await loginBtn.click();
    await page.waitForTimeout(2000);
    return true;
  }
  return false;
}

function isLoggedInUrl(url) {
  const s = url.toString();
  return !s.includes('qiniulogin') && !s.includes('login');
}

async function waitForLogin(page, options = {}) {
  const skipLogin = options.skipLogin;
  const waitMinutes = options.waitMinutes || config.loginWaitMinutes;

  console.log('尝试直接访问直播中心...');
  await page.goto(config.centerUrl, { timeout: config.navigationTimeout });
  await page.waitForTimeout(3000);
  await dismissBlockingOverlays(page, '直播中心');

  if (isLoggedInUrl(page.url())) {
    console.log('已登录（会话有效）');
    return true;
  }

  if (skipLogin) {
    console.log('未登录且设置了 --skip-login');
    return false;
  }

  console.log(`打开登录页: ${config.loginUrl}`);
  await page.goto(config.loginUrl, { timeout: config.navigationTimeout });
  await page.waitForTimeout(1500);
  if (typeof options.onLoginPage === 'function') {
    await options.onLoginPage(page);
  }

  console.log(`等待登录完成（最多 ${waitMinutes} 分钟，将自动点击登录并关闭通知）...`);

  const deadline = Date.now() + waitMinutes * 60 * 1000;
  while (Date.now() < deadline) {
    if (isLoggedInUrl(page.url())) {
      console.log('检测到登录成功');
      await dismissBlockingOverlays(page, '登录后');
      return true;
    }
    await attemptLoginPageActions(page);
    await dismissBlockingOverlays(page, '登录等待');
    await page.waitForTimeout(3000);
  }

  const ok = isLoggedInUrl(page.url());
  if (ok) console.log('检测到登录成功');
  return ok;
}

async function filterByDate(page, targetDate) {
  const { start, end } = buildCenterFilterRange(targetDate);
  console.log(`按日期筛选: ${targetDate}（${start} ~ ${end}）`);
  await dismissBlockingOverlays(page, '筛选前');
  await page.waitForTimeout(500);
  await dismissBlockingOverlays(page, '筛选前');
  const startInput = page.locator('input[placeholder*="开始日期"], input[placeholder*="开始时间"]').first();
  const endInput = page.locator('input[placeholder*="结束日期"], input[placeholder*="结束时间"]').first();

  if (!(await startInput.isVisible({ timeout: 5000 }).catch(() => false))) {
    console.log('未找到日期筛选器');
    return { applied: false };
  }

  await startInput.click();
  await startInput.fill('');
  await startInput.fill(start);
  await endInput.click();
  await endInput.fill('');
  await endInput.fill(end);
  await endInput.press('Enter');

  const searchBtn = page.locator(
    'button:has-text("搜索"), button:has-text("查询"), button:has-text("筛选")'
  ).first();
  if (await searchBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await searchBtn.click();
  }
  await page.waitForTimeout(4000);
  return { applied: true };
}

function getTableRows(page) {
  return page.locator('table tbody tr, .ant-table-tbody tr, .el-table__body-wrapper tr');
}

async function goToFirstPage(page) {
  const firstPageBtn = page.locator(
    '.el-pagination .number:text-is("1"), ' +
    '.el-pagination .number >> nth=0, ' +
    '.ant-pagination-item-1'
  ).first();
  if (await firstPageBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
    await firstPageBtn.click();
    await page.waitForTimeout(2000);
  }
}

async function clickNextPage(page) {
  const nextBtn = page.locator(
    '.el-pagination button.btn-next:not([disabled]), ' +
    '.el-pagination .btn-next:not(.disabled), ' +
    '.ant-pagination-next:not(.ant-pagination-disabled), ' +
    'button:has-text("下一页"), ' +
    'li.number + li.btn-next:not(.disabled) button'
  ).first();

  if (!(await nextBtn.isVisible({ timeout: 1500 }).catch(() => false))) {
    return false;
  }
  if (await nextBtn.isDisabled().catch(() => false)) {
    return false;
  }

  await nextBtn.click();
  await page.waitForTimeout(2500);
  return true;
}

function parseLiveFromRowText(text, targetDate) {
  if (!text.includes(targetDate)) return null;

  const id = text.match(/(\d{6})(?=\d{4}-\d{2}-\d{2})/)?.[1] || text.match(/(\d{6})/)?.[1];
  if (!id) return null;

  const nameMatch = text.match(/【[^】]+】[^0-9]*/);
  const timeMatch = text.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  return {
    id,
    name: (nameMatch?.[0] || '').trim(),
    startTime: timeMatch?.[0] || targetDate,
    date: (timeMatch?.[0] || targetDate).slice(0, 10),
    rowText: text,
  };
}

async function collectLiveRowsFromCurrentPage(page, targetDate, seen, lives) {
  const allRows = getTableRows(page);
  const rowCount = await allRows.count();

  for (let i = 0; i < rowCount; i++) {
    const row = allRows.nth(i);
    const text = (await row.textContent().catch(() => '')) || '';
    const live = parseLiveFromRowText(text, targetDate);
    if (!live || seen.has(live.id)) continue;
    seen.add(live.id);
    lives.push(live);
  }
}

async function currentPageHasTargetDate(page, targetDate) {
  const allRows = getTableRows(page);
  const rowCount = await allRows.count();
  for (let i = 0; i < rowCount; i++) {
    const text = (await allRows.nth(i).textContent().catch(() => '')) || '';
    if (text.includes(targetDate)) return true;
  }
  return false;
}

async function findLiveRows(page, targetDate, options = {}) {
  const dateFilterApplied = options.dateFilterApplied === true;
  const seen = new Set();
  const lives = [];

  await goToFirstPage(page);
  await collectLiveRowsFromCurrentPage(page, targetDate, seen, lives);
  console.log(`  列表第 1 页: 累计匹配 ${lives.length} 场 (${targetDate})`);

  if (dateFilterApplied) {
    if (lives.length === 0) {
      console.log(`  已按日期筛选，当前列表无 ${targetDate} 的直播，不翻页`);
    } else {
      console.log('  已按日期筛选，仅扫描筛选结果（不翻页）');
    }
    if (lives.length > 0) {
      console.log(`共找到 ${lives.length} 场: ${lives.map((l) => l.id).join(', ')}`);
    }
    return lives;
  }

  if (lives.length > 0) {
    console.log('  第 1 页已找到，跳过翻页');
    console.log(`共找到 ${lives.length} 场: ${lives.map((l) => l.id).join(', ')}`);
    return lives;
  }

  const maxPages = options.maxPages ?? 15;
  console.log(`  未使用日期筛选且第 1 页无匹配，最多再翻 ${maxPages - 1} 页`);
  let pagesWithoutDate = 0;
  for (let pageNum = 2; pageNum <= maxPages; pageNum += 1) {
    const hasNext = await clickNextPage(page);
    if (!hasNext) break;

    const hasDateOnPage = await currentPageHasTargetDate(page, targetDate);
    if (!hasDateOnPage) {
      pagesWithoutDate += 1;
      if (pagesWithoutDate >= 2) {
        console.log('  连续多页无目标日期，停止翻页');
        break;
      }
    } else {
      pagesWithoutDate = 0;
    }

    await collectLiveRowsFromCurrentPage(page, targetDate, seen, lives);
    console.log(`  列表第 ${pageNum} 页: 累计匹配 ${lives.length} 场 (${targetDate})`);

    if (!hasDateOnPage && lives.length > 0) break;
  }

  if (lives.length > 0) {
    console.log(`共找到 ${lives.length} 场: ${lives.map((l) => l.id).join(', ')}`);
  }

  return lives;
}

async function findRowByLiveIdOnCurrentPage(page, liveId) {
  const allRows = getTableRows(page);
  const rowCount = await allRows.count();
  let fallback = null;

  for (let i = 0; i < rowCount; i++) {
    const row = allRows.nth(i);
    const text = (await row.textContent().catch(() => '')) || '';
    if (!text.includes(liveId)) continue;
    if (!fallback) fallback = row;

    const controlBtn = row.locator(
      'button:has-text("中控台"), a:has-text("中控台"), span:has-text("中控台")'
    ).first();
    const btnCount = await controlBtn.count().catch(() => 0);
    if (btnCount && await controlBtn.isVisible({ timeout: 300 }).catch(() => false)) {
      return row;
    }
  }

  return fallback;
}

async function findRowByLiveId(page, liveId, options = {}) {
  const dateFilterApplied = options.dateFilterApplied === true;
  const maxPages = dateFilterApplied ? 1 : (options.maxPages ?? 5);

  await goToFirstPage(page);

  let row = await findRowByLiveIdOnCurrentPage(page, liveId);
  if (row) return row;

  if (maxPages <= 1) return null;

  for (let pageNum = 2; pageNum <= maxPages; pageNum += 1) {
    const hasNext = await clickNextPage(page);
    if (!hasNext) break;
    row = await findRowByLiveIdOnCurrentPage(page, liveId);
    if (row) return row;
  }

  return null;
}

function printBanner(title, targetDate) {
  console.log(`=== ${title} ===`);
  console.log(`东八区今日: ${getTodayUTC8()}`);
  console.log(`目标日期: ${targetDate}`);
  console.log();
}

module.exports = {
  launchBrowser,
  waitForLogin,
  dismissBlockingOverlays,
  attemptLoginPageActions,
  filterByDate,
  findLiveRows,
  findRowByLiveId,
  goToFirstPage,
  printBanner,
};
