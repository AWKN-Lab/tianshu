# push-realign.ps1 — 本地分支与远端"等效历史"对齐后快进推送
#
# 适用场景：远端通过 Git Data API 重建了 commit 对象（sha 变化、内容与消息等效），
# 导致本地与远端历史分叉。本脚本：
#   1) fetch 远端分支
#   2) 校验分叉部分是否为"等效历史"（提交消息逐一匹配）
#   3) 用 commit-tree 把本地独有的提交重放到远端 tip 之上（tree 完全保留）
#   4) 校验重放后 tree 与原 HEAD 一致，然后 update-ref + 快进推送
#
# 用法：
#   pwsh scripts/push-realign.ps1                 # 默认 remote=tianshu branch=main，对齐并推送
#   pwsh scripts/push-realign.ps1 -NoPush         # 只对齐不推送
#   pwsh scripts/push-realign.ps1 -DryRun         # 只报告，不改动任何 ref
#
# 安全性：不触碰工作区与暂存区；所有破坏性判断失败即中止（abort），旧 ref 可从 reflog 恢复。

param(
  [string]$Remote = 'tianshu',
  [string]$Branch = 'main',
  [switch]$NoPush,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Abort([string]$Reason) {
  Write-Output "ABORT: $Reason"
  exit 1
}

# ---- 0. 基础状态 ----
$curBranch = git rev-parse --abbrev-ref HEAD
if ($curBranch -ne $Branch) { Abort "current branch is '$curBranch', expected '$Branch'" }

$oldHead = git rev-parse HEAD
Write-Output "local HEAD: $oldHead"

git fetch $Remote $Branch
if ($LASTEXITCODE -ne 0) { Abort "git fetch $Remote $Branch failed" }

$remoteTip = git rev-parse "$Remote/$Branch"
Write-Output "remote tip: $remoteTip"

if ($oldHead -eq $remoteTip) {
  Write-Output 'ALREADY ALIGNED'
  if (-not $NoPush -and -not $DryRun) { git push $Remote $Branch }
  exit 0
}

# ---- 1. 分叉分析 ----
$aheadShas = @(git rev-list "$remoteTip..HEAD")      # 本地独有（新→旧）
$behindSubjects = @(git log --format=%s --reverse "HEAD..$remoteTip")   # 远端独有（旧→新）
$aheadSubjects  = @(git log --format=%s --reverse "$remoteTip..HEAD")  # 本地独有（旧→新）

$n = $behindSubjects.Count
$m = $aheadShas.Count - $n
Write-Output "divergence: local ahead=$($aheadShas.Count), remote ahead=$n, local-only extras=$m"

if ($m -lt 0) { Abort 'remote contains commits not mirrored locally (not an equivalent-history split)' }

# ---- 2. 等效历史校验：最旧的 n 条提交消息必须逐一相等 ----
for ($i = 0; $i -lt $n; $i++) {
  if ($aheadSubjects[$i] -ne $behindSubjects[$i]) {
    Abort ("equivalent-history check failed at position {0}: local='{1}' remote='{2}'" -f $i, $aheadSubjects[$i], $behindSubjects[$i])
  }
}
Write-Output "equivalent-history check passed ($n mirrored commits)"

if ($m -eq 0) {
  if ($DryRun) { Write-Output 'DRYRUN: would fast-forward to remote tip'; exit 0 }
  git update-ref "refs/heads/$Branch" $remoteTip
  Write-Output "fast-forwarded $Branch to $remoteTip"
  if (-not $NoPush) { git push $Remote $Branch }
  exit $LASTEXITCODE
}

# ---- 3. commit-tree 重放本地独有的 m 条提交（旧→新）----
$newTip = $remoteTip
# aheadShas 为新→旧排列：索引 0..m-1 是本地独有 extras，索引 m 之后是与远端镜像对应的 n 条
$extraShas = @($aheadShas[0..($m - 1)])
[Array]::Reverse($extraShas)  # 变为旧→新

$msgFile = Join-Path $env:TEMP 'push-realign-msg.txt'
foreach ($sha in $extraShas) {
  $msgText = (git log -1 --format=%B $sha) -join "`n"
  [System.IO.File]::WriteAllText($msgFile, $msgText, (New-Object System.Text.UTF8Encoding $false))
  $tree = git rev-parse "$sha^{tree}"
  $replayed = git commit-tree $tree -p $newTip -F $msgFile
  if ($LASTEXITCODE -ne 0 -or -not $replayed) { Abort "commit-tree replay failed for $sha" }
  Write-Output "replayed $sha -> $replayed"
  $newTip = $replayed
}
Remove-Item $msgFile -ErrorAction SilentlyContinue

# ---- 4. tree 一致性校验：重放结果必须与原 HEAD 完全同 tree ----
git diff --quiet $oldHead $newTip --
if ($LASTEXITCODE -ne 0) { Abort 'replayed tip tree differs from original HEAD; refusing to move ref' }
Write-Output 'tree equivalence verified'

if ($DryRun) {
  Write-Output "DRYRUN: would move $Branch -> $newTip"
  exit 0
}

# ---- 5. 移动 ref 并推送 ----
git update-ref "refs/heads/$Branch" $newTip
Write-Output "moved $Branch -> $newTip (old $oldHead kept in reflog)"

if ($NoPush) {
  Write-Output 'NoPush: skipping push'
  exit 0
}

git push $Remote $Branch
if ($LASTEXITCODE -ne 0) { Abort "push failed (pre-push gate rejected or network error)" }

$finalRemote = git ls-remote $Remote "refs/heads/$Branch" | ForEach-Object { ($_ -split '\t')[0] }
Write-Output "DONE: local=$newTip remote=$finalRemote aligned=$($newTip -eq $finalRemote)"
