#Requires -Version 5.1
<#
AWKN 本地门禁安装/校验脚本（core.hooksPath 兜底层 1）

背景：pre-push 门禁依赖 `git config core.hooksPath .githooks`。
新机器 clone 后若忘记配置，推送将完全绕过三档检查（scripts/local-ci.ps1 唯一真源）。
本脚本幂等地设置并校验 hooksPath，作为门禁链的最小本地兜底。

用法：
  .\scripts\setup-hooks.ps1             # 设置并校验（幂等，可反复执行）
  .\scripts\setup-hooks.ps1 -CheckOnly  # 仅校验，不改动配置

退出码：0 = 校验通过；1 = 设置或校验失败
#>
param(
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $Root

$ExpectedHooksPath = '.githooks'
$HookFile = Join-Path $Root '.githooks\pre-push'

function Test-HooksPathConfigured {
  $value = git config --local --get core.hooksPath 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $value) { return $false }
  $normalized = (($value -join ' ').Trim()).TrimEnd('\', '/')
  return ($normalized -ieq $ExpectedHooksPath.TrimEnd('\', '/'))
}

$configured = Test-HooksPathConfigured

if (-not $CheckOnly -and -not $configured) {
  Write-Host "[SET] 仓库未配置 core.hooksPath，正在设置: $ExpectedHooksPath" -ForegroundColor Cyan
  git config core.hooksPath $ExpectedHooksPath
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[FAIL] git config 设置失败 (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
  }
}

# 设置后重新读取做真校验，而非信任赋值结果
$configured = Test-HooksPathConfigured

if (-not $configured) {
  Write-Host "[FAIL] core.hooksPath 校验未通过（当前未指向 .githooks）" -ForegroundColor Red
  Write-Host "       请检查: git config --local --get core.hooksPath" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path -LiteralPath $HookFile)) {
  Write-Host "[FAIL] 钩子文件缺失: $HookFile（pre-push 三档检查将不会执行）" -ForegroundColor Red
  exit 1
}

Write-Host "[OK] 本地 pre-push 门禁已启用: core.hooksPath=$ExpectedHooksPath" -ForegroundColor Green
Write-Host "[OK] 钩子文件就位: .githooks\pre-push" -ForegroundColor Green
exit 0
