[CmdletBinding()]
param(
    [switch]$Plan,
    [switch]$Apply,
    [switch]$Rollback,
    [string]$EngineRoot = "D:\awkn-lab\awkn引擎",
    [string]$SkillSourcesRoot = "D:\awkn-lab\skill-sources",
    [string]$BackupRoot = "D:\awkn-lab\_backup\skill-boundary-20260806"
)

$ErrorActionPreference = "Stop"

# ----------------------------------------------------------------------------
# Path anchors
# ----------------------------------------------------------------------------
$skillsRoot     = Join-Path $EngineRoot "skills"
$governanceRoot = Join-Path $skillsRoot "awkn-技能治理"
$evaluationRoot = Join-Path $skillsRoot "awkn-技能测评"
$absorbedRoot   = Join-Path $governanceRoot "absorbed-skills"

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
function Write-Step([string]$Message) { Write-Host $Message }

function Get-StringSha256([string]$Text) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $ms = [System.IO.MemoryStream]::new($bytes)
    try {
        return (Get-FileHash -InputStream $ms -Algorithm SHA256).Hash
    } finally {
        $ms.Dispose()
    }
}

# Build the full list of migration items (existing and missing alike).
function Get-MigrationItems {
    $items = New-Object System.Collections.Generic.List[object]
    $idx = 0

    # Group A: each subdirectory of absorbed-skills -> $SkillSourcesRoot/<name>
    if (Test-Path -LiteralPath $absorbedRoot) {
        Get-ChildItem -LiteralPath $absorbedRoot -Force -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name | ForEach-Object {
                $leaf = $_.Name
                $items.Add([pscustomobject]@{
                    Kind        = 'absorbed'
                    Index       = $idx
                    Source      = $_.FullName
                    Leaf        = $leaf
                    Relative    = "absorbed-skills\$leaf"
                    Destination = (Join-Path $SkillSourcesRoot $leaf)
                }) | Out-Null
                $idx++
            }
    }

    # Group B: legacy dirs/files -> $BackupRoot/<relative>
    $legacy = @(
        @{ Root = $governanceRoot; Leaf = 'scripts';       Rel = 'awkn-技能治理\scripts' },
        @{ Root = $governanceRoot; Leaf = 'skills';        Rel = 'awkn-技能治理\skills' },
        @{ Root = $governanceRoot; Leaf = 'data';          Rel = 'awkn-技能治理\data' },
        @{ Root = $governanceRoot; Leaf = 'logs';          Rel = 'awkn-技能治理\logs' },
        @{ Root = $governanceRoot; Leaf = 'telemetry';     Rel = 'awkn-技能治理\telemetry' },
        @{ Root = $governanceRoot; Leaf = 'skill-cli.py';  Rel = 'awkn-技能治理\skill-cli.py' },
        @{ Root = $governanceRoot; Leaf = '__pycache__';   Rel = 'awkn-技能治理\__pycache__' },
        @{ Root = $governanceRoot; Leaf = '.pytest_cache'; Rel = 'awkn-技能治理\.pytest_cache' },
        @{ Root = $evaluationRoot; Leaf = 'scripts';       Rel = 'awkn-技能测评\scripts' },
        @{ Root = $evaluationRoot; Leaf = 'skills';        Rel = 'awkn-技能测评\skills' },
        @{ Root = $evaluationRoot; Leaf = '__pycache__';   Rel = 'awkn-技能测评\__pycache__' },
        @{ Root = $evaluationRoot; Leaf = '.pytest_cache'; Rel = 'awkn-技能测评\.pytest_cache' }
    )
    foreach ($e in $legacy) {
        $src = Join-Path $e.Root $e.Leaf
        $items.Add([pscustomobject]@{
            Kind        = 'legacy'
            Index       = $idx
            Source      = $src
            Leaf        = $e.Leaf
            Relative    = $e.Rel
            Destination = (Join-Path $BackupRoot $e.Rel)
        }) | Out-Null
        $idx++
    }

    return ,$items
}

