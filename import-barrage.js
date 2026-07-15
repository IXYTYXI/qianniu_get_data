#!/usr/bin/env node
/**
 * 手动将 downloads/ 目录下的 xlsx 弹幕文件导入飞书并删除本地文件
 * 用法: node import-barrage.js [文件路径或目录]
 */
const fs = require('fs');
const path = require('path');
const { importBarrageToFeishu } = require('./feishu');

async function main() {
  const target = process.argv[2] || path.join(__dirname, 'downloads');
  const files = [];

  if (fs.statSync(target).isDirectory()) {
    for (const name of fs.readdirSync(target)) {
      if (/\.xlsx?$/i.test(name)) files.push(path.join(target, name));
    }
  } else {
    files.push(target);
  }

  if (!files.length) {
    console.log('未找到 xlsx 文件');
    return;
  }

  for (const file of files) {
    await importBarrageToFeishu(file);
  }
}

main().catch((err) => {
  console.error('错误:', err.message);
  process.exit(1);
});
