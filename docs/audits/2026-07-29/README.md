# 2026-07-29 外部工程审查交付

## Git 基线

- 仓库：`AWKN-Lab/tianshu`
- 审计输入 HEAD：`b090fa9535ea3324eb518021cf9b327625fe03e3`
- 随附工作树 ZIP SHA-256：`88c4c23b4ba99ae093f82df1580279aacbc7ce78af963f9cd7d5aeb5c9adc813`
- 交付分支：`codex/external-audit-20260729`
- 分支基线：创建时的 `main`
- 本分支只提交审计交付物和统一 diff，未直接修改 Runtime 源码，未创建 PR，未合并到 `main`。

## 文件

- `AUDIT.md`：源码级结论、状态矩阵、闭环可达性图、P0/P1/P2、文档修正建议。
- `TEST-EVIDENCE.md`：实际执行命令、环境、通过/失败/跳过和限制。
- `REMAINING-RISKS.md`：本仓、Memory OS 对端、真实 IDE、生产验证风险。
- `patches/tianshu-external-audit.patch`：基于随附工作树的 9 文件统一 diff。
- `logs/npm-ci.log`：依赖镜像 404 证据。
- `logs/architecture-final.log`：最终架构扫描结果。
- `logs/targeted-checks.log`：9 个修改文件语法、桥路径和 patch apply 检查。
- `SHA256SUMS`：Git 中交付文件的 SHA-256。

## 应用补丁

### 应用于随附工作树

```bash
git apply --check docs/audits/2026-07-29/patches/tianshu-external-audit.patch
git apply docs/audits/2026-07-29/patches/tianshu-external-audit.patch
```

### 应用于当前 main

远程 `main` 的 `runtime/test/contracts/policy-ast-deep.test.ts` 已在后续合并中加入奇偶深度语义测试，文件 blob 与随附工作树不同。其余 6 个已有文件 blob 与补丁基线一致，2 个新增 bridge 文件尚不存在。应用时排除已被远程吸收的 Policy 测试 hunk：

```bash
git apply --check \
  --exclude=runtime/test/contracts/policy-ast-deep.test.ts \
  docs/audits/2026-07-29/patches/tianshu-external-audit.patch

git apply \
  --exclude=runtime/test/contracts/policy-ast-deep.test.ts \
  docs/audits/2026-07-29/patches/tianshu-external-audit.patch
```

该命令等价于本地验证过的 8 文件 `main` 重基补丁。

## 关键结论

- Engine v2 执行、循环、旧门禁和本地持久化可达。
- Agent OS 3.0 的 C04-C09、Outcome、Memory Write、Evolve 回灌尚未形成单一生产链。
- Goal 完成态仍可绕过 Goal Judge，列为 P0-01，未在本次最小补丁中改动。
- Skill 新编译/评测/晋级链没有进入下一次生产运行。
- TRAE 当前为 hook + 文件桥，Codex 当前为 OpenAI-compatible API provider；真实 IDE 宿主 E2E 未验证。
- Memory OS 当前证据为单仓 adapter 与 fixture；本补丁封堵强制模式、401/403 和协议错误的本地降级。

## 测试限制

沙箱 Node.js 版本为 `v22.16.0`。`npm ci` 因内部镜像缺少 `zod@3.25.76` 返回 404，完整 typecheck、lint、unit、contract、build 未执行。架构扫描、9 个修改文件的 TypeScript strip-types 语法检查、桥路径行为检查和 `git apply --check` 已通过。详细口径见 `TEST-EVIDENCE.md`。
