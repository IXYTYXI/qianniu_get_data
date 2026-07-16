# 注册 Windows 定时任务（两个独立任务，请勿合并）
#
# 用法:
#   cd 项目目录
#   powershell -ExecutionPolicy Bypass -File scripts/windows/install-scheduled-tasks.ps1
#
# 自定义时间:
#   powershell -ExecutionPolicy Bypass -File scripts/windows/install-scheduled-tasks.ps1 -BarrageTime 01:40 -AudioTime 07:00

param(
  [string]$BarrageTime = "01:40",
  [string]$AudioTime = "07:00"
)

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$BarrageBat = Join-Path $ProjectRoot "scripts\windows\run-task-barrage.bat"
$AudioBat = Join-Path $ProjectRoot "scripts\windows\run-task-audio.bat"

if (-not (Test-Path $BarrageBat)) { throw "未找到: $BarrageBat" }
if (-not (Test-Path $AudioBat)) { throw "未找到: $AudioBat" }

$TaskBarrage = "Qianniu-Task-Barrage"
$TaskAudio = "Qianniu-Task-Audio"

function Register-DailyTask {
  param(
    [string]$Name,
    [string]$BatPath,
    [string]$Time,
    [string]$Description,
    [string]$WorkingDirectory
  )

  Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue

  $action = New-ScheduledTaskAction -Execute $BatPath -WorkingDirectory $WorkingDirectory
  $trigger = New-ScheduledTaskTrigger -Daily -At $Time
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 12)
  $principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

  try {
    Register-ScheduledTask `
      -TaskName $Name `
      -Action $action `
      -Trigger $trigger `
      -Settings $settings `
      -Principal $principal `
      -Description $Description `
      -Force | Out-Null
  } catch {
    throw "注册任务失败: $Name`n$($_.Exception.Message)"
  }

  Write-Host "OK: $Name"
  Write-Host "  Time: daily $Time"
  Write-Host "  Script: $BatPath"
  Write-Host "  Note: $Description"
  Write-Host ""
}

Write-Host "Project: $ProjectRoot"
Write-Host ""

Register-DailyTask `
  -Name $TaskBarrage `
  -BatPath $BarrageBat `
  -Time $BarrageTime `
  -WorkingDirectory $ProjectRoot `
  -Description "transcode + barrage export + feishu import (yesterday)"

Register-DailyTask `
  -Name $TaskAudio `
  -BatPath $AudioBat `
  -Time $AudioTime `
  -WorkingDirectory $ProjectRoot `
  -Description "download video + audio export + feishu upload (yesterday)"

Write-Host "Done. Open Task Scheduler to verify:"
Write-Host "  - $TaskBarrage"
Write-Host "  - $TaskAudio"
Write-Host ""
Write-Host "Logs: $ProjectRoot\logs"
Write-Host "Uninstall: powershell -ExecutionPolicy Bypass -File scripts/windows/uninstall-scheduled-tasks.ps1"
