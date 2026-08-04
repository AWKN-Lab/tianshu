#Requires -Version 5.1
<#
AWKN local environment control entry
Source: awkn引擎\awkn-local.ps1 | Daily entry: D:\awkn-lab\awkn-local.ps1

Usage:
  .\awkn-local.ps1 start    Start local AWKN env (auto-launch Memory OS Core if offline)
  .\awkn-local.ps1 status   Show Memory OS / engine config status
  .\awkn-local.ps1 doctor   Full connection diagnosis (protocol + auth + project + Receipt + Render)
  .\awkn-local.ps1 stop     Stop Memory OS Core

Design:
  - Memory OS listens on 127.0.0.1:8765 only, data never leaves this machine
  - Memory OS config maintained once: awkn引擎\runtime\.env (auto-loaded by MCP server)
  - Daily use needs no script: IDE calls engine via MCP, engine auto reads/writes Memory OS
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'status', 'doctor', 'stop')]
  [string]$Command = 'status'
)

$ErrorActionPreference = 'Stop'

# ===== Paths & constants =====
$LabRoot      = 'D:\awkn-lab'
$MemoryOsRoot = Join-Path $LabRoot 'AWKN Memory OS'
$EngineRoot   = Join-Path $LabRoot 'awkn引擎'
$RuntimeRoot  = Join-Path $EngineRoot 'runtime'
$AwknExe      = Join-Path $MemoryOsRoot '.venv-release\Scripts\awkn.exe'
$CoreUrl      = 'http://127.0.0.1:8765'
$ProtocolUrl  = "$CoreUrl/api/v1/protocol"
$TokenPath    = Join-Path $MemoryOsRoot 'data\session.token'
$EnvFile      = Join-Path $RuntimeRoot '.env'
$StdOutLog    = Join-Path $MemoryOsRoot 'data\core.stdout.log'
$StdErrLog    = Join-Path $MemoryOsRoot 'data\core.stderr.log'
$TsxCmd       = Join-Path $RuntimeRoot 'node_modules\.bin\tsx.cmd'

function Get-ProtocolInfo {
  try {
    $response = Invoke-WebRequest -Uri $ProtocolUrl -UseBasicParsing -TimeoutSec 3
    return @{ Online = $true; Body = $response.Content }
  } catch {
    return @{ Online = $false; Body = $null }
  }
}

function Get-EnvFileValues {
  $values = @{}
  if (Test-Path $EnvFile) {
    # Read as UTF-8 explicitly: Windows PowerShell 5.1 defaults to ANSI and mangles .env with CJK comments
    foreach ($line in [System.IO.File]::ReadAllLines($EnvFile, [System.Text.UTF8Encoding]::new($false))) {
      if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$') {
        $values[$Matches[1]] = $Matches[2]
      }
    }
  }
  return $values
}

