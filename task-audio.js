#!/usr/bin/env node
/**
 * 定时任务 2：下载转码完成的视频 → ffmpeg 导出音频 → 上传飞书
 *
 * 用法:
 *   npm run task-audio                              # 默认昨天，全流程
 *   npm run task-audio -- --date 2026-07-14         # 指定日期
 *   npm run task-audio -- --skip-login              # 已登录
 *   npm run task-audio -- --audio-only --date 2026-07-14   # 跳过下载，仅导出+上传
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { resolveTargetDate, parseCliArgs } = require('./dates');
const {
  launchBrowser,
  waitForLogin,
  filterByDate,
  findLiveRows,
  printBanner,
} = require('./browser');
const {
  downloadLive,
} = require('./download-video');
const {
  exportAudioFromVideo,
  listVideosForDate,
  parseVideoFilename,
  checkFfmpeg,
} = require('./audio');
const { uploadAudioToFeishu } = require('./feishu');

function parseOptions(argv) {
  const options = parseCliArgs(argv, {
    date: 'yesterday',
    skipLogin: false,
    waitMinutes: config.loginWaitMinutes,
    keepBrowser: false,
    audioOnly: false,
  });
  if (argv.includes('--audio-only')) options.audioOnly = true;
  return options;
}

async function downloadAllVideos(options, targetDate) {
  const { context, page } = await launchBrowser();
  const downloadResults = [];

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
      return downloadResults;
    }

    console.log(`=== 阶段 1: 下载视频（共 ${lives.length} 场）===\n`);
    for (let i = 0; i < lives.length; i++) {
      console.log(`\n--- [${i + 1}/${lives.length}] 直播 ${lives[i].id} ---`);
      downloadResults.push(await downloadLive(context, page, lives[i]));
    }
  } finally {
    if (!options.keepBrowser) {
      console.log('\n全部下载结束，关闭浏览器...');
      await context.close().catch(() => {});
    }
  }

  return downloadResults;
}

async function exportAndUploadAudio(targetDate, liveMetaById = {}) {
  if (!checkFfmpeg()) {
    throw new Error(`未找到 ffmpeg: ${config.ffmpegPath}`);
  }

  const videos = listVideosForDate(targetDate);
  if (!videos.length) {
    console.log(`未找到 ${targetDate} 的本地视频`);
    return { exportResults: [], uploadSummary: [], videoCount: 0 };
  }

  console.log(`\n=== 阶段 2: 导出音频（共 ${videos.length} 个）===\n`);
  const exportResults = [];
  for (let i = 0; i < videos.length; i++) {
    const videoPath = videos[i];
    const meta = parseVideoFilename(videoPath);
    const live = meta?.id ? liveMetaById[meta.id] : null;
    const displayName = live?.name || meta?.name || (meta?.id ? `直播${meta.id}` : path.basename(videoPath));
    console.log(`--- [${i + 1}/${videos.length}] ${meta?.id || path.basename(videoPath)} ---`);
    try {
      const result = exportAudioFromVideo(videoPath);
      exportResults.push({ ...meta, name: displayName, ...result });
    } catch (err) {
      console.log(`  导出失败: ${err.message}`);
      exportResults.push({ ...meta, name: displayName, status: 'error', error: err.message });
    }
  }

  console.log(`\n=== 阶段 3: 上传音频到飞书 ===\n`);
  const uploadSummary = [];
  for (let i = 0; i < exportResults.length; i++) {
    const item = exportResults[i];
    if (!item.outputPath) continue;
    console.log(`--- [${i + 1}] 上传 ${item.id} ---`);
    try {
      const result = await uploadAudioToFeishu({
        date: item.date,
        name: item.name,
        filePath: item.outputPath,
      });
      uploadSummary.push({
        id: item.id,
        status: result.skipped ? 'skipped' : 'success',
      });
    } catch (err) {
      console.log(`  上传失败: ${err.message}`);
      uploadSummary.push({ id: item.id, status: 'error', error: err.message });
    }
  }

  return { exportResults, uploadSummary, videoCount: videos.length };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const targetDate = resolveTargetDate(options.date);

  printBanner('定时任务2：下载视频 → 导出音频 → 上传飞书', targetDate);
  console.log('流程: 下载视频 → 关闭浏览器 → ffmpeg 导出音频 → 分片上传飞书\n');

  let downloadResults = [];
  if (!options.audioOnly) {
    console.log('提示: 下载过程中会保持浏览器和中控台页面打开，请勿手动关闭\n');
    downloadResults = await downloadAllVideos(options, targetDate);
  }

  const liveMetaById = {};
  for (const item of downloadResults) {
    if (item.live) liveMetaById[item.liveId] = item.live;
  }

  const { exportResults, uploadSummary, videoCount } = await exportAndUploadAudio(
    targetDate,
    liveMetaById
  );

  console.log('\n=== 执行摘要 ===');
  if (!options.audioOnly) {
    console.log('下载:');
    for (const item of downloadResults) {
      console.log(`  ${item.liveId}: ${item.status}${item.error ? ` (${item.error})` : ''}`);
    }
  }
  console.log('上传:');
  for (const item of uploadSummary) {
    console.log(`  ${item.id}: ${item.status}${item.error ? ` (${item.error})` : ''}`);
  }

  const downloaded = downloadResults.filter((s) => s.status === 'downloaded').length;
  const transcoding = downloadResults.filter((s) => s.status === 'transcoding' || s.status === 'not_ready').length;
  const uploaded = uploadSummary.filter((s) => s.status === 'success').length;
  const skipped = uploadSummary.filter((s) => s.status === 'skipped').length;
  console.log(`\n下载完成 ${downloaded}，转码未完成 ${transcoding}，音频上传成功 ${uploaded}，已跳过 ${skipped}`);

  if (options.keepBrowser) {
    console.log('\n浏览器保持打开，按 Ctrl+C 退出');
    await new Promise(() => {});
    return;
  }

  const hadVideos = videoCount > 0;
  const uploadDone = uploaded > 0 || skipped > 0;
  if (hadVideos && !uploadDone) {
    console.error('有视频但音频均未上传成功');
    process.exit(1);
  }
  if (!options.audioOnly && downloadResults.length > 0 && downloaded === 0 && transcoding === downloadResults.length) {
    console.error('所有场次仍在转码中，请稍后重跑任务 2');
    process.exit(1);
  }

  console.log('EXIT_CODE: 0');
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('执行失败:', err.message);
    process.exit(1);
  });
}
