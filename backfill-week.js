#!/usr/bin/env node
/**
 * 补跑：单浏览器会话，逐日弹幕 + 音频
 *
 * 用法:
 *   node backfill-week.js --skip-login
 *   node backfill-week.js --from 2026-07-27 --to 2026-08-02 --skip-login
 *   node backfill-week.js --date 2026-07-28 --date 2026-07-29
 *
 * 默认（无 --date/--from）：本周一至今天（周一当天只有 1 天，补缺失日期请用 --from/--to）
 */

const config = require('./config');
const {
  parseCliArgs,
  getWeekDatesUTC8,
  getDatesBetween,
  getTodayUTC8,
  resolveTargetDate,
} = require('./dates');
const { launchBrowser, waitForLogin, printBanner } = require('./browser');
const { QianniuDownloader } = require('./index');
const { processLivesPipeline } = require('./task-audio');

function parseDates(argv) {
  const explicit = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date' && argv[i + 1]) {
      explicit.push(resolveTargetDate(argv[++i]));
    }
  }
  if (explicit.length) return explicit;

  let fromDate;
  let toDate;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from' && argv[i + 1]) fromDate = resolveTargetDate(argv[++i]);
    if (argv[i] === '--to' && argv[i + 1]) toDate = resolveTargetDate(argv[++i]);
  }
  if (fromDate) {
    return getDatesBetween(fromDate, toDate || getTodayUTC8());
  }

  return getWeekDatesUTC8();
}

function parseOptions(argv) {
  return parseCliArgs(argv, {
    skipLogin: false,
    waitMinutes: config.loginWaitMinutes,
    allowTranscodingSkip: true,
    continueOnError: true,
  });
}

function summarizeAudio(audioResult) {
  const results = audioResult.downloadResults || [];
  const skipped = results.filter((d) => d.status === 'skipped_uploaded').length;
  const downloaded = results.filter((d) => d.status === 'downloaded').length;
  const transcoding = results.filter((d) => d.status === 'transcoding' || d.status === 'not_ready').length;
  const uploaded = (audioResult.uploadSummary || []).filter((s) => s.status === 'success').length;

  if (uploaded > 0) return `上传 ${uploaded} 场`;
  if (skipped > 0 && downloaded === 0 && transcoding === 0) return `已齐全，跳过 ${skipped} 场`;
  if (downloaded > 0) return `下载 ${downloaded} 场`;
  if (transcoding > 0) return `转码中 ${transcoding} 场，待重跑`;
  if (results.length === 0) return '无直播';
  return '无/跳过';
}

async function main() {
  const argv = process.argv.slice(2);
  const options = parseOptions(argv);
  const dates = parseDates(argv);

  printBanner('补跑（单浏览器会话）', `${dates[0]} ~ ${dates[dates.length - 1]}`);
  console.log(`共 ${dates.length} 天: ${dates.join(', ')}`);
  if (dates.length === 1 && !argv.includes('--date') && !argv.includes('--from')) {
    console.log('提示: 默认仅「本周一至今天」；补多天请用 --from YYYY-MM-DD --to YYYY-MM-DD\n');
  } else {
    console.log('');
  }

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

      let barrageText = '-';
      let audioText = '-';

      try {
        console.log(`--- [${targetDate}] 弹幕 ---`);
        const barrage = new QianniuDownloader({
          date: targetDate,
          mode: 'barrage-task',
          skipLogin: true,
          context,
          page,
        });
        const barrageResult = await barrage.runCore({ manageSession: false });
        barrageText = barrageResult.ok ? `${barrageResult.liveCount || 0} 场` : '失败';
      } catch (err) {
        barrageText = `失败: ${err.message}`;
        console.error(`弹幕失败 (${targetDate}):`, err.message);
        if (!options.continueOnError) throw err;
      }

      try {
        console.log(`\n--- [${targetDate}] 音频 ---`);
        const audioResult = await processLivesPipeline(
          { ...options, skipLogin: true, keepBrowser: true, allowTranscodingSkip: true },
          targetDate,
          { context, page }
        );
        audioText = summarizeAudio(audioResult);
      } catch (err) {
        audioText = `失败: ${err.message}`;
        console.error(`音频失败 (${targetDate}):`, err.message);
        if (!options.continueOnError) throw err;
      }

      summary.push({ date: targetDate, barrage: barrageText, audio: audioText });
    }
  } finally {
    console.log('\n关闭浏览器...');
    await context.close().catch(() => {});
  }

  console.log('\n=== 补跑摘要 ===');
  for (const item of summary) {
    console.log(`  ${item.date}: 弹幕 ${item.barrage} | 音频 ${item.audio}`);
  }
  console.log('EXIT_CODE: 0');
}

main().catch((err) => {
  console.error('执行失败:', err.message);
  process.exit(1);
});
