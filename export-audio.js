/**
 * 从已下载的 MP4 导出音频，并可选上传到飞书
 *
 * 用法:
 *   node export-audio.js --date 2026-07-14              # 仅导出音频
 *   node export-audio.js --date 2026-07-14 --upload     # 导出后上传飞书
 */

const path = require('path');
const { resolveTargetDate, parseCliArgs } = require('./dates');
const {
  exportAudioFromVideo,
  listVideosForDate,
  parseVideoFilename,
  checkFfmpeg,
} = require('./audio');
const { uploadAudioToFeishu } = require('./feishu');

function parseOptions(argv) {
  const options = parseCliArgs(argv, { date: 'yesterday' });
  options.upload = argv.includes('--upload');
  return options;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const targetDate = resolveTargetDate(options.date);

  console.log('=== 直播音频导出 ===');
  console.log(`目标日期: ${targetDate}\n`);

  if (!checkFfmpeg()) {
    console.error('未找到 ffmpeg，请先安装: brew install ffmpeg');
    process.exit(1);
  }

  const videos = listVideosForDate(targetDate);
  if (!videos.length) {
    console.log(`未找到 ${targetDate} 的本地视频，请先运行 download-video`);
    return;
  }

  console.log(`找到 ${videos.length} 个视频\n`);

  const exportResults = [];
  for (let i = 0; i < videos.length; i++) {
    const videoPath = videos[i];
    const meta = parseVideoFilename(videoPath);
    console.log(`--- [${i + 1}/${videos.length}] ${meta?.id || path.basename(videoPath)} ---`);
    try {
      const result = exportAudioFromVideo(videoPath);
      exportResults.push({ ...meta, videoPath, ...result });
    } catch (err) {
      console.log(`  导出失败: ${err.message}`);
      exportResults.push({ videoPath, status: 'error', error: err.message });
    }
  }

  if (!options.upload) {
    console.log('\n导出完成。上传飞书请运行:');
    console.log(`  node export-audio.js --date ${targetDate} --upload`);
    return;
  }

  console.log('\n=== 上传音频到飞书 ===\n');
  const uploadSummary = [];
  for (let i = 0; i < exportResults.length; i++) {
    const item = exportResults[i];
    if (!item.outputPath) continue;
    console.log(`--- [${i + 1}] 上传 ${item.id} ---`);
    try {
      const result = await uploadAudioToFeishu({
        date: item.date,
        name: item.name,
        liveId: item.id,
        filePath: item.outputPath,
      });
      uploadSummary.push({ id: item.id, status: result.skipped ? 'skipped' : 'success' });
    } catch (err) {
      console.log(`  上传失败: ${err.message}`);
      uploadSummary.push({ id: item.id, status: 'error', error: err.message });
    }
  }

  console.log('\n=== 摘要 ===');
  for (const item of uploadSummary) {
    console.log(`  ${item.id}: ${item.status}`);
  }
}

main().catch((err) => {
  console.error('执行失败:', err.message);
  process.exit(1);
});
