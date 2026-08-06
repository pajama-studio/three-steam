[CmdletBinding()]
param(
  [string]$Workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$Listen = '0.0.0.0',
  [int]$Port = 47731,
  [int]$DiscoveryPort = 47732,
  [string]$PairCode = '',
  [switch]$ConfigureFirewall,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
  throw 'This bootstrap must run on Windows.'
}

$Workspace = (Resolve-Path $Workspace).Path
$PackagePath = Join-Path $Workspace 'package.json'
if (-not (Test-Path $PackagePath -PathType Leaf)) {
  throw "No package.json found in workspace: $Workspace"
}

foreach ($Tool in @('node', 'npm', 'git')) {
  if (-not (Get-Command $Tool -ErrorAction SilentlyContinue)) {
    throw "$Tool is required and was not found on PATH."
  }
}

$NodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($NodeMajor -lt 20) {
  throw "Node.js 20 or newer is required; found $(& node --version)."
}

if ($ConfigureFirewall) {
  $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
  if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run PowerShell as Administrator when using -ConfigureFirewall.'
  }

  $TcpRule = 'three-steam runner TCP'
  $UdpRule = 'three-steam discovery UDP'
  if (-not (Get-NetFirewallRule -DisplayName $TcpRule -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $TcpRule -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
  }
  if (-not (Get-NetFirewallRule -DisplayName $UdpRule -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $UdpRule -Direction Inbound -Action Allow -Protocol UDP -LocalPort $DiscoveryPort -Profile Private | Out-Null
  }
}

Push-Location $Workspace
try {
  if (-not $SkipInstall) {
    & npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
  }
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }

  $RunnerArgs = @(
    'dist/cli/main.js', 'runner', 'serve',
    '--workspace', $Workspace,
    '--listen', $Listen,
    '--port', "$Port",
    '--discovery-port', "$DiscoveryPort",
    '--json'
  )
  if ($PairCode) { $RunnerArgs += @('--pair-code', $PairCode) }

  Write-Host "Starting three-steam runner from $Workspace" -ForegroundColor Cyan
  Write-Host 'Keep this window open. The JSON output contains the one-time pairing code.' -ForegroundColor Yellow
  & node @RunnerArgs
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
