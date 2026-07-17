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

async function openControlCenter(context, page, live) {
  const liveRow = await findRowByLiveId(page, live.id);
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
  await targetPage.waitForTimeout(2000);
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

async function waitForFileReady(filePath, timeoutMs = config.videoFileReadyTimeout) {
  const start = Date.now();
  let lastSize = -1;
  let stableCount = 0;

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
        process.stdout.write(`\r  下载中... ${mb} MB`);
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
    return fs.statSync(filePath).size;
  }
  throw new Error(`视频文件未就绪: ${filePath}`);
}

async function downloadTranscodedVideo(targetPage, live) {
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
    console.log(`直播 ${live.id} 仍在转码中，跳过`);
    await closeDialog(dialog);
    return { status: 'transcoding' };
  }

  if (/^开始|发起|点击转码/.test(btnText) || (/转码/.test(btnText) && !/下载/.test(btnText))) {
    console.log(`直播 ${live.id} 尚未转码完成（${btnText}），跳过`);
    await closeDialog(dialog);
    return { status: 'not_ready', btnText };
  }

  if (!/网页直接下载|下载MP4|下载.*视频/.test(btnText)) {
    console.log(`直播 ${live.id} 按钮状态不可下载: ${btnText}`);
    await closeDialog(dialog);
    return { status: 'unknown_button', btnText };
  }

  if (await actionBtn.isDisabled().catch(() => false)) {
    console.log(`直播 ${live.id} 下载按钮不可用: ${btnText}`);
    await closeDialog(dialog);
    return { status: 'disabled', btnText };
  }

  const existingPath = findLocalVideo(live);
  if (existingPath && fs.statSync(existingPath).size > 0) {
    const sizeMb = (fs.statSync(existingPath).size / 1024 / 1024).toFixed(1);
    console.log(`  本地已有视频，跳过下载: ${existingPath} (${sizeMb} MB)`);
    await closeDialog(dialog);
    return { status: 'downloaded', filePath: existingPath, skippedDownload: true };
  }

  console.log(`开始下载: ${btnText}（浏览器保持打开，请勿手动关闭）`);
  const [download] = await Promise.all([
    targetPage.waitForEvent('download', { timeout: config.videoDownloadTimeout }),
    actionBtn.click(),
  ]);

  const savePath = buildVideoPath(live, download.suggestedFilename());
  await download.saveAs(savePath);
  const size = await waitForFileReady(savePath);
  await closeDialog(dialog);
  process.stdout.write('\n');
  const sizeMb = (size / 1024 / 1024).toFixed(1);
  console.log(`  视频已保存: ${savePath} (${sizeMb} MB)`);

  return { status: 'downloaded', filePath: savePath };
}

async function downloadLive(context, page, live) {
  const targetPage = await openControlCenter(context, page, live);
  if (!targetPage) return { liveId: live.id, status: 'no_control', live };

  try {
    const result = await downloadTranscodedVideo(targetPage, live);
    return { liveId: live.id, live, ...result };
  } catch (err) {
    console.log(`  下载失败: ${err.message}`);
    return { liveId: live.id, live, status: 'error', error: err.message };
  } finally {
    if (targetPage !== page && !targetPage.isClosed()) {
      await targetPage.waitForTimeout(1000);
      await targetPage.close().catch(() => {});
    }
  }
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

  console.log('流程: 阶段1 下载全部视频 → 关闭浏览器 → 阶段2 统一上传飞书');
  console.log('提示: 下载过程中会保持浏览器和中控台页面打开，请勿手动关闭\n');

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

    await filterByDate(page, targetDate);
    const lives = await findLiveRows(page, targetDate);

    if (!lives.length) {
      console.log(`未找到 ${targetDate} 的直播记录`);
      return;
    }

    console.log(`=== 阶段 1: 下载视频（共 ${lives.length} 场）===\n`);

    for (let i = 0; i < lives.length; i++) {
      console.log(`\n--- [${i + 1}/${lives.length}] 直播 ${lives[i].id} ---`);
      const result = await downloadLive(context, page, lives[i]);
      downloadResults.push(result);
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

main().catch((err) => {
  console.error('执行失败:', err.message);
  process.exit(1);
});

module.exports = {
  openControlCenter,
  downloadTranscodedVideo,
  downloadLive,
  buildVideoPath,
  findLocalVideo,
};
