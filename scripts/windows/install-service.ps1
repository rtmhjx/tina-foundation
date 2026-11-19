#requires -Version 5.1
<#
  Tina Foundation - register a per-user logon task (preview).

  This is not a Windows Service. It starts the launcher when the selected
  user logs on, which is the closest match to a desktop assistant.

  Examples:
    .\install-service.ps1 -StateDir C:\Tina\state
    .\install-service.ps1 -TaskName TinaFusion -Status
    .\install-service.ps1 -TaskName TinaFusion -Remove
#>
[CmdletBinding()]
param(
    [string]$StateDir = '',
    [string]$TaskName = 'TinaFusion',
    [switch]$Remove,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $StateDir) { $StateDir = Join-Path $Root 'state' }
$StateDir = [IO.Path]::GetFullPath($StateDir)
$runScript = Join-Path $PSScriptRoot 'run.ps1'

function Fail([string]$Text) { Write-Host ('ERROR: ' + $Text) -ForegroundColor Red; exit 1 }

if ($Status) {
    & schtasks /Query /TN $TaskName /V /FO LIST 2>$null
    exit $LASTEXITCODE
}

if ($Remove) {
    & schtasks /Delete /TN $TaskName /F
    exit $LASTEXITCODE
}

if (-not (Test-Path $runScript)) { Fail ('Missing launcher: ' + $runScript) }
if (-not (Test-Path (Join-Path $StateDir 'deployment\config.json'))) {
    Fail ('Missing config in ' + $StateDir + '. Run bootstrap.ps1 first.')
}

$tr = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $runScript + '" -StateDir "' + $StateDir + '"'
Write-Host ('Registering logon task: ' + $TaskName) -ForegroundColor Cyan
Write-Host ('Action: ' + $tr)

& schtasks /Create /TN $TaskName /SC ONLOGON /RL LIMITED /TR $tr /F
if ($LASTEXITCODE -ne 0) { Fail 'schtasks failed. Open Task Scheduler and inspect the task.' }

Write-Host ''
Write-Host 'Task registered.' -ForegroundColor Green
Write-Host ('Start now:  schtasks /Run /TN ' + $TaskName)
Write-Host ('Inspect:    schtasks /Query /TN ' + $TaskName + ' /V /FO LIST')
Write-Host ('Remove:     .\install-service.ps1 -TaskName ' + $TaskName + ' -Remove')
Write-Host ''
Write-Host 'Note: ONLOGON tasks run only after this user signs in.' -ForegroundColor Yellow
