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
  goToFirstPage,
} = require('./browser');
const {
  triggerDownloadLive,
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

async function exportAndUploadOne(meta, displayName, { awaitUpload = true } = {}) {
  const uploadSummary = [];
  const exportResults = [];
  console.log(`--- ${meta?.id || path.basename(meta?.videoPath || '')} ---`);
  try {
    const result = exportAudioFromVideo(meta.videoPath);
    const item = { ...meta, name: displayName, ...result };
    exportResults.push(item);
    if (!item.outputPath) return { exportResults, uploadSummary };

    console.log(`  上传飞书: ${item.id}${awaitUpload ? '' : '（后台）'}`);
    const uploadPromise = uploadAudioToFeishu({
      date: item.date,
      name: item.name,
      liveId: item.id,
      filePath: item.outputPath,
    }).then((upload) => {
      uploadSummary.push({
        id: item.id,
        status: upload.skipped ? 'skipped' : 'success',
      });
      return upload;
    }).catch((err) => {
      console.log(`  [${item.id}] 上传失败: ${err.message}`);
      uploadSummary.push({ id: item.id, status: 'error', error: err.message });
      throw err;
    });

    if (awaitUpload) {
      await uploadPromise;
    }
    return { exportResults, uploadSummary, uploadPromise: awaitUpload ? null : uploadPromise };
  } catch (err) {
    console.log(`  失败: ${err.message}`);
    exportResults.push({ ...meta, name: displayName, status: 'error', error: err.message });
    uploadSummary.push({ id: meta?.id, status: 'error', error: err.message });
  }
  return { exportResults, uploadSummary };
}

function schedulePostDownload(live, filePath, uploadSummary, uploadTasks) {
  const meta = parseVideoFilename(filePath);
  const displayName = live.name || meta?.name || `直播${live.id}`;
  return exportAndUploadOne(
    { ...meta, videoPath: filePath },
    displayName,
    { awaitUpload: false }
  ).then(({ uploadPromise }) => {
    if (uploadPromise) {
      uploadTasks.add(uploadPromise);
      uploadPromise.finally(() => uploadTasks.delete(uploadPromise));
    }
  });
}

async function processLivesPipeline(options, targetDate) {
  if (!checkFfmpeg()) {
    throw new Error(`未找到 ffmpeg: ${config.ffmpegPath}`);
  }

  const { context, page } = await launchBrowser();
  const downloadResults = [];
  const uploadSummary = [];

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
      return { downloadResults, uploadSummary, videoCount: 0 };
    }

    await filterByDate(page, targetDate);
    await goToFirstPage(page);

    console.log(`=== 流水线：连续发起下载，下完即转音频并上传（共 ${lives.length} 场）===\n`);

    const downloadPromises = [];
    const postProcessTasks = [];
    const uploadTasks = new Set();

    for (let i = 0; i < lives.length; i++) {
      const live = lives[i];
      console.log(`\n--- [${i + 1}/${lives.length}] 发起下载 ${live.id} ---`);

      const dl = await triggerDownloadLive(context, page, live, targetDate);

      if (dl.status === 'downloaded' && dl.filePath) {
        downloadResults.push({ liveId: live.id, live, ...dl });
        postProcessTasks.push(schedulePostDownload(live, dl.filePath, uploadSummary, uploadTasks));
        continue;
      }

      if (dl.status === 'downloading' && dl.promise) {
        downloadResults.push({ liveId: live.id, live, status: 'downloading' });
        downloadPromises.push(
          dl.promise.then((completed) => {
            const idx = downloadResults.findIndex((d) => d.liveId === live.id);
            if (idx >= 0) {
              downloadResults[idx] = { liveId: live.id, live, ...completed };
            }
            if (completed.status === 'downloaded' && completed.filePath) {
              console.log(`\n--- ${live.id} 下载完成，开始转音频 ---`);
              postProcessTasks.push(
                schedulePostDownload(live, completed.filePath, uploadSummary, uploadTasks)
              );
            }
            return completed;
          })
        );
        continue;
      }

      downloadResults.push({ liveId: live.id, live, ...dl });
    }

    if (downloadPromises.length) {
      console.log(`\n${downloadPromises.length} 个下载在后台进行，等待全部落盘...`);
      await Promise.all(downloadPromises);
    }

    if (postProcessTasks.length) {
      console.log('\n等待转音频任务完成...');
      await Promise.all(postProcessTasks);
    }

    if (uploadTasks.size) {
      console.log(`等待 ${uploadTasks.size} 个飞书上传完成...`);
      await Promise.all([...uploadTasks]);
    }
  } finally {
    if (!options.keepBrowser) {
      console.log('\n全部处理结束，关闭浏览器...');
      await context.close().catch(() => {});
    }
  }

  return {
    downloadResults,
    uploadSummary,
    videoCount: downloadResults.filter((d) => d.status === 'downloaded').length,
  };
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

  console.log(`\n=== 逐场导出并上传（共 ${videos.length} 个）===\n`);
  const exportResults = [];
  const uploadSummary = [];

  for (let i = 0; i < videos.length; i++) {
    const videoPath = videos[i];
    const meta = parseVideoFilename(videoPath);
    const live = meta?.id ? liveMetaById[meta.id] : null;
    const displayName = live?.name || meta?.name || (meta?.id ? `直播${meta.id}` : path.basename(videoPath));
    console.log(`\n--- [${i + 1}/${videos.length}] ---`);
    const { exportResults: er, uploadSummary: us } = await exportAndUploadOne(
      { ...meta, videoPath },
      displayName
    );
    exportResults.push(...er);
    uploadSummary.push(...us);
  }

  return { exportResults, uploadSummary, videoCount: videos.length };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const targetDate = resolveTargetDate(options.date);

  printBanner('定时任务2：下载视频 → 导出音频 → 上传飞书', targetDate);
  console.log('流程: 连续发起下载（后台并行）→ 下完即 ffmpeg → 上传飞书（上传可重叠）\n');

  let downloadResults = [];
  let exportResults = [];
  let uploadSummary = [];
  let videoCount = 0;

  if (!options.audioOnly) {
    console.log('提示: 下载过程中会保持浏览器和中控台页面打开，请勿手动关闭\n');
    const pipeline = await processLivesPipeline(options, targetDate);
    downloadResults = pipeline.downloadResults;
    uploadSummary = pipeline.uploadSummary;
    videoCount = pipeline.videoCount;
  } else {
    const result = await exportAndUploadAudio(targetDate, {});
    exportResults = result.exportResults;
    uploadSummary = result.uploadSummary;
    videoCount = result.videoCount;
  }

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
