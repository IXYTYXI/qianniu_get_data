const path = require('path');

module.exports = {
  loginUrl: 'https://live.youinsh.com/livestream/qiniulogin',
  centerUrl: 'https://live.pili-live.com/livestream/center',

  loginWaitMinutes: 6,
  navigationTimeout: 30000,
  downloadTimeout: 120000,

  downloadDir: path.join(__dirname, 'downloads'),
  screenshotDir: path.join(__dirname, 'screenshots'),
  userDataDir: path.join(__dirname, '.chrome-profile'),

  chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
};
