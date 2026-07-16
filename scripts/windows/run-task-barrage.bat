@echo off
setlocal EnableExtensions

rem 定时任务 1：转码 + 弹幕导出 + 导入飞书
rem 由 Windows 任务计划程序调用，也可手动双击测试

set "ROOT=%~dp0..\.."
cd /d "%ROOT%"

if not exist "logs" mkdir "logs"

set "LOG=logs\task-barrage-%date:~0,4%%date:~5,2%%date:~8,2%.log"

echo.>>"%LOG%"
echo ==================================================>>"%LOG%"
echo [%date% %time%] task-barrage start>>"%LOG%"
echo ROOT=%CD%>>"%LOG%"

call npm run task-barrage -- --date yesterday --skip-login >>"%LOG%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

echo [%date% %time%] task-barrage end, exit=%EXIT_CODE%>>"%LOG%"
exit /b %EXIT_CODE%
