#!/usr/bin/env node
/**
 * 本周补跑：只打开一次浏览器，逐日执行弹幕 + 音频
 *
 * 用法:
 *   node backfill-week.js
 *   node backfill-week.js --skip-login
 *   node backfill-week.js --date 2026-07-28 --date 2026-07-29
 */

const config = require('./config');
const { parseCliArgs, getWeekDatesUTC8, resolveTargetDate } = require('./dates');
const { launchBrowser, waitForLogin, printBanner } = require('./browser');
const { QianniuDownloader } = require('./index');
const { processLivesPipeline } = require('./task-audio');

function parseDates(argv) {
  const dates = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date' && argv[i + 1]) {
      dates.push(resolveTargetDate(argv[++i]));
    }
  }
  return dates.length ? dates : getWeekDatesUTC8();
}

function parseOptions(argv) {
  return parseCliArgs(argv, {
    skipLogin: false,
    waitMinutes: config.loginWaitMinutes,
    allowTranscodingSkip: true,
    continueOnError: true,
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const options = parseOptions(argv);
  const dates = parseDates(argv);

  printBanner('本周补跑（单浏览器会话）', `${dates[0]} ~ ${dates[dates.length - 1]}`);
  console.log(`共 ${dates.length} 天: ${dates.join(', ')}\n`);

  const { context, page } = await launchBrowser();
  const summary = [];

  try {
    const loggedIn = await waitForLogin(page, options);
    if (!loggedIn) {
      console.error('未登录，任务终止');
      process.exit(1);
    }

    for (const targetDate of dates) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`日期: ${targetDate}`);
      console.log(`${'='.repeat(60)}\n`);

      console.log(`--- [${targetDate}] 弹幕 ---`);
      const barrage = new QianniuDownloader({
        date: targetDate,
        mode: 'barrage-task',
        skipLogin: true,
        context,
        page,
      });
      const barrageResult = await barrage.runCore({ manageSession: false });
      summary.push({
        date: targetDate,
        barrage: barrageResult.ok ? `${barrageResult.liveCount || 0} 场` : '失败',
      });

      console.log(`\n--- [${targetDate}] 音频 ---`);
      const audioResult = await processLivesPipeline(
        { ...options, skipLogin: true, keepBrowser: true, allowTranscodingSkip: true },
        targetDate,
        { context, page }
      );
      const last = summary[summary.length - 1];
      last.audio = audioResult.videoCount > 0
        ? `下载 ${audioResult.videoCount} 场`
        : (audioResult.downloadResults?.some((d) => d.status === 'transcoding')
          ? '转码中，待重跑'
          : '无/跳过');
    }
  } finally {
    console.log('\n关闭浏览器...');
    await context.close().catch(() => {});
  }

  console.log('\n=== 本周补跑摘要 ===');
  for (const item of summary) {
    console.log(`  ${item.date}: 弹幕 ${item.barrage} | 音频 ${item.audio || '-'}`);
  }
  console.log('EXIT_CODE: 0');
}

main().catch((err) => {
  console.error('执行失败:', err.message);
  process.exit(1);
});
