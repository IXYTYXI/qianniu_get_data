const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const appConfig = require('./config');
const api = require('./feishu-api');
const { FIELD_TYPE } = api;
const {
  detectSchoolLevel,
  getSchoolTableKeys,
  describeSchoolMode,
  isMergeMiddleHigh,
} = require('./school-level');

const FEISHU_CONFIG_PATH = path.join(__dirname, 'feishu.config.json');
const BATCH_SIZE = 200;
const SKIP_IMPORT_COLUMNS = new Set(['引用用户ID', '引用用户名称', '引用消息']);
const SEQ_FIELD = '序号';
const LIVE_ID_FIELD = '直播ID';

const VIDEO_TABLE_NAME = '直播视频';
const VIDEO_TABLE_FIELDS = [
  { name: '名称', type: 'text' },
  { name: '日期', type: 'text' },
  { name: '视频', type: 'attachment' },
];

const BARRAGE_TABLE_DEFAULT_NAMES = {
  小学: '小学弹幕',
  初高: '初高弹幕',
  初中: '初中弹幕',
  高中: '高中弹幕',
};

const BARRAGE_TABLE_STARTER_FIELDS = [
  { name: '时间', type: 'text' },
  { name: '内容', type: 'text' },
  { name: '用户', type: 'text' },
];

const BARRAGE_CLONE_TEMPLATE_NAMES = ['初中弹幕', '高中弹幕', '小学弹幕'];

function loadFeishuConfig() {
  if (!fs.existsSync(FEISHU_CONFIG_PATH)) {
    const example = path.join(__dirname, 'feishu.config.example.json');
    throw new Error(
      `缺少飞书配置: ${FEISHU_CONFIG_PATH}\n请复制 ${example} 为 feishu.config.json 并填写 baseToken`
    );
  }
  api.getAppCredentials();
  const raw = fs.readFileSync(FEISHU_CONFIG_PATH, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `feishu.config.json 格式错误: ${e.message}\n请检查是否有多余字符、注释或粘贴了两份 JSON`
    );
  }
}

function collectExistingFieldNames(fields) {
  return new Set(
    fields
      .filter((f) => f.type !== 1005)
      .map((f) => f.field_name)
      .filter(Boolean)
  );
}

/** xlsx 表头 → 飞书实际字段名（大小写不一致时复用已有列） */
function resolveImportFieldMap(existingFields, headers) {
  const byLower = new Map();
  for (const f of existingFields) {
    if (!f.field_name) continue;
    byLower.set(f.field_name.toLowerCase(), f.field_name);
  }
  const map = {};
  for (const header of headers) {
    if (!header) continue;
    if (existingFields.some((f) => f.field_name === header)) {
      map[header] = header;
    } else if (byLower.has(header.toLowerCase())) {
      map[header] = byLower.get(header.toLowerCase());
    } else {
      map[header] = header;
    }
  }
  return map;
}

function monthFromDate(dateStr) {
  return String(dateStr).slice(0, 7);
}

