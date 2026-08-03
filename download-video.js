/**
 * 定时任务 2：下载已转码完成的直播回放，并上传到当月飞书多维表格
 *
 * 流程: 阶段1 先下载全部视频 → 关闭浏览器 → 阶段2 再统一上传飞书
 *
 * 用法:
 *   node download-video.js                         # 默认处理昨天
 *   node download-video.js --date 2026-07-14       # 指定日期
 *   node download-video.js --skip-login            # 已登录时跳过等待
 *   node download-video.js --upload-only           # 仅上传本地已下载视频
 *   node download-video.js --keep-browser          # 完成后保持浏览器打开
 */

const path = require('path');
const fs = require('fs');
const config = require('./config');
const { resolveTargetDate, parseCliArgs } = require('./dates');
const {
  launchBrowser,
  waitForLogin,
  filterByDate,
  findLiveRows,
  findRowByLiveId,
  printBanner,
  goToFirstPage,
  dismissBlockingOverlays,
} = require('./browser');
const { uploadVideoToFeishu } = require('./feishu');

function parseOptions(argv) {
  return parseCliArgs(argv, {
    date: 'yesterday',
    skipLogin: false,
    waitMinutes: config.loginWaitMinutes,
    keepBrowser: false,
    uploadOnly: false,
  });
}

async function openControlCenter(context, page, live, listSearchOptions = {}) {
  const liveRow = await findRowByLiveId(page, live.id, listSearchOptions);
  if (!liveRow) {
    console.log(`未找到直播行: ${live.id}`);
    return null;
  }

  await liveRow.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);

  const controlBtn = liveRow.locator(
    'button:has-text("中控台"), a:has-text("中控台"), span:has-text("中控台")'
  ).first();

  const btnCount = await controlBtn.count().catch(() => 0);
  if (!btnCount) {
    console.log('未找到中控台按钮');
    return null;
  }

  const [newPage] = await Promise.all([
    context.waitForEvent('page', { timeout: 10000 }).catch(() => null),
    controlBtn.click({ force: true }),
  ]);

  const targetPage = newPage || page;
  if (newPage) {
    await newPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  }
  await targetPage.waitForTimeout(3000);
  await dismissBlockingOverlays(targetPage, `中控台 ${live.id}`);
  return targetPage;
}

async function closeDialog(dialog) {
  const closeBtn = dialog.locator('.el-dialog__headerbtn').first();
  if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await closeBtn.click();
  }
}