function Start-Core {
  Write-Host "[INFO] Starting Memory OS Core ..."
  Start-Process -FilePath $AwknExe `
    -ArgumentList 'serve' `
    -WorkingDirectory $MemoryOsRoot `
    -RedirectStandardOutput $StdOutLog `
    -RedirectStandardError $StdErrLog `
    -WindowStyle Hidden

  $ready = $false
  for ($attempt = 1; $attempt -le 20; $attempt++) {
    Start-Sleep -Seconds 1
    $probe = Get-ProtocolInfo
    if ($probe.Online) { $ready = $true; break }
  }
  if (-not $ready) {
    Write-Host "[FAIL] Memory OS Core not ready in 20s, check log: $StdErrLog" -ForegroundColor Red
    exit 1
  }
  Write-Host "[OK] Memory OS Core online: $CoreUrl" -ForegroundColor Green
}

function Show-Status {
  $protocol = Get-ProtocolInfo
  if ($protocol.Online) {
    Write-Host "[OK] Memory OS ONLINE $CoreUrl" -ForegroundColor Green
    Write-Host ("Protocol: " + $protocol.Body)
  } else {
    Write-Host "[WARN] Memory OS OFFLINE $CoreUrl" -ForegroundColor Yellow
  }

  $procs = @(Get-CimInstance Win32_Process -Filter "Name='awkn.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -like '*AWKN Memory OS*' })
  $countText = if ($procs.Count -gt 0) { "$($procs.Count)" } else { '0' }
  Write-Host "Core process count: $countText"

  $envValues = Get-EnvFileValues
  $required = @('AWKN_MEMORY_BACKEND', 'AWKN_MEMORY_OS_URL', 'AWKN_MEMORY_OS_TOKEN_PATH', 'AWKN_PROJECT_ID', 'AWKN_MEMORY_SESSION_ID')
  $missing = @($required | Where-Object { -not $envValues.ContainsKey($_) })
  if ($missing.Count -eq 0) {
    Write-Host "[OK] Engine CONFIGURED (runtime\.env complete, backend=$($envValues['AWKN_MEMORY_BACKEND']))" -ForegroundColor Green
  } else {
    Write-Host "[WARN] Engine config INCOMPLETE (missing: $($missing -join ', '))" -ForegroundColor Yellow
  }
  $tokenText = if (Test-Path $TokenPath) { 'present' } else { "MISSING $TokenPath" }
  Write-Host "Token: $tokenText"
}

function Invoke-Doctor {
  $failed = $false

  # 1. Core online check
  $protocol = Get-ProtocolInfo
  if ($protocol.Online) {
    Write-Host "[OK] Memory OS Core online" -ForegroundColor Green
  } else {
    Write-Host "[FAIL] Memory OS Core offline (run: .\awkn-local.ps1 start)" -ForegroundColor Red
    $failed = $true
  }

  # 2. Token check
  if (Test-Path $TokenPath) {
    Write-Host "[OK] session.token present" -ForegroundColor Green
  } else {
    Write-Host "[FAIL] session.token missing: $TokenPath" -ForegroundColor Red
    $failed = $true
  }

  # 3. Engine config check
  $envValues = Get-EnvFileValues
  if ($envValues['AWKN_MEMORY_BACKEND'] -eq 'memory-os' -and $envValues['AWKN_MEMORY_OS_URL'] -eq $CoreUrl) {
    Write-Host "[OK] runtime\.env configured (backend=memory-os)" -ForegroundColor Green
  } else {
    Write-Host "[FAIL] runtime\.env not configured for memory-os backend" -ForegroundColor Red
    $failed = $true
  }

  if ($failed) {
    Write-Host "AWKN local env: NOT READY" -ForegroundColor Red
    exit 1
  }

  # 4. Deep diagnose (memory-cli loads .env itself); assert JSON to prevent silent degradation
  $projectId = $envValues['AWKN_PROJECT_ID']
  $sessionId = $envValues['AWKN_MEMORY_SESSION_ID']
  Write-Host "[INFO] Deep diagnose (protocol + auth + project + Receipt + Render) ..."
  Push-Location $RuntimeRoot
  try {
    $output = & $TsxCmd 'src\memory-cli.ts' diagnose --project $projectId --session $sessionId --query 'awkn-local doctor smoke' 2>&1 | Out-String
  } finally {
    Pop-Location
  }
  $jsonStart = $output.IndexOf('{')
  if ($jsonStart -lt 0) {
    Write-Host "[FAIL] Diagnose produced no output: $output" -ForegroundColor Red
    exit 1
  }
  $report = $output.Substring($jsonStart) | ConvertFrom-Json

  if ($report.mode -ne 'memory-os') {
    Write-Host "[FAIL] Engine backend mode is '$($report.mode)', expected memory-os (silent degradation risk)" -ForegroundColor Red
    exit 1
  }
  if (-not $report.remoteEnabled) {
    Write-Host "[FAIL] Engine remoteEnabled=false, remote authority not enabled" -ForegroundColor Red
    exit 1
  }
  if (-not $report.remote -or $report.remote.error) {
    Write-Host "[FAIL] Remote diagnose failed: $($report.remote.error)" -ForegroundColor Red
    exit 1
  }
  if (-not $report.remote.capabilities.online) {
    Write-Host "[FAIL] Remote capabilities.online=false" -ForegroundColor Red
    exit 1
  }

  $receiptId = $report.remote.context.receiptId
  $renderId = $report.remote.context.renderId
  $items = @($report.remote.context.items).Count
  Write-Host "[OK] Protocol: $($report.remote.capabilities.protocol.protocol)" -ForegroundColor Green
  Write-Host "[OK] Project authorized: $projectId" -ForegroundColor Green
  Write-Host "[OK] Context Receipt: $receiptId" -ForegroundColor Green
  $renderText = if ($renderId) { $renderId } else { '(empty memory store, valid)' }
  Write-Host "[OK] Render: $renderText (items: $items)" -ForegroundColor Green

  Write-Host "AWKN local env: READY" -ForegroundColor Green
  Write-Host "Memory OS ONLINE | AWKN Engine CONFIGURED | Project AUTHORIZED" -ForegroundColor Green
}

function Stop-Core {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='awkn.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -like '*AWKN Memory OS*' })
  if ($procs.Count -eq 0) {
    Write-Host 'Memory OS Core not running.'
    return
  }
  foreach ($proc in $procs) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Write-Host "[OK] Stopped $($procs.Count) Memory OS Core process(es)." -ForegroundColor Green
}

switch ($Command) {
  'start' {
    $probe = Get-ProtocolInfo
    if ($probe.Online) {
      Write-Host "Memory OS Core already online." -ForegroundColor Green
    } else {
      Start-Core
    }
    Show-Status
  }
  'status' { Show-Status }
  'doctor' { Invoke-Doctor }
  'stop'   { Stop-Core }
}

# Fix exit code explicitly: intermediate pipeline failures must not leak into scheduler logs
exit 0
