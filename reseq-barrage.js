#!/usr/bin/env node
/**
 * 按日期重置弹幕序号（每天从 1 开始）
 * 用法: node reseq-barrage.js --date 2026-07-15
 */
const { loadFeishuConfig, resequenceRecordsForDate } = require('./feishu');
const { resolveTargetDate, parseCliArgs } = require('./dates');

async function main() {
  const options = parseCliArgs(process.argv.slice(2), { date: 'yesterday' });
  const targetDate = resolveTargetDate(options.date);
  const config = loadFeishuConfig();

  console.log(`=== 重置弹幕序号: ${targetDate} ===\n`);

  for (const [school, table] of Object.entries(config.tables)) {
    console.log(`${school} → ${table.name}`);
    await resequenceRecordsForDate(config.baseToken, table.tableId, targetDate);
  }

  console.log('\n完成');
}

main().catch((err) => {
  console.error('错误:', err.message);
  process.exit(1);
});
