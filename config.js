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

module.exports = {
  loginUrl: 'https://live.youinsh.com/livestream/qiniulogin',
  centerUrl: 'https://live.pili-live.com/livestream/center',

  loginWaitMinutes: 6,
  navigationTimeout: 30000,
  downloadTimeout: 120000,
  videoDownloadTimeout: 600000,
  videoFileReadyTimeout: 600000,
  multipartUploadThreshold: 20 * 1024 * 1024,

  downloadDir: path.join(__dirname, 'downloads'),
  videoDownloadDir: path.join(__dirname, 'downloads', 'videos'),
  audioDownloadDir: path.join(__dirname, 'downloads', 'audio'),
  screenshotDir: path.join(__dirname, 'screenshots'),
  userDataDir: resolveUserDataDir(),

  chromePath: resolveChromePath(),
  ffmpegPath: resolveFfmpegPath(),
};
