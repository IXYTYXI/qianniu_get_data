@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem 补跑指定日期的视频下载 + 音频导出 + 上传飞书
rem 用法:
rem   scripts\windows\run-backfill-audio.bat              默认昨天
rem   scripts\windows\run-backfill-audio.bat 2026-07-16   指定日期

chcp 65001 >nul

set "ROOT=%~dp0..\.."
cd /d "%ROOT%"

set "TARGET_DATE=%~1"
if "%TARGET_DATE%"=="" (
  for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "(Get-Date).AddDays(-1).ToString('yyyy-MM-dd')"`) do set "TARGET_DATE=%%I"
)

if not exist "logs" mkdir "logs"

for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "Get-Date -Format 'yyyyMMdd'"`) do set "LOGDATE=%%I"
set "LOG=logs\backfill-audio-%TARGET_DATE%-%LOGDATE%.log"

echo.>>"%LOG%"
echo ==================================================>>"%LOG%"
echo [%date% %time%] backfill-audio start, date=%TARGET_DATE%>>"%LOG%"
echo ROOT=!CD!>>"%LOG%"

call npm run task-audio -- --date %TARGET_DATE% --skip-login >>"%LOG%" 2>&1
set "EXIT_CODE=!ERRORLEVEL!"
if not defined EXIT_CODE set "EXIT_CODE=1"

echo [%date% %time%] backfill-audio end, exit=!EXIT_CODE!>>"%LOG%"
echo 日志: %LOG%
exit /b !EXIT_CODE!
