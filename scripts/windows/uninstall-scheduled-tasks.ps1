# 卸载 Windows 定时任务
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File scripts/windows/uninstall-scheduled-tasks.ps1

$TaskBarrage = "Qianniu-Task-Barrage"
$TaskAudio = "Qianniu-Task-Audio"

foreach ($name in @($TaskBarrage, $TaskAudio)) {
  schtasks /Delete /TN $name /F 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "已删除: $name"
  } else {
    Write-Host "未找到或已删除: $name"
  }
}
