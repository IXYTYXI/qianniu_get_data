const path = require('path');
const { loadDotEnv } = require('./env');
const { resolveChromePath, resolveFfmpegPath } = require('./utils');

loadDotEnv();

function resolveUserDataDir() {
  if (process.env.CHROME_USER_DATA_DIR) {
    return process.env.CHROME_USER_DATA_DIR;
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'qianniu-chrome-profile');
  }
  return path.join(__dirname, '.chrome-profile');
}

const FEISHU_UPLOAD_CONCURRENCY_MIN = 3;

function resolveFeishuUploadConcurrency() {
  const raw = parseInt(process.env.FEISHU_UPLOAD_CONCURRENCY, 10);
  const configured = Number.isFinite(raw) ? raw : FEISHU_UPLOAD_CONCURRENCY_MIN;
  return Math.max(FEISHU_UPLOAD_CONCURRENCY_MIN, configured);
}

module.exports = {
  loginUrl: 'https://live.youinsh.com/livestream/qiniulogin',
  centerUrl: 'https://live.pili-live.com/livestream/center',

  loginWaitMinutes: 6,
  navigationTimeout: 30000,
  downloadTimeout: 120000,
  videoDownloadTimeout: 600000,
  videoFileReadyTimeout: 600000,
  multipartUploadThreshold: 20 * 1024 * 1024,
  /** 飞书媒体上传：单次请求超时、重试次数；并发最低 3，可用 FEISHU_UPLOAD_CONCURRENCY 调高 */
  feishuUploadTimeoutMs: 600_000,
  feishuUploadRetries: 5,
  feishuUploadConcurrencyMin: FEISHU_UPLOAD_CONCURRENCY_MIN,
  feishuUploadConcurrency: resolveFeishuUploadConcurrency(),
  /** 上传飞书前将单场 MP3 按秒切分（默认 1 小时一段） */
  audioSegmentSeconds: 3600,

  downloadDir: path.join(__dirname, 'downloads'),
  videoDownloadDir: path.join(__dirname, 'downloads', 'videos'),
  audioDownloadDir: path.join(__dirname, 'downloads', 'audio'),
  screenshotDir: path.join(__dirname, 'screenshots'),
  userDataDir: resolveUserDataDir(),

  chromePath: resolveChromePath(),
  ffmpegPath: resolveFfmpegPath(),
};
