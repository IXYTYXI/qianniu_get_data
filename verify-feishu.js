#!/usr/bin/env node
/**
 * 部署检查：验证飞书自建应用凭证与 Base 连通性
 */
const fs = require('fs');
const path = require('path');
const api = require('./feishu-api');

const CONFIG_PATH = path.join(__dirname, 'feishu.config.json');

async function main() {
  await api.getTenantAccessToken();
  console.log('✓ tenant_access_token 获取成功');

  if (!fs.existsSync(CONFIG_PATH)) {
    console.log('⚠ 未找到 feishu.config.json，跳过 Base 连通性测试');
    return;
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!config.baseToken) {
    throw new Error('feishu.config.json 缺少 baseToken');
  }

  const tables = await api.listTables(config.baseToken);
  console.log(`✓ Base 连通正常（${config.baseName || config.month || config.baseToken}），共 ${tables.length} 张表`);
  for (const table of tables) {
    console.log(`  - ${table.name} (${table.table_id})`);
  }
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
