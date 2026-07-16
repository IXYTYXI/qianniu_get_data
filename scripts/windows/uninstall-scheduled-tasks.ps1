# 卸载 Windows 定时任务
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File scripts/windows/uninstall-scheduled-tasks.ps1

$TaskBarrage = "Qianniu-Task-Barrage"
$TaskAudio = "Qianniu-Task-Audio"

foreach ($name in @($TaskBarrage, $TaskAudio)) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "Not found: $name"
    continue
  }

  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  Write-Host "Removed: $name"
}
