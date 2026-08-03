#!/usr/bin/env node
/**
 * 定时任务 1：逐场触发平台转码 → 导出弹幕 → 上传飞书
 *
 * 流程: 场次1 转码+弹幕+上传 → 场次2 转码+弹幕+上传 → …（不下载视频）
 *
 * 用法:
 *   npm run task-barrage                              # 默认昨天
 *   npm run task-barrage -- --date 2026-07-14       # 指定日期
 *   npm run task-barrage -- --date yesterday --skip-login
 */

const args = process.argv.slice(2);
const hasMode = args.some((arg, i) => arg === '--mode' && args[i + 1]);
if (!hasMode) {
  args.push('--mode', 'barrage-task');
}
process.argv = [process.argv[0], require('path').join(__dirname, 'index.js'), ...args];
require('./index.js');
