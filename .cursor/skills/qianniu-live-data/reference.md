# 千牛直播数据采集 — 参考

## 环境变量（`.env`）

| 变量 | 说明 |
|------|------|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书自建应用凭证（必填） |
| `QIANNIU_USERNAME` / `QIANNIU_PASSWORD` | 千牛账号登录（Profile 失效时自动填表） |
| `MERGE_MIDDLE_HIGH` | `0` 分学段（小/初/高），`1` 初高合并 |
| `CHROME_PATH` | 非默认 Chrome 路径 |
| `FFMPEG_PATH` | 非默认 ffmpeg 路径 |
| `CHROME_USER_DATA_DIR` | Chrome Profile 目录 |
| `PLAYWRIGHT_HEADLESS` | `1` 无头（Windows 定时任务默认） |
| `FEISHU_UPLOAD_CONCURRENCY` | 飞书上传并发，最低 3 |

## 飞书配置（`feishu.config.json`）

```json
{
  "baseToken": "多维表格 token",
  "mergeMiddleHigh": false,
  "tables": {
    "小学": { "name": "小学弹幕", "tableId": "tbl..." },
    "初中": { "name": "初中弹幕", "tableId": "tbl..." },
    "高中": { "name": "高中弹幕", "tableId": "tbl..." },
    "初高": { "name": "初高弹幕", "tableId": "tbl..." }
  },
  "videoTable": { "name": "直播视频", "tableId": "tbl..." }
}
```

`tableId` 可留空，首次运行 `ensureFeishuTables` 会自动匹配或创建并回写。

## npm scripts 一览

| 命令 | 说明 |
|------|------|
| `task-barrage` | 定时任务 1 |
| `task-audio` | 定时任务 2 |
| `backfill-week` | 补跑（支持 `--from`/`--to`/`--date`） |
| `verify-feishu` | 检测 Base 连通性与表配置 |
| `import-barrage` | 仅导入本地 xlsx |
| `export-audio` / `upload-audio` | 本地视频转音频 / 上传 |

## CLI 常用参数

| 参数 | 说明 |
|------|------|
| `--date yesterday\|today\|YYYY-MM-DD` | 目标日期 |
| `--from` / `--to` | 补跑日期范围 |
| `--skip-login` | 跳过交互等待；Profile 无效时用 `.env` 自动登录 |
| `--skip-transcode-wait` | 音频任务不等待转码轮询 |

## 单场处理流程

**弹幕（task-barrage / backfill 阶段 1）**
1. 直播中心按日期筛选
2. 学段过滤（若配置了 mergeMiddleHigh）
3. 逐场：中控台 → 触发 MP4 下载（后台）→ 导出弹幕 xlsx → 导入飞书
4. 可选等待 MP4 落盘

**音频（task-audio / backfill 阶段 2）**
1. 轮询转码状态（默认每 5 分钟，最多 360 分钟）
2. 下载 MP4（本地已有则跳过）
3. ffmpeg 整段 MP3 → 按 3600 秒切分（默认 17 段/16 小时场）
4. 飞书「直播视频」表创建记录，分片上传附件（>20MB 自动分片）
5. 成功后删除本地 MP4/MP3

## 日志与产物

| 路径 | 内容 |
|------|------|
| `logs/backfill-YYYYMMDD.log` | 补跑日志 |
| `logs/task-barrage-YYYYMMDD.log` | Windows 弹幕任务 |
| `logs/task-audio-YYYYMMDD.log` | Windows 音频任务 |
| `downloads/videos/` | MP4（上传后通常删除） |
| `downloads/audio/` | MP3 分段 |
| `screenshots/` | 异常截图 |

## 典型耗时（参考）

- 弹幕 2 场：5–15 分钟
- MP4 下载：6–8 GB/场，约 10–30 分钟/场
- ffmpeg + 上传：约 30–50 分钟/场（16–17 段）

## 排错

| 现象 | 处理 |
|------|------|
| `Target page, context or browser has been closed` | 关占用 Profile 的 Chrome；检查内存；重跑 |
| `无法识别学段` | 检查场次标题是否含【小学】【初中】【高中】【初高】 |
| `缺少飞书配置` | 复制 `feishu.config.example.json` → `feishu.config.json` |
| 弹幕条数偏少 | 中控台聊天懒加载；重跑覆盖即可 |
| 仅缺音频 | `npm run task-audio -- --date YYYY-MM-DD --skip-login --skip-transcode-wait` |

## macOS crontab 示例

```cron
40 1 * * * cd /path/to/qianniu_get_data && npm run task-barrage -- --date yesterday --skip-login >> logs/task-barrage.log 2>&1
0 14 * * * cd /path/to/qianniu_get_data && npm run task-audio -- --date yesterday --skip-login >> logs/task-audio.log 2>&1
```

## Codex / 其他 Agent 用法

1. 加载本 skill：`qianniu-live-data`（Cursor 项目 skill 路径 `.cursor/skills/qianniu-live-data/SKILL.md`）
2. 读取仓库代码确认行为变更时，优先看 `school-level.js`、`feishu.js`、`backfill-week.js`
3. 执行补跑需 **network + 完整 shell**（Playwright 启 Chrome）
4. 完成后向用户汇报摘要表（日期、场次数、弹幕条数、音频 record_id、exit code）