# Compute a manifest for a tree root (file or directory).
# Returns: file_count, total_bytes, set_digest, manifest_string, files
function Get-TreeManifest([string]$Root) {
    $files = @()
    if (Test-Path -LiteralPath $Root -PathType Leaf) {
        $info = Get-Item -LiteralPath $Root -Force
        $h = (Get-FileHash -LiteralPath $Root -Algorithm SHA256).Hash
        $files = @([pscustomobject]@{ relpath = ''; sha256 = $h; bytes = $info.Length })
    } elseif (Test-Path -LiteralPath $Root -PathType Container) {
        $rootInfo = Get-Item -LiteralPath $Root -Force
        $rootFull = $rootInfo.FullName
        $all = Get-ChildItem -LiteralPath $Root -Recurse -File -Force -ErrorAction SilentlyContinue
        foreach ($f in $all) {
            $rel = $f.FullName.Substring($rootFull.Length).TrimStart('\', '/')
            $rel = $rel -replace '\\', '/'
            $h = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
            $files += [pscustomobject]@{ relpath = $rel; sha256 = $h; bytes = $f.Length }
        }
    } else {
        throw "Get-TreeManifest: root not found: $Root"
    }

    $fileCount = ($files | Measure-Object).Count
    $sumObj = $files | Measure-Object -Property bytes -Sum
    $totalBytes = if ($null -eq $sumObj.Sum) { 0 } else { [int64]$sumObj.Sum }

    $sortedHashes = $files | ForEach-Object { $_.sha256 } | Sort-Object
    $setDigest = Get-StringSha256 ($sortedHashes -join '')

    $manifestLines = $files | Sort-Object relpath | ForEach-Object { "$($_.relpath)|$($_.sha256)|$($_.bytes)" }
    $manifestString = $manifestLines -join "`n"

    return [pscustomobject]@{
        file_count      = $fileCount
        total_bytes     = $totalBytes
        set_digest      = $setDigest
        manifest_string = $manifestString
        files           = $files
    }
}

# Restore original sources. Idempotent; tolerates partial states.
function Invoke-Restore {
    param(
        [Parameter(Mandatory)]$Items,
        [string]$BackupRoot,
        [switch]$UpdateReceipt,
        [string]$ReceiptPath
    )

    $reversed = $Items | Sort-Object Index -Descending
    foreach ($item in $reversed) {
        $S = $item.Source
        $D = $item.Destination
        $MS = $item.MigratedSourceBackup
        Write-Step "  RESTORE [$($item.Index)] $S"

        $sExists  = Test-Path -LiteralPath $S
        $dExists  = Test-Path -LiteralPath $D
        $msExists = [bool]$MS -and (Test-Path -LiteralPath $MS)

        if ($sExists) {
            Write-Step "    source already in place; removing redundant copies"
            if ($dExists)  { Remove-Item -LiteralPath $D -Recurse -Force; Write-Step "    removed destination $D" }
            if ($msExists) { Remove-Item -LiteralPath $MS -Recurse -Force; Write-Step "    removed migrated-source backup $MS" }
        } elseif ($msExists) {
            $parent = Split-Path -Parent $S
            if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            Move-Item -LiteralPath $MS -Destination $S
            Write-Step "    restored source from migrated-source backup"
            if ($dExists) { Remove-Item -LiteralPath $D -Recurse -Force; Write-Step "    removed destination $D" }
        } elseif ($dExists) {
            $parent = Split-Path -Parent $S
            if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            Move-Item -LiteralPath $D -Destination $S
            Write-Step "    restored source from destination"
        } else {
            Write-Step "    WARN: nothing to restore for $S"
        }
    }

    # Clean staging dirs
    if ($BackupRoot -and (Test-Path -LiteralPath $BackupRoot)) {
        Get-ChildItem -LiteralPath $BackupRoot -Force -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like '.staging-*' } | ForEach-Object {
                Remove-Item -LiteralPath $_.FullName -Recurse -Force
                Write-Step "    cleaned staging $($_.FullName)"
            }
    }

    if ($UpdateReceipt -and $ReceiptPath -and (Test-Path -LiteralPath $ReceiptPath)) {
        $r = Get-Content -LiteralPath $ReceiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $r.status = 'ROLLED_BACK'
        $r | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ReceiptPath -Encoding UTF8
        Write-Step "    receipt status -> ROLLED_BACK"
    }
}

