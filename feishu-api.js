const fs = require('fs');
const path = require('path');
const { loadDotEnv } = require('./env');

const FEISHU_HOST = 'https://open.feishu.cn';
const FIELD_TYPE = {
  text: 1,
  number: 2,
  formula: 20,
  attachment: 17,
};

let cachedToken = null;
let tokenExpireAt = 0;

function getAppCredentials() {
  loadDotEnv();
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error(
      '缺少飞书自建应用凭证，请复制 .env.example 为 .env 并填写 FEISHU_APP_ID / FEISHU_APP_SECRET'
    );
  }
  return { appId, appSecret };
}

async function getTenantAccessToken() {
  if (cachedToken && Date.now() < tokenExpireAt - 60_000) {
    return cachedToken;
  }

  const { appId, appSecret } = getAppCredentials();
  const res = await fetch(`${FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`飞书 tenant_access_token 获取失败: ${data.msg}`);
  }

  cachedToken = data.tenant_access_token;
  tokenExpireAt = Date.now() + data.expire * 1000;
  return cachedToken;
}

async function feishuRequest(method, apiPath, options = {}) {
  const token = await getTenantAccessToken();
  let url = `${FEISHU_HOST}${apiPath}`;
  if (options.params) {
    url += `?${new URLSearchParams(options.params)}`;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    ...(options.headers || {}),
  };

  const fetchOptions = { method, headers };
  if (options.rawBody !== undefined) {
    fetchOptions.body = options.rawBody;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    fetchOptions.body = JSON.stringify(options.body);
  }

  const res = await fetch(url, fetchOptions);
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`飞书 API 错误 [${data.code}]: ${data.msg}`);
  }
  return data.data;
}

function appPath(appToken, suffix) {
  return `/open-apis/bitable/v1/apps/${appToken}${suffix}`;
}

async function listTableFields(appToken, tableId) {
  const data = await feishuRequest('GET', appPath(appToken, `/tables/${tableId}/fields`), {
    params: { page_size: '100' },
  });
  return data.items || [];
}

async function createField(appToken, tableId, fieldName, type, options = {}) {
  const body = {
    field_name: fieldName,
    type: FIELD_TYPE[type] || FIELD_TYPE.text,
  };
  if (type === 'formula' && options.formula_expression) {
    body.property = { formula_expression: options.formula_expression };
  }
  await feishuRequest('POST', appPath(appToken, `/tables/${tableId}/fields`), { body });
}

async function listTables(appToken) {
  const data = await feishuRequest('GET', appPath(appToken, '/tables'), {
    params: { page_size: '100' },
  });
  return data.items || [];
}

async function createTable(appToken, tableName, fields) {
  const data = await feishuRequest('POST', appPath(appToken, '/tables'), {
    body: {
      table: {
        name: tableName,
        fields: fields.map((f) => ({
          field_name: f.name,
          type: FIELD_TYPE[f.type] || FIELD_TYPE.text,
        })),
      },
    },
  });
  return data.table_id || data.table?.table_id;
}

async function batchCreateRecords(appToken, tableId, records) {
  const data = await feishuRequest('POST', appPath(appToken, `/tables/${tableId}/records/batch_create`), {
    body: { records },
  });
  return data.records || [];
}

async function createRecord(appToken, tableId, fields) {
  const data = await feishuRequest('POST', appPath(appToken, `/tables/${tableId}/records`), {
    body: { fields },
  });
  return data.record;
}

async function updateRecord(appToken, tableId, recordId, fields) {
  const data = await feishuRequest('PUT', appPath(appToken, `/tables/${tableId}/records/${recordId}`), {
    body: { fields },
  });
  return data.record;
}

async function searchRecords(appToken, tableId, payload) {
  const data = await feishuRequest('POST', appPath(appToken, `/tables/${tableId}/records/search`), {
    body: payload,
  });
  return data.items || [];
}

async function searchRecordsAll(appToken, tableId, payload) {
  const items = [];
  let pageToken;
  do {
    const body = { ...payload, page_size: payload.page_size || 500 };
    if (pageToken) body.page_token = pageToken;
    const data = await feishuRequest('POST', appPath(appToken, `/tables/${tableId}/records/search`), {
      body,
    });
    items.push(...(data.items || []));
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);
  return items;
}

async function batchDeleteRecords(appToken, tableId, recordIds) {
  if (!recordIds.length) return;
  const BATCH = 500;
  for (let i = 0; i < recordIds.length; i += BATCH) {
    await feishuRequest('POST', appPath(appToken, `/tables/${tableId}/records/batch_delete`), {
      body: { records: recordIds.slice(i, i + BATCH) },
    });
  }
}

async function batchUpdateRecords(appToken, tableId, records) {
  if (!records.length) return;
  const BATCH = 500;
  for (let i = 0; i < records.length; i += BATCH) {
    await feishuRequest('POST', appPath(appToken, `/tables/${tableId}/records/batch_update`), {
      body: { records: records.slice(i, i + BATCH) },
    });
  }
}

async function listRecords(appToken, tableId, { pageSize = 200, pageToken } = {}) {
  const params = { page_size: String(pageSize) };
  if (pageToken) params.page_token = pageToken;
  const data = await feishuRequest('GET', appPath(appToken, `/tables/${tableId}/records`), { params });
  return data;
}

async function deleteField(appToken, tableId, fieldId) {
  await feishuRequest('DELETE', appPath(appToken, `/tables/${tableId}/fields/${fieldId}`));
}

async function uploadAllMedia(appToken, filePath) {
  const buffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const size = buffer.length;
  const form = new FormData();
  form.append('file_name', fileName);
  form.append('parent_type', 'bitable_file');
  form.append('parent_node', appToken);
  form.append('size', String(size));
  form.append('file', new Blob([buffer]), fileName);

  const token = await getTenantAccessToken();
  const res = await fetch(`${FEISHU_HOST}/open-apis/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`飞书附件上传失败: ${data.msg}`);
  }
  return data.data.file_token;
}

