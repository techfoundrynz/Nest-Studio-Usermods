<#
.SYNOPSIS
  Installs (or re-installs after an app update) the Nest Studio user-mod loader.

.DESCRIPTION
  Nest Studio's Electron build only loads code from resources\app.asar, so the loader is injected by
  rebuilding that archive:
    1. Extract resources\app.asar into <mod>\build\app   (no admin needed; skipped if unchanged)
    2. Apply three idempotent, marker-based patches in the staging copy:
         out\main\index.js       -> first statement requires <mod>\loader\main.js
         out\preload\index.js    -> appends <mod>\loader\preload.js (window.usermod + UI mod injection)
         out\renderer\index.html -> adds file: to the CSP script-src so <mod>\ui\*.js may load
    3. Repack to <mod>\build\app.asar using the original header (unpacked native modules untouched)
    4. Back up the original to resources\app.asar.orig (once per app version) and copy the patched
       archive over resources\app.asar            (this step needs an elevated PowerShell)

  Nest Studio must be closed. Re-run after every app update. -Uninstall restores app.asar.orig.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File "$env:APPDATA\Nest Studio\mod\tools\install.ps1"
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = "C:\Program Files\nest-studio",
  [switch]$Force,
  [switch]$Uninstall,
  [switch]$BuildOnly
)

