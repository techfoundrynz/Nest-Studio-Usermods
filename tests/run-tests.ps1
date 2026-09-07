# Syntax-checks every JS file and runs the loader harness. Exit code 0 = all good.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$failed = 0
Get-ChildItem -Path $root -Recurse -Filter *.js | Where-Object { $_.FullName -notmatch '\\build\\' } | ForEach-Object {
  & node --check $_.FullName
  if ($LASTEXITCODE -ne 0) { Write-Host "SYNTAX FAIL $($_.FullName)" -ForegroundColor Red; $failed++ }
}
Write-Host "syntax check done ($failed failure(s))"
& node (Join-Path $PSScriptRoot "harness.js")
if ($LASTEXITCODE -ne 0) { $failed++ }
exit $failed
