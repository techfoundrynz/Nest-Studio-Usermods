<#
.SYNOPSIS
  Thin wrapper for the Node-based installer, handy from an elevated PowerShell.
  Equivalent to: pnpm install && pnpm run install:app -- <args>
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\install.ps1            # interactive menu
  powershell -ExecutionPolicy Bypass -File tools\install.ps1 --install  # non-interactive
#>
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  if (Get-Command corepack -ErrorAction SilentlyContinue) { corepack enable | Out-Null }
  else { Write-Host "pnpm not found. Install it with: npm install -g pnpm" -ForegroundColor Red; exit 1 }
}
Push-Location $Root
try {
  if (-not (Test-Path (Join-Path $Root "node_modules"))) { pnpm install; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
  pnpm exec tsx packages/installer/src/install.ts @args
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
