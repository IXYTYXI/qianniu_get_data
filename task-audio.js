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
  waitForLivesTranscodeReady,
} = require('./download-video');
const {
  exportAudioSegmentsFromVideo,
  listVideosForDate,
  parseVideoFilename,
  checkFfmpeg,
} = require('./audio');
const { uploadAudioToFeishu, checkAudioUploadedToFeishu, ensureFeishuConfigForDate, loadFeishuConfig } = require('./feishu');

function parseOptions(argv) {
  const options = parseCliArgs(argv, {
    date: 'yesterday',
    skipLogin: false,
    waitMinutes: config.loginWaitMinutes,
    keepBrowser: false,
    audioOnly: false,
  });
  if (argv.includes('--audio-only')) options.audioOnly = true;
  if (argv.includes('--skip-transcode-wait')) options.skipTranscodeWait = true;
  return options;
}

async function transcodeOne(meta, displayName) {
  console.log(`--- ${meta?.id || path.basename(meta?.videoPath || '')} ---`);
  const result = exportAudioSegmentsFromVideo(meta.videoPath);
  return { ...meta, name: displayName, ...result };
}

async function uploadOne(item) {
  if (!item.segmentPaths?.length) {
    return { id: item.id, status: 'skipped', reason: 'no_segments' };
  }
  console.log(`\n>>> 上传飞书: ${item.id}（${item.segmentPaths.length} 段）`);
  try {
    const upload = await uploadAudioToFeishu({
      date: item.date,
      name: item.name,
      liveId: item.id,
      filePaths: item.segmentPaths,
    });
    return {
      id: item.id,
      status: upload.skipped ? 'skipped' : 'success',
    };
  } catch (err) {
    console.log(`  [${item.id}] 上传失败: ${err.message}`);
    return { id: item.id, status: 'error', error: err.message };
  }
}

async function exportAndUploadOne(meta, displayName, { awaitUpload = true } = {}) {
  const uploadSummary = [];
  const exportResults = [];
  try {
    const item = await transcodeOne(meta, displayName);
    exportResults.push(item);
    if (!item.segmentPaths?.length) return { exportResults, uploadSummary };

    if (awaitUpload) {
      const result = await uploadOne(item);
      uploadSummary.push(result);
    }
    return { exportResults, uploadSummary, uploadItem: awaitUpload ? null : item };
  } catch (err) {
    console.log(`  失败: ${err.message}`);
    exportResults.push({ ...meta, name: displayName, status: 'error', error: err.message });
    uploadSummary.push({ id: meta?.id, status: 'error', error: err.message });
  }
  return { exportResults, uploadSummary };
}

function schedulePostDownload(live, filePath, uploadSummary) {
  const meta = parseVideoFilename(filePath);
  const displayName = live.name || meta?.name || `直播${live.id}`;
  return exportAndUploadOne(
    { ...meta, videoPath: filePath },
    displayName,
    { awaitUpload: true }
  ).then(({ uploadSummary: us }) => {
    uploadSummary.push(...us);
  });
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker())
  );
  return results;
}

async function runUploadQueue(transcodeResults) {
  const pending = transcodeResults.filter((item) => item.segmentPaths?.length);
  if (!pending.length) return [];

  const min = config.feishuUploadConcurrencyMin ?? 3;
  const concurrency = Math.max(min, config.feishuUploadConcurrency ?? min);
  console.log(`\n=== 飞书上传队列（${pending.length} 场，并发 ${concurrency}，与浏览器无关）===`);
  return runPool(pending, (item) => uploadOne(item), concurrency);
}

