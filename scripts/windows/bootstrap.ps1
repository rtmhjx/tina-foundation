#requires -Version 5.1
<#
  Tina Foundation - Windows bootstrap (preview).

  Checks the toolchain, installs the host and upstream dependencies,
  builds the web console and native overlay, then initializes a state dir.

  The DSH runtime closure is NOT shipped in the source repository.
  Put it at runtime\dsh-0.1.5-rc.2, or pass -RuntimeDir <path>.

  Examples:
    .\bootstrap.ps1 -CheckOnly
    .\bootstrap.ps1 -RuntimeDir C:\Tina\runtime\dsh-0.1.5-rc.2
    .\bootstrap.ps1 -SkipNative
#>
[CmdletBinding()]
param(
    [string]$StateDir = '',
    [string]$RuntimeDir = '',
    [switch]$SkipNative,
    [switch]$Offline,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $StateDir) { $StateDir = Join-Path $Root 'state' }
if (-not $RuntimeDir) { $RuntimeDir = Join-Path $Root 'runtime\dsh-0.1.5-rc.2' }
$StateDir = [IO.Path]::GetFullPath($StateDir)
$RuntimeDir = [IO.Path]::GetFullPath($RuntimeDir)

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host ('==> ' + $Text) -ForegroundColor Cyan
}
function Write-Ok([string]$Text) { Write-Host ('  OK  ' + $Text) -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host ('  !!  ' + $Text) -ForegroundColor Yellow }
function Fail([string]$Text) { Write-Host ('ERROR: ' + $Text) -ForegroundColor Red; exit 1 }

function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$WorkDir) {
    Write-Host ('  $ ' + $File + ' ' + ($Arguments -join ' ')) -ForegroundColor DarkGray
    Push-Location $WorkDir
    try {
        & $File @Arguments
        if ($LASTEXITCODE -ne 0) { Fail ("Command failed with exit code {0}: {1}" -f $LASTEXITCODE, $File) }
    } finally {
        Pop-Location
    }
}

Write-Host 'Tina Foundation / Windows bootstrap (preview)' -ForegroundColor White
Write-Host ('Root:  ' + $Root)
Write-Host ('State: ' + $StateDir)
Write-Host ('Runtime: ' + $RuntimeDir)

Write-Step 'Toolchain'
$nodeVersion = (& node -v 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $nodeVersion) { Fail 'Node.js was not found on PATH.' }
$nodeVersion = $nodeVersion.Trim()
if ($nodeVersion -notmatch '^v24\.(\d+)\.') { Fail ('Node.js 24.x is required, found ' + $nodeVersion) }
if ([int]$Matches[1] -lt 12) { Fail ('Node.js 24.12+ is required, found ' + $nodeVersion) }
Write-Ok ('node ' + $nodeVersion)

$pnpmVersion = (& pnpm -v 2>$null)
$pnpmOk = ($LASTEXITCODE -eq 0 -and $pnpmVersion)
if (-not $pnpmOk) {
    Write-Warn 'pnpm was not found. Install it with: npm install -g pnpm@11.28.6'
} else {
    $pnpmVersion = $pnpmVersion.Trim()
    if (-not $pnpmVersion.StartsWith('11.')) { Write-Warn ('pnpm 11.x is recommended, found ' + $pnpmVersion) }
    else { Write-Ok ('pnpm ' + $pnpmVersion) }
}

$gitVersion = (& git --version 2>$null)
if ($LASTEXITCODE -eq 0 -and $gitVersion) { Write-Ok $gitVersion.Trim() } else { Write-Warn 'Git was not found on PATH.' }

$tarVersion = (& tar --version 2>$null)
if ($LASTEXITCODE -eq 0 -and $tarVersion) { Write-Ok 'tar available' } else { Write-Warn 'tar was not found; the Windows 10+ built-in tar is recommended.' }

Write-Step 'DSH runtime closure'
$runtimeManifest = Join-Path $RuntimeDir 'package.json'
if (Test-Path $runtimeManifest) {
    Write-Ok ('found ' + $RuntimeDir)
} else {
    Write-Warn ('not found: ' + $RuntimeDir)
    Write-Host '  The source repository does not ship runtime/dsh-0.1.5-rc.2.'
    Write-Host '  Put the DSH runtime closure there, or pass -RuntimeDir <path>.'
    Write-Host '  If you moved an existing closure, repair its links with:'
    Write-Host ('    node scripts\stage-dsh-runtime.mjs --relocate "' + $RuntimeDir + '"')
}

if ($CheckOnly) {
    Write-Host ''
    Write-Host 'Check-only mode: nothing was installed or changed.' -ForegroundColor Yellow
    exit 0
}

if (-not $pnpmOk) { Fail 'pnpm 11.x is required to continue.' }
if (-not $SkipNative -and -not (Test-Path $runtimeManifest)) {
    Fail 'The DSH runtime is required for the native build. Use -SkipNative to build only the host and web console.'
}

Write-Step 'Host dependencies'
Invoke-Checked 'npm' @('ci', '--ignore-scripts') $Root

Write-Step 'Upstream Cortico'
$cortico = Join-Path $Root 'upstream\cortico'
$pnpmArgs = @('install', '--frozen-lockfile')
if ($Offline) { $pnpmArgs += '--offline' }
Invoke-Checked 'pnpm' $pnpmArgs $cortico
Invoke-Checked 'pnpm' @('run', 'build:web') $cortico

if (-not $SkipNative) {
    Write-Step 'Native DSH overlay'
    Invoke-Checked 'node' @('scripts\build-fusion-native.mjs', $RuntimeDir) $Root
} else {
    Write-Warn 'Skipping the native build (-SkipNative). The runtime must already contain a matching overlay.'
}

Write-Step 'Memory Bot'
$env:CORTICO_FUSION_STATE = $StateDir
Invoke-Checked 'npm' @('run', 'setup:memory') $Root

Write-Step 'Deployment templates'
$deploy = Join-Path $StateDir 'deployment'
New-Item -ItemType Directory -Force -Path $deploy | Out-Null
$configTarget = Join-Path $deploy 'config.json'
if (-not (Test-Path $configTarget)) {
    Copy-Item (Join-Path $Root 'config\config.windows.example.json') $configTarget
    Write-Ok ('wrote ' + $configTarget)
} else {
    Write-Warn ('kept existing ' + $configTarget)
}
$envTarget = Join-Path $deploy '.env'
if (-not (Test-Path $envTarget)) {
    Copy-Item (Join-Path $Root 'config\env.example') $envTarget
    Write-Ok ('wrote ' + $envTarget)
} else {
    Write-Warn ('kept existing ' + $envTarget)
}

Write-Step 'Permissions'
$account = $env:USERDOMAIN + '\' + $env:USERNAME
& icacls $StateDir /inheritance:r /grant:r ($account + ':(OI)(CI)F') | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Ok ('restricted state dir to ' + $account) } else { Write-Warn 'icacls failed; set ACLs manually.' }

Write-Host ''
Write-Host 'Bootstrap complete.' -ForegroundColor Green
Write-Host ('1. Fill in: ' + $envTarget)
Write-Host ('2. Review:  ' + $configTarget)
Write-Host '3. Start:   .\scripts\windows\run.ps1'
Write-Host '4. Console: http://127.0.0.1:7789'
Write-Host ''
Write-Host 'Preview only: this path has not been end-to-end verified on Windows.' -ForegroundColor Yellow
