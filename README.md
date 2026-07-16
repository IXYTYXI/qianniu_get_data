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

| 依赖 | 版本 | 用途 |
|------|------|------|
| Node.js | 18+ | 运行脚本（内置 `fetch`、`FormData`，无需额外 HTTP 库） |
| Google Chrome | 最新稳定版 | 浏览器自动化（使用系统 Chrome，非 Playwright 内置浏览器） |
| ffmpeg | 任意较新版本 | 视频转音频（任务 2 必需） |
| npm 包 | 见 `package.json` | `playwright`（控制 Chrome）、`xlsx`（解析弹幕） |

### 依赖安装说明

按目标机器操作系统，依次安装以下依赖。

#### 1. Node.js

- 下载：https://nodejs.org （选 **LTS**，要求 **18 及以上**）
- 安装后验证：

```bash
node -v    # 应显示 v18.x 或更高
npm -v
```

#### 2. 项目 npm 依赖

在项目根目录执行：

```bash
cd qianniu_get_data
npm install
```

会安装 `playwright`、`xlsx` 等依赖。本工具通过 Playwright 驱动 **系统已安装的 Chrome**，一般 **不需要** 执行 `npx playwright install chromium`。

#### 3. Google Chrome

必须安装正式版 Chrome（千牛页面兼容性要求），脚本会自动探测常见安装路径。

| 系统 | 安装方式 | 默认路径 |
|------|---------|---------|
| macOS | https://www.google.com/chrome/ | `/Applications/Google Chrome.app/...` |
| Windows | https://www.google.com/chrome/ | `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe` |
| Linux | 发行版包管理器或官网 | `/usr/bin/google-chrome` |

非默认路径时，设置环境变量：

```bash
# macOS / Linux
export CHROME_PATH="/path/to/chrome"

# Windows（系统环境变量或 bat 脚本中）
set CHROME_PATH=C:\path\to\chrome.exe
```

#### 4. ffmpeg

任务 2（`task-audio`）需要 ffmpeg 将 MP4 转为 MP3。

