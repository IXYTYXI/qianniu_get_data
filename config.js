const path = require('path');
const { resolveChromePath, resolveFfmpegPath } = require('./utils');

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
  userDataDir: path.join(__dirname, '.chrome-profile'),

  chromePath: resolveChromePath(),
  ffmpegPath: resolveFfmpegPath(),
};
