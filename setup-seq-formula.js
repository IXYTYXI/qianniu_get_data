#!/usr/bin/env node
/**
 * 将三张弹幕表的「序号」改为按日期自动编号的公式字段
 */
const { loadFeishuConfig } = require('./feishu');
const api = require('./feishu-api');

const SEQ_FIELD = '序号';

function buildDailySeqFormula(tableName) {
  return `IF(ISBLANK([时间]),"",${tableName}.FILTER(LEFT(CurrentValue.[时间],10)=LEFT([时间],10)&&CurrentValue.[时间]<=[时间]).[时间].COUNTA())`;
}

async function ensureDailySeqField(appToken, tableId, tableName) {
  const existing = await api.listTableFields(appToken, tableId);
  const seqField = existing.find((f) => f.field_name === SEQ_FIELD);

  if (seqField?.type === 20) {
    console.log(`  ${tableName}: 已是公式序号，跳过`);
    return;
  }

  if (seqField) {
    await api.deleteField(appToken, tableId, seqField.field_id);
    console.log(`  ${tableName}: 已删除旧数字序号字段`);
  }

  await api.createField(appToken, tableId, SEQ_FIELD, 'formula', {
    formula_expression: buildDailySeqFormula(tableName),
  });
  console.log(`  ${tableName}: 已创建公式序号（按日期自动 1、2、3...）`);
}

async function main() {
  const config = loadFeishuConfig();
  console.log('=== 配置弹幕表公式序号 ===\n');
  for (const table of Object.values(config.tables)) {
    await ensureDailySeqField(config.baseToken, table.tableId, table.name);
  }
  console.log('\n完成。飞书将按「时间」字段每天自动从 1 编号。');
}

main().catch((err) => {
  console.error('错误:', err.message);
  process.exit(1);
});
