# AGENTS.md — runtime 核心模块 Agent 上下文

版本: v1.0
定位: 最小 Agent 上下文入口，只放 owner 路由、边界与风险指引；不放执行长流程。
事实源: `scripts/architecture-scan.mjs`（ARCH-001~007 机器校验）、`../.trae/rules/tianshu-dispatch.md`（任务层级协议）、`../capabilities/project/manifest.yaml`（能力角色）。

---

## 1. 模块 owner 路由

runtime/src 核心模块按主链分组，实现 owner 均为 **天火 (tianhuo)**，审核 owner 为 **audit**，修改前门禁为 **execution-check**（awkn-执行检查）。

| 模块 | 归属 | 角色职责 | 改动前必看 |
|------|------|----------|------------|
| `contracts` | 天火 | 全模块共享契约；改动波及面最大 | `npm run test:contracts`；禁止依赖 runtime 实现 |
| `input` `intent` `context` `policy` | 天火 | Trusted Input → Goal 主链前半段 | 对应 `public.ts` 导出面 |
| `goal` `loop` `gates` `core` | 天火 | Evidence-Gain Loop 心脏 | `core/agent-loop.ts`、`loop/evidence-loop.ts` 的状态机语义 |
| `broker` `tools` `llm` | 天火 | Tool & Model Broker | 工具授权策略（tianshu-dispatch 第五节） |
| `delivery` `outcome` | 天火 | Delivery Router → 证据/结果 | 输出契约与回滚路径 |
| `memory` `evolve` `store` | 天火 | 记忆写入门与进化；`store` 直连 DB | `store/db` 仅允许经授权层引用；迁移版本连续性 ARCH-007 |
| `workflow` `workgraph` `orchestrator` `cron` | 天火 | 编排与定时 | 状态机/协议变更需升级任务层级至 L2/L4 |
| `review` | audit | 代码审核；**不得自改自审** | 审核走 `awkn-审核`，提交前冻结目标 |
| `observability` `recovery` `governor` `sandbox` `shadow` | 天火 | 支撑与治理 | 变更需保留可观测性与回滚证据 |

## 2. 边界（机器强制，勿绕过）

- 跨组件 import 只能走 `*/public.ts`、`*/public.js` 或 `*/ports/inbound/`（ARCH-002）；strict 组件（contracts/input/intent/context/policy/skills/broker/loop/delivery/outcome/review）违规直接 fail。
- `contracts` 不得依赖任何 runtime 实现（ARCH-001）。
- strict 组件不得直连 `store/db`（ARCH-003）、不得声明可变模块单例 `let instance`（ARCH-004）。
- `domain/` `application/` 层不得直读 `process.env`（ARCH-006）。
- `store/agent-os-migration-registry.ts` 迁移版本必须连续无重复（ARCH-007）。
- 新增架构例外必须带移除工作包，且需架构评审；`legacyExceptions` 是债务登记簿，不是通行证。

## 3. 风险指引

- **高风险**：`core` `loop` `gates` `store` `contracts` —— 动前先跑 `npm run check` 基线，改动后全量 `npm run check`；涉及状态机/协议/DB 时按 tianshu-dispatch L2 建 Goal 闭环。
- **中风险**：`workflow` `orchestrator` `cron` `memory` `evolve` `mcp` `worker` —— 先跑受影响单测，再跑 contracts。
- 所有修改先过 `awkn-执行检查`（只读定位 + 影响范围 + 计划），完成后由独立 `awkn-审核` 复核；验证以 `npm run check` 输出为准，禁止跳过测试或弱化验收。

## 4. 验证命令

```bash
cd runtime
npm run check            # architecture + typecheck + lint + unit/contracts/verify
npm run check:architecture  # 只看 ARCH-001~007
```
