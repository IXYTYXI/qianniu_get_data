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

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$BarrageBat = Join-Path $ProjectRoot "scripts\windows\run-task-barrage.bat"
$AudioBat = Join-Path $ProjectRoot "scripts\windows\run-task-audio.bat"

if (-not (Test-Path $BarrageBat)) { throw "未找到: $BarrageBat" }
if (-not (Test-Path $AudioBat)) { throw "未找到: $AudioBat" }

$TaskBarrage = "Qianniu-Task-Barrage"
$TaskAudio = "Qianniu-Task-Audio"

function Remove-ScheduledTaskIfExists {
  param([string]$Name)

  & schtasks.exe /Query /TN $Name *> $null
  if ($LASTEXITCODE -ne 0) { return }

  & schtasks.exe /Delete /TN $Name /F *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "删除旧任务失败: $Name (exit $LASTEXITCODE)"
  }
}

function Register-DailyTask {
  param(
    [string]$Name,
    [string]$BatPath,
    [string]$Time,
    [string]$Description
  )

  Remove-ScheduledTaskIfExists -Name $Name

  # 路径含空格（如 Program Files）时，用 cmd.exe 包装更稳妥
  $taskRun = "cmd.exe /c `"`"$BatPath`"`""

  & schtasks.exe /Create `
    /TN $Name `
    /TR $taskRun `
    /SC DAILY `
    /ST $Time `
    /RL HIGHEST `
    /F `
    /RU $env:USERNAME *> $null

  if ($LASTEXITCODE -ne 0) {
    throw "注册任务失败: $Name (exit $LASTEXITCODE)"
  }

  Write-Host "已注册: $Name"
  Write-Host "  时间: 每天 $Time"
  Write-Host "  脚本: $BatPath"
  Write-Host "  说明: $Description"
  Write-Host ""
}

Write-Host "项目目录: $ProjectRoot"
Write-Host ""

Register-DailyTask `
  -Name $TaskBarrage `
  -BatPath $BarrageBat `
  -Time $BarrageTime `
  -Description "转码 + 弹幕导出 + 导入飞书（处理昨天）"

Register-DailyTask `
  -Name $TaskAudio `
  -BatPath $AudioBat `
  -Time $AudioTime `
  -Description "下载视频 + 转音频 + 上传飞书（处理昨天，需等转码完成）"

Write-Host "完成。可在「任务计划程序」中查看:"
Write-Host "  - $TaskBarrage"
Write-Host "  - $TaskAudio"
Write-Host ""
Write-Host "日志目录: $ProjectRoot\logs"
Write-Host "卸载命令: powershell -ExecutionPolicy Bypass -File scripts/windows/uninstall-scheduled-tasks.ps1"
