function getDateUTC8(offsetDays = 0) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const adjusted = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return formatter.format(adjusted);
}

function getYesterdayUTC8() {
  return getDateUTC8(-1);
}

function getTodayUTC8() {
  return getDateUTC8(0);
}

function getMonthUTC8(dateStr) {
  const m = String(dateStr).match(/(\d{4}-\d{2})/);
  return m ? m[1] : getDateUTC8(0).slice(0, 7);
}

function resolveTargetDate(dateArg) {
  if (dateArg === 'yesterday') return getYesterdayUTC8();
  if (dateArg === 'today') return getTodayUTC8();
  return dateArg;
}

function parseCliArgs(argv, defaults = {}) {
  const options = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--date': options.date = argv[++i]; break;
      case '--skip-login': options.skipLogin = true; break;
      case '--wait': options.waitMinutes = parseInt(argv[++i], 10); break;
      case '--keep-browser': options.keepBrowser = true; break;
      case '--upload-only': options.uploadOnly = true; break;
      case '--audio-only': options.audioOnly = true; break;
    }
  }
  return options;
}

module.exports = {
  getDateUTC8,
  getYesterdayUTC8,
  getTodayUTC8,
  getMonthUTC8,
  resolveTargetDate,
  parseCliArgs,
};
