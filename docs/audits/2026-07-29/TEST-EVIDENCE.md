# TEST-EVIDENCE

> 审计日期：2026-07-29  
> 工作目录：`/mnt/data/awkn-audit-work`  
> 运行环境：Linux 沙箱，Node.js `v22.16.0`，npm `10.9.2`

## 1. 证据口径

- `PASS`：本次沙箱实际执行并成功；
- `FAIL`：本次沙箱实际执行并失败；
- `BLOCKED`：前置依赖或外部服务缺失，命令无法形成有效结果；
- `NOT_EXECUTED`：本次没有执行；
- 用户提供的历史数字单独列示，不计入本次通过数。

## 2. 源码包校验

| 命令 | 结果 | 关键输出 |
|---|---|---|
| `stat` / `sha256sum /mnt/data/awkn-engine-source-b090fa9-working-tree-v2.zip` | `PASS` | 大小 `1,405,993 bytes`；SHA-256 `88c4c23b4ba99ae093f82df1580279aacbc7ce78af963f9cd7d5aeb5c9adc813` |
| ZIP 解包到隔离目录 | `PASS` | 工作树位于 `/mnt/data/awkn-audit-work`；ZIP 不含 `.git` 元数据 |

## 3. 任务书指定门禁

任务书要求：

```text
cd runtime
npm ci
npm run check:architecture
npm run typecheck
npm run lint
npm run test
npm run test:contracts
npm run build
```

本次结果：

| 命令 | 状态 | 通过 / 失败 / 跳过 | 关键日志或原因 |
|---|---|---:|---|
| `npm ci` | `BLOCKED` | 0 / 1 / 0 | 沙箱内部 npm 镜像请求 `zod-3.25.76.tgz` 返回 HTTP 404；日志：`npm-ci.log` |
| `npm run check:architecture`（补丁前） | `PASS` | 1 / 0 / 0 | `blockingViolations=0`；日志：`architecture-baseline.log` |
| `npm run check:architecture`（补丁后） | `PASS` | 1 / 0 / 0 | `blockingViolations=0`；日志：`architecture-after.log` |
| `npm run typecheck` | `NOT_EXECUTED` | 0 / 0 / 1 | `npm ci` 未完成，依赖与类型包不可用 |
| `npm run lint` | `NOT_EXECUTED` | 0 / 0 / 1 | 同上；脚本本身等同 `tsc --noEmit` |
| `npm run test` | `NOT_EXECUTED` | 0 / 0 / 1 | 同上 |
| `npm run test:contracts` | `NOT_EXECUTED` | 0 / 0 / 1 | 同上 |
| `npm run build` | `NOT_EXECUTED` | 0 / 0 / 1 | 同上 |

### 3.1 架构扫描结果

补丁前后相同：

```text
directDbImports=20
moduleSingletons=12
processEnvInCoreLayers=0
crossComponentImports=22
legacyExceptionsUsed=1
blockingViolations=0
```

`blockingViolations=0` 只覆盖扫描器当前设为阻断的规则。报告级计数仍需逐组件处理。

## 4. 补丁定向检查

| 检查 | 状态 | 数量 | 结果 |
|---|---|---:|---|
| Node TypeScript strip-types 语法检查 | `PASS` | 9 / 9 文件 | 所有修改和新增 TypeScript 文件通过 `node --experimental-strip-types --check` |
| Bridge 默认路径与 CWD 独立性 | `PASS` | 1 / 1 | 模块加载后切换 `process.cwd()`，默认路径保持不变且为绝对路径 |
| Bridge 绝对 override | `PASS` | 1 / 1 | 显式绝对路径被接受 |
| Bridge 相对 override | `PASS` | 1 / 1 | 抛出 `AWKN_LLM_BRIDGE_DIR must be an absolute path` |
| Policy `none` 语义推导 | `PASS`（静态推导） | 2 / 2 断言 | 10 层为偶数次逻辑取反：leaf=false 得 false；leaf=true 得 true |
| Memory fail-closed 合同测试 | `NOT_EXECUTED` | 0 / 0 / 3 | 测试已新增；依赖安装受阻，未运行 |
| Bridge path 合同测试 | `NOT_EXECUTED` | 0 / 0 / 3 | 测试已新增；依赖安装受阻，未运行 |

### 4.1 修改文件语法检查清单

```text
runtime/test/contracts/policy-ast-deep.test.ts
runtime/src/llm/bridge-path.ts
runtime/src/llm/providers/trae.ts
runtime/scripts/bridge-daemon.ts
runtime/src/memory/awkn-memory-os-backend.ts
runtime/src/memory/router.ts
runtime/src/llm/router.ts
runtime/test/contracts/memory-backend-adapter.test.ts
runtime/test/contracts/bridge-path.test.ts
```

## 5. 无效或受限检查

| 命令 | 状态 | 解释 |
|---|---|---|
| 系统全局 `tsc --noEmit` | `FAIL / INVALID_AS_GATE` | 缺少项目依赖与 `@types/node`，产生模块和 Node 全局缺失错误；不能据此判断源码类型正确性。日志：`typecheck-global.log` |

## 6. 用户提供的基线

以下数字来自任务书，未在本沙箱复验：

| 门禁 | 用户提供结果 | 本次口径 |
|---|---:|---|
| Unit | `99 passed / 0 failed` | 历史输入 |
| Contract | `633 passed / 2 failed` | 历史输入 |
| 已知失败 | `policy-ast-deep.test.ts` 约第 149、154 行 | 已完成语义分析和最小测试修正，尚未运行完整合同测试 |
| TypeScript typecheck | 通过 | 历史输入 |
| Architecture Scan | blocking 0 | 本次另行复验通过 |

## 7. 两个 Policy 合同失败的语义结论

`none` 的实现语义为 `!children.some(child => evaluate(child))`。单子节点嵌套每层产生一次逻辑取反：

```text
深度 1：!leaf
深度 2：!!leaf = leaf
...
深度 10：leaf
```

因此：

- `deepNone(10, count === 999)`，上下文 `count=5`，leaf 为 false，最终为 false；
- `deepNone(10, count === 5)`，leaf 为 true，最终为 true。

原测试在偶数深度使用了奇数深度的预期。实现与 5 层测试保持一致，修复目标为测试断言。

## 8. 测试发现审计

| 类别 | 文件数 | 是否进入 `run-tests.mjs` |
|---|---:|---|
| `runtime/test/*.test.ts` | 8 | 是，unit 模式 |
| `runtime/test/contracts/**/*.test.ts` | 50 | 是，contracts 模式 |
| `runtime/test/verify-*.ts` | 23 | 否 |

未进入门禁的验证脚本包含：bridge daemon、hook fail-closed、evolve full loop、goal state machine、LLM timeout、provider empty content、loop checkpoint、工具错误传播等。

## 9. 外部 E2E

| 目标 | 状态 | 原因 |
|---|---|---|
| 真实 TRAE IDE | `NOT_EXECUTED` | 沙箱无 TRAE IDE 宿主 |
| 真实 Codex IDE | `NOT_EXECUTED` | 沙箱无 Codex IDE 宿主契约和会话 |
| 真实 AWKN Memory OS | `NOT_EXECUTED` | 未提供独立仓库或服务，不使用真实 Token |
| 生产数据库 / 用户数据 | `NOT_EXECUTED` | 任务明确禁止 |

## 10. 日志文件

- `npm-ci.log`
- `architecture-baseline.log`
- `architecture-after.log`
- `typecheck-global.log`

完整测试复验应在可正常访问锁文件依赖的 Node 20/22 环境执行，并附 CI artifact。
