---
schema: awkn-experience-candidate/v1
disposition: EVOLVE
candidateType: SKILL
sourceEvidence:
  - "2026-08-04 game deploy key 失效排查：PowerShell 下 ssh-keygen -N '""' 生成 ed25519 私钥被 aes256-ctr+bcrypt 加密，BatchMode SSH 无法解密 → 所有 deploy key 认证 Permission denied；对比 Mr.Mont 正常 key 头部为 bm9uZQ==(none) 定位根因"
  - "ssh-keygen -p -P '\"\"' -N '' 解除密码后，ssh -T 立即返回 Hi AWKN-Lab/game! 认证成功"
  - "GitHub deploy key REST API enabled/verified=true 与 SSH 认证数据库不一致，REST 状态不能作为认证成功的证据"
lesson: "PowerShell 生成 SSH 密钥必须用 -N ''（空单引号）表示无密码，-N '\"\"' 会把字面量双引号当 passphrase；生成后必须校验私钥头部（none vs aes256-ctr/bcrypt）并用 ssh -T 实测认证，不能只信 REST API 状态"
scope: "所有在 Windows PowerShell 下生成 SSH deploy key 并用于 GitHub/BatchMode CI 的场景"
proposedTarget: "awkn-部署 skill references/deploy-key-onboarding.md 3.2 节与故障排查表"
verification: "新生成 key 头部含 bm9uZQ==（none）且 ssh -T git@github.com 返回 Hi <org>/<repo>!"
counterExamples:
  - "Linux/macOS bash 下 -N '' 与 -N '\"\"' 行为一致（均无密码），该坑仅 Windows PowerShell"
  - "仅做 ssh -v 诊断见 Offering public key 但 No more authentication methods 时不代表 key 内容错，可能是私钥被加密"
authorizationBoundary: "只修正密钥生成/验证规范，不涉及提升任何密钥权限；不得自动轮换现有 ACTIVE 密钥"
expiryConditions: "PowerShell 或 OpenSSH 修复 -N 参数语义，或部署技能已内置自动化私钥完整性校验后，此候选可 RETIRED"
status: DRAFT
---

# EXP-FIX-20260804 — Windows PowerShell 下 ssh-keygen -N '""' 导致 deploy key 加密失效

## 现象

AWKN-Lab/game 的 ed25519 deploy key：
- GitHub REST API 显示 `enabled=true, verified=true, read_only=false`
- `ssh -v` 显示 `Offering public key: ... ED25519 SHA256:cych6... explicit`
- 但 `ssh -T` / `git ls-remote` 全部 `Permission denied (publickey)`、`No more authentication methods to try`
- 对照组 id_rsa (RSA) 同一方式秒过

## 排查过程

1. gh CLI 登录 AWKN-Lab → `gh api repos/AWKN-Lab/game/keys` 确认 key 存在且 enabled
2. 删除重建 key → 仍失败（排除授权缓存）
3. 新建 ED25519/RSA test key → 仍失败（排除 key 内容/算法）
4. Mr.Mont 仓库 deploy key（awkn-部署 技能标准流程生成）→ 成功
5. **对比私钥头部**：成功 key 为 `b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ...`（none 无密码）；失败 key 为 `...CmVhczI1Ni1jdHI...YmNyeXB0...`（aes256-ctr+bcrypt 加密）
6. `ssh-keygen -p -P '""' -N ''` 解除密码 → 立即认证成功

## 根因

生成命令 `ssh-keygen -t ed25519 -C $comment -f "$HOME\.ssh\$slug" -N '""'`：
- PowerShell 单引号 `'""'` 是字面字符串 `""`（两个双引号字符），不是空密码
- OpenSSH 把 `""` 当作 passphrase，私钥被加密
- BatchMode/CI 无 TTY 交互，SSH 无法输入 passphrase → 认证必然失败
- **该错误写法直接写在 awkn-部署 deploy-key-onboarding.md 3.2 节，是错误源头**

## 修复与预防

- 生成：`ssh-keygen ... -N ''`（空单引号）或省略 `-N`
- 校验（新增到验证清单）：
  - 私钥首行后 base64 含 `bm9uZQ==`（none）= 无密码 ✓；含 `aes256-ctr`/`bcrypt` = 已加密 ✗
  - `ssh -T git@github.com -i <key>` 实测返回 `Hi <org>/<repo>!`
- 已修复：game deploy key 密码解除、remote 切回 `github.com-AWKN-Lab-game` alias、误删的 Mr.Mont key 重建

## 晋级条件

- [ ] 部署技能 onboarding 文档含此坑
- [ ] 新生成 deploy key 全部通过 ssh -T 实测
- [ ] 私钥完整性校验进入验证清单
