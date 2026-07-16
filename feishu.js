const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const appConfig = require('./config');
const api = require('./feishu-api');

const FEISHU_CONFIG_PATH = path.join(__dirname, 'feishu.config.json');
const BATCH_SIZE = 200;
const SKIP_IMPORT_COLUMNS = new Set(['引用用户ID', '引用用户名称', '引用消息']);
const SEQ_FIELD = '序号';

const VIDEO_TABLE_NAME = '直播视频';
const VIDEO_TABLE_FIELDS = [
  { name: '名称', type: 'text' },
  { name: '日期', type: 'text' },
  { name: '视频', type: 'attachment' },
];

function loadFeishuConfig() {
  if (!fs.existsSync(FEISHU_CONFIG_PATH)) {
    const example = path.join(__dirname, 'feishu.config.example.json');
    throw new Error(
      `缺少飞书配置: ${FEISHU_CONFIG_PATH}\n请复制 ${example} 为 feishu.config.json 并填写 baseToken`
    );
  }
  api.getAppCredentials();
  return JSON.parse(fs.readFileSync(FEISHU_CONFIG_PATH, 'utf8'));
}

function detectSchoolLevel(text) {
  if (text.includes('【小学】') || text.includes('小学')) return '小学';
  if (text.includes('【初中】') || text.includes('初中')) return '初中';
  if (text.includes('【高中】') || text.includes('高中')) return '高中';
  return null;
}

async function ensureFields(appToken, tableId, headers) {
  const existing = await api.listTableFields(appToken, tableId);
  const existingNames = new Set(
    existing
      .filter((f) => f.type !== 1005 && !f.is_primary)
      .map((f) => f.field_name)
  );

  for (const header of headers) {
    if (!header || existingNames.has(header)) continue;
    console.log(`  创建字段: ${header}`);
    await api.createField(appToken, tableId, header, 'text');
    existingNames.add(header);
  }
}

function extractDate(timeStr) {
  if (!timeStr) return 'unknown';
  const m = String(timeStr).match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : 'unknown';
}

async function getMaxSeqForDate(appToken, tableId, date) {
  try {
    const items = await api.searchRecords(appToken, tableId, {
      filter: {
        conjunction: 'and',
        conditions: [{
          field_name: '时间',
          operator: 'contains',
          value: [date],
        }],
      },
      field_names: [SEQ_FIELD],
      page_size: 200,
    });
    let max = 0;
    for (const item of items) {
      const seq = Number(item.fields?.[SEQ_FIELD]);
      if (!Number.isNaN(seq) && seq > max) max = seq;
    }
    return max;
  } catch {
    return 0;
  }
}

async function ensureSeqField(appToken, tableId) {
  const existing = await api.listTableFields(appToken, tableId);
  if (existing.some((f) => f.field_name === SEQ_FIELD)) return;
  await api.createField(appToken, tableId, SEQ_FIELD, 'number');
  console.log(`  创建字段: ${SEQ_FIELD}`);
}

