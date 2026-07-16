# 千牛直播自动化工具

自动处理千牛直播回放：触发转码、导出弹幕、下载视频、转音频并上传到飞书多维表格。

## 架构说明

本工具拆成 **两个独立的定时任务**，必须分开部署、分开调度，不要合并成一个任务。

```
┌─────────────────────────────────────────────────────────────┐
│  定时任务 1（凌晨较早执行）task-barrage.js                    │
│  触发转码 → 导出弹幕 xlsx → 导入飞书弹幕表                    │
└─────────────────────────────────────────────────────────────┘
                            ↓  等待转码完成（通常数小时）
┌─────────────────────────────────────────────────────────────┐
│  定时任务 2（转码完成后再执行）task-audio.js                  │
│  下载 MP4 → ffmpeg 导出 MP3 → 分片上传飞书「音频」字段          │
└─────────────────────────────────────────────────────────────┘
```

| 任务 | 脚本 | 飞书写入位置 |
|------|------|-------------|
| 任务 1 | `npm run task-barrage` | 小学弹幕 / 初中弹幕 / 高中弹幕 |
| 任务 2 | `npm run task-audio` | 直播视频 表（日期、名称、音频） |

**为什么要分开？**

- 任务 1 只负责「发起转码」，此时视频还不能下载
- 任务 2 需要等转码完成后才能下载，且下载+转码+上传耗时很长（单场可达 1 小时）
- 两个任务共用 Chrome 登录态（`.chrome-profile`），同时运行会冲突

## 环境要求

| 依赖 | 用途 | 安装 |
|------|------|------|
| Node.js 18+ | 运行脚本 | https://nodejs.org |
| Google Chrome | 浏览器自动化 | 系统安装即可 |
| Playwright | 控制 Chrome | `npm install` 自动安装 |
| ffmpeg | 视频转音频 | Mac: `brew install ffmpeg` |
| lark-cli | 飞书多维表格 API | 参考飞书 CLI 文档安装并登录 |

### 环境变量（可选）

```bash
# Chrome 路径（非默认安装时）
export CHROME_PATH="/path/to/chrome"

# ffmpeg 路径（非默认安装时）
export FFMPEG_PATH="/opt/homebrew/bin/ffmpeg"
```

## 部署步骤

### 1. 克隆并安装

```bash
git clone https://github.com/IXYTYXI/qianniu_get_data.git
cd qianniu_get_data
npm install
npx playwright install chromium   # 首次需要
```

### 2. 配置飞书

```bash
cp feishu.config.example.json feishu.config.json
```

编辑 `feishu.config.json`，填入当月多维表格信息：

```json
{
  "month": "2026-07",
  "baseName": "直播弹幕-2026-07",
  "baseToken": "你的BaseToken",
  "tables": {
    "小学": { "name": "小学弹幕", "tableId": "tblXXX" },
    "初中": { "name": "初中弹幕", "tableId": "tblXXX" },
    "高中": { "name": "高中弹幕", "tableId": "tblXXX" }
  },
  "videoTable": {
    "name": "直播视频",
    "tableId": "tblXXX"
  }
}
```

每月新建 Base 后，更新 `feishu.config.json` 中的 `month`、`baseToken` 和各 `tableId`。

确保 lark-cli 已授权：

```bash
lark-cli auth status
```

### 3. 首次登录千牛

首次运行需要手动登录，会打开 Chrome 并等待登录：

```bash
npm run task-barrage -- --date yesterday
```

登录成功后，会话保存在 `.chrome-profile/`，后续可加 `--skip-login`。

> **注意**：运行脚本时不要手动打开使用同一 profile 的 Chrome，否则 Playwright 无法启动。

## 定时任务配置

### 推荐执行时间（东八区）

| 任务 | 建议时间 | 处理数据 |
|------|---------|---------|
| 任务 1 `task-barrage` | 每天 **06:00** | 昨天直播 |
| 任务 2 `task-audio` | 每天 **12:00** 或 **14:00** | 昨天直播 |

任务 2 比任务 1 晚 **4–8 小时**，确保转码完成。若转码较慢，可再延后。

### macOS / Linux（crontab）

```bash
crontab -e
```

```cron
# 任务 1：转码 + 弹幕（每天 06:00，处理昨天）
0 6 * * * cd /path/to/qianniu_get_data && /usr/local/bin/npm run task-barrage -- --date yesterday --skip-login >> logs/task-barrage.log 2>&1

# 任务 2：下载视频 + 转音频 + 上传（每天 14:00，处理昨天）
0 14 * * * cd /path/to/qianniu_get_data && /usr/local/bin/npm run task-audio -- --date yesterday --skip-login >> logs/task-audio.log 2>&1
```

请先创建日志目录：

```bash
mkdir -p logs
```

将 `/path/to/qianniu_get_data` 替换为实际路径。`npm` 路径可用 `which npm` 查看。

### Windows（任务计划程序）

项目提供了现成的脚本，位于 `scripts/windows/`：

