#!/usr/bin/env node
/**
 * 仅上传本地已切分的 MP3 到飞书（不启动浏览器）
 * 用法: node upload-audio-only.js --date 2026-07-30 --live-id 611071 --name "【高中】直降"
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { parseCliArgs, resolveTargetDate } = require('./dates');
const { uploadAudioToFeishu } = require('./feishu');

function parseArgs(argv) {
  const options = parseCliArgs(argv, {});
  options.liveId = null;
  options.name = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--live-id') options.liveId = argv[++i];
    if (argv[i] === '--name') options.name = argv[++i];
  }
  return options;
}

function findSegmentPaths(date, liveId) {
  const dir = config.audioDownloadDir;
  const prefix = `${date}_${liveId}_`;
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.mp3') && f.includes('_part'))
    .sort()
    .map((f) => path.join(dir, f));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const date = resolveTargetDate(options.date);
  const { liveId, name } = options;
  if (!date || !liveId || !name) {
    console.error('用法: node upload-audio-only.js --date YYYY-MM-DD --live-id 611071 --name "【高中】直降"');
    process.exit(1);
  }

  const filePaths = findSegmentPaths(date, liveId);
  if (!filePaths.length) {
    console.error(`未找到 ${date} 直播 ${liveId} 的 MP3 分片`);
    process.exit(1);
  }

  console.log(`上传 ${liveId}（${filePaths.length} 段）→ 飞书`);
  const result = await uploadAudioToFeishu({ date, name, liveId, filePaths });
  console.log(result.skipped ? '已跳过（已存在）' : '上传完成');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
