<#
.SYNOPSIS
  Builds a signed DelphEye release: the installer plus latest.json for auto-updates.

.DESCRIPTION
  1. Bump "version" in src-tauri/tauri.conf.json (and package.json / Cargo.toml to match).
  2. Run:  powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Notes "What changed"
  3. Create a GitHub release tagged v<version> and attach the two files the script prints:
     DelphEye_<version>_x64-setup.exe and latest.json.

  Installed copies look for
  https://github.com/<owner>/<repo>/releases/latest/download/latest.json
  and offer the update. The signing key stays in %USERPROFILE%\.tauri — never in the repo.
  Losing it means installed copies can no longer be updated, so keep a backup.
#>
param(
  [string]$Notes = "",
  [string]$Key = "$env:USERPROFILE\.tauri\delpheye.key"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path $Key)) { throw "Signing key not found: $Key" }
$conf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$version = $conf.version
$endpoint = $conf.plugins.updater.endpoints[0]
if ($endpoint -match "OWNER/REPO") { throw "Set the GitHub owner/repo in src-tauri\tauri.conf.json (plugins.updater.endpoints) first." }
if ($endpoint -notmatch "github\.com/([^/]+)/([^/]+)/") { throw "Unexpected updater endpoint: $endpoint" }
$owner = $Matches[1]; $repo = $Matches[2]

$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $Key -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
& npm.cmd run tauri build
if ($LASTEXITCODE -ne 0) { throw "Build failed" }

$bundle = "$env:USERPROFILE\.cargo-target\delpheye\release\bundle\nsis"
$setup = Join-Path $bundle "DelphEye_${version}_x64-setup.exe"
$sig = "$setup.sig"
if (-not (Test-Path $sig)) { throw "No signature next to the installer: $sig" }

$manifest = [ordered]@{
  version  = $version
  notes    = $Notes
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = (Get-Content $sig -Raw).Trim()
      url       = "https://github.com/$owner/$repo/releases/download/v$version/DelphEye_${version}_x64-setup.exe"
    }
  }
}
$json = Join-Path $bundle "latest.json"
# UTF-8 without a byte-order mark: Windows PowerShell's "utf8" adds one, which the updater rejects.
[System.IO.File]::WriteAllText($json, ($manifest | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
Write-Host ""
Write-Host "Release v$version is ready. Attach these two files to a GitHub release tagged v${version}:"
Write-Host "  $setup"
Write-Host "  $json"
