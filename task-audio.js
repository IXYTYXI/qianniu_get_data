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
    if (!loggedIn) return downloadResults;

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

async function exportAndUploadAudio(targetDate) {
  if (!checkFfmpeg()) {
    throw new Error('未找到 ffmpeg，请先安装: brew install ffmpeg');
  }

  const videos = listVideosForDate(targetDate);
  if (!videos.length) {
    console.log(`未找到 ${targetDate} 的本地视频`);
    return { exportResults: [], uploadSummary: [] };
  }

  console.log(`\n=== 阶段 2: 导出音频（共 ${videos.length} 个）===\n`);
  const exportResults = [];
  for (let i = 0; i < videos.length; i++) {
    const videoPath = videos[i];
    const meta = parseVideoFilename(videoPath);
    console.log(`--- [${i + 1}/${videos.length}] ${meta?.id || path.basename(videoPath)} ---`);
    try {
      const result = exportAudioFromVideo(videoPath);
      exportResults.push({ ...meta, ...result });
    } catch (err) {
      console.log(`  导出失败: ${err.message}`);
      exportResults.push({ ...meta, status: 'error', error: err.message });
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

  return { exportResults, uploadSummary };
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

  const { exportResults, uploadSummary } = await exportAndUploadAudio(targetDate);

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
  const uploaded = uploadSummary.filter((s) => s.status === 'success').length;
  console.log(`\n下载完成 ${downloaded}，音频上传成功 ${uploaded}`);

  if (options.keepBrowser) {
    console.log('\n浏览器保持打开，按 Ctrl+C 退出');
    await new Promise(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('执行失败:', err.message);
    process.exit(1);
  });
}
