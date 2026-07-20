@echo off
rem Windows 定时任务 / 补跑共用环境（由 run-task-*.bat 引用）

rem 无人值守时必须 headless，否则锁屏/无桌面时 Chrome 会秒退
set "PLAYWRIGHT_HEADLESS=1"

rem Profile 放在用户目录，避免 Program Files 无写权限
if not defined CHROME_USER_DATA_DIR (
  set "CHROME_USER_DATA_DIR=%LOCALAPPDATA%\qianniu-chrome-profile"
)
