---
name: qianniu-live-data
description: >-
  千牛直播数据自动化：转码、弹幕导出、飞书导入、MP4 下载、ffmpeg 转音频、分片上传。
  用于补跑指定日期、排查定时任务、配置学段分表、Windows/macOS 部署。
  触发词：千牛、qianniu、直播弹幕、补跑、backfill、task-barrage、task-audio、飞书 Base。
---

# 千牛直播数据采集

## 使用前

1. 进入仓库根目录（含 `package.json`）。
2. 确认存在且已填写：
   - `.env`：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`；可选 `QIANNIU_USERNAME`/`QIANNIU_PASSWORD`、`MERGE_MIDDLE_HIGH`
   - `feishu.config.json`（gitignore，从 `feishu.config.example.json` 复制）：`baseToken`、各表 `tableId`
3. 依赖：Node 18+、系统 Chrome、ffmpeg（音频任务必需）。
4. **必须实际执行命令**，不要只描述步骤。长任务放后台，盯 `logs/`。

## 架构（两个独立任务，勿合并）

| 任务 | 命令 | 作用 | 飞书写入 |
|------|------|------|----------|
| 1 弹幕 | `npm run task-barrage` | 转码 → 导出 xlsx → 导入弹幕 | 小学/初中/高中/初高弹幕表 |
| 2 音频 | `npm run task-audio` | 下载 MP4 → ffmpeg → 切段 → 上传 | 直播视频表 |

两任务共用 Chrome Profile，**不要并行**。补跑单日用 `backfill-week`（单浏览器串行完成 1+2）。

## 常用命令

### 补跑指定日期（推荐）

```bash
mkdir -p logs
npm run backfill-week -- --from YYYY-MM-DD --to YYYY-MM-DD --skip-login 2>&1 | tee logs/backfill-YYYYMMDD.log
```

- 单日：`--from 2026-08-06 --to 2026-08-06`
- Profile 有效时用 `--skip-login`；失效时会读 `.env` 自动登录
- 耗时：每场约 40–90 分钟（含大 MP4 下载与飞书分片上传）

### 仅弹幕 / 仅音频

```bash
npm run task-barrage -- --date yesterday --skip-login
npm run task-audio -- --date yesterday --skip-login
npm run task-audio -- --date 2026-08-06 --skip-login --skip-transcode-wait
```

`--date` 支持 `yesterday`、`today` 或 `YYYY-MM-DD`。

### 验证飞书配置

```bash
npm run verify-feishu
```

## 学段与弹幕表路由

由 `feishu.config.json` 的 `mergeMiddleHigh` 或 `.env` 的 `MERGE_MIDDLE_HIGH` 控制：

| 模式 | 配置 | 【小学】 | 【初中】 | 【高中】 | 【初高】 |
|------|------|---------|---------|---------|---------|
| 分学段（三场直播） | `false` / `0` | 小学弹幕 | 初中弹幕 | 高中弹幕 | 初高弹幕 |
| 初高合并 | `true` / `1` | 小学弹幕 | → 初高 | → 初高 | 初高弹幕 |

场次标题**必须**含对应标签，否则报「无法识别学段」。首次切换模式后跑 `verify-feishu` 或任意导入任务，会自动补齐 `tableId` 并写回 `feishu.config.json`。

## 执行工作流（Agent）

用户说「补 X 月 X 日」「跑昨天数据」「查进度」时：

```
进度:
- [ ] 1. 读 .env / feishu.config.json，确认 mergeMiddleHigh 与日期
- [ ] 2. 选命令（补跑 / 单任务）并在后台启动
- [ ] 3. 轮询 logs/*.log 或 terminals 输出
- [ ] 4. 汇报：场次数、弹幕条数、音频段数、飞书 record_id、EXIT_CODE
```

**进度关键词**：`共找到 N 场`、`导入完成`、`附件上传完成`、`=== 补跑摘要 ===`、`EXIT_CODE: 0`

**失败处理**：
- 登录失败 → 检查 `.env` 账号密码或去掉 `--skip-login` 手动登录一次
- 浏览器 closed → Profile 被占用，关手动 Chrome 后重试
- 飞书 fetch failed → 网络抖动，脚本会重试；仍失败则重跑音频段
- 转码未就绪 → `task-audio` 会轮询；或次日再跑

## 弹幕去重

导入前按 **日期 + 直播ID** 删除旧记录再全量写入（`feishu.js` → `deleteRecordsForLiveAndDate`）。重跑安全，不会重复累加。

## Windows 部署机

路径示例：`E:\autoget\qianniu_get_data`

```powershell
# 注册定时任务（弹幕 01:40，音频 14:00 示例）
powershell -ExecutionPolicy Bypass -File scripts\windows\install-scheduled-tasks.ps1 -BarrageTime 01:40 -AudioTime 14:00

# 手动测试
scripts\windows\run-task-barrage.bat
scripts\windows\run-task-audio.bat
```

同步 `.env`、`feishu.config.json`（不进 git）。日志在 `logs\task-barrage-*.log`、`logs\task-audio-*.log`。

## 关键文件

| 文件 | 用途 |
|------|------|
| `backfill-week.js` | 补跑入口（弹幕+音频单会话） |
| `task-barrage.js` / `task-audio.js` | 定时任务入口 |
| `school-level.js` | 学段识别与列表筛选 |
| `feishu.js` | 弹幕导入、音频上传、删旧写新 |
| `browser.js` | 登录、列表扫描、日期筛选 |
| `index.js` | 单场中控台流程（转码/弹幕/下载） |

详细配置、排错、目录结构见 [reference.md](reference.md)。

## 安全

- 勿提交 `.env`、`feishu.config.json`
- 勿在回复中泄露 `FEISHU_APP_SECRET`、密码
