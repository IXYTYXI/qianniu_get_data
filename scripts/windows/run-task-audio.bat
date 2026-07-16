@echo off
setlocal EnableExtensions

rem 定时任务 2：下载视频 + ffmpeg 转音频 + 上传飞书
rem 由 Windows 任务计划程序调用，也可手动双击测试

set "ROOT=%~dp0..\.."
cd /d "%ROOT%"

rem 若未在 .env 中配置 FFMPEG_PATH，可在此取消注释并填写实际路径
rem set "FFMPEG_PATH=D:\tools\ffmpeg\bin\ffmpeg.exe"

if not exist "logs" mkdir "logs"

set "LOG=logs\task-audio-%date:~0,4%%date:~5,2%%date:~8,2%.log"

echo.>>"%LOG%"
echo ==================================================>>"%LOG%"
echo [%date% %time%] task-audio start>>"%LOG%"
echo ROOT=%CD%>>"%LOG%"

call npm run task-audio -- --date yesterday --skip-login >>"%LOG%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

echo [%date% %time%] task-audio end, exit=%EXIT_CODE%>>"%LOG%"
exit /b %EXIT_CODE%
