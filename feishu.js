const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { getLarkCliBin } = require('./utils');

const FEISHU_CONFIG_PATH = path.join(__dirname, 'feishu.config.json');
const BATCH_SIZE = 200;
const SKIP_IMPORT_COLUMNS = new Set(['引用用户ID', '引用用户名称', '引用消息']);
const SEQ_FIELD = '序号';

function loadFeishuConfig() {
  if (!fs.existsSync(FEISHU_CONFIG_PATH)) {
    const example = path.join(__dirname, 'feishu.config.example.json');
    throw new Error(
      `缺少飞书配置: ${FEISHU_CONFIG_PATH}\n请复制 ${example} 为 feishu.config.json 并填写 baseToken`
    );
  }
  return JSON.parse(fs.readFileSync(FEISHU_CONFIG_PATH, 'utf8'));
}

function detectSchoolLevel(text) {
  if (text.includes('【小学】') || text.includes('小学')) return '小学';
  if (text.includes('【初中】') || text.includes('初中')) return '初中';
  if (text.includes('【高中】') || text.includes('高中')) return '高中';
  return null;
}

function runLarkCli(args) {
  const env = {
    ...process.env,
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
  };
  const output = execFileSync(getLarkCliBin(), args, { env, encoding: 'utf8', shell: process.platform === 'win32' });
  return JSON.parse(output);
}

function listTableFields(baseToken, tableId) {
  const result = runLarkCli([
    'base', '+field-list',
    '--base-token', baseToken,
    '--table-id', tableId,
    '--as', 'user',
    '--format', 'json',
  ]);
  return result.data?.fields || result.fields || [];
}

function createTextField(baseToken, tableId, fieldName) {
  runLarkCli([
    'base', '+field-create',
    '--base-token', baseToken,
    '--table-id', tableId,
    '--json', JSON.stringify({ name: fieldName, type: 'text' }),
    '--as', 'user',
    '--format', 'json',
  ]);
}

function ensureFields(baseToken, tableId, headers) {
  const existing = listTableFields(baseToken, tableId);
  const existingNames = new Set(
    existing
      .filter((f) => f.type !== 'auto_number' && !f.is_primary)
      .map((f) => f.name)
  );

  for (const header of headers) {
    if (!header || existingNames.has(header)) continue;
    console.log(`  创建字段: ${header}`);
    createTextField(baseToken, tableId, header);
    existingNames.add(header);
  }
}

function extractDate(timeStr) {
  if (!timeStr) return 'unknown';
  const m = String(timeStr).match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : 'unknown';
}

function getMaxSeqForDate(baseToken, tableId, date) {
  try {
    const result = runLarkCli([
      'base', '+record-search',
      '--base-token', baseToken,
      '--table-id', tableId,
      '--json', JSON.stringify({
        filter: {
          conjunction: 'and',
          conditions: [{
            field_name: '时间',
            operator: 'contains',
            value: [date],
          }],
        },
        field_names: [SEQ_FIELD],
      }),
      '--as', 'user',
      '--format', 'json',
    ]);
    const records = result.data?.items || result.data?.records || [];
    let max = 0;
    for (const rec of records) {
      const fields = rec.fields || rec;
      const seq = Number(fields[SEQ_FIELD]);
      if (!Number.isNaN(seq) && seq > max) max = seq;
    }
    return max;
  } catch {
    return 0;
  }
}

function ensureSeqField(baseToken, tableId) {
  const existing = listTableFields(baseToken, tableId);
  if (existing.some((f) => f.name === SEQ_FIELD)) return;
  runLarkCli([
    'base', '+field-create',
    '--base-token', baseToken,
    '--table-id', tableId,
    '--json', JSON.stringify({ name: SEQ_FIELD, type: 'number' }),
    '--as', 'user',
    '--format', 'json',
  ]);
  console.log(`  创建字段: ${SEQ_FIELD}`);
}

function buildImportRows(headers, dataRows, baseToken, tableId) {
  const timeIdx = headers.indexOf('时间');
  const filteredHeaders = headers.filter((h) => h && !SKIP_IMPORT_COLUMNS.has(h));
  const importHeaders = [SEQ_FIELD, ...filteredHeaders];

  const dateGroups = {};
  for (const row of dataRows) {
    const date = timeIdx >= 0 ? extractDate(row[timeIdx]) : 'unknown';
    if (!dateGroups[date]) dateGroups[date] = [];
    dateGroups[date].push(row);
  }

  const allRows = [];
  for (const [date, rows] of Object.entries(dateGroups)) {
    let seq = getMaxSeqForDate(baseToken, tableId, date);
    for (const row of rows) {
      seq += 1;
      const values = filteredHeaders.map((h) => {
        const idx = headers.indexOf(h);
        const val = row[idx];
        if (val == null || String(val).trim() === '') return null;
        return String(val);
      });
      allRows.push([seq, ...values]);
    }
    console.log(`  日期 ${date}: 序号 ${seq - rows.length + 1} ~ ${seq}`);
  }

  return { importHeaders, allRows };
}

function readXlsx(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  if (!rows.length) return { headers: [], dataRows: [] };

  const headers = rows[0].map((h) => (h == null ? '' : String(h).trim()));
  const dataRows = rows.slice(1).filter((row) => row.some((cell) => cell != null && String(cell).trim() !== ''));
  return { headers, dataRows };
}

function batchCreateRecords(baseToken, tableId, headers, dataRows) {
  for (let i = 0; i < dataRows.length; i += BATCH_SIZE) {
    const chunk = dataRows.slice(i, i + BATCH_SIZE);
    const rows = chunk.map((row) =>
      headers.map((_, idx) => {
        const val = row[idx];
        if (val == null || String(val).trim() === '') return null;
        return String(val);
      })
    );

    runLarkCli([
      'base', '+record-batch-create',
      '--base-token', baseToken,
      '--table-id', tableId,
      '--json', JSON.stringify({ fields: headers, rows }),
      '--as', 'user',
      '--format', 'json',
    ]);
    console.log(`  已写入 ${Math.min(i + BATCH_SIZE, dataRows.length)}/${dataRows.length} 条`);
  }
}

async function importBarrageToFeishu(filePath, hintText = '') {
  const config = loadFeishuConfig();
  const filename = path.basename(filePath);
  const school = detectSchoolLevel(`${hintText} ${filename}`);
  if (!school) {
    throw new Error(`无法识别学段: ${filename}`);
  }

  const table = config.tables[school];
  if (!table) {
    throw new Error(`未配置学段表: ${school}`);
  }

  console.log(`\n导入飞书: ${filename} → ${table.name}`);
  const { headers, dataRows } = readXlsx(filePath);
  if (!headers.length || !dataRows.length) {
    throw new Error(`xlsx 为空: ${filename}`);
  }

  const writableHeaders = headers.filter((h) => h && !SKIP_IMPORT_COLUMNS.has(h));
  ensureFields(config.baseToken, table.tableId, writableHeaders);
  ensureSeqField(config.baseToken, table.tableId);

  const { importHeaders, allRows } = buildImportRows(headers, dataRows, config.baseToken, table.tableId);
  batchCreateRecords(config.baseToken, table.tableId, importHeaders, allRows);

  fs.unlinkSync(filePath);
  console.log(`  导入完成，已删除本地文件: ${filename}`);
  return { school, table: table.name, rows: dataRows.length };
}

module.exports = {
  loadFeishuConfig,
  detectSchoolLevel,
  importBarrageToFeishu,
};
