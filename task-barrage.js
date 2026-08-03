#!/usr/bin/env node
/**
 * 定时任务 1：逐场触发平台转码 → 导出弹幕 → 上传飞书
 *
 * 流程: 场次1 转码(或已转码则后台下载)+弹幕+上传 → 场次2 … → 全部结束后等待视频落盘
 *
 * 用法:
 *   npm run task-barrage                              # 默认昨天
 *   npm run task-barrage -- --date 2026-07-14       # 指定日期
 *   npm run task-barrage -- --date yesterday --skip-login
 */

const path = require('path');
const { QianniuDownloader, parseArgs } = require('./index.js');

const args = process.argv.slice(2);
const hasMode = args.some((arg, i) => arg === '--mode' && args[i + 1]);
if (!hasMode) {
  args.push('--mode', 'barrage-task');
}
process.argv = [process.argv[0], path.join(__dirname, 'index.js'), ...args];

const options = parseArgs();
const downloader = new QianniuDownloader(options);

process.on('SIGINT', async () => {
  console.log('\n关闭浏览器...');
  await downloader.close();
  process.exit(0);
});

downloader.run().catch(async (err) => {
  console.error('致命错误:', err);
  await downloader.close();
  process.exit(1);
});
