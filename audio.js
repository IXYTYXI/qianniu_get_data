const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');

function ensureAudioDir() {
  fs.mkdirSync(config.audioDownloadDir, { recursive: true });
}

function getAudioOutputPath(videoPath) {
  const base = path.basename(videoPath, path.extname(videoPath));
  return path.join(config.audioDownloadDir, `${base}.mp3`);
}

function checkFfmpeg() {
  try {
    execFileSync(config.ffmpegPath, ['-version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function exportAudioFromVideo(videoPath, options = {}) {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`视频不存在: ${videoPath}`);
  }
  if (!checkFfmpeg()) {
    throw new Error(
      '未找到 ffmpeg，请先安装:\n  Mac: brew install ffmpeg\n  或设置 FFMPEG_PATH 环境变量'
    );
  }

  ensureAudioDir();
  const outputPath = options.outputPath || getAudioOutputPath(videoPath);

  if (fs.existsSync(outputPath) && !options.overwrite) {
    const sizeMb = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
    console.log(`  音频已存在，跳过导出: ${outputPath} (${sizeMb} MB)`);
    return { outputPath, skipped: true };
  }

  const bitrate = options.bitrate || '128k';
  console.log(`  导出音频: ${path.basename(videoPath)} → ${path.basename(outputPath)}`);

  execFileSync(config.ffmpegPath, [
    '-y',
    '-i', videoPath,
    '-vn',
    '-acodec', 'libmp3lame',
    '-b:a', bitrate,
    '-ar', '44100',
    outputPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const sizeMb = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
  console.log(`  音频导出完成: ${outputPath} (${sizeMb} MB)`);
  return { outputPath, skipped: false };
}

function listVideosForDate(targetDate) {
  const dir = config.videoDownloadDir;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(targetDate) && /\.mp4$/i.test(f))
    .map((f) => path.join(dir, f));
}

function parseVideoFilename(filename) {
  const m = path.basename(filename).match(/^(\d{4}-\d{2}-\d{2})_(\d{6})_(.+)\.mp4$/i);
  if (!m) return null;
  return { date: m[1], id: m[2], name: m[3] };
}

module.exports = {
  exportAudioFromVideo,
  getAudioOutputPath,
  listVideosForDate,
  parseVideoFilename,
  checkFfmpeg,
};