function sanitizeFilename(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

function buildVideoPath(live, suggestedName) {
  const ext = path.extname(suggestedName) || '.mp4';
  const safeName = `${live.date}_${live.id}_${sanitizeFilename(live.name)}${ext}`;
  return path.join(config.videoDownloadDir, safeName);
}

function findLocalVideo(live) {
  const dir = config.videoDownloadDir;
  if (!fs.existsSync(dir)) return null;
  const prefix = `${live.date}_${live.id}_`;
  const match = fs.readdirSync(dir).find((f) => f.startsWith(prefix) && /\.mp4$/i.test(f));
  return match ? path.join(dir, match) : null;
}

async function waitForFileReady(filePath, timeoutMs = config.videoFileReadyTimeout, liveId = '') {
  const start = Date.now();
  let lastSize = -1;
  let stableCount = 0;
  const tag = liveId ? `[${liveId}] ` : '';

  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(filePath)) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    const size = fs.statSync(filePath).size;
    if (size > 0 && size === lastSize) {
      stableCount += 1;
      if (stableCount >= 3) return size;
    } else {
      stableCount = 0;
      lastSize = size;
      if (size > 0) {
        const mb = (size / 1024 / 1024).toFixed(1);
        console.log(`  ${tag}下载中... ${mb} MB`);
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
    return fs.statSync(filePath).size;
  }
  throw new Error(`视频文件未就绪: ${filePath}`);
}

async function returnToLiveList(page, targetDate) {
  await page.goto(config.centerUrl, { timeout: config.navigationTimeout });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await filterByDate(page, targetDate);
  await goToFirstPage(page);
}

async function checkVideoDownloadStatus(targetPage, live) {
  console.log(`检查转码状态: ${live.id} ${live.name}`);

  const replayDownload = targetPage.locator(
    '.nav-list li:has-text("回放下载"), .sidebar li:has-text("回放下载"), ' +
    '.left-nav :text-is("回放下载"), li.tabs:has-text("回放下载"), span:has-text("回放下载")'
  ).first();
  if (!(await replayDownload.isVisible({ timeout: 5000 }).catch(() => false))) {
    console.log('未找到「回放下载」菜单');
    return { status: 'no_menu' };
  }

  await replayDownload.click();
  await targetPage.waitForTimeout(2000);

  const dialog = targetPage.locator('.el-dialog__wrapper:visible').filter({ hasText: '下载视频' }).last();
  if (!(await dialog.isVisible({ timeout: 5000 }).catch(() => false))) {
    console.log('未弹出「下载视频」对话框');
    return { status: 'no_dialog' };
  }

  const actionBtn = dialog.locator('.el-dialog__body button').first();
  const btnText = ((await actionBtn.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();

  if (!btnText) {
    console.log('未找到下载按钮');
    await closeDialog(dialog);
    return { status: 'no_button' };
  }

  console.log(`  下载按钮状态: 「${btnText}」`);

  if (/转码中|处理中|请稍后/.test(btnText)) {
    await closeDialog(dialog);
    return { status: 'transcoding', btnText };
  }

  if (/^开始|发起|点击转码/.test(btnText) || (/转码/.test(btnText) && !/下载/.test(btnText))) {
    await closeDialog(dialog);
    return { status: 'not_ready', btnText };
  }

  if (!/网页直接下载|下载MP4|下载.*视频/.test(btnText)) {
    await closeDialog(dialog);
    return { status: 'unknown_button', btnText };
  }

  if (await actionBtn.isDisabled().catch(() => false)) {
    await closeDialog(dialog);
    return { status: 'disabled', btnText };
  }

  const existingPath = findLocalVideo(live);
  if (existingPath && fs.statSync(existingPath).size > 0) {
    await closeDialog(dialog);
    return { status: 'downloaded', filePath: existingPath, skippedDownload: true, btnText };
  }

  await closeDialog(dialog);
  return { status: 'ready', btnText };
}

/**
 * 检查转码状态并点击下载；saveAs 在后台进行，不阻塞返回。
 * 返回 downloaded（本地已有）| downloading（含 promise）| 其他跳过状态。
 */
async function triggerVideoDownload(targetPage, live) {
  const check = await checkVideoDownloadStatus(targetPage, live);

  if (check.status === 'transcoding') {
    console.log(`直播 ${live.id} 仍在转码中，跳过`);
    return { status: 'transcoding' };
  }
  if (check.status === 'not_ready') {
    console.log(`直播 ${live.id} 尚未转码完成（${check.btnText}），跳过`);
    return { status: 'not_ready', btnText: check.btnText };
  }
  if (check.status === 'unknown_button') {
    console.log(`直播 ${live.id} 按钮状态不可下载: ${check.btnText}`);
    return { status: 'unknown_button', btnText: check.btnText };
  }
  if (check.status === 'disabled') {
    console.log(`直播 ${live.id} 下载按钮不可用: ${check.btnText}`);
    return { status: 'disabled', btnText: check.btnText };
  }
  if (check.status === 'downloaded') {
    const sizeMb = (fs.statSync(check.filePath).size / 1024 / 1024).toFixed(1);
    console.log(`  本地已有视频，跳过下载: ${check.filePath} (${sizeMb} MB)`);
    return { status: 'downloaded', filePath: check.filePath, skippedDownload: true };
  }
  if (check.status !== 'ready') {
    return check;
  }

  // 重新打开对话框并点击下载
  const replayDownload = targetPage.locator(
    '.nav-list li:has-text("回放下载"), .sidebar li:has-text("回放下载"), ' +
    '.left-nav :text-is("回放下载"), li.tabs:has-text("回放下载"), span:has-text("回放下载")'
  ).first();
  await replayDownload.click();
  await targetPage.waitForTimeout(2000);
  const dialog = targetPage.locator('.el-dialog__wrapper:visible').filter({ hasText: '下载视频' }).last();
  const actionBtn = dialog.locator('.el-dialog__body button').first();
  const btnText = check.btnText;

  console.log(`  [${live.id}] 发起下载: ${btnText}`);
  const [download] = await Promise.all([
    targetPage.waitForEvent('download', { timeout: config.videoDownloadTimeout }),
    actionBtn.click(),
  ]);

  const savePath = buildVideoPath(live, download.suggestedFilename());
  await closeDialog(dialog);

  const promise = (async () => {
    try {
      await download.saveAs(savePath);
      const size = await waitForFileReady(savePath, config.videoFileReadyTimeout, live.id);
      const sizeMb = (size / 1024 / 1024).toFixed(1);
      console.log(`  [${live.id}] 视频已保存: ${savePath} (${sizeMb} MB)`);
      return { status: 'downloaded', filePath: savePath };
    } catch (err) {
      console.log(`  [${live.id}] 下载失败: ${err.message}`);
      return { status: 'error', error: err.message, filePath: savePath };
    }
  })();

  console.log(`  [${live.id}] 下载已在后台进行，继续下一场...`);
  return { status: 'downloading', filePath: savePath, promise };
}

/** 阻塞式单场下载（兼容旧调用） */
async function downloadTranscodedVideo(targetPage, live) {
  const result = await triggerVideoDownload(targetPage, live);
  if (result.promise) {
    return result.promise;
  }
  return result;
}

async function checkLiveDownloadStatus(context, page, live, targetDate, listSearchOptions) {
  const targetPage = await openControlCenter(context, page, live, listSearchOptions);
  if (!targetPage) return { liveId: live.id, status: 'no_control' };

  const openedNewTab = targetPage !== page;
  try {
    return { liveId: live.id, live, ...(await checkVideoDownloadStatus(targetPage, live)) };
  } finally {
    if (openedNewTab && !targetPage.isClosed()) {
      await targetPage.close().catch(() => {});
      await page.bringToFront().catch(() => {});
    } else if (!openedNewTab && targetDate) {
      await returnToLiveList(page, targetDate);
    }
  }
}

function isLiveDownloadReady(status) {
  return status === 'ready' || status === 'downloaded';
}

/**
 * 轮询等待所有场次平台转码完成（可下载）
 */
async function waitForLivesTranscodeReady(context, page, lives, targetDate, listSearchOptions, options = {}) {
  const pollMinutes = options.transcodePollMinutes ?? config.transcodePollMinutes ?? 5;
  const maxWaitMinutes = options.transcodeMaxWaitMinutes ?? config.transcodeMaxWaitMinutes ?? 360;
  const deadline = Date.now() + maxWaitMinutes * 60_000;
  let round = 0;

  console.log(`\n=== 等待平台转码完成（每 ${pollMinutes} 分钟检查，最多 ${maxWaitMinutes} 分钟）===`);

  while (Date.now() < deadline) {
    round += 1;
    const pending = [];
    const ready = [];

    for (const live of lives) {
      const result = await checkLiveDownloadStatus(context, page, live, targetDate, listSearchOptions);
      if (isLiveDownloadReady(result.status)) {
        ready.push(live.id);
      } else if (result.status === 'transcoding' || result.status === 'not_ready') {
        pending.push({ id: live.id, status: result.status, btnText: result.btnText });
      } else {
        console.log(`  [${live.id}] 状态异常: ${result.status}，不再等待转码`);
        ready.push(live.id);
      }
    }

    console.log(`  第 ${round} 轮: 可下载 ${ready.length}/${lives.length}${pending.length ? `，仍转码 ${pending.map((p) => p.id).join(', ')}` : ''}`);

    if (pending.length === 0) {
      console.log('  全部场次已可下载\n');
      return { ready: lives, pending: [] };
    }

    const waitMs = pollMinutes * 60_000;
    console.log(`  ${pollMinutes} 分钟后重试...`);
    await page.waitForTimeout(waitMs);
    await returnToLiveList(page, targetDate);
  }

  console.log('  等待转码超时，将仅下载已就绪场次');
  return { ready: lives, pending: [], timedOut: true };
}

async function triggerDownloadLive(context, page, live, targetDate, listSearchOptions = {}) {
  const targetPage = await openControlCenter(context, page, live, listSearchOptions);
  if (!targetPage) return { liveId: live.id, status: 'no_control', live };

  const openedNewTab = targetPage !== page;

  try {
    const result = await triggerVideoDownload(targetPage, live);
    return { liveId: live.id, live, ...result };
  } catch (err) {
    console.log(`  [${live.id}] 触发下载失败: ${err.message}`);
    return { liveId: live.id, live, status: 'error', error: err.message };
  } finally {
    if (openedNewTab && !targetPage.isClosed()) {
      await targetPage.close().catch(() => {});
      await page.bringToFront().catch(() => {});
    } else if (!openedNewTab && targetDate) {
      await returnToLiveList(page, targetDate);
    }
  }
}

async function downloadLive(context, page, live, targetDate) {
  const result = await triggerDownloadLive(context, page, live, targetDate);
  if (result.promise) {
    const completed = await result.promise;
    return { liveId: live.id, live, ...completed };
  }
  return result;
}

async function uploadDownloadedVideos(downloadResults) {
  const toUpload = downloadResults.filter((r) => r.status === 'downloaded' && r.filePath);
  if (!toUpload.length) {
    console.log('没有可上传的视频');
    return [];
  }

  console.log(`\n=== 阶段 2: 上传飞书（共 ${toUpload.length} 个，大文件自动分片）===\n`);

  const uploadSummary = [];
  for (let i = 0; i < toUpload.length; i++) {
    const item = toUpload[i];
    const live = item.live;
    console.log(`--- [${i + 1}/${toUpload.length}] 上传 ${item.liveId} ---`);
    try {
      const uploadResult = await uploadVideoToFeishu({
        date: live.date,
        name: live.name || `直播${live.id}`,
        liveId: live.id,
        filePath: item.filePath,
      });
      uploadSummary.push({
        liveId: item.liveId,
        status: uploadResult.skipped ? 'skipped_upload' : 'success',
      });
    } catch (err) {
      console.log(`  上传失败: ${err.message}`);
      uploadSummary.push({ liveId: item.liveId, status: 'upload_error', error: err.message });
    }
  }
  return uploadSummary;
}

function collectLocalVideos(lives) {
  return lives
    .map((live) => {
      const filePath = findLocalVideo(live);
      if (!filePath) return null;
      return { liveId: live.id, live, status: 'downloaded', filePath, skippedDownload: true };
    })
    .filter(Boolean);
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const targetDate = resolveTargetDate(options.date);

  printBanner('千牛直播视频下载 + 飞书上传', targetDate);

  if (options.uploadOnly) {
    await filterByDateForUploadOnly(targetDate, options);
    return;
  }

  console.log('流程: 连续发起下载（后台并行）→ 全部下完后关闭浏览器 → 统一上传飞书');
  console.log('提示: 请勿手动关闭浏览器，下载会在后台继续\n');

  const { context, page } = await launchBrowser();
  let downloadResults = [];

  try {
    const loggedIn = await waitForLogin(page, options);
    if (!loggedIn) {
      console.error('未登录且设置了 --skip-login，任务终止');
      process.exit(1);
    }

    await page.goto(config.centerUrl, { timeout: config.navigationTimeout });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const filterResult = await filterByDate(page, targetDate);
    const listSearchOptions = { dateFilterApplied: filterResult.applied };
    const lives = await findLiveRows(page, targetDate, listSearchOptions);

    if (!lives.length) {
      console.log(`未找到 ${targetDate} 的直播记录`);
      return;
    }

    await filterByDate(page, targetDate);
    await goToFirstPage(page);

    console.log(`=== 阶段 1: 发起下载（共 ${lives.length} 场，后台并行）===\n`);

    const pendingDownloads = [];
    for (let i = 0; i < lives.length; i++) {
      console.log(`\n--- [${i + 1}/${lives.length}] 直播 ${lives[i].id} ---`);
      const result = await triggerDownloadLive(context, page, lives[i], targetDate, listSearchOptions);
      if (result.promise) {
        pendingDownloads.push(
          result.promise.then((completed) => ({ liveId: lives[i].id, live: lives[i], ...completed }))
        );
        downloadResults.push({ liveId: lives[i].id, live: lives[i], status: 'downloading' });
      } else {
        downloadResults.push(result);
      }
    }

    if (pendingDownloads.length) {
      console.log(`\n等待 ${pendingDownloads.length} 个后台下载完成...`);
      const completed = await Promise.all(pendingDownloads);
      for (const item of completed) {
        const idx = downloadResults.findIndex((d) => d.liveId === item.liveId);
        if (idx >= 0) downloadResults[idx] = item;
        else downloadResults.push(item);
      }
    }
  } finally {
    if (!options.keepBrowser) {
      console.log('\n全部下载结束，关闭浏览器...');
      await context.close().catch(() => {});
    }
  }

  const uploadSummary = await uploadDownloadedVideos(downloadResults);

  console.log('\n=== 执行摘要 ===');
  console.log('下载:');
  for (const item of downloadResults) {
    console.log(`  ${item.liveId}: ${item.status}${item.error ? ` (${item.error})` : ''}`);
  }
  console.log('上传:');
  for (const item of uploadSummary) {
    console.log(`  ${item.liveId}: ${item.status}${item.error ? ` (${item.error})` : ''}`);
  }

  const downloaded = downloadResults.filter((s) => s.status === 'downloaded').length;
  const uploaded = uploadSummary.filter((s) => s.status === 'success').length;
  const transcoding = downloadResults.filter((s) => s.status === 'transcoding').length;
  console.log(`\n下载完成 ${downloaded}，上传成功 ${uploaded}，转码中 ${transcoding}`);

  if (options.keepBrowser) {
    console.log('\n浏览器保持打开，按 Ctrl+C 退出');
    await new Promise(() => {});
  }
}

async function filterByDateForUploadOnly(targetDate, options) {
  const lives = await findLiveRowsFromLocal(targetDate);
  if (!lives.length) {
    console.log(`未找到 ${targetDate} 的本地视频，请先运行下载`);
    return;
  }
  const downloadResults = collectLocalVideos(lives);
  const uploadSummary = await uploadDownloadedVideos(downloadResults);
  console.log('\n=== 上传摘要 ===');
  for (const item of uploadSummary) {
    console.log(`  ${item.liveId}: ${item.status}${item.error ? ` (${item.error})` : ''}`);
  }
}

function findLiveRowsFromLocal(targetDate) {
  const dir = config.videoDownloadDir;
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(targetDate) && /\.mp4$/i.test(f));
  return files.map((f) => {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})_(\d{6})_(.+)\.mp4$/i);
    if (!m) return null;
    return {
      id: m[2],
      date: m[1],
      name: m[3].replace(/_/g, ' '),
    };
  }).filter(Boolean);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('执行失败:', err.message);
    process.exit(1);
  });
}

module.exports = {
  openControlCenter,
  checkVideoDownloadStatus,
  checkLiveDownloadStatus,
  waitForLivesTranscodeReady,
  isLiveDownloadReady,
  triggerVideoDownload,
  triggerDownloadLive,
  downloadTranscodedVideo,
  downloadLive,
  buildVideoPath,
  findLocalVideo,
  returnToLiveList,
};