| 系统 | 安装命令 | 说明 |
|------|---------|------|
| macOS | `brew install ffmpeg` | 需先安装 [Homebrew](https://brew.sh) |
| Windows | 见下方 Windows 说明 | 推荐解压到 `C:\ffmpeg\` |
| Linux (Debian/Ubuntu) | `sudo apt update && sudo apt install -y ffmpeg` | |
| Linux (CentOS/RHEL) | `sudo yum install -y ffmpeg` 或启用 RPM Fusion 后安装 | |

**Windows 安装 ffmpeg（推荐步骤）：**

1. 从 https://www.gyan.dev/ffmpeg/builds/ 下载 `ffmpeg-release-essentials.zip`
2. 解压到 `C:\ffmpeg\`，确保存在 `C:\ffmpeg\bin\ffmpeg.exe`
3. 验证：打开 cmd 执行 `C:\ffmpeg\bin\ffmpeg.exe -version`

若安装在其他目录，设置环境变量：

```bat
set FFMPEG_PATH=D:\tools\ffmpeg\bin\ffmpeg.exe
```

或将 `ffmpeg\bin` 加入系统 `PATH`，脚本也会自动尝试从 PATH 调用 `ffmpeg`。

#### 5. 安装验证

全部装好后，在项目目录执行：

```bash
node -v
npm -v
npm run verify-feishu    # 需先配置 .env
```

手动确认 Chrome、ffmpeg 可用：

```bash
# macOS / Linux
"$CHROME_PATH" --version 2>/dev/null || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version
ffmpeg -version

# Windows
"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" --version
C:\ffmpeg\bin\ffmpeg.exe -version
```

### 环境变量

**飞书自建应用凭证（必填）**

```bash
cp .env.example .env
# 编辑 .env，填入 FEISHU_APP_ID 和 FEISHU_APP_SECRET
```

| 变量 | 说明 |
|------|------|
| `FEISHU_APP_ID` | 飞书开放平台自建应用的 App ID |
| `FEISHU_APP_SECRET` | 飞书开放平台自建应用的 App Secret |

`.env` 含敏感信息，已加入 `.gitignore`，**不要提交到 git**。

**可选路径覆盖**

```bash
# Chrome 路径（非默认安装时）
export CHROME_PATH="/path/to/chrome"

# ffmpeg 路径（非默认安装时）
export FFMPEG_PATH="/opt/homebrew/bin/ffmpeg"
```

## 部署步骤

### 1. 克隆并安装依赖

```bash
git clone https://github.com/IXYTYXI/qianniu_get_data.git
cd qianniu_get_data
npm install
```

> 完整依赖说明（Node.js、Chrome、ffmpeg 各平台安装）见上文 **依赖安装说明**。

### 2. 配置飞书自建应用

本工具通过 **飞书开放平台自建应用** 调用多维表格 API，部署时无需安装 `lark-cli`，也无需个人扫码登录。

#### 2.1 创建自建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/app) → **创建企业自建应用**
2. 记录 **App ID**、**App Secret**（凭证与基础信息页）
3. 在 **权限管理** 中开通以下权限，并提交 **版本发布** 由管理员审批：

| 权限标识 | 用途 |
|---------|------|
| `bitable:app` | 读写多维表格 |
| `base:record:retrieve` | 检索记录 |
| `drive:drive` | 上传附件（音频分片上传） |

4. 将 App ID / App Secret 写入 `.env`：

```bash
cp .env.example .env
```

```env
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

5. 验证凭证与 API 连通性：

```bash
npm run verify-feishu
```

#### 2.2 配置多维表格

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

**Base Token 获取方式：** 打开多维表格，浏览器地址栏中 `/base/` 后面即为 `baseToken`。各表的 `tableId` 可在表设置或 URL 中查看。

每月新建 Base 后，更新 `feishu.config.json` 中的 `month`、`baseToken` 和各 `tableId`。

> **注意：** 自建应用使用 `tenant_access_token`，代表企业身份访问。请确保目标 Base 属于同一飞书企业，且应用权限已由管理员审批通过。

### 3. 首次登录千牛

首次运行需要手动登录，会打开 Chrome 并等待登录：

```bash
npm run task-barrage -- --date yesterday
```

登录成功后，会话保存在 `.chrome-profile/`，后续可加 `--skip-login`。

> **注意**：运行脚本时不要手动打开使用同一 profile 的 Chrome，否则 Playwright 无法启动。

## 定时任务配置

### 推荐执行时间（东八区）

直播时段为 **08:00 – 次日 01:06**，脚本安排在剩余时间（01:06 – 08:00）执行，处理**昨天**已结束的场次。

| 任务 | 建议时间 | 处理数据 |
|------|---------|---------|
| 任务 1 `task-barrage` | 每天 **01:40** | 昨天直播（转码 + 弹幕） |
| 任务 2 `task-audio` | 每天 **07:00** | 昨天直播（视频 + 音频） |

任务 2 比任务 1 晚约 **5.5 小时**，给转码留出时间，并在 **08:00 开播前**完成。若转码较慢，可将任务 2 延后到 07:30。

### macOS / Linux（crontab）

```bash
crontab -e
```

```cron
# 任务 1：转码 + 弹幕（每天 01:40，处理昨天）
40 1 * * * cd /path/to/qianniu_get_data && /usr/local/bin/npm run task-barrage -- --date yesterday --skip-login >> logs/task-barrage.log 2>&1

# 任务 2：下载视频 + 转音频 + 上传（每天 07:00，处理昨天）
0 7 * * * cd /path/to/qianniu_get_data && /usr/local/bin/npm run task-audio -- --date yesterday --skip-login >> logs/task-audio.log 2>&1
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
| `Qianniu-Task-Barrage` | 每天 01:40 | 转码 + 弹幕 |
| `Qianniu-Task-Audio` | 每天 07:00 | 下载 + 音频 + 上传 |

自定义时间：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows/install-scheduled-tasks.ps1 -BarrageTime 01:40 -AudioTime 07:00
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
- 触发器：每天 01:40

**任务 2 — 千牛音频**
- 程序：`scripts\windows\run-task-audio.bat`
- 起始于：项目目录
- 触发器：每天 07:00

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
npm run verify-feishu          # 验证飞书自建应用凭证与 Base 连通性
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
├── feishu.js            # 飞书多维表格业务逻辑
├── feishu-api.js        # 飞书自建应用 API 封装
├── verify-feishu.js     # 部署时验证飞书凭证
├── .env.example         # 飞书凭证模板
├── feishu.config.json   # 多维表格配置（本地，不提交 git）
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

- 先运行 `npm run verify-feishu`，确认 `.env` 凭证正确且权限已审批
- 检查 `feishu.config.json` 中 `baseToken`、`tableId` 是否与当月 Base 一致
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
