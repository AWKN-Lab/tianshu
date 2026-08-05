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

# 门禁兜底校验：pre-push 依赖 core.hooksPath 指向 .githooks，未配置时推送会绕过三档检查。
# 仅提示不阻断，保证"手动检查"流程可用；自动设置请运行 scripts/setup-hooks.ps1。
function Assert-HooksPath {
  $expected = '.githooks'
  $value = git config --local --get core.hooksPath 2>$null
  $normalized = if ($value) { ($value -join ' ').Trim().TrimEnd('\', '/') } else { '' }
  if ($normalized -ine $expected.TrimEnd('\', '/')) {
    Write-Host ''
    Write-Host 'WARN: 本地 pre-push 门禁未启用（core.hooksPath 未指向 .githooks）。' -ForegroundColor Yellow
    Write-Host '      推送将不经过三档检查。请运行: .\scripts\setup-hooks.ps1' -ForegroundColor Yellow
    Write-Host ''
  }
}

Assert-HooksPath

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
  $agentsHit = @($Files | Where-Object {
      $_ -match '^agents/' -or
      $_ -match '^\.better-harness/' -or
      # 门禁链自身（scripts/.githooks/workflows）改动也纳入 agents 档，
      # 避免“修门禁的脚本不受门禁保护”盲区（2026-08-05 复盘 EXP-DRV-005）
      $_ -match '^scripts/' -or
      $_ -match '^\.githooks/' -or
      $_ -match '^\.github/workflows/'
    })

  if ($runtimeHit.Count -gt 0) { return 'full' }
  if ($contractHit.Count -gt 0) { return 'contract' }
  if ($agentsHit.Count -gt 0) { return 'agents' }
  return 'none'
}

function Assert-GateScriptsSyntax {
  # 门禁链脚本语法自检：PSParser 解析 ps1 + bash -n 解析 pre-push + js-yaml 解析 workflows。
  # 由 agents 档触发，门禁链自身改动不再裸奔（2026-08-05 复盘 EXP-DRV-005/006）。
  $ps1Files = @('scripts/local-ci.ps1', 'scripts/setup-hooks.ps1')
  foreach ($ps1 in $ps1Files) {
    if (-not (Test-Path -LiteralPath $ps1)) { continue }
    $errors = $null
    [void][System.Management.Automation.PSParser]::Tokenize((Get-Content -LiteralPath $ps1 -Raw), [ref]$errors)
    if ($errors -and $errors.Count -gt 0) {
      throw "PowerShell 语法错误 in $ps1 : $($errors[0].Message) (line $($errors[0].Token.StartLine))"
    }
  }
  $bash = Get-Command bash -ErrorAction SilentlyContinue
  if ($bash) {
    & $bash.Source -n .githooks/pre-push
    if ($LASTEXITCODE -ne 0) { throw '.githooks/pre-push bash 语法错误' }
  } else {
    Write-Host 'WARN: bash 未找到，跳过 pre-push 语法校验' -ForegroundColor Yellow
  }
  $jsYaml = Resolve-Path (Join-Path $Root 'agents/tianhuo/gates/node_modules/js-yaml') -ErrorAction SilentlyContinue
  if ($jsYaml) {
    $script = "const fs=require('fs'),y=require(process.argv[1]);for(const f of process.argv.slice(2)){y.load(fs.readFileSync(f,'utf8'))}"
    node -e $script $jsYaml '.github/workflows/agents-ci.yml' '.github/workflows/runtime-ci.yml'
    if ($LASTEXITCODE -ne 0) { throw 'Workflow YAML 解析失败' }
  } else {
    Write-Host 'WARN: js-yaml 未找到，跳过 workflow YAML 校验' -ForegroundColor Yellow
  }
}

function Run-AgentsCheck {
  Invoke-Step '门禁脚本语法自检 (PSParser + bash -n + YAML)' { Assert-GateScriptsSyntax }
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
