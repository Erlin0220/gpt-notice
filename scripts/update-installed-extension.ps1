param(
  [string]$TargetPath = (Join-Path $env:USERPROFILE "Downloads\chatgpt-task-notifier")
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceManifest = Join-Path $repoRoot "manifest.json"
if (-not (Test-Path $sourceManifest)) { throw "未找到仓库 manifest.json：$sourceManifest" }
if (-not (Test-Path $TargetPath)) { throw "未找到已安装扩展目录：$TargetPath" }

$sourceVersion = (Get-Content $sourceManifest -Raw -Encoding UTF8 | ConvertFrom-Json).version
$targetManifest = Join-Path $TargetPath "manifest.json"
$targetVersion = if (Test-Path $targetManifest) { (Get-Content $targetManifest -Raw -Encoding UTF8 | ConvertFrom-Json).version } else { "unknown" }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupPath = "$TargetPath.backup-v$targetVersion-$stamp"
Copy-Item $TargetPath $backupPath -Recurse -Force

$releaseFiles = @(
  "manifest.json", "background.js", "chatgpt-dom.js", "content.js", "diagnostics.js", "popup.js", "popup.html", "popup.css",
  "queue-core.js", "queue-lease-guard.js", "queue-ui.js", "queue.css", "queue-v060.js", "README.md", "CHANGELOG.md", "PRIVACY.md"
)
Get-ChildItem $TargetPath -Force | Remove-Item -Recurse -Force
foreach ($file in $releaseFiles) {
  $source = Join-Path $repoRoot $file
  if (-not (Test-Path $source)) { throw "缺少发布文件：$source" }
  Copy-Item $source (Join-Path $TargetPath $file) -Force
}
Copy-Item (Join-Path $repoRoot "icons") (Join-Path $TargetPath "icons") -Recurse -Force

$installedVersion = (Get-Content (Join-Path $TargetPath "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($installedVersion -ne $sourceVersion) { throw "更新校验失败：期望 $sourceVersion，实际 $installedVersion" }
Write-Host "扩展已从 v$targetVersion 更新到 v$installedVersion"
Write-Host "备份目录：$backupPath"
Write-Host "请打开 chrome://extensions/ 并点击该扩展的‘重新加载’。"