async function buildImportRows(headers, dataRows, appToken, tableId) {
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
    let seq = await getMaxSeqForDate(appToken, tableId, date);
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

function rowsToRecords(headers, dataRows) {
  return dataRows.map((row) => {
    const fields = {};
    headers.forEach((header, idx) => {
      const val = row[idx];
      if (val == null || String(val).trim() === '') return;
      if (header === SEQ_FIELD) {
        fields[header] = Number(val);
      } else {
        fields[header] = String(val);
      }
    });
    return { fields };
  });
}

async function batchCreateRecords(appToken, tableId, headers, dataRows) {
  for (let i = 0; i < dataRows.length; i += BATCH_SIZE) {
    const chunk = dataRows.slice(i, i + BATCH_SIZE);
    const records = rowsToRecords(headers, chunk);
    await api.batchCreateRecords(appToken, tableId, records);
    console.log(`  已写入 ${Math.min(i + BATCH_SIZE, dataRows.length)}/${dataRows.length} 条`);
  }
}

function saveVideoTableToConfig(tableId, tableName) {
  const config = loadFeishuConfig();
  config.videoTable = { name: tableName, tableId };
  fs.writeFileSync(FEISHU_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

async function ensureVideoTable(config) {
  const tableName = config.videoTable?.name || VIDEO_TABLE_NAME;
  const tables = await api.listTables(config.baseToken);

  if (config.videoTable?.tableId) {
    const byId = tables.find((t) => t.table_id === config.videoTable.tableId);
    if (byId) return config.videoTable.tableId;
  }

  const existing = tables.find((t) => t.name === tableName);
  if (existing) {
    const tableId = existing.table_id;
    if (!config.videoTable?.tableId) {
      saveVideoTableToConfig(tableId, tableName);
    }
    return tableId;
  }

  console.log(`创建视频表: ${tableName}`);
  const tableId = await api.createTable(config.baseToken, tableName, VIDEO_TABLE_FIELDS);
  if (!tableId) {
    throw new Error('创建视频表失败');
  }

  saveVideoTableToConfig(tableId, tableName);
  return tableId;
}

async function findVideoRecord(appToken, tableId, date, name) {
  try {
    const items = await api.searchRecords(appToken, tableId, {
      filter: {
        conjunction: 'and',
        conditions: [
          { field_name: '名称', operator: 'is', value: [name] },
          { field_name: '日期', operator: 'is', value: [date] },
        ],
      },
      field_names: ['日期', '名称', '音频', '视频'],
      page_size: 20,
    });
    return items[0] || null;
  } catch {
    return null;
  }
}

async function ensureAudioField(appToken, tableId) {
  const existing = await api.listTableFields(appToken, tableId);
  if (existing.some((f) => f.field_name === '音频')) return;
  await api.createField(appToken, tableId, '音频', 'attachment');
  console.log('  已创建字段: 音频');
}

async function uploadAttachmentToRecord({
  appToken, tableId, recordId, fieldName, filePath, label,
}) {
  const filename = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;
  const sizeMb = (fileSize / 1024 / 1024).toFixed(1);

  console.log(`\n上传飞书${label}: ${filename} (${sizeMb} MB)`);
  if (fileSize > appConfig.multipartUploadThreshold) {
    console.log('  文件超过 20MB，将自动分片上传');
  }
  console.log('  开始上传附件，请耐心等待...');
  await api.uploadAttachmentToField(appToken, tableId, recordId, fieldName, filePath);
  console.log('  附件上传完成');
}

async function uploadVideoToFeishu({ date, name, filePath }) {
  const config = loadFeishuConfig();
  const tableId = await ensureVideoTable(config);
  const filename = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;
  const sizeMb = (fileSize / 1024 / 1024).toFixed(1);

  console.log(`\n上传飞书视频: ${filename} → ${config.videoTable?.name || VIDEO_TABLE_NAME} (${sizeMb} MB)`);
  if (fileSize > 2 * 1024 * 1024 * 1024) {
    console.warn('  警告: 飞书附件单文件上限 2GB，超大文件可能上传失败');
  }

  const existing = await findVideoRecord(config.baseToken, tableId, date, name);
  if (existing) {
    const attachments = existing.fields?.['视频'] || [];
    if (Array.isArray(attachments) && attachments.length > 0) {
      console.log(`  已存在且已有视频附件，跳过: ${name}`);
      fs.unlinkSync(filePath);
      return { skipped: true, reason: 'already_uploaded' };
    }
  }

  let recordId = existing?.record_id;
  if (!recordId) {
    const record = await api.createRecord(config.baseToken, tableId, { 日期: date, 名称: name });
    recordId = record?.record_id;
    if (!recordId) {
      throw new Error('创建视频记录失败');
    }
    console.log(`  已创建记录: ${recordId}`);
  } else {
    console.log(`  复用已有记录: ${recordId}`);
  }

  await uploadAttachmentToRecord({
    appToken: config.baseToken,
    tableId,
    recordId,
    fieldName: '视频',
    filePath,
    label: '视频',
  });

  fs.unlinkSync(filePath);
  console.log(`  已删除本地文件: ${filename}`);
  return { uploaded: true, recordId, tableId };
}

async function uploadAudioToFeishu({ date, name, filePath }) {
  const config = loadFeishuConfig();
  const tableId = await ensureVideoTable(config);
  await ensureAudioField(config.baseToken, tableId);

  const existing = await findVideoRecord(config.baseToken, tableId, date, name);
  if (existing) {
    const attachments = existing.fields?.['音频'] || [];
    if (Array.isArray(attachments) && attachments.length > 0) {
      console.log(`  已存在且已有音频附件，跳过: ${name}`);
      return { skipped: true, reason: 'already_uploaded' };
    }
  }

  let recordId = existing?.record_id;
  if (!recordId) {
    const record = await api.createRecord(config.baseToken, tableId, { 日期: date, 名称: name });
    recordId = record?.record_id;
    if (!recordId) {
      throw new Error('创建记录失败');
    }
    console.log(`  已创建记录: ${recordId}`);
  } else {
    console.log(`  复用已有记录: ${recordId}`);
  }

  await uploadAttachmentToRecord({
    appToken: config.baseToken,
    tableId,
    recordId,
    fieldName: '音频',
    filePath,
    label: '音频',
  });

  return { uploaded: true, recordId, tableId };
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
  await ensureFields(config.baseToken, table.tableId, writableHeaders);
  await ensureSeqField(config.baseToken, table.tableId);

  const { importHeaders, allRows } = await buildImportRows(headers, dataRows, config.baseToken, table.tableId);
  await batchCreateRecords(config.baseToken, table.tableId, importHeaders, allRows);

  fs.unlinkSync(filePath);
  console.log(`  导入完成，已删除本地文件: ${filename}`);
  return { school, table: table.name, rows: dataRows.length };
}

module.exports = {
  loadFeishuConfig,
  detectSchoolLevel,
  importBarrageToFeishu,
  ensureVideoTable,
  uploadVideoToFeishu,
  uploadAudioToFeishu,
};