async function uploadMultipartMedia(appToken, filePath) {
  const buffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const size = buffer.length;

  const prepare = await feishuRequest('POST', '/open-apis/drive/v1/medias/upload_prepare', {
    body: {
      file_name: fileName,
      parent_type: 'bitable_file',
      parent_node: appToken,
      size,
    },
  });

  const { upload_id: uploadId, block_size: blockSize = 4 * 1024 * 1024 } = prepare;
  let offset = 0;
  let seq = 0;

  while (offset < size) {
    const chunk = buffer.subarray(offset, Math.min(offset + blockSize, size));
    const form = new FormData();
    form.append('upload_id', uploadId);
    form.append('seq', String(seq));
    form.append('size', String(chunk.length));
    form.append('file', new Blob([chunk]), fileName);

    const token = await getTenantAccessToken();
    const res = await fetch(`${FEISHU_HOST}/open-apis/drive/v1/medias/upload_part`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const data = await res.json();
    if (data.code !== 0) {
      throw new Error(`飞书分片上传失败(seq=${seq}): ${data.msg}`);
    }

    if ((seq + 1) % 10 === 0 || offset + chunk.length >= size) {
      const pct = Math.min(100, Math.round(((offset + chunk.length) / size) * 100));
      console.log(`  分片进度: ${pct}% (${seq + 1} 片)`);
    }

    offset += chunk.length;
    seq += 1;
  }

  const finish = await feishuRequest('POST', '/open-apis/drive/v1/medias/upload_finish', {
    body: { upload_id: uploadId },
  });
  return finish.file_token;
}

async function uploadMedia(appToken, filePath) {
  const size = fs.statSync(filePath).size;
  if (size <= 20 * 1024 * 1024) {
    return uploadAllMedia(appToken, filePath);
  }
  console.log('  文件超过 20MB，使用分片上传');
  return uploadMultipartMedia(appToken, filePath);
}

async function uploadAttachmentToField(appToken, tableId, recordId, fieldName, filePath) {
  const fileToken = await uploadMedia(appToken, filePath);
  await updateRecord(appToken, tableId, recordId, {
    [fieldName]: [{ file_token: fileToken }],
  });
  return fileToken;
}

module.exports = {
  FIELD_TYPE,
  getAppCredentials,
  getTenantAccessToken,
  listTableFields,
  createField,
  listTables,
  createTable,
  batchCreateRecords,
  createRecord,
  updateRecord,
  searchRecords,
  searchRecordsAll,
  batchDeleteRecords,
  batchUpdateRecords,
  listRecords,
  deleteField,
  uploadAttachmentToField,
};
