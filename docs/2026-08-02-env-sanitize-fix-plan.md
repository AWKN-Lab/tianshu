# Env 净化修复落地计划（2026-08-02）

来源：CICD 偶发失败根因（`runtime/.env` 经 `loadRuntimeEnv` 泄漏进测试进程）已修复（57b5d41），本计划覆盖审核发现的遗留项。

## 背景与目标

- 根因：`runtime/src/action/action-cli.ts:38` → `loadRuntimeEnv()` 注入 `.env`（`AWKN_APPROVED_TOOLS=exec,write`、`AWKN_LLM_PROVIDER=codex` 等）到 CICD 子进程 → 测试断言被污染（tool-policy/metrics 偶发失败，失败点漂移）。
- 已落地：`run-tests.mjs` 净化测试进程 env（剔除全部 `AWKN_*`，保留 `AWKN_DB_PATH`），CICD 已 PASS（f01a7c32）。
- 本计划目标：清理审核发现的 4 项遗留，使"所有测试入口免疫 + 测试自给自足 + 边界可读"。

## 影响范围

| 文件 | 当前状态 | 归属 |
|---|---|---|
| `runtime/test/llm-router-metrics.test.ts` | 未提交修改（并行会话 09:51，beforeEach delete env） | 并行会话 |
| `runtime/package.json`（test:coverage 脚本） | 已提交 | 既有 |
| `runtime/test/contracts/tool-policy.test.ts` | 已提交（afterEach-only 清理） | 既有 |
| `runtime/scripts/run-tests.mjs`（净化注释） | 已提交（57b5d41） | 我 |

## 任务分解

### P1：llm-router-metrics.test.ts 清理未用 import（低风险，先并行会话确认）

- 动作：删除未使用的 `afterEach` import（`:4`），保留 beforeEach delete env 逻辑（它是 test:coverage 等未净化入口的唯一防线，不删）。
- 注意：文件是并行会话未提交修改，动工前须 `git status` 确认其未继续编辑；若仍活跃，改为注释说明等待其收口。
- 验收：`node --import tsx --test test/llm-router-metrics.test.ts` 4/4 通过。
- 回滚点：commit 前 diff 留痕。

### P2：test:coverage 入口（中风险，二选一决策）

现状：`package.json:22` `node --experimental-test-coverage --import tsx --test test/*.test.ts test/contracts/*.test.ts` —— 无净化、无 EventStore 隔离，含 .env 的 shell 下会复现同款失败。

- 选项 A（推荐，最小）：docs/README 或脚本注释标注"须在干净 env 运行（避免 .env 泄漏）"，不纳入门禁。
- 选项 B：改为经 run-tests.mjs 包装（净化 + DB 隔离 + coverage flag 透传），成本中等。
- 验收：A → 文档标注可见；B → `npm run test:coverage` 在注入 .env 的 shell 下 0 fail。
- 决策点：@用户 确认 A/B。

### P3：tool-policy.test.ts 改 beforeEach 清理（根治推进，低风险）

- 动作：`afterEach` → `beforeEach`（第一个用例前 env 即干净，不再依赖净化兜底），保留 afterEach 双保险。
- 验收：在 `AWKN_APPROVED_TOOLS=write` 污染的 shell 下直接 `node --import tsx --test test/contracts/tool-policy.test.ts`（不经 run-tests.mjs）全过。
- 回滚点：单文件 commit，可 revert。

### P4：run-tests.mjs 净化注释补已知边界（零风险）

- 动作：buildTestEnv 注释补充：① spawn 子进程若自身调用 loadRuntimeEnv（cli.ts:29、mcp/server.ts:34 模块顶层）将从磁盘重载 .env，净化无效；② verify 模式保留宿主 env 的理由（verify 脚本自给自足，非依赖宿主配置，待 P2 决策后统一措辞）。
- 验收：注释可读，无行为变更。

## 执行顺序

P4（零风险）→ P3（小改）→ P1（待并行会话确认）→ P2（需用户决策）

## 验收命令（全量）

```bash
npm run check                # architecture + tsc + lint + unit + contracts + verify 全绿
node bin/awkn-action-runner.js run --pipeline cicd   # CICD 全绿（终验）
```

## 风险

- P1 与并行会话并发编辑同一文件 → 动工前核对 `git status`/mtime，最后一次保存为准。
- P2 选项 B 若改 run-tests.mjs 包装，可能影响 `npm run test`/`test:all` 既有行为 → 需全量回归。
- P3 改动 tool-policy 后，若净化失效时行为由"依赖外部"变"自给自足"，语义增强无回归风险。

## 不做

- 不改 `runtime/.env` 内容（机器级配置，gitignore，非代码问题）。
- 不动 EXP-LEGACY-E01..E26（并行会话 AGENTS 经验迁徙产物，另行收口）。
- 不处理 packages/awkn-engine-mcp 独立测试套件（非门禁，记录为后续项）。
