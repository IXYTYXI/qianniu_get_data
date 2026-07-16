const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const config = require('./config');
const { getTodayUTC8 } = require('./dates');

function ensureChromeProfileFree() {
  const profile = config.userDataDir;
  try {
    execSync(`pkill -f "user-data-dir=${profile}"`, { stdio: 'ignore' });
  } catch {
    // no running chrome
  }

  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const lockPath = path.join(profile, name);
    try {
      fs.lstatSync(lockPath);
      fs.unlinkSync(lockPath);
    } catch {
      // not present
    }
  }
}

async function launchBrowser() {
  if (!config.chromePath) {
    throw new Error('未找到 Chrome，请安装 Google Chrome 或设置 CHROME_PATH 环境变量');
  }

  fs.mkdirSync(config.downloadDir, { recursive: true });
  fs.mkdirSync(config.videoDownloadDir, { recursive: true });
  fs.mkdirSync(config.screenshotDir, { recursive: true });

  ensureChromeProfileFree();
  await new Promise((r) => setTimeout(r, 1500));

  const context = await chromium.launchPersistentContext(config.userDataDir, {
    headless: false,
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
  await startInput.fill(targetDate);
  await endInput.click();
  await endInput.fill(targetDate);
  await endInput.press('Enter');

  const searchBtn = page.locator('button:has-text("搜索"), button:has-text("查询")').first();
  if (await searchBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await searchBtn.click();
  }
  await page.waitForTimeout(3000);
}

function getTableRows(page) {
  return page.locator('table tbody tr, .ant-table-tbody tr, .el-table__body-wrapper tr');
}

async function findLiveRows(page, targetDate) {
  const allRows = getTableRows(page);
  const rowCount = await allRows.count();
  const seen = new Set();
  const lives = [];

  for (let i = 0; i < rowCount; i++) {
    const row = allRows.nth(i);
    const text = (await row.textContent().catch(() => '')) || '';
    if (!text.includes(targetDate)) continue;

    const id = text.match(/(\d{6})(?=\d{4}-\d{2}-\d{2})/)?.[1] || text.match(/(\d{6})/)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const nameMatch = text.match(/【[^】]+】[^0-9]*/);
    const timeMatch = text.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    lives.push({
      id,
      name: (nameMatch?.[0] || '').trim(),
      startTime: timeMatch?.[0] || targetDate,
      date: (timeMatch?.[0] || targetDate).slice(0, 10),
      rowText: text,
    });
  }

  return lives;
}

async function findRowByLiveId(page, liveId) {
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
  printBanner,
};
