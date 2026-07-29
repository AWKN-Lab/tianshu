# TEST-EVIDENCE

## 1. 执行环境

- 日期：2026-07-29
- OS：Linux 沙箱
- Node：`v22.16.0`
- npm：`10.9.2`
- 源码目录：`/mnt/data/awkn_audit_work`
- 源码包 SHA-256：`88c4c23b4ba99ae093f82df1580279aacbc7ce78af963f9cd7d5aeb5c9adc813`
- 源码包不含 `.git` 元数据；Git 基线通过任务书和 GitHub commit `b090fa9535ea3324eb518021cf9b327625fe03e3` 交叉确认。
- 审计交付时，远程 `main` 已前进到 `bc3869412e9b683b03ad808304ba682c2d5fe995`。`policy-ast-deep.test.ts` 在该提交已包含正确的奇偶取反测试，因此 Git 交付分支不会用 ZIP 中较旧文件覆盖它。

## 2. 任务书提供的进入审计前基线

以下数据由任务书提供，本次未将其改写为本地执行结果：

| Gate | 任务书基线 |
|---|---|
| Architecture Scan | 通过，`blockingViolations=0`；`directDbImports=20`、`moduleSingletons=12`、`crossComponentImports=22`、`legacyExceptionsUsed=1` |
| TypeScript typecheck | 通过 |
| lint | 通过；脚本实际等同 `tsc --noEmit` |
| Unit | `99 passed / 0 failed` |
| Contract | `633 passed / 2 failed` |
| 已知失败 | `policy-ast-deep.test.ts` 10 层 `none` 两个断言 |

## 3. 本次实际执行的规定命令

执行目录：`/mnt/data/awkn_audit_work/runtime`

| 命令 | 退出码 | 结果 | 关键证据 |
|---|---:|---|---|
| `npm ci` | 1 | 失败 | 内部 npm 镜像请求 `zod-3.25.76.tgz` 返回 404。安装未完成，并移除了原 `node_modules`。 |
| `npm run check:architecture` | 0 | 通过 | `blockingViolations=0`; `directDbImports=20`; `moduleSingletons=12`; `crossComponentImports=22`; `legacyExceptionsUsed=1`。 |
| `npm run typecheck` | 2 | 环境阻塞 | `npm ci` 未完成后缺少依赖与 Node 类型；该结果不能归因为本次源码补丁。 |
| `npm run lint` | 2 | 环境阻塞 | 脚本为 `tsc --noEmit`，同受依赖缺失影响。 |
| `npm run test` | 1 | 环境阻塞 | `tsx` 不存在。 |
| `npm run test:contracts` | 1 | 环境阻塞 | `tsx` 不存在。 |
| `npm run build` | 1 | 环境阻塞 | 依赖与类型包缺失。 |

依赖失败 URL：

```text
https://packages.applied-caas-gateway1.internal.api.openai.org/artifactory/api/npm/npm-public/zod/-/zod-3.25.76.tgz
```

本次没有访问外部公共 npm registry 的可用网络路径，也没有改写 lockfile 或 registry 配置。

## 4. 补充的无依赖检查

### 4.1 修改文件 TypeScript 语法转译

使用沙箱全局 TypeScript `transpileModule` 检查 10 个修改/新增 TypeScript 文件：

```text
PASS runtime/scripts/bridge-daemon.ts
PASS runtime/src/llm/bridge-path.ts
PASS runtime/src/llm/providers/trae.ts
PASS runtime/src/llm/router.ts
PASS runtime/src/memory/awkn-memory-os-backend.ts
PASS runtime/src/memory/outbox.ts
PASS runtime/src/memory/router.ts
PASS runtime/test/contracts/bridge-path.test.ts
PASS runtime/test/contracts/memory-backend-adapter.test.ts
PASS runtime/test/contracts/policy-ast-deep.test.ts
exit=0
```

该检查只覆盖 TypeScript 语法转译，不替代项目级 typecheck。

### 4.2 绝对路径逻辑的隔离执行

将 `bridge-path.ts` 与 `outbox.ts` 转译为临时 ESM 后执行 Node 断言：

```text
PASS bridge path: default absolute, explicit absolute, relative rejected
PASS memory outbox: default absolute, relative rejected
exit=0
```

### 4.3 Policy AST 语义判定

实际实现：

```ts
case 'none':
  return !children.some((child) => evaluateCondition(child, context));
```

单子节点嵌套 10 层产生 10 次布尔取反。偶数次取反保持叶值：

- `fieldEquals('count', 999)` 的叶值为 false，10 层结果为 false；
- `fieldEquals('count', 5)` 的叶值为 true，10 层结果为 true。

因此补丁修正测试预期，没有改动 evaluator。

## 5. 未执行

以下验证均未执行：

- 真实 TRAE IDE 宿主调用；
- 真实 Codex IDE 宿主调用；
- 使用真实 Codex/OpenAI-compatible API Key 的 provider 调用；
- 独立 AWKN Memory OS 服务 smoke；
- Memory OS vNext Project Grant、CAS Transaction、Tombstone、Outcome Attribution 双仓 E2E；
- 生产数据库迁移；
- 生产用户数据操作；
- 部署、发布、远程推送以外的生产变更；
- Windows 本地复验；
- Node 20 复验。

## 6. 复验命令

在可访问 lockfile 依赖的隔离工作树中执行：

```bash
cd runtime
npm ci
npm run check:architecture
npm run typecheck
npm run lint
npm run test
npm run test:contracts
npm run build
```

定向复验：

```bash
node scripts/run-tests.mjs contracts policy-ast-deep
node scripts/run-tests.mjs contracts memory-backend-adapter
node scripts/run-tests.mjs contracts bridge-path
```

若当前 test runner 不支持文件过滤，直接运行完整 `npm run test:contracts`，并核对三个文件均进入发现列表。

## 7. 交付补丁

| 文件 | 字节数 | SHA-256 |
|---|---:|---|
| `AWKN-audit-fixes.patch` | 21,563 | `e0b0bef109ea8fb1927b1c5c05d0b0db387e20a773262d765fdaac52660e5e74` |

该统一 diff 以随附 ZIP 工作树为基准。远程 `main@bc386941` 已包含等价的 Policy AST 奇偶语义测试，Git 交付分支保留远程新文件，不覆盖该测试文件。
