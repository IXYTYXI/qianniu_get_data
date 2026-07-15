#!/usr/bin/env node
/**
 * 清理小学弹幕多余字段，添加序号，并按日期回填序号
 */
const { execFileSync } = require('child_process');
const { loadFeishuConfig } = require('./feishu');
const { getLarkCliBin } = require('./utils');

const TABLE_ID = 'tbloJQVbuZ6jtCo4';
const FIELDS_TO_DELETE = ['文本', '单选', '附件', '日期', '引用消息', '引用用户ID', '引用用户名称'];

function runLarkCli(args) {
  const env = {
    ...process.env,
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
  };
  return JSON.parse(execFileSync(getLarkCliBin(), args, { env, encoding: 'utf8', shell: process.platform === 'win32' }));
}

function listAllRecords(baseToken, tableId) {
  const records = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const result = runLarkCli([
      'base', '+record-list',
      '--base-token', baseToken,
      '--table-id', tableId,
      '--as', 'user',
      '--format', 'json',
      '--limit', String(limit),
      '--offset', String(offset),
      '--sort-json', JSON.stringify([{ field: '时间', desc: false }]),
    ]);
    const data = result.data;
    for (let i = 0; i < data.record_id_list.length; i++) {
      const row = data.data[i];
      const fields = data.fields;
      const record = { id: data.record_id_list[i] };
      fields.forEach((name, idx) => { record[name] = row[idx]; });
      records.push(record);
    }
    if (!data.has_more || data.record_id_list.length === 0) break;
    offset += data.record_id_list.length;
  }
  return records;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function upsertWithRetry(baseToken, tableId, recordId, patch, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return runLarkCli([
        'base', '+record-upsert',
        '--base-token', baseToken,
        '--table-id', tableId,
        '--record-id', recordId,
        '--json', JSON.stringify(patch),
        '--as', 'user',
        '--format', 'json',
      ]);
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(1000);
    }
  }
}

function extractDate(timeStr) {
  if (!timeStr) return 'unknown';
  const m = String(timeStr).match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : 'unknown';
}

async function main() {
  const seqOnly = process.argv.includes('--seq-only');
  const config = loadFeishuConfig();
  const baseToken = config.baseToken;

  if (!seqOnly) {
    console.log('=== 1. 删除多余字段 ===');
  for (const name of FIELDS_TO_DELETE) {
    try {
      runLarkCli([
        'base', '+field-delete',
        '--base-token', baseToken,
        '--table-id', TABLE_ID,
        '--field-id', name,
        '--as', 'user',
        '--format', 'json',
        '--yes',
      ]);
      console.log(`  已删除: ${name}`);
      await new Promise((r) => setTimeout(r, 800));
    } catch (e) {
      console.log(`  跳过: ${name} (${e.message?.slice(0, 60)})`);
    }
  }
  }

  console.log('\n=== 2. 创建序号字段 ===');
  const fields = runLarkCli([
    'base', '+field-list',
    '--base-token', baseToken,
    '--table-id', TABLE_ID,
    '--as', 'user',
    '--format', 'json',
  ]).data.fields;

  if (!fields.some((f) => f.name === '序号')) {
    runLarkCli([
      'base', '+field-create',
      '--base-token', baseToken,
      '--table-id', TABLE_ID,
      '--json', JSON.stringify({ name: '序号', type: 'number' }),
      '--as', 'user',
      '--format', 'json',
    ]);
    console.log('  已创建: 序号');
  } else {
    console.log('  序号字段已存在');
  }

  console.log('\n=== 3. 按日期回填序号 ===');
  const records = listAllRecords(baseToken, TABLE_ID);
  console.log(`  共 ${records.length} 条记录`);

  const byDate = {};
  for (const rec of records) {
    const date = extractDate(rec['时间']);
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(rec);
  }

  let updated = 0;
  for (const [date, group] of Object.entries(byDate)) {
    group.sort((a, b) => String(a['时间']).localeCompare(String(b['时间'])));
    for (let i = 0; i < group.length; i++) {
      await upsertWithRetry(baseToken, TABLE_ID, group[i].id, { 序号: i + 1 });
      updated++;
      if (updated % 100 === 0) console.log(`  已更新 ${updated}/${records.length}`);
    }
    console.log(`  ${date}: 序号 1 ~ ${group.length}`);
  }

  console.log(`\n完成，共更新 ${updated} 条序号`);
}

main().catch((e) => {
  console.error('错误:', e.message);
  process.exit(1);
});
