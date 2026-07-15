const path = require('path');
const { resolveChromePath } = require('./utils');

module.exports = {
  loginUrl: 'https://live.youinsh.com/livestream/qiniulogin',
  centerUrl: 'https://live.pili-live.com/livestream/center',

  loginWaitMinutes: 6,
  navigationTimeout: 30000,
  downloadTimeout: 120000,

  downloadDir: path.join(__dirname, 'downloads'),
  screenshotDir: path.join(__dirname, 'screenshots'),
  userDataDir: path.join(__dirname, '.chrome-profile'),

  // 支持 CHROME_PATH 环境变量；Mac/Windows 自动探测常见安装路径
  chromePath: resolveChromePath(),
};