# ----------------------------------------------------------------------------
# -Plan: pure read-only precheck
# ----------------------------------------------------------------------------
function Invoke-Plan {
    Write-Step "=== PLAN MODE (read-only) ==="
    Write-Step "EngineRoot       : $EngineRoot"
    Write-Step "SkillSourcesRoot : $SkillSourcesRoot"
    Write-Step "BackupRoot       : $BackupRoot"
    Write-Step ""

    if (-not (Test-Path -LiteralPath $absorbedRoot)) {
        Write-Step "WARN: absorbed-skills root not found: $absorbedRoot"
    }

    $items = Get-MigrationItems
    $present = @(); $missing = @(); $conflicts = @()
    $totalFiles = 0; $totalBytes = [int64]0

    foreach ($item in $items) {
        $srcExists = Test-Path -LiteralPath $item.Source
        $dstExists = Test-Path -LiteralPath $item.Destination
        if (-not $srcExists) {
            $missing += $item
            Write-Step ("  [MISS]    {0,-8} {1}" -f $item.Kind, $item.Source)
            continue
        }
        if ($dstExists) { $conflicts += $item }

        if (Test-Path -LiteralPath $item.Source -PathType Leaf) {
            $fc = 1
            $tb = [int64](Get-Item -LiteralPath $item.Source -Force).Length
        } else {
            $kids = Get-ChildItem -LiteralPath $item.Source -Recurse -File -Force -ErrorAction SilentlyContinue
            $fc = ($kids | Measure-Object).Count
            $sumObj = $kids | Measure-Object -Property Length -Sum
            $tb = if ($null -eq $sumObj.Sum) { [int64]0 } else { [int64]$sumObj.Sum }
        }

        $totalFiles += $fc
        $totalBytes += $tb
        $flag = if ($dstExists) { 'CONFLICT' } else { 'ok      ' }
        Write-Step ("  [{0}] {1,-8} {2} -> {3}  files={4} bytes={5}" -f $flag, $item.Kind, $item.Source, $item.Destination, $fc, $tb)
        $present += [pscustomobject]@{ Index = $item.Index; Kind = $item.Kind; Source = $item.Source; Destination = $item.Destination; Files = $fc; Bytes = $tb; Conflict = $dstExists }
    }

    Write-Step ""
    Write-Step "=== SUMMARY ==="
    Write-Step "Sources present  : $($present.Count)"
    Write-Step "Sources missing  : $($missing.Count)"
    Write-Step "Target conflicts : $($conflicts.Count)"
    Write-Step "Expected files   : $totalFiles"
    Write-Step "Expected bytes   : $totalBytes"

    if ($missing.Count -gt 0) {
        Write-Step ""
        Write-Step "MISSING SOURCES (will be skipped on -Apply):"
        foreach ($m in $missing) { Write-Step "  $($m.Source)" }
    }
    if ($conflicts.Count -gt 0) {
        Write-Step ""
        Write-Step "TARGET CONFLICTS (-Apply will abort if any remain):"
        foreach ($c in $conflicts) { Write-Step "  $($c.Destination)" }
    }
    Write-Step ""
    Write-Step "Plan is read-only: no files or directories were created, modified, or deleted."
}

