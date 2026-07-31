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

function getSegmentFilePrefix(fullMp3Path) {
  const base = path.basename(fullMp3Path, path.extname(fullMp3Path));
  return `${base}_part`;
}

function listExistingSegments(fullMp3Path) {
  const dir = path.dirname(fullMp3Path);
  const prefix = getSegmentFilePrefix(fullMp3Path);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && /\.mp3$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
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
      `未找到 ffmpeg: ${config.ffmpegPath}\n请在 .env 中设置 FFMPEG_PATH 或安装 ffmpeg`
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

function splitAudioIntoSegments(fullMp3Path, options = {}) {
  if (!fs.existsSync(fullMp3Path)) {
    throw new Error(`音频不存在: ${fullMp3Path}`);
  }
  if (!checkFfmpeg()) {
    throw new Error(`未找到 ffmpeg: ${config.ffmpegPath}`);
  }

  const segmentSeconds = options.segmentSeconds ?? config.audioSegmentSeconds;
  const overwrite = options.overwrite ?? false;
  const existing = listExistingSegments(fullMp3Path);

  if (existing.length > 0 && !overwrite) {
    console.log(`  音频分段已存在 (${existing.length} 段)，跳过切分`);
    return existing;
  }

  if (existing.length > 0 && overwrite) {
    for (const p of existing) {
      fs.unlinkSync(p);
    }
  }

  const dir = path.dirname(fullMp3Path);
  const pattern = path.join(dir, `${getSegmentFilePrefix(fullMp3Path)}%02d.mp3`);
  console.log(`  按 ${segmentSeconds} 秒切分: ${path.basename(fullMp3Path)}`);

  execFileSync(config.ffmpegPath, [
    '-y',
    '-i', fullMp3Path,
    '-f', 'segment',
    '-segment_time', String(segmentSeconds),
    '-segment_start_number', '1',
    '-reset_timestamps', '1',
    '-acodec', 'libmp3lame',
    '-b:a', options.bitrate || '128k',
    '-ar', '44100',
    pattern,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const segments = listExistingSegments(fullMp3Path);
  if (!segments.length) {
    throw new Error('切分后未生成分段文件');
  }
  console.log(`  切分完成: ${segments.length} 段`);
  return segments;
}

/**
 * 导出整段 MP3 后按配置时长切分；默认删除整段 MP3，仅保留 _partXX 文件。
 */
function exportAudioSegmentsFromVideo(videoPath, options = {}) {
  const exportResult = exportAudioFromVideo(videoPath, options);
  const segmentPaths = splitAudioIntoSegments(exportResult.outputPath, {
    ...options,
    overwrite: !exportResult.skipped || options.overwrite,
  });

  if (!options.keepFullMp3 && fs.existsSync(exportResult.outputPath)) {
    fs.unlinkSync(exportResult.outputPath);
    console.log(`  已删除整段 MP3: ${path.basename(exportResult.outputPath)}`);
  }

  return {
    ...exportResult,
    segmentPaths,
    outputPath: segmentPaths[0] || exportResult.outputPath,
  };
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
  return { date: m[1], id: m[2], name: m[3].replace(/_/g, ' ') };
}

module.exports = {
  exportAudioFromVideo,
  exportAudioSegmentsFromVideo,
  splitAudioIntoSegments,
  listExistingSegments,
  getAudioOutputPath,
  listVideosForDate,
  parseVideoFilename,
  checkFfmpeg,
};
