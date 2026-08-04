#Requires -Version 5.1
<#
AWKN 本地分级检查入口（GitHub 仅存代码，检查全部在本机完成）

档位继承关系（full ⊇ contract ⊇ agents）：
  agents   = 结构化资产(JSON/YAML) + 派生 Markdown 机械校验
  contract = agents + runtime 依赖准备 + typecheck + capability 绑定/契约测试 + agents-runtime 契约
  full     = contract + architecture scan + 全部测试(unit/contracts/verify) + build

用法：
  .\scripts\local-ci.ps1 auto                       # 宽检测：工作区+暂存+untracked，自动选档
  .\scripts\local-ci.ps1 auto -ChangedFilesFile F   # 用给定文件清单选档（pre-push 推送范围）
  .\scripts\local-ci.ps1 agents|contract|full       # 显式指定档位

设计要点：
  - auto 不带清单时用"宽检测"（含 untracked），满足"识别未跟踪派生 .md"。
  - pre-push 传"推送范围"清单（仅将推送的提交），不被无关工作区草稿误伤。
  - 档位选择逻辑只在此处一份，避免多处漂移。
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('auto', 'agents', 'contract', 'full')]
  [string]$Mode = 'auto',
  [string]$ChangedFilesFile = ''
)

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $Root

function Invoke-Step {
  param([string]$Description, [scriptblock]$Block)
  Write-Host ''
  Write-Host "==> $Description" -ForegroundColor Cyan
  & $Block
  $code = $LASTEXITCODE
  if ($null -ne $code -and $code -ne 0) {
    Write-Host "FAILED: $Description (exit $code)" -ForegroundColor Red
    exit $code
  }
}

# 宽检测：工作区改动 + 暂存改动 + untracked(非 ignore) + 领先上游的提交
function Get-BroadChangedFiles {
  $files = @()
  $files += git diff --name-only
  $files += git diff --cached --name-only
  $files += git ls-files --others --exclude-standard
  $upstream = git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null
  if ($LASTEXITCODE -eq 0 -and $upstream) {
    $files += git diff --name-only "$upstream...HEAD"
  }
  return @($files | Where-Object { $_ } | Sort-Object -Unique)
}

# 档位选择：唯一真源。runtime/OCR → full；capabilities/agent 配置 → contract；agents → agents。
function Select-CheckMode {
  param([string[]]$Files)
  $runtimeHit = @($Files | Where-Object {
      $_ -match '^runtime/' -or $_ -match '^integrations/open-code-review/'
    })
  $contractHit = @($Files | Where-Object {
      $_ -match '^capabilities/' -or
      $_ -match '^agents/.*config\.json$' -or
      $_ -match '^agents/.*agent\.prompt$' -or
      $_ -match 'check-runtime-contract'
    })
  $agentsHit = @($Files | Where-Object { $_ -match '^agents/' -or $_ -match '^\.better-harness/' })

  if ($runtimeHit.Count -gt 0) { return 'full' }
  if ($contractHit.Count -gt 0) { return 'contract' }
  if ($agentsHit.Count -gt 0) { return 'agents' }
  return 'none'
}

function Run-AgentsCheck {
  Invoke-Step 'Agents 结构化资产校验 (JSON/YAML)' {
    node agents/tianhuo/scripts/check-structured-assets.js
  }
  Invoke-Step 'Agents 派生 Markdown 机械校验' {
    node agents/tianhuo/scripts/check-markdown-assets.js
  }
  Invoke-Step 'Harness core-code 边界校验' {
    node agents/tianhuo/scripts/check-core-code.js
  }
}

function Ensure-RuntimeDependencies {
  Push-Location runtime
  try {
    if (-not (Test-Path 'node_modules')) {
      Invoke-Step '安装 runtime 依赖 (npm ci)' { npm ci }
    }
  } finally {
    Pop-Location
  }
}

function Run-ContractCheck {
  Run-AgentsCheck
  Ensure-RuntimeDependencies
  Push-Location runtime
  try {
    Invoke-Step 'Runtime TypeScript 类型检查' { npm run typecheck }
    Invoke-Step 'Capability manifest SHA-256 绑定' {
      node --import tsx --test test/capability-manifest.test.ts
    }
    Invoke-Step 'Capability loader 契约测试' {
      node --import tsx --test test/capability-loader.test.ts
    }
  } finally {
    Pop-Location
  }
  Invoke-Step 'Agents 与 runtime 契约校验' {
    node agents/tianhuo/scripts/check-runtime-contract.js
  }
}

function Run-FullCheck {
  Run-ContractCheck
  Push-Location runtime
  try {
    Invoke-Step 'Runtime 架构扫描' { npm run check:architecture }
    Invoke-Step 'Runtime 全部测试 (unit + contracts + verify)' { npm run test:all }
    Invoke-Step 'Runtime 构建' { npm run build }
  } finally {
    Pop-Location
  }
}

if ($Mode -eq 'auto') {
  if ($ChangedFilesFile -and (Test-Path $ChangedFilesFile)) {
    $changed = @(Get-Content -LiteralPath $ChangedFilesFile | Where-Object { $_ })
    Write-Host "[auto] 使用给定文件清单选档: $ChangedFilesFile" -ForegroundColor DarkGray
  } else {
    $changed = Get-BroadChangedFiles
  }

  Write-Host '变更文件:' -ForegroundColor DarkGray
  foreach ($f in $changed) { Write-Host "  $f" -ForegroundColor DarkGray }

  $resolved = Select-CheckMode $changed
  if ($resolved -eq 'none') {
    Write-Host '无相关变更，跳过本地检查。' -ForegroundColor Green
    exit 0
  }
  $Mode = $resolved
  Write-Host "已选档位: $Mode" -ForegroundColor Yellow
}

switch ($Mode) {
  'agents'   { Run-AgentsCheck }
  'contract' { Run-ContractCheck }
  'full'     { Run-FullCheck }
}

Write-Host ''
Write-Host "LOCAL CHECK PASS ($Mode)" -ForegroundColor Green
exit 0