$ErrorActionPreference = "Stop"
$ModDir = Split-Path -Parent $PSScriptRoot
$LoaderMain = Join-Path $ModDir "loader\main.js"
$LoaderPreload = Join-Path $ModDir "loader\preload.js"
$AsarTool = Join-Path $PSScriptRoot "asar-tool.js"
$Resources = Join-Path $InstallRoot "resources"
$Asar = Join-Path $Resources "app.asar"
$AsarOrig = Join-Path $Resources "app.asar.orig"
$BuildDir = Join-Path $ModDir "build"
$StagingDir = Join-Path $BuildDir "app"
$PackedAsar = Join-Path $BuildDir "app.asar"
$StampFile = Join-Path $BuildDir "stamp.json"

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "ERROR: $text" -ForegroundColor Red; exit 1 }
function Get-Sha($file) { (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
function Assert-Closed {
  $running = Get-Process -Name "nest-studio", "Nest Studio Service" -ErrorAction SilentlyContinue
  if ($running) { Fail "Nest Studio is running (pids: $($running.Id -join ', ')). Quit it fully first." }
}
function Assert-Writable {
  $probe = Join-Path $Resources ".usermod-write-probe"
  try { Set-Content -LiteralPath $probe -Value "probe" -ErrorAction Stop; Remove-Item -LiteralPath $probe -Force }
  catch { Fail "cannot write to $Resources. Run this from an elevated (Administrator) PowerShell." }
}

if (-not (Test-Path $Asar)) { Fail "app.asar not found at $Asar (wrong -InstallRoot?)" }

# --------------------------------------------------------------- uninstall
if ($Uninstall) {
  Assert-Closed
  Assert-Writable
  if (-not (Test-Path $AsarOrig)) { Fail "no backup at $AsarOrig; nothing to restore" }
  Copy-Item -LiteralPath $AsarOrig -Destination $Asar -Force
  Remove-Item -LiteralPath $AsarOrig -Force
  Write-Host "Restored original app.asar. Your mods in $ModDir are untouched." -ForegroundColor Green
  exit 0
}

if (-not (Test-Path $LoaderMain)) { Fail "loader not found at $LoaderMain" }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "node.exe not found on PATH; install Node.js" }

# ------------------------------------------------- identify the installed asar
# Content-based: the installed archive is "patched" if its main script carries our marker. A patched
# archive is never treated as the original (that would overwrite app.asar.orig with a patched copy).
$stamp = if (Test-Path $StampFile) { Get-Content $StampFile -Raw | ConvertFrom-Json } else { $null }
$currentSha = Get-Sha $Asar
$installedMain = (& $node.Source $AsarTool cat $Asar "out/main/index.js" 2>$null | Out-String)
$installedPatched = $installedMain -match [regex]::Escape("/* NEST-USERMOD-MAIN */")
$installedLoader = $null
if ($installedPatched -and $installedMain -match 'NEST_MOD_LOADER \|\| ("(?:[^"\\]|\\.)*")') { $installedLoader = $Matches[1] | ConvertFrom-Json }
$isCurrentBuild = $stamp -and $stamp.packedSha -eq $currentSha
$loaderMatches = $installedLoader -and ($installedLoader -ieq $LoaderMain)
if ($isCurrentBuild -and $loaderMatches -and -not $Force) {
  Write-Host "Installed app.asar already carries this loader (sha $($currentSha.Substring(0,12))). Use -Force to rebuild." -ForegroundColor Green
  exit 0
}
if ($installedPatched) {
  if (-not (Test-Path $AsarOrig)) { Fail "app.asar is already patched (loader: $installedLoader) but $AsarOrig is missing; cannot rebuild safely" }
  $SourceAsar = $AsarOrig
  if ($installedLoader -and -not $loaderMatches) { Write-Step "installed loader path is $installedLoader; repointing to $LoaderMain" }
} else {
  $SourceAsar = $Asar
}
$sourceSha = Get-Sha $SourceAsar
Write-Step "source archive: $SourceAsar (sha $($sourceSha.Substring(0,12)))"

# ------------------------------------------------------------------ extract
$needExtract = $Force -or -not (Test-Path (Join-Path $StagingDir "package.json")) -or ($stamp.sourceSha -ne $sourceSha)
if ($needExtract) {
  if (Test-Path $StagingDir) {
    Write-Step "removing previous staging dir"
    Remove-Item -LiteralPath $StagingDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null
  Write-Step "extracting to $StagingDir"
  & $node.Source $AsarTool extract $SourceAsar $StagingDir
  if ($LASTEXITCODE -ne 0) { Fail "asar extraction failed" }
} else {
  Write-Step "staging dir is current; skipping extraction"
}

# --------------------------------------------------------------- patch: main
$mainFile = Join-Path $StagingDir "out\main\index.js"
$mainMarker = "/* NEST-USERMOD-MAIN */"
$main = [System.IO.File]::ReadAllText($mainFile)
$loaderPathJs = ($LoaderMain | ConvertTo-Json)
$inject = "$mainMarker try { require(process.env.NEST_MOD_LOADER || $loaderPathJs); } catch (e) { console.error(`"[usermod] loader failed to start`", e); }"
if ($main.Contains($mainMarker)) {
  # Replace the whole marker line so a changed loader location is picked up.
  $pattern = [regex]::Escape($mainMarker) + "[^`r`n]*"
  $updated = [regex]::new($pattern).Replace($main, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $inject }, 1)
  if ($updated -ne $main) {
    [System.IO.File]::WriteAllText($mainFile, $updated, (New-Object System.Text.UTF8Encoding($false)))
    Write-Step "updated main process loader path"
  } else {
    Write-Step "main process already patched"
  }
} else {
  if ($main.StartsWith('"use strict";')) {
    $main = '"use strict";' + "`r`n" + $inject + $main.Substring('"use strict";'.Length)
  } else {
    $main = $inject + "`r`n" + $main
  }
  [System.IO.File]::WriteAllText($mainFile, $main, (New-Object System.Text.UTF8Encoding($false)))
  Write-Step "patched main process"
}

# ------------------------------------------------------------ patch: preload
$preloadFile = Join-Path $StagingDir "out\preload\index.js"
$begin = "// ==== NEST-USERMOD-PRELOAD-BEGIN ===="
$end = "// ==== NEST-USERMOD-PRELOAD-END ===="
$block = [System.IO.File]::ReadAllText($LoaderPreload).TrimEnd()
if (-not $block.StartsWith($begin) -or -not $block.EndsWith($end)) { Fail "loader\preload.js must start/end with the BEGIN/END markers" }
$preload = [System.IO.File]::ReadAllText($preloadFile)
$bi = $preload.IndexOf($begin)
$ei = $preload.IndexOf($end)
if ($bi -ge 0 -and $ei -gt $bi) {
  $preload = $preload.Substring(0, $bi) + $block + $preload.Substring($ei + $end.Length)
  Write-Step "refreshed preload bridge block"
} else {
  $preload = $preload.TrimEnd() + "`r`n" + $block + "`r`n"
  Write-Step "appended preload bridge block"
}
[System.IO.File]::WriteAllText($preloadFile, $preload, (New-Object System.Text.UTF8Encoding($false)))

# ---------------------------------------------------------------- patch: csp
$htmlFile = Join-Path $StagingDir "out\renderer\index.html"
$html = [System.IO.File]::ReadAllText($htmlFile)
if ($html -match "script-src 'self' file:") {
  Write-Step "CSP already allows file: scripts"
} elseif ($html -match "script-src 'self';") {
  $html = $html -replace "script-src 'self';", "script-src 'self' file:;"
  [System.IO.File]::WriteAllText($htmlFile, $html, (New-Object System.Text.UTF8Encoding($false)))
  Write-Step "patched CSP script-src in index.html"
} else {
  Write-Host "WARNING: could not find script-src 'self'; in index.html - UI mods may be blocked by CSP" -ForegroundColor Yellow
}

# --------------------------------------------------------------------- pack
Write-Step "repacking archive"
& $node.Source $AsarTool pack $SourceAsar $StagingDir $PackedAsar
if ($LASTEXITCODE -ne 0) { Fail "asar packing failed" }
$packedSha = Get-Sha $PackedAsar
@{ sourceSha = $sourceSha; packedSha = $packedSha; builtAt = (Get-Date).ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $StampFile -Encoding UTF8
$pkg = Get-Content (Join-Path $StagingDir "package.json") -Raw | ConvertFrom-Json

if ($BuildOnly) {
  Write-Host "Built $PackedAsar for Nest Studio $($pkg.version) (not installed; -BuildOnly)." -ForegroundColor Green
  exit 0
}

# ------------------------------------------------------------------ install
Assert-Closed
Assert-Writable
if ($SourceAsar -eq $Asar) {
  Write-Step "backing up original to $AsarOrig"
  Copy-Item -LiteralPath $Asar -Destination $AsarOrig -Force
}
Write-Step "installing patched archive"
Copy-Item -LiteralPath $PackedAsar -Destination $Asar -Force
$staleDir = Join-Path $Resources "app"
if (Test-Path (Join-Path $staleDir ".usermod-stamp.json")) {
  Write-Step "removing stale resources\app directory from the earlier install method"
  Remove-Item -LiteralPath $staleDir -Recurse -Force
}

Write-Host ""
Write-Host "Nest Studio $($pkg.version) is now patched for user mods." -ForegroundColor Green
Write-Host "  archive : $Asar  (original kept at $AsarOrig)"
Write-Host "  mod dir : $ModDir"
Write-Host "  log     : $(Join-Path $ModDir 'usermod.log')"
Write-Host "Start Nest Studio normally. Re-run this script after any app update; -Uninstall restores the original."