# ----------------------------------------------------------------------------
# -Apply
# ----------------------------------------------------------------------------
function Invoke-Apply {
    $items = Get-MigrationItems

    # --- Precheck (same as Plan): split missing vs conflicts ---
    $migratable = @()
    $conflicts = @()
    foreach ($item in $items) {
        if (-not (Test-Path -LiteralPath $item.Source)) {
            Write-Step "SKIP missing source: $($item.Source)"
            continue
        }
        if (Test-Path -LiteralPath $item.Destination) { $conflicts += $item }
        $migratable += $item
    }

    if ($conflicts.Count -gt 0) {
        Write-Step "TARGET CONFLICT DETECTED. Aborting before any file is moved."
        foreach ($c in $conflicts) { Write-Step "  conflict: $($c.Destination) already exists" }
        Write-Step "No files were changed."
        exit 1
    }
    if ($migratable.Count -eq 0) {
        Write-Step "No migratable sources found. Nothing to do."
        return
    }

    $timestamp             = (Get-Date).ToString("yyyyMMdd-HHmmss")
    $stagingDir            = Join-Path $BackupRoot ".staging-$timestamp"
    $migratedSourcesBackup = Join-Path $BackupRoot ".migrated-sources-$timestamp"
    $receiptPath           = Join-Path $BackupRoot "migration-receipt.json"
    $rollbackScriptPath    = Join-Path $BackupRoot "rollback.ps1"

    New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null

    # Refuse to overwrite a completed migration
    if (Test-Path -LiteralPath $receiptPath) {
        $old = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($old.status -eq 'COMPLETE') {
            Write-Step "A COMPLETE migration receipt already exists at $receiptPath"
            Write-Step "Refusing to re-apply. Run -Rollback first if needed."
            exit 1
        }
    }

    Write-Step "=== APPLY MODE ==="
    Write-Step "Staging            : $stagingDir"
    Write-Step "Migrated sources   : $migratedSourcesBackup"
    Write-Step "Migratable items   : $($migratable.Count)"

    try {
        # ---- Phase 1: stage + verify ----
        New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
        Write-Step "Phase 1: staging + SHA256 verification"
        foreach ($item in $migratable) {
            $slot = Join-Path $stagingDir ("item-{0:D3}" -f $item.Index)
            New-Item -ItemType Directory -Path $slot -Force | Out-Null
            $stagedLeaf = Join-Path $slot $item.Leaf

            Write-Step "  [$($item.Index)] stage copy $($item.Source) -> $stagedLeaf"
            Copy-Item -LiteralPath $item.Source -Destination $slot -Recurse -Force
            if (-not (Test-Path -LiteralPath $stagedLeaf)) { throw "Staging copy failed: $stagedLeaf not found" }

            $srcMan = Get-TreeManifest -Root $item.Source
            $stgMan = Get-TreeManifest -Root $stagedLeaf
            if ($srcMan.manifest_string -ne $stgMan.manifest_string) {
                throw "Manifest mismatch between source and staging for $($item.Source)"
            }
            Write-Step "    OK files=$($srcMan.file_count) bytes=$($srcMan.total_bytes) digest=$($srcMan.set_digest)"

            $item | Add-Member -NotePropertyName StagingSlot -NotePropertyValue $slot -Force
            $item | Add-Member -NotePropertyName StagedLeaf -NotePropertyValue $stagedLeaf -Force
            $item | Add-Member -NotePropertyName Manifest    -NotePropertyValue $srcMan -Force
        }

        # ---- Phase 2: atomic switch (staging -> destination) ----
        Write-Step "Phase 2: atomic switch to destinations"
        foreach ($item in $migratable) {
            $D = $item.Destination
            $destParent = Split-Path -Parent $D
            if (-not (Test-Path -LiteralPath $destParent)) { New-Item -ItemType Directory -Path $destParent -Force | Out-Null }

            Write-Step "  [$($item.Index)] move $($item.StagedLeaf) -> $D"
            Move-Item -LiteralPath $item.StagedLeaf -Destination $D
            if (-not (Test-Path -LiteralPath $D)) { throw "Atomic move failed: $D not present" }

            $dstMan = Get-TreeManifest -Root $D
            if ($dstMan.manifest_string -ne $item.Manifest.manifest_string) {
                throw "Post-move manifest mismatch for $D"
            }
            Write-Step "    OK verified"
        }

        # ---- Phase 3: move original sources into migrated-sources backup ----
        Write-Step "Phase 3: move original sources to $migratedSourcesBackup"
        $appliedItems = @()
        foreach ($item in $migratable) {
            $msPath = Join-Path $migratedSourcesBackup $item.Relative
            $msParent = Split-Path -Parent $msPath
            if (-not (Test-Path -LiteralPath $msParent)) { New-Item -ItemType Directory -Path $msParent -Force | Out-Null }

            Write-Step "  [$($item.Index)] move source $($item.Source) -> $msPath"
            Move-Item -LiteralPath $item.Source -Destination $msPath
            $item | Add-Member -NotePropertyName MigratedSourceBackup -NotePropertyValue $msPath -Force
            $appliedItems += $item
        }

        # ---- Phase 4: receipt + rollback script ----
        $receipt = [ordered]@{
            timestamp             = (Get-Date).ToString("o")
            operation             = 'apply'
            status                = 'COMPLETE'
            engine_root           = $EngineRoot
            skill_sources_root    = $SkillSourcesRoot
            backup_root           = $BackupRoot
            staging_dir           = $stagingDir
            migrated_sources_backup = $migratedSourcesBackup
            items                 = @()
        }
        foreach ($item in $appliedItems) {
            $receipt.items += [ordered]@{
                index                 = $item.Index
                kind                  = $item.Kind
                source                = $item.Source
                destination           = $item.Destination
                relative              = $item.Relative
                leaf                  = $item.Leaf
                file_count            = $item.Manifest.file_count
                total_bytes           = $item.Manifest.total_bytes
                set_digest            = $item.Manifest.set_digest
                migrated_source_backup = $item.MigratedSourceBackup
            }
        }
        $receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
        Write-Step "Wrote receipt: $receiptPath"

        $rb = @"
`$ErrorActionPreference = "Stop"
& "$PSCommandPath" -Rollback -EngineRoot "$EngineRoot" -SkillSourcesRoot "$SkillSourcesRoot" -BackupRoot "$BackupRoot"
"@
        Set-Content -LiteralPath $rollbackScriptPath -Value $rb -Encoding UTF8
        Write-Step "Wrote rollback script: $rollbackScriptPath"

        if (Test-Path -LiteralPath $stagingDir) { Remove-Item -LiteralPath $stagingDir -Recurse -Force }
        Write-Step "Migration COMPLETE."
    } catch {
        Write-Step "APPLY FAILED: $_"
        Write-Step "Attempting rollback to restore original state..."
        $restoreItems = @()
        foreach ($item in $migratable) {
            $ms = if ($item.PSObject.Properties.Name -contains 'MigratedSourceBackup') { $item.MigratedSourceBackup } else { $null }
            $restoreItems += [pscustomobject]@{
                Index                = $item.Index
                Source               = $item.Source
                Destination          = $item.Destination
                Relative             = $item.Relative
                MigratedSourceBackup = $ms
            }
        }
        try {
            Invoke-Restore -Items $restoreItems -BackupRoot $BackupRoot
            if (Test-Path -LiteralPath $stagingDir) { Remove-Item -LiteralPath $stagingDir -Recurse -Force }
            Write-Step "Rollback complete. Sources restored to original state."
        } catch {
            Write-Step "Rollback also failed: $_"
            Write-Step "MANUAL INTERVENTION REQUIRED. Staging dir (if any): $stagingDir"
        }
        exit 1
    }
}

# ----------------------------------------------------------------------------
# -Rollback
# ----------------------------------------------------------------------------
function Invoke-RollbackMode {
    $receiptPath = Join-Path $BackupRoot "migration-receipt.json"
    if (-not (Test-Path -LiteralPath $receiptPath)) {
        Write-Step "No receipt found at $receiptPath. Nothing to roll back."
        exit 1
    }

    $r = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($r.status -ne 'COMPLETE') {
        Write-Step "Receipt status is '$($r.status)'. Nothing to roll back."
        exit 1
    }

    Write-Step "=== ROLLBACK MODE ==="
    Write-Step "Receipt: $receiptPath"
    Write-Step "Items   : $($r.items.Count)"

    $items = @()
    foreach ($it in $r.items) {
        $items += [pscustomobject]@{
            Index                = $it.index
            Source               = $it.source
            Destination          = $it.destination
            Relative             = $it.relative
            MigratedSourceBackup = $it.migrated_source_backup
        }
    }

    Invoke-Restore -Items $items -BackupRoot $BackupRoot -UpdateReceipt -ReceiptPath $receiptPath
    Write-Step "Rollback complete."
}

# ----------------------------------------------------------------------------
# Dispatch
# ----------------------------------------------------------------------------
$modeCount = 0
if ($Plan)     { $modeCount++ }
if ($Apply)    { $modeCount++ }
if ($Rollback) { $modeCount++ }

if ($modeCount -eq 0) {
    Write-Host "No mode selected. Use exactly one of -Plan, -Apply, or -Rollback."
    exit 1
}
if ($modeCount -gt 1) {
    Write-Host "Specify only one mode: -Plan, -Apply, or -Rollback."
    exit 1
}

if ($Plan)     { Invoke-Plan;        return }
if ($Apply)    { Invoke-Apply;       return }
if ($Rollback) { Invoke-RollbackMode; return }
