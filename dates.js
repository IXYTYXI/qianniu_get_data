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

function getWeekDatesUTC8() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const sh = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const dow = sh.getDay();
  const toMon = dow === 0 ? -6 : 1 - dow;
  const dates = [];
  for (let i = toMon; i <= 0; i += 1) {
    dates.push(fmt.format(new Date(Date.now() + i * 86400000)));
  }
  return dates;
}

/** 含起止日的连续日期列表（东八区 YYYY-MM-DD） */
function getDatesBetween(startDate, endDate) {
  const dates = [];
  let cur = startDate;
  while (cur <= endDate) {
    dates.push(cur);
    cur = addDaysToDateStr(cur, 1);
  }
  return dates;
}

function addDaysToDateStr(dateStr, days) {
  const match = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateStr;
  const base = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00+08:00`);
  base.setDate(base.getDate() + days);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(base);
}

/** 直播中心日期筛选：目标日 00:00:00 ～ 次日 23:59:59（东八区） */
function buildCenterFilterRange(targetDate) {
  const nextDay = addDaysToDateStr(targetDate, 1);
  return {
    start: `${targetDate} 00:00:00`,
    end: `${nextDay} 23:59:59`,
  };
}

function resolveTargetDate(dateArg) {
  if (dateArg === 'yesterday') return getYesterdayUTC8();
  if (dateArg === 'today') return getTodayUTC8();
  if (dateArg === 'day-before-yesterday' || dateArg === '前天') return getDateUTC8(-2);
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
      case '--skip-transcode-wait': options.skipTranscodeWait = true; break;
    }
  }
  return options;
}

module.exports = {
  getDateUTC8,
  getYesterdayUTC8,
  getTodayUTC8,
  getWeekDatesUTC8,
  getDatesBetween,
  getMonthUTC8,
  addDaysToDateStr,
  buildCenterFilterRange,
  resolveTargetDate,
  parseCliArgs,
};
