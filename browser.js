const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const config = require('./config');
const { getTodayUTC8 } = require('./dates');

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

async function waitForLogin(page, options = {}) {
  const skipLogin = options.skipLogin;
  const waitMinutes = options.waitMinutes || config.loginWaitMinutes;

  console.log('尝试直接访问直播中心...');
  await page.goto(config.centerUrl, { timeout: config.navigationTimeout });
  await page.waitForTimeout(3000);

  const url = page.url();
  if (!url.includes('login') && !url.includes('qiniulogin')) {
    console.log('已登录（会话有效）');
    return true;
  }

  if (skipLogin) {
    console.log('未登录且设置了 --skip-login');
    return false;
  }

  console.log(`打开登录页: ${config.loginUrl}`);
  await page.goto(config.loginUrl, { timeout: config.navigationTimeout });
  console.log(`请在浏览器中登录，等待 ${waitMinutes} 分钟...`);

  try {
    await page.waitForURL(
      (u) => !u.toString().includes('qiniulogin') && !u.toString().includes('login'),
      { timeout: waitMinutes * 60 * 1000 }
    );
    console.log('检测到登录成功');
    return true;
  } catch {
    return !page.url().includes('login');
  }
}

async function filterByDate(page, targetDate) {
  console.log(`按日期筛选: ${targetDate}`);
  const startInput = page.locator('input[placeholder*="开始日期"], input[placeholder*="开始时间"]').first();
  const endInput = page.locator('input[placeholder*="结束日期"], input[placeholder*="结束时间"]').first();

  if (!(await startInput.isVisible({ timeout: 5000 }).catch(() => false))) {
    console.log('未找到日期筛选器');
    return;
  }

  await startInput.click();
  await startInput.fill('');
  await startInput.fill(targetDate);
  await endInput.click();
  await endInput.fill('');
  await endInput.fill(targetDate);
  await endInput.press('Enter');

  const searchBtn = page.locator(
    'button:has-text("搜索"), button:has-text("查询"), button:has-text("筛选")'
  ).first();
  if (await searchBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await searchBtn.click();
  }
  await page.waitForTimeout(4000);
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

async function findLiveRows(page, targetDate) {
  const seen = new Set();
  const lives = [];

  await goToFirstPage(page);
  await collectLiveRowsFromCurrentPage(page, targetDate, seen, lives);
  console.log(`  列表第 1 页: 累计匹配 ${lives.length} 场 (${targetDate})`);

  // 定时任务（日期筛选后）：第一页通常已包含全部目标场次
  if (lives.length > 0) {
    console.log('  第 1 页已找到，跳过翻页');
    console.log(`共找到 ${lives.length} 场: ${lives.map((l) => l.id).join(', ')}`);
    return lives;
  }

  // 补跑历史日期：第一页无匹配时再翻页
  console.log('  第 1 页无匹配，开始翻页查找（补跑）');
  for (let pageNum = 2; pageNum <= 50; pageNum += 1) {
    const hasNext = await clickNextPage(page);
    if (!hasNext) break;

    const hasDateOnPage = await currentPageHasTargetDate(page, targetDate);
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

async function findRowByLiveId(page, liveId) {
  await goToFirstPage(page);

  let row = await findRowByLiveIdOnCurrentPage(page, liveId);
  if (row) return row;

  // 补跑时目标可能在后续页
  for (let pageNum = 2; pageNum <= 50; pageNum += 1) {
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
  filterByDate,
  findLiveRows,
  findRowByLiveId,
  goToFirstPage,
  printBanner,
};
