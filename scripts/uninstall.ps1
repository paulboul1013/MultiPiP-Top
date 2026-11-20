<#
  MultiPiP Top — 移除 Edge Native Messaging host 註冊與檔案
    powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
#>
$ErrorActionPreference = 'Stop'
$HostName = 'com.ztop.multipip'
$key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
$dest = Join-Path $env:LOCALAPPDATA 'MultiPiPTop'

if (Test-Path $key) {
  Remove-Item -Path $key -Recurse -Force
  Write-Host "已移除登錄機碼 $key"
} else {
  Write-Host "登錄機碼不存在，略過"
}

if (Test-Path $dest) {
  try {
    Remove-Item -LiteralPath $dest -Recurse -Force
    Write-Host "已刪除 $dest"
  } catch {
    Write-Warning "無法刪除 $dest（可能有小窗正在使用 pip_host.exe）。關閉所有小窗後再執行一次。"
    exit 1
  }
}
Write-Host "完成。擴充功能本身請到 edge://extensions 移除。"