async function processLivesPipeline(options, targetDate, session = null) {
  if (!checkFfmpeg()) {
    throw new Error(`未找到 ffmpeg: ${config.ffmpegPath}`);
  }

  await ensureFeishuConfigForDate(targetDate);

  let feishuConfig;
  try {
    feishuConfig = loadFeishuConfig();
  } catch {
    feishuConfig = null;
  }

  const ownsBrowser = !session;
  let context;
  let page;
  if (session) {
    context = session.context;
    page = session.page;
  } else {
    ({ context, page } = await launchBrowser());
  }

  const downloadResults = [];
  const uploadSummary = [];

  try {
    if (ownsBrowser) {
      const loggedIn = await waitForLogin(page, options);
      if (!loggedIn) {
        if (!options.keepBrowser) await context.close().catch(() => {});
        if (!options.continueOnError) process.exit(1);
        return { downloadResults, uploadSummary, videoCount: 0, ok: false };
      }
    }

    await page.goto(config.centerUrl, { timeout: config.navigationTimeout });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const filterResult = await filterByDate(page, targetDate);
    const listSearchOptions = { dateFilterApplied: filterResult.applied, feishuConfig };
    const lives = await findLiveRows(page, targetDate, listSearchOptions);
    if (!lives.length) {
      console.log(`未找到 ${targetDate} 的直播记录`);
      return { downloadResults, uploadSummary, videoCount: 0, ok: true };
    }

    await filterByDate(page, targetDate);
    await goToFirstPage(page);

    if (!options.skipTranscodeWait) {
      await waitForLivesTranscodeReady(context, page, lives, targetDate, listSearchOptions, options);
    } else {
      console.log('\n=== 跳过等待平台转码（--skip-transcode-wait）===\n');
    }

    console.log(`=== 阶段2：连续发起下载（不等待落盘），下完即 ffmpeg + 上传（共 ${lives.length} 场）===\n`);

    const downloadPromises = [];
    const postProcessTasks = [];

    for (let i = 0; i < lives.length; i++) {
      const live = lives[i];
      console.log(`\n--- [${i + 1}/${lives.length}] 发起下载 ${live.id} ---`);

      try {
        const uploadCheck = await checkAudioUploadedToFeishu({
          date: targetDate,
          name: live.name,
          liveId: live.id,
        });
        if (uploadCheck.complete) {
          console.log(`  飞书音频已齐全（${uploadCheck.segmentCount} 段），跳过下载/转码: ${live.id}`);
          downloadResults.push({ liveId: live.id, live, status: 'skipped_uploaded' });
          continue;
        }
        if (uploadCheck.segmentCount > 0) {
          console.log(`  飞书音频不完整（${uploadCheck.segmentCount} 段），需补传: ${live.id}`);
        }
      } catch (err) {
        console.log(`  飞书检查失败，继续下载: ${err.message}`);
      }

      const dl = await triggerDownloadLive(context, page, live, targetDate, listSearchOptions);

      if (dl.status === 'downloaded' && dl.filePath) {
        downloadResults.push({ liveId: live.id, live, ...dl });
        postProcessTasks.push(schedulePostDownload(live, dl.filePath, uploadSummary));
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
              console.log(`\n--- ${live.id} 下载完成，开始转音频并上传 ---`);
              postProcessTasks.push(
                schedulePostDownload(live, completed.filePath, uploadSummary)
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
      console.log('\n等待各场 ffmpeg + 飞书上传完成...');
      await Promise.all(postProcessTasks);
    }
  } finally {
    if (!options.keepBrowser && ownsBrowser) {
      console.log('\n下载/转码完成，关闭浏览器...');
      await context.close().catch(() => {});
    }
  }

  return {
    downloadResults,
    uploadSummary,
    videoCount: downloadResults.filter((d) => d.status === 'downloaded').length,
    ok: true,
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
  console.log('流程: 等待平台转码 → 连续发起下载 → 每场下完即 ffmpeg + 上传飞书\n');

  await ensureFeishuConfigForDate(targetDate);

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
  if (!options.allowTranscodingSkip && !options.audioOnly && downloadResults.length > 0 && downloaded === 0 && transcoding === downloadResults.length) {
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

module.exports = {
  parseOptions,
  processLivesPipeline,
  exportAndUploadAudio,
  exportAndUploadOne,
  uploadOne,
};
