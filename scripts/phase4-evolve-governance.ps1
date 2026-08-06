param(
    [switch]$CompleteDrafts,
    [ValidateRange(1, 168)]
    [int]$SinceHours = 72
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $repoRoot "runtime"
$derivedDir = Join-Path $repoRoot "agents\tianhuo\04-记忆与知识\EXPERIENCE\derived"
$logDir = Join-Path $repoRoot ".better-harness\tasks\phase4-evolve-logs"

if (-not (Test-Path (Join-Path $runtimeRoot "package.json"))) {
    throw "Authoritative Runtime not found: $runtimeRoot"
}

# 单一权威源：禁止治理脚本切换到 packages/awkn-engine-mcp/runtime 旧副本。
$env:AWKN_DERIVED_DIR = $derivedDir
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Push-Location $runtimeRoot

try {
    Write-Host "=== authoritative runtime ==="
    Write-Host $runtimeRoot

    Write-Host "`n=== evolve scan-drafts ==="
    $scanOut = node bin/awkn-engine.js evolve scan-drafts 2>&1
    $scanOut | Out-String -Stream | Tee-Object -FilePath (Join-Path $logDir "scan-drafts.log")

    if ($CompleteDrafts) {
        Write-Host "`n=== evolve complete-drafts (explicitly enabled) ==="
        $completeOut = node bin/awkn-engine.js evolve complete-drafts 2>&1
        $completeOut | Out-String -Stream | Tee-Object -FilePath (Join-Path $logDir "complete-drafts.log")
    } else {
        Write-Host "`ncomplete-drafts skipped. Use -CompleteDrafts only after candidate ingest, budget and provider checks pass."
    }

    Write-Host "`n=== evolve stats ==="
    $statsOut = node bin/awkn-engine.js evolve stats --sinceHours $SinceHours 2>&1
    $statsOut | Out-String -Stream | Tee-Object -FilePath (Join-Path $logDir "stats.log")
}
finally {
    Pop-Location
}
