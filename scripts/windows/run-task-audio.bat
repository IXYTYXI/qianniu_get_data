@echo off
setlocal EnableExtensions

rem 定时任务 2：下载视频 + ffmpeg 转音频 + 上传飞书
rem 由 Windows 任务计划程序调用，也可手动双击测试

chcp 65001 >nul

set "ROOT=%~dp0..\.."
cd /d "%ROOT%"

rem 若未在 .env 中配置 FFMPEG_PATH，可在此取消注释并填写实际路径
rem set "FFMPEG_PATH=D:\tools\ffmpeg\bin\ffmpeg.exe"

if not exist "logs" mkdir "logs"

for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "Get-Date -Format 'yyyyMMdd'"`) do set "LOGDATE=%%I"
set "LOG=logs\task-audio-%LOGDATE%.log"

echo.>>"%LOG%"
echo ==================================================>>"%LOG%"
echo [%date% %time%] task-audio start>>"%LOG%"
echo ROOT=%CD%>>"%LOG%"
where node >>"%LOG%" 2>&1
where npm >>"%LOG%" 2>&1
node -e "const c=require('./config'); console.log('chrome:', c.chromePath); console.log('ffmpeg:', c.ffmpegPath);" >>"%LOG%" 2>&1

call npm run task-audio -- --date yesterday --skip-login >>"%LOG%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

echo [%date% %time%] task-audio end, exit=%EXIT_CODE%>>"%LOG%"
exit /b %EXIT_CODE%
