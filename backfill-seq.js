#!/usr/bin/env node
/**
 * 清理小学弹幕多余字段，添加序号，并按日期回填序号
 */
const { loadFeishuConfig } = require('./feishu');
const api = require('./feishu-api');

const TABLE_ID = 'tbloJQVbuZ6jtCo4';
const FIELDS_TO_DELETE = ['文本', '单选', '附件', '日期', '引用消息', '引用用户ID', '引用用户名称'];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function listAllRecords(appToken, tableId) {
  const records = [];
  let pageToken;
  do {
    const data = await api.listRecords(appToken, tableId, { pageToken });
    for (const item of data.items || []) {
      records.push({
        id: item.record_id,
        ...item.fields,
      });
    }
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);
  return records;
}

async function upsertWithRetry(appToken, tableId, recordId, patch, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await api.updateRecord(appToken, tableId, recordId, patch);
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
  const appToken = config.baseToken;

  if (!seqOnly) {
    console.log('=== 1. 删除多余字段 ===');
    const fields = await api.listTableFields(appToken, TABLE_ID);
    for (const name of FIELDS_TO_DELETE) {
      const field = fields.find((f) => f.field_name === name);
      if (!field) {
        console.log(`  跳过: ${name} (不存在)`);
        continue;
      }
      try {
        await api.deleteField(appToken, TABLE_ID, field.field_id);
        console.log(`  已删除: ${name}`);
        await sleep(800);
      } catch (e) {
        console.log(`  跳过: ${name} (${e.message?.slice(0, 60)})`);
      }
    }
  }

  console.log('\n=== 2. 创建序号字段 ===');
  const fields = await api.listTableFields(appToken, TABLE_ID);
  if (!fields.some((f) => f.field_name === '序号')) {
    await api.createField(appToken, TABLE_ID, '序号', 'number');
    console.log('  已创建: 序号');
  } else {
    console.log('  序号字段已存在');
  }

  console.log('\n=== 3. 按日期回填序号 ===');
  const records = await listAllRecords(appToken, TABLE_ID);
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
      await upsertWithRetry(appToken, TABLE_ID, group[i].id, { 序号: i + 1 });
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
