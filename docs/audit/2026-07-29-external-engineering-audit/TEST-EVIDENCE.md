# TEST-EVIDENCE

## 一、环境

- OS：Linux sandbox
- Node：`v22.16.0`
- npm：`10.9.2`
- TypeScript 全局工具：`5.8.3`
- 工作目录：`/mnt/data/awkn-worktree/runtime`
- 源码 ZIP SHA-256：`88c4c23b4ba99ae093f82df1580279aacbc7ce78af963f9cd7d5aeb5c9adc813`
- ZIP 大小：`1,405,993 bytes`

## 二、实际执行结果

| 命令 | 状态 | 结果 |
|---|---|---|
| `sha256sum <zip>` | PASS | 与任务书给定 SHA-256 一致。 |
| `node --version` | PASS | `v22.16.0`。 |
| `npm --version` | PASS | `10.9.2`。 |
| `npm ci` | BLOCKED | 内部 npm 镜像请求 `zod-3.25.76.tgz` 返回 404。 |
| 强制官方 registry 的 `npm ci` | BLOCKED | 运行环境仍把 tarball 路由到内部镜像，同一 404。 |
| `node scripts/architecture-scan.mjs` | PASS | `blockingViolations=0`。 |
| TypeScript `transpileModule` 静态语法检查 | PASS | 补丁涉及的 3 个文件均 `syntax=ok`。 |
| `npm run typecheck` | 未执行 | `npm ci` 未完成，缺少项目依赖。 |
| `npm run lint` | 未执行 | 同上。ZIP 中该命令等同 `tsc --noEmit`。 |
| `npm run test` | 未执行 | 同上。 |
| `npm run test:contracts` | 未执行 | 同上。 |
| `npm run build` | 未执行 | 同上。 |
| Memory OS 定向合同测试 | 未执行 | 同上。 |
| 真实 TRAE IDE E2E | 未执行 | 沙箱没有 TRAE 宿主。 |
| 真实 Codex IDE E2E | 未执行 | 沙箱没有 Codex IDE 宿主。 |
| 真实 Memory OS 双仓 smoke | 未执行 | 未提供对端仓库、服务地址或测试凭据。 |

## 三、Architecture Scan 原始摘要

```text
blockingViolations=0
directDbImports=20
moduleSingletons=12
crossComponentImports=22
legacyExceptionsUsed=1
```

扫描报告：`logs/architecture-scan.json`

## 四、npm 安装失败摘要

```text
npm error 404 Not Found
GET .../zod/-/zod-3.25.76.tgz
```

原始日志：

- `logs/00-npm-ci.log`
- `logs/00b-npm-ci-public-registry.log`

## 五、补丁静态检查

执行方式：

```text
typescript.transpileModule(
  source,
  { module: NodeNext, target: ES2022, strict: true, reportDiagnostics: true }
)
```

结果：

```text
runtime/src/memory/awkn-memory-os-backend.ts: syntax=ok
runtime/src/memory/router.ts: syntax=ok
runtime/test/contracts/memory-backend-adapter.test.ts: syntax=ok
```

该检查只覆盖语法转换，无法替代项目 typecheck、contract test 或 runtime test。

## 六、基线数字的使用边界

任务书提供：

- Unit：`99 passed / 0 failed`
- Contract：`633 passed / 2 failed`
- 两个失败位于 `policy-ast-deep.test.ts`

这些数字属于用户给定基线，本次沙箱没有独立复验。Policy AST 的奇偶语义通过源码推导完成，当前 GitHub 主线也已更新相关断言。

## 七、复验命令

依赖镜像恢复后，在分支根目录执行：

```text
cd runtime
npm ci
npm run check:architecture
npm run typecheck
npm run lint
npm run test
npm run test:contracts
npm run test:verify
npm run build
node --import tsx --test test/contracts/memory-backend-adapter.test.ts
```

验收要求：

- 所有命令退出码 0。
- Memory 定向测试新增场景全部通过。
- 401/403 和协议 major 不兼容不得出现 local context。
- `memory-os` 的 transport/503 必须抛错。
- `auto` 的 transport/503 可返回 `backend=local, stale=true`。
