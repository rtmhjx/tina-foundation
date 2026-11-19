#requires -Version 5.1
<#
  Tina Foundation - Windows launcher (preview).

  Examples:
    .\run.ps1
    .\run.ps1 -StateDir C:\Tina\state
    .\run.ps1 -Port 7789 -OpenBrowser
    .\run.ps1 -CheckOnly
#>
[CmdletBinding()]
param(
    [string]$StateDir = '',
    [int]$Port = 0,
    [switch]$OpenBrowser,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $StateDir) { $StateDir = Join-Path $Root 'state' }
$StateDir = [IO.Path]::GetFullPath($StateDir)
$config = Join-Path $StateDir 'deployment\config.json'
$envFile = Join-Path $StateDir 'deployment\.env'
$runtime = Join-Path $Root 'runtime\dsh-0.1.5-rc.2'

function Fail([string]$Text) { Write-Host ('ERROR: ' + $Text) -ForegroundColor Red; exit 1 }

if (-not (Test-Path $config)) { Fail ('Missing config: ' + $config + '. Run scripts\windows\bootstrap.ps1 first.') }
if (-not (Test-Path $runtime)) { Fail ('Missing DSH runtime: ' + $runtime) }

$env:CORTICO_FUSION_STATE = $StateDir
if ($Port -gt 0) { $env:CORTICO_FUSION_PORT = [string]$Port }

Write-Host 'Tina Foundation / Windows launcher' -ForegroundColor White
Write-Host ('Root:  ' + $Root)
Write-Host ('State: ' + $StateDir)
Write-Host ('Config: ' + $config)
if (Test-Path $envFile) { Write-Host ('Env:    ' + $envFile) } else { Write-Host 'Env:    (missing; provider keys will be unavailable)' -ForegroundColor Yellow }
Write-Host ('Port:  ' + $(if ($Port -gt 0) { $Port } else { 'from config.json' }))

if ($CheckOnly) {
    Write-Host ''
    Write-Host 'Check-only mode: configuration and runtime are present.' -ForegroundColor Yellow
    exit 0
}

if ($OpenBrowser) {
    $url = 'http://127.0.0.1:' + $(if ($Port -gt 0) { $Port } else { 7789 })
    Start-Process $url | Out-Null
}

Push-Location $Root
try {
    & node 'src\fusion-launcher.mjs'
} finally {
    Pop-Location
}