function saveFeishuConfig(config) {
  fs.writeFileSync(FEISHU_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function normalizeSchoolTableSpecs(config) {
  const specs = {};
  for (const schoolKey of getSchoolTableKeys(config)) {
    const existing = config.tables?.[schoolKey];
    specs[schoolKey] = {
      name: existing?.name || BARRAGE_TABLE_DEFAULT_NAMES[schoolKey],
      tableId: existing?.tableId,
    };
  }
  return specs;
}

async function cloneBarrageTableFromTemplate(appToken, sourceTableId, tableName) {
  const tableId = await api.createTable(appToken, tableName, BARRAGE_TABLE_STARTER_FIELDS);
  const sourceFields = await api.listTableFields(appToken, sourceTableId);
  const targetFields = await api.listTableFields(appToken, tableId);
  const targetNames = new Set(targetFields.map((f) => f.field_name));

  for (const field of sourceFields) {
    if (field.is_primary || field.type === 1005) continue;
    if (field.field_name === SEQ_FIELD || field.type === FIELD_TYPE.formula) continue;
    if (targetNames.has(field.field_name)) continue;
    if (field.type !== FIELD_TYPE.text && field.type !== 1) continue;
    try {
      await api.createField(appToken, tableId, field.field_name, 'text');
      targetNames.add(field.field_name);
    } catch (e) {
      if (!/FieldNameDuplicated|1254014/.test(e.message)) throw e;
    }
  }

  await ensureDailySeqField(appToken, tableId, tableName);
  return tableId;
}

async function ensureSchoolTable(appToken, listedTables, schoolKey, spec) {
  const tableName = spec.name;

  if (spec.tableId) {
    const byId = listedTables.find((t) => t.table_id === spec.tableId);
    if (byId) return { name: byId.name, tableId: byId.table_id };
  }

  const byName = listedTables.find((t) => t.name === tableName);
  if (byName) {
    return { name: byName.name, tableId: byName.table_id };
  }

  console.log(`  Base 中无「${tableName}」，自动创建...`);
  let tableId;
  if (tableName === BARRAGE_TABLE_DEFAULT_NAMES.初高) {
    const template = listedTables.find((t) => BARRAGE_CLONE_TEMPLATE_NAMES.includes(t.name));
    if (template) {
      console.log(`  参考「${template.name}」结构创建「${tableName}」`);
      tableId = await cloneBarrageTableFromTemplate(appToken, template.table_id, tableName);
    } else {
      tableId = await api.createTable(appToken, tableName, BARRAGE_TABLE_STARTER_FIELDS);
      await ensureDailySeqField(appToken, tableId, tableName);
    }
  } else {
    tableId = await api.createTable(appToken, tableName, BARRAGE_TABLE_STARTER_FIELDS);
    await ensureDailySeqField(appToken, tableId, tableName);
  }

  if (!tableId) throw new Error(`创建弹幕表失败: ${tableName}`);
  listedTables.push({ name: tableName, table_id: tableId });
  return { name: tableName, tableId };
}

/**
 * 检测 Base 内各学段弹幕表 / 视频表：存在则复用 tableId，缺失则自动创建并回写配置。
 */
async function ensureFeishuTables(config) {
  if (!config?.baseToken) return config;

  const listedTables = await api.listTables(config.baseToken);
  const specs = normalizeSchoolTableSpecs(config);
  const mapped = { ...(config.tables || {}) };
  let changed = false;

  for (const [schoolKey, spec] of Object.entries(specs)) {
    const resolved = await ensureSchoolTable(config.baseToken, listedTables, schoolKey, spec);
    const prev = mapped[schoolKey];
    if (!prev || prev.tableId !== resolved.tableId || prev.name !== resolved.name) {
      mapped[schoolKey] = resolved;
      changed = true;
    }
  }

  const activeKeys = getSchoolTableKeys(config);
  for (const key of Object.keys(mapped)) {
    if (!activeKeys.includes(key)) {
      delete mapped[key];
      changed = true;
    }
  }

  const videoTableId = await ensureVideoTable({ ...config, tables: mapped });
  const videoTable = {
    name: config.videoTable?.name || VIDEO_TABLE_NAME,
    tableId: videoTableId,
  };
  if (config.videoTable?.tableId !== videoTableId) changed = true;

  if (!changed) return { ...config, tables: mapped, videoTable };

  const next = {
    ...config,
    tables: mapped,
    videoTable,
  };
  saveFeishuConfig(next);
  console.log('  已同步 feishu.config.json 中的 tableId');
  return next;
}

/**
 * 任务启动前确保飞书 Base 与表结构可用。
 * 始终使用 feishu.config.json 中的固定 baseToken，不按月份切换或新建 Base。
 */
async function ensureFeishuConfigForDate(targetDate) {
  const config = loadFeishuConfig();
  const neededMonth = monthFromDate(targetDate);
  if (config.month && config.month !== neededMonth) {
    console.log(`  目标日期 ${targetDate}（${neededMonth}），写入固定 Base: ${config.baseName || config.baseToken}`);
  }
  return ensureFeishuTables(config);
}

function extractLiveId(text) {
  if (!text) return null;
  return text.match(/(\d{6})(?=\d{4}-\d{2}-\d{2})/)?.[1]
    || text.match(/\b(\d{6})\b/)?.[1]
    || null;
}

async function ensureFields(appToken, tableId, headers) {
  const existing = await api.listTableFields(appToken, tableId);
  const existingNames = collectExistingFieldNames(existing);

  for (const header of headers) {
    if (!header || existingNames.has(header)) continue;
    const alias = [...existingNames].find(
      (name) => name.toLowerCase() === header.toLowerCase()
    );
    if (alias) continue;

    console.log(`  创建字段: ${header}`);
    try {
      await api.createField(appToken, tableId, header, 'text');
      existingNames.add(header);
    } catch (e) {
      if (/FieldNameDuplicated|1254014/.test(e.message)) {
        console.log(`  字段已存在，跳过: ${header}`);
        existingNames.add(header);
        continue;
      }
      throw e;
    }
  }
  return existing;
}

function extractDate(timeStr) {
  if (!timeStr) return 'unknown';
  const m = String(timeStr).match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : 'unknown';
}

async function scanRecords(appToken, tableId, predicate, label = '') {
  const matched = [];
  let pageToken;
  let pageNum = 0;
  let total;

  console.log(`  扫描表内记录${label ? `（${label}）` : ''}...`);

  do {
    pageNum += 1;
    const data = await api.listRecords(appToken, tableId, { pageSize: 500, pageToken });
    total = data.total;
    for (const item of data.items || []) {
      if (predicate(item)) matched.push(item);
    }
    if (pageNum === 1 || pageNum % 5 === 0 || !data.has_more) {
      console.log(`  已扫描 ${pageNum} 页 / 约 ${total ?? '?'} 条，匹配 ${matched.length} 条`);
    }
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);

  return matched;
}

async function listRecordsForDate(appToken, tableId, date) {
  return scanRecords(
    appToken,
    tableId,
    (item) => String(item.fields?.['时间'] || '').includes(date),
    date
  );
}

async function deleteRecordsForLiveAndDate(appToken, tableId, date, liveId) {
  const items = await scanRecords(
    appToken,
    tableId,
    (item) => String(item.fields?.['时间'] || '').includes(date)
      && String(item.fields?.['直播ID'] || '') === String(liveId),
    `${date} 直播 ${liveId}`
  );
  if (!items.length) return 0;
  const ids = items.map((item) => item.record_id).filter(Boolean);
  await api.batchDeleteRecords(appToken, tableId, ids);
  console.log(`  已清除 ${date} 直播 ${liveId} 旧记录 ${ids.length} 条`);
  return ids.length;
}

async function deleteRecordsForDate(appToken, tableId, date) {
  const items = await listRecordsForDate(appToken, tableId, date);
  if (!items.length) return 0;
  const ids = items.map((item) => item.record_id).filter(Boolean);
  await api.batchDeleteRecords(appToken, tableId, ids);
  console.log(`  已清除 ${date} 旧记录 ${ids.length} 条`);
  return ids.length;
}

async function resequenceRecordsForDate(appToken, tableId, date) {
  const items = await listRecordsForDate(appToken, tableId, date);
  if (!items.length) return 0;

  items.sort((a, b) => {
    const ta = String(a.fields?.['时间'] || '');
    const tb = String(b.fields?.['时间'] || '');
    return ta.localeCompare(tb);
  });

  const updates = [];
  for (let i = 0; i < items.length; i++) {
    const seq = i + 1;
    const current = Number(items[i].fields?.[SEQ_FIELD]);
    if (current === seq) continue;
    updates.push({
      record_id: items[i].record_id,
      fields: { [SEQ_FIELD]: seq },
    });
  }

  if (updates.length) {
    await api.batchUpdateRecords(appToken, tableId, updates);
    console.log(`  日期 ${date}: 已更新 ${updates.length} 条序号 → 1 ~ ${items.length}`);
  } else {
    console.log(`  日期 ${date}: 序号已是 1 ~ ${items.length}，无需更新`);
  }
  return items.length;
}

function buildDailySeqFormula(tableName) {
  // 同一天内按「时间」升序排名，每天从 1 重新开始
  return `IF(ISBLANK([时间]),"",${tableName}.FILTER(LEFT(CurrentValue.[时间],10)=LEFT([时间],10)&&CurrentValue.[时间]<=[时间]).[时间].COUNTA())`;
}

async function ensureDailySeqField(appToken, tableId, tableName) {
  const existing = await api.listTableFields(appToken, tableId);
  const seqField = existing.find((f) => f.field_name === SEQ_FIELD);

  if (seqField) {
    if (seqField.type === FIELD_TYPE.formula) return;
    console.log(`  序号字段已存在（文本/数字），跳过改为公式（避免 1254014）`);
    return;
  }

  const formula = buildDailySeqFormula(tableName);
  try {
    await api.createField(appToken, tableId, SEQ_FIELD, 'formula', {
      formula_expression: formula,
    });
    console.log(`  已创建公式字段「序号」（按日期自动编号）`);
  } catch (e) {
    if (/FieldNameDuplicated|1254014/.test(e.message)) {
      console.log(`  序号公式字段已存在，跳过`);
      return;
    }
    throw e;
  }
}

function buildImportRows(headers, dataRows, liveId) {
  const timeIdx = headers.indexOf('时间');
  const filteredHeaders = headers.filter(
    (h) => h && !SKIP_IMPORT_COLUMNS.has(h) && h !== SEQ_FIELD && h !== LIVE_ID_FIELD
  );
  const importHeaders = [...filteredHeaders];
  if (liveId) importHeaders.push(LIVE_ID_FIELD);

  const dateGroups = {};
  for (const row of dataRows) {
    const date = timeIdx >= 0 ? extractDate(row[timeIdx]) : 'unknown';
    if (!dateGroups[date]) dateGroups[date] = [];
    dateGroups[date].push(row);
  }

  const allRows = [];
  for (const [date, rows] of Object.entries(dateGroups)) {
    for (const row of rows) {
      const values = filteredHeaders.map((h) => {
        const idx = headers.indexOf(h);
        const val = row[idx];
        if (val == null || String(val).trim() === '') return null;
        return String(val);
      });
      if (liveId) values.push(String(liveId));
      allRows.push(values);
    }
    const liveTag = liveId ? ` 直播 ${liveId}` : '';
    console.log(`  日期 ${date}${liveTag}: ${rows.length} 条（序号由公式按日自动生成）`);
  }

  return { importHeaders, allRows, dates: Object.keys(dateGroups) };
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
      if (header === SEQ_FIELD) return;
      fields[header] = String(val);
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

async function findVideoRecord(appToken, tableId, date, name, liveId) {
  const names = liveId
    ? [buildFeishuRecordName(liveId, name)]
    : [name];

  for (const recordName of names) {
    try {
      const items = await api.searchRecords(appToken, tableId, {
        filter: {
          conjunction: 'and',
          conditions: [
            { field_name: '名称', operator: 'is', value: [recordName] },
            { field_name: '日期', operator: 'is', value: [date] },
          ],
        },
        field_names: ['日期', '名称', '音频', '视频'],
        page_size: 20,
      });
      if (items[0]) return items[0];
    } catch {
      // try next name variant
    }
  }
  return null;
}

function buildFeishuRecordName(liveId, name) {
  if (liveId) return `${liveId} ${name}`.trim();
  return name;
}

async function ensureAudioField(appToken, tableId) {
  const existing = await api.listTableFields(appToken, tableId);
  if (existing.some((f) => f.field_name === '音频')) return;
  try {
    await api.createField(appToken, tableId, '音频', 'attachment');
    console.log('  已创建字段: 音频');
  } catch (e) {
    if (/FieldNameDuplicated|1254014/.test(e.message)) {
      console.log('  字段已存在，跳过: 音频');
      return;
    }
    throw e;
  }
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

async function uploadVideoToFeishu({ date, name, liveId, filePath }) {
  const config = loadFeishuConfig();
  const tableId = await ensureVideoTable(config);
  const recordName = buildFeishuRecordName(liveId, name);
  const filename = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;
  const sizeMb = (fileSize / 1024 / 1024).toFixed(1);

  console.log(`\n上传飞书视频: ${filename} → ${config.videoTable?.name || VIDEO_TABLE_NAME} (${sizeMb} MB)`);
  if (fileSize > 2 * 1024 * 1024 * 1024) {
    console.warn('  警告: 飞书附件单文件上限 2GB，超大文件可能上传失败');
  }

  const existing = await findVideoRecord(config.baseToken, tableId, date, name, liveId);
  if (existing) {
    const attachments = existing.fields?.['视频'] || [];
    if (Array.isArray(attachments) && attachments.length > 0) {
      console.log(`  已存在且已有视频附件，跳过: ${recordName}`);
      fs.unlinkSync(filePath);
      return { skipped: true, reason: 'already_uploaded' };
    }
  }

  let recordId = existing?.record_id;
  if (!recordId) {
    const record = await api.createRecord(config.baseToken, tableId, { 日期: date, 名称: recordName });
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

function hasMatchingAttachment(attachments, filePath) {
  if (!Array.isArray(attachments) || attachments.length === 0) return false;
  const expectedName = path.basename(filePath);
  return attachments.some((item) => item.name === expectedName);
}

function hasAllSegmentAttachments(attachments, segmentPaths) {
  if (!Array.isArray(segmentPaths) || segmentPaths.length === 0) return false;
  if (!Array.isArray(attachments) || attachments.length === 0) return false;
  const names = new Set(attachments.map((item) => item.name).filter(Boolean));
  return segmentPaths.every((p) => names.has(path.basename(p)));
}

/** 从飞书附件名解析 part 序号，判断分段是否连续齐全（无需本地文件） */
function isAudioUploadCompleteFromAttachments(attachments) {
  const parts = (attachments || [])
    .map((item) => item.name)
    .filter(Boolean)
    .map((name) => name.match(/_part(\d+)\.mp3$/i)?.[1])
    .filter(Boolean)
    .map((n) => parseInt(n, 10))
    .sort((a, b) => a - b);
  if (!parts.length) return false;
  const max = parts[parts.length - 1];
  if (parts.length !== max) return false;
  for (let i = 1; i <= max; i += 1) {
    if (!parts.includes(i)) return false;
  }
  return true;
}

async function checkAudioUploadedToFeishu({ date, name, liveId }) {
  const config = loadFeishuConfig();
  const tableId = await ensureVideoTable(config);
  const existing = await findVideoRecord(config.baseToken, tableId, date, name, liveId);
  if (!existing) return { complete: false, segmentCount: 0 };
  const attachments = existing.fields?.['音频'] || [];
  return {
    complete: isAudioUploadCompleteFromAttachments(attachments),
    segmentCount: attachments.length,
    recordId: existing.record_id,
  };
}

function deriveMediaBaseStem(anyAudioPath) {
  const base = path.basename(anyAudioPath, path.extname(anyAudioPath));
  return base.replace(/_part\d+$/i, '');
}

/** 音频上传完成或飞书已有同文件时，删除本地 mp3 分段、整段 mp3 及同名 mp4 */
function cleanupLocalMediaPair(audioPathOrSegment, segmentPaths = []) {
  const baseStem = deriveMediaBaseStem(
    segmentPaths[0] || audioPathOrSegment
  );
  const audioDir = appConfig.audioDownloadDir;
  const candidates = [
    path.join(audioDir, `${baseStem}.mp3`),
    path.join(appConfig.videoDownloadDir, `${baseStem}.mp4`),
  ];
  if (fs.existsSync(audioDir)) {
    for (const f of fs.readdirSync(audioDir)) {
      if (f.startsWith(`${baseStem}_part`) && /\.mp3$/i.test(f)) {
        candidates.push(path.join(audioDir, f));
      }
    }
  }
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    fs.unlinkSync(filePath);
    console.log(`  已删除本地文件: ${path.basename(filePath)}`);
  }
}

async function uploadMultipleAttachmentsToRecord({
  appToken, tableId, recordId, fieldName, filePaths, label, existingAttachments = [],
}) {
  let totalMb = 0;
  for (const filePath of filePaths) {
    if (fs.existsSync(filePath)) totalMb += fs.statSync(filePath).size;
  }
  console.log(`\n上传飞书${label}: ${filePaths.length} 个文件 (合计 ${(totalMb / 1024 / 1024).toFixed(1)} MB)`);
  const overThreshold = filePaths.some(
    (p) => fs.existsSync(p) && fs.statSync(p).size > appConfig.multipartUploadThreshold
  );
  if (overThreshold) {
    console.log('  部分文件超过 20MB，将自动分片上传');
  }
  console.log('  开始上传附件，请耐心等待...');
  await api.uploadMultipleAttachmentsToField(
    appToken, tableId, recordId, fieldName, filePaths, { existingAttachments }
  );
  console.log('  附件上传完成');
}

async function uploadAudioToFeishu({ date, name, liveId, filePath, filePaths }) {
  const paths = (filePaths && filePaths.length)
    ? filePaths
    : (filePath ? [filePath] : []);
  if (!paths.length) {
    throw new Error('uploadAudioToFeishu: 缺少 filePaths 或 filePath');
  }

  const config = loadFeishuConfig();
  const tableId = await ensureVideoTable(config);
  await ensureAudioField(config.baseToken, tableId);
  const recordName = buildFeishuRecordName(liveId, name);

  const existing = await findVideoRecord(config.baseToken, tableId, date, name, liveId);
  let existingAttachments = [];
  if (existing) {
    existingAttachments = existing.fields?.['音频'] || [];
    if (hasAllSegmentAttachments(existingAttachments, paths)) {
      console.log(`  已存在且音频分段齐全，跳过: ${recordName}`);
      cleanupLocalMediaPair(paths[0], paths);
      return { skipped: true, reason: 'already_uploaded' };
    }
    if (existingAttachments.length > 0) {
      const names = existingAttachments.map((item) => item.name).filter(Boolean).join(', ') || '(未知文件名)';
      console.log(`  已有 ${existingAttachments.length} 个附件，断点续传: ${names}`);
    }
  }

  let recordId = existing?.record_id;
  if (!recordId) {
    const record = await api.createRecord(config.baseToken, tableId, { 日期: date, 名称: recordName });
    recordId = record?.record_id;
    if (!recordId) {
      throw new Error('创建记录失败');
    }
    console.log(`  已创建记录: ${recordId}`);
  } else {
    console.log(`  复用已有记录: ${recordId}`);
  }

  await uploadMultipleAttachmentsToRecord({
    appToken: config.baseToken,
    tableId,
    recordId,
    fieldName: '音频',
    filePaths: paths,
    label: '音频',
    existingAttachments,
  });

  cleanupLocalMediaPair(paths[0], paths);
  return { uploaded: true, recordId, tableId, segmentCount: paths.length };
}

async function importBarrageToFeishu(filePath, hintText = '', options = {}) {
  const config = await ensureFeishuTables(loadFeishuConfig());
  const filename = path.basename(filePath);
  const school = detectSchoolLevel(`${hintText} ${filename}`, config);
  if (!school) {
    throw new Error(
      `无法识别学段: ${filename}（当前: ${describeSchoolMode(config)}）`
    );
  }

  const liveId = options.liveId || extractLiveId(hintText);

  const table = config.tables[school];
  if (!table) {
    throw new Error(`未配置学段表: ${school}`);
  }

  console.log(`\n导入飞书: ${filename} → ${table.name}${liveId ? ` (直播 ${liveId})` : ''}`);
  const { headers, dataRows } = readXlsx(filePath);
  if (!headers.length || !dataRows.length) {
    throw new Error(`xlsx 为空: ${filename}`);
  }

  const writableHeaders = headers.filter((h) => h && !SKIP_IMPORT_COLUMNS.has(h));
  if (liveId) writableHeaders.push(LIVE_ID_FIELD);
  const existingFields = await ensureFields(config.baseToken, table.tableId, writableHeaders);
  await ensureDailySeqField(config.baseToken, table.tableId, table.name);

  const { importHeaders, allRows, dates } = buildImportRows(headers, dataRows, liveId);
  const fieldMap = resolveImportFieldMap(existingFields, importHeaders);
  const feishuHeaders = importHeaders.map((h) => fieldMap[h] || h);
  for (const date of dates) {
    if (date === 'unknown') continue;
    if (liveId) {
      await deleteRecordsForLiveAndDate(config.baseToken, table.tableId, date, liveId);
    } else {
      await deleteRecordsForDate(config.baseToken, table.tableId, date);
    }
  }
  await batchCreateRecords(config.baseToken, table.tableId, feishuHeaders, allRows);

  fs.unlinkSync(filePath);
  console.log(`  导入完成，已删除本地文件: ${filename}`);
  return { school, table: table.name, liveId, rows: dataRows.length };
}

module.exports = {
  loadFeishuConfig,
  ensureFeishuConfigForDate,
  ensureFeishuTables,
  detectSchoolLevel,
  getSchoolTableKeys,
  describeSchoolMode,
  isMergeMiddleHigh,
  extractLiveId,
  importBarrageToFeishu,
  resequenceRecordsForDate,
  ensureVideoTable,
  uploadVideoToFeishu,
  uploadAudioToFeishu,
  checkAudioUploadedToFeishu,
  isAudioUploadCompleteFromAttachments,
};
