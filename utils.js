const fs = require('fs');
const path = require('path');

const CHROME_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ],
  win32: [
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean),
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ],
};

function resolveChromePath(customPath) {
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }

  const envPath = process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const candidates = CHROME_CANDIDATES[process.platform] || [];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] || null;
}

function getLarkCliBin() {
  return process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli';
}

const FFMPEG_CANDIDATES = {
  darwin: ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'],
  win32: ['C:\\ffmpeg\\bin\\ffmpeg.exe'],
  linux: ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'],
};

function resolveFfmpegPath(customPath) {
  if (customPath && fs.existsSync(customPath)) return customPath;
  const envPath = process.env.FFMPEG_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const candidates = FFMPEG_CANDIDATES[process.platform] || [];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'ffmpeg';
}

module.exports = {
  resolveChromePath,
  resolveFfmpegPath,
  getLarkCliBin,
};
