param(
  [string]$TargetPath = (Join-Path $env:USERPROFILE "Downloads\chatgpt-task-notifier"),
  [switch]$WhatIf
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceManifest = Join-Path $repoRoot "manifest.json"
if (-not (Test-Path -LiteralPath $sourceManifest)) { throw "Repository manifest.json not found: $sourceManifest" }
if (-not (Test-Path -LiteralPath $TargetPath)) { throw "Installed extension directory not found: $TargetPath" }
$targetItem = Get-Item -LiteralPath $TargetPath -Force
if (-not $targetItem.PSIsContainer) { throw "Installed extension target is not a directory: $TargetPath" }
if (($targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Installed extension target cannot be a reparse point: $TargetPath" }
$TargetPath = (Resolve-Path -LiteralPath $TargetPath).Path.TrimEnd('\')

$sourceVersion = (Get-Content -LiteralPath $sourceManifest -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($sourceVersion -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') { throw "Invalid source extension version: $sourceVersion" }
$targetManifest = Join-Path $TargetPath "manifest.json"
$targetVersion = if (Test-Path -LiteralPath $targetManifest) { (Get-Content -LiteralPath $targetManifest -Raw -Encoding UTF8 | ConvertFrom-Json).version } else { "unknown" }
if ($targetVersion -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') { $targetVersion = "unknown" }
$buildScript = Join-Path $repoRoot "scripts\build-extension.js"
& node $buildScript
if ($LASTEXITCODE -ne 0) { throw "Extension build failed; installed directory was not modified" }
$distPath = Join-Path $repoRoot "dist"
if (-not (Test-Path -LiteralPath (Join-Path $distPath "manifest.json"))) { throw "Incomplete build output: $distPath" }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupPath = "$TargetPath.backup-v$targetVersion-$stamp"
$stagingPath = "$TargetPath.staging-$stamp"

if ($WhatIf) {
  Write-Host "Dry run only. Built and validated extension v$sourceVersion."
  Write-Host "Would update: $TargetPath"
  Write-Host "Would create backup: $backupPath"
  return
}

function Assert-SameTree([string]$Expected, [string]$Actual) {
  $expectedRoot = (Resolve-Path -LiteralPath $Expected).Path.TrimEnd('\') + '\'
  $actualRoot = (Resolve-Path -LiteralPath $Actual).Path.TrimEnd('\') + '\'
  $expectedFiles = @(Get-ChildItem -LiteralPath $Expected -File -Recurse | ForEach-Object { $_.FullName.Substring($expectedRoot.Length) })
  $actualFiles = @(Get-ChildItem -LiteralPath $Actual -File -Recurse | ForEach-Object { $_.FullName.Substring($actualRoot.Length) })
  if (Compare-Object $expectedFiles $actualFiles) { throw "Extension file list verification failed" }
  foreach ($relative in $expectedFiles) {
    $left = (Get-FileHash -LiteralPath (Join-Path $Expected $relative) -Algorithm SHA256).Hash
    $right = (Get-FileHash -LiteralPath (Join-Path $Actual $relative) -Algorithm SHA256).Hash
    if ($left -ne $right) { throw "Extension file hash verification failed: $relative" }
  }
}

if (Test-Path -LiteralPath $stagingPath) { Remove-Item -LiteralPath $stagingPath -Recurse -Force }
try {
  New-Item -ItemType Directory -Path $stagingPath | Out-Null
  Get-ChildItem -LiteralPath $distPath -Force | Copy-Item -Destination $stagingPath -Recurse -Force
  Assert-SameTree $distPath $stagingPath
} catch {
  if (Test-Path -LiteralPath $stagingPath) { Remove-Item -LiteralPath $stagingPath -Recurse -Force }
  throw
}

$movedTarget = $false
try {
  Move-Item -LiteralPath $TargetPath -Destination $backupPath
  $movedTarget = $true
  Move-Item -LiteralPath $stagingPath -Destination $TargetPath
  Assert-SameTree $distPath $TargetPath
  $installedVersion = (Get-Content -LiteralPath (Join-Path $TargetPath "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
  if ($installedVersion -ne $sourceVersion) { throw "Version verification failed: expected $sourceVersion, got $installedVersion" }
} catch {
  if ($movedTarget) {
    if (Test-Path -LiteralPath $TargetPath) { Remove-Item -LiteralPath $TargetPath -Recurse -Force }
    if (Test-Path -LiteralPath $backupPath) { Move-Item -LiteralPath $backupPath -Destination $TargetPath }
  }
  if (Test-Path -LiteralPath $stagingPath) { Remove-Item -LiteralPath $stagingPath -Recurse -Force }
  throw
}

Write-Host "Extension updated from v$targetVersion to v$installedVersion"
Write-Host "Backup directory: $backupPath"
Write-Host "Open chrome://extensions/ and reload the extension."
