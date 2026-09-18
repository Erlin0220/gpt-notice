param(
  [string]$TargetPath = (Join-Path $env:USERPROFILE "Downloads\chatgpt-task-notifier")
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceManifest = Join-Path $repoRoot "manifest.json"
if (-not (Test-Path $sourceManifest)) { throw "Repository manifest.json not found: $sourceManifest" }
if (-not (Test-Path $TargetPath)) { throw "Installed extension directory not found: $TargetPath" }

$sourceVersion = (Get-Content $sourceManifest -Raw -Encoding UTF8 | ConvertFrom-Json).version
$targetManifest = Join-Path $TargetPath "manifest.json"
$targetVersion = if (Test-Path $targetManifest) { (Get-Content $targetManifest -Raw -Encoding UTF8 | ConvertFrom-Json).version } else { "unknown" }
$buildScript = Join-Path $repoRoot "scripts\build-extension.js"
& node $buildScript
if ($LASTEXITCODE -ne 0) { throw "Extension build failed; installed directory was not modified" }
$distPath = Join-Path $repoRoot "dist"
if (-not (Test-Path (Join-Path $distPath "manifest.json"))) { throw "Incomplete build output: $distPath" }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupPath = "$TargetPath.backup-v$targetVersion-$stamp"
$stagingPath = "$TargetPath.staging-$stamp"

function Assert-SameTree([string]$Expected, [string]$Actual) {
  $expectedRoot = (Resolve-Path $Expected).Path.TrimEnd('\') + '\'
  $actualRoot = (Resolve-Path $Actual).Path.TrimEnd('\') + '\'
  $expectedFiles = @(Get-ChildItem $Expected -File -Recurse | ForEach-Object { $_.FullName.Substring($expectedRoot.Length) })
  $actualFiles = @(Get-ChildItem $Actual -File -Recurse | ForEach-Object { $_.FullName.Substring($actualRoot.Length) })
  if (Compare-Object $expectedFiles $actualFiles) { throw "Extension file list verification failed" }
  foreach ($relative in $expectedFiles) {
    $left = (Get-FileHash (Join-Path $Expected $relative) -Algorithm SHA256).Hash
    $right = (Get-FileHash (Join-Path $Actual $relative) -Algorithm SHA256).Hash
    if ($left -ne $right) { throw "Extension file hash verification failed: $relative" }
  }
}

if (Test-Path $stagingPath) { Remove-Item $stagingPath -Recurse -Force }
try {
  New-Item -ItemType Directory -Path $stagingPath | Out-Null
  Copy-Item (Join-Path $distPath "*") $stagingPath -Recurse -Force
  Assert-SameTree $distPath $stagingPath
} catch {
  if (Test-Path $stagingPath) { Remove-Item $stagingPath -Recurse -Force }
  throw
}

$movedTarget = $false
try {
  Move-Item $TargetPath $backupPath
  $movedTarget = $true
  Move-Item $stagingPath $TargetPath
  Assert-SameTree $distPath $TargetPath
  $installedVersion = (Get-Content (Join-Path $TargetPath "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
  if ($installedVersion -ne $sourceVersion) { throw "Version verification failed: expected $sourceVersion, got $installedVersion" }
} catch {
  if ($movedTarget) {
    if (Test-Path $TargetPath) { Remove-Item $TargetPath -Recurse -Force }
    if (Test-Path $backupPath) { Move-Item $backupPath $TargetPath }
  }
  if (Test-Path $stagingPath) { Remove-Item $stagingPath -Recurse -Force }
  throw
}

Write-Host "Extension updated from v$targetVersion to v$installedVersion"
Write-Host "Backup directory: $backupPath"
Write-Host "Open chrome://extensions/ and reload the extension."