| 文件 | 作用 |
|------|------|
| `run-task-barrage.bat` | 执行任务 1，日志写入 `logs/` |
| `run-task-audio.bat` | 执行任务 2，日志写入 `logs/` |
| `install-scheduled-tasks.ps1` | 一键注册两个定时任务 |
| `uninstall-scheduled-tasks.ps1` | 卸载定时任务 |

#### 一键安装（推荐）

在项目目录打开 **PowerShell**，执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows/install-scheduled-tasks.ps1
```

默认注册两个独立任务：

| 任务名 | 时间 | 说明 |
|--------|------|------|
| `Qianniu-Task-Barrage` | 每天 06:00 | 转码 + 弹幕 |
| `Qianniu-Task-Audio` | 每天 14:00 | 下载 + 音频 + 上传 |

自定义时间：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows/install-scheduled-tasks.ps1 -BarrageTime 06:00 -AudioTime 14:00
```

#### 手动测试

```bat
scripts\windows\run-task-barrage.bat
scripts\windows\run-task-audio.bat
```

#### 卸载

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows/uninstall-scheduled-tasks.ps1
```

#### 手动配置（可选）

若不用安装脚本，在「任务计划程序」中创建 **两个** 计划任务，不要合并：

**任务 1 — 千牛弹幕**
- 程序：`scripts\windows\run-task-barrage.bat`
- 起始于：项目目录
- 触发器：每天 06:00

**任务 2 — 千牛音频**
- 程序：`scripts\windows\run-task-audio.bat`
- 起始于：项目目录
- 触发器：每天 14:00

## 命令参考

### 任务 1：转码 + 弹幕

```bash
# 默认处理昨天
npm run task-barrage

# 指定日期
npm run task-barrage -- --date 2026-07-14

# 已登录，跳过等待
npm run task-barrage -- --date yesterday --skip-login
```

### 任务 2：视频 → 音频 → 上传

```bash
# 全流程（下载 + 转音频 + 上传）
npm run task-audio -- --date yesterday --skip-login

# 视频已下载，仅转音频并上传
npm run task-audio -- --date 2026-07-14 --audio-only
```

### 其他辅助命令

```bash
npm run import-barrage          # 手动导入 downloads/ 下的弹幕 xlsx
npm run export-audio -- --date 2026-07-14   # 仅导出音频，不上传
```

## 目录结构

```
qianniu_get_data/
├── task-barrage.js      # 定时任务 1 入口
├── task-audio.js        # 定时任务 2 入口
├── scripts/
│   └── windows/         # Windows 定时任务脚本
│       ├── run-task-barrage.bat
│       ├── run-task-audio.bat
│       ├── install-scheduled-tasks.ps1
│       └── uninstall-scheduled-tasks.ps1
├── index.js             # 千牛浏览器操作核心
├── download-video.js    # 视频下载逻辑
├── audio.js             # ffmpeg 音频导出
├── feishu.js            # 飞书多维表格读写
├── feishu.config.json   # 飞书配置（本地，不提交 git）
├── .chrome-profile/     # Chrome 登录态（不提交 git）
├── downloads/
│   ├── *.xlsx           # 弹幕文件（导入后自动删除）
│   ├── videos/          # 下载的 MP4
│   └── audio/           # 导出的 MP3
└── screenshots/         # 调试截图
```

## 飞书表结构

**直播弹幕-YYYY-MM** Base 下：

| 表名 | 字段 |
|------|------|
| 小学弹幕 | 内容、序号、时间、用户、用户ID |
| 初中弹幕 | 同上 |
| 高中弹幕 | 同上 |
| 直播视频 | 名称、日期、音频（附件） |

「直播视频」表由脚本自动创建；「音频」字段在首次上传时自动添加。

## 常见问题

### Playwright 启动失败 / Chrome 被占用

```text
正在现有的浏览器会话中打开
```

关闭所有使用 `.chrome-profile` 的 Chrome 窗口后再运行。不要同时跑两个任务。

### 视频显示「转码中」

任务 2 会跳过未转码完成的场次。延后重跑任务 2 即可：

```bash
npm run task-audio -- --date 2026-07-14 --skip-login
```

### 下载中断

任务 2 下载期间会保持浏览器和中控台页面打开。请勿手动关闭 Chrome。已下载的文件会跳过重复下载。

### 飞书上传失败

- 确认 `lark-cli auth status` 正常
- 大文件（>20MB）自动分片上传，需耐心等待
- 原视频 MP4 可达数 GB，超过飞书单文件 2GB 上限；因此任务 2 改为上传 **音频**（约 800MB/场）

### 每月切换 Base

1. 在飞书新建 `直播弹幕-YYYY-MM` Base 及三张弹幕表
2. 更新 `feishu.config.json`
3. 「直播视频」表会在任务 2 首次运行时自动创建

## 手动补跑示例

补跑前天（7/14）的完整流程：

```bash
# 第一步：转码 + 弹幕
npm run task-barrage -- --date 2026-07-14 --skip-login

# 等待几小时转码完成后，第二步：下载 + 音频 + 上传
npm run task-audio -- --date 2026-07-14 --skip-login
```

若视频已下载到本地：

```bash
npm run task-audio -- --date 2026-07-14 --audio-only
```
