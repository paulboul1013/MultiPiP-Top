<#
  MultiPiP Top — 註冊 Edge Native Messaging host（僅目前使用者，不需系統管理員）

  1. 把 host\pip_host.exe 複製到 %LOCALAPPDATA%\MultiPiPTop\
  2. 產生 host manifest（allowed_origins 指定擴充功能 ID）
  3. 寫入 HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.ztop.multipip

  用法：
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -ExtensionId <edge://extensions 顯示的 ID>
#>
param(
  # extension\manifest.json 內的 "key" 固定了未封裝載入時的 ID
  [string]$ExtensionId = 'aecflblnefekahejlagpcffnffdflaoh',
  [string]$HostExe = (Join-Path $PSScriptRoot '..\host\pip_host.exe')
)
$ErrorActionPreference = 'Stop'
$HostName = 'com.ztop.multipip'

if ($ExtensionId -notmatch '^[a-p]{32}$') {
  throw "擴充功能 ID 格式不正確：'$ExtensionId'（應為 32 個 a-p 字母）"
}
if (-not (Test-Path $HostExe)) {
  throw "找不到 $HostExe，請先在 WSL 執行 host/build.sh 編譯。"
}

$dest = Join-Path $env:LOCALAPPDATA 'MultiPiPTop'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$exe = Join-Path $dest 'pip_host.exe'
try {
  Copy-Item -LiteralPath $HostExe -Destination $exe -Force
} catch {
  throw "無法覆寫 $exe（可能有小窗正在使用它）。請先關閉所有 MultiPiP 小窗再重試。"
}

$manifestPath = Join-Path $dest "$HostName.json"
$manifest = [ordered]@{
  name            = $HostName
  description     = 'MultiPiP Top always-on-top helper'
  path            = $exe
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
# Edge 需要不含 BOM 的 UTF-8
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

$key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath

Write-Host "已安裝 MultiPiP Top 輔助程式"
Write-Host "  執行檔   : $exe"
Write-Host "  manifest : $manifestPath"
Write-Host "  登錄機碼 : $key"
Write-Host "  擴充功能 : chrome-extension://$ExtensionId/"
Write-Host "已開啟的小窗請按狀態列的「重試」，或重新開啟小窗。"
