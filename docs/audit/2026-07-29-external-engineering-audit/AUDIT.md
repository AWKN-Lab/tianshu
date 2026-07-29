# AWKN 天枢外部工程审查

- 审查对象：`AWKN-Lab/tianshu`
- 源码快照：`awkn-engine-source-b090fa9-working-tree-v2.zip`
- 快照基线：`b090fa9535ea3324eb518021cf9b327625fe03e3`
- 快照 SHA-256：`88c4c23b4ba99ae093f82df1580279aacbc7ce78af963f9cd7d5aeb5c9adc813`
- 审查日期：2026-07-29
- 主线复核点：`main@9810bc0768d545a305aa0aecfa8ad578524eab24`

## 一、结论

当前实现尚未形成任务书定义的完整运行闭环。

ZIP 快照具备 Engine v2 的 L1/L2 执行、质量门、失败记录、Corrections、Experience Candidate、Replay 与 Lifecycle 等组件。主链在质量门全通过后由 `AgentLoop` 直接把 Goal 写为 `achieved`，调用者标记为 `model`。Delivery、Outcome、Memory Write、Evolve 晋级后的下一轮加载没有连成同一条可达调用链。该路径可产生假成功。

2026-07-29 的 GitHub 主线已经新增 Evidence-Gain Loop、Delivery Router、Outcome Recorder、Memory Write Gate 和 Candidate Factory v2。Evidence-Gain Loop 已接入 `AgentLoop.runL2`，默认由环境变量关闭。C07-C09 组件仍未进入 `AgentLoop` 的成功交付链，Goal 的两个成功路径仍由 `model` 直接写入 `achieved`。

Skill 系统已支持外置 `SKILL.md` 加载和触发匹配。Skill Compiler 与 Evaluation Registry 具备代码和合同测试，生产调用链没有调用它们。历史 Outcome、Replay 指标、审核结果、ACTIVE 版本尚未自动汇入下一次 Skill 编译与执行。

TRAE 已有 hook 兼容与文件桥；Codex 已有 OpenAI-compatible HTTP Provider。源码没有提供 TRAE IDE 或 Codex IDE 的完整宿主握手、安装、生命周期、工作区定位和真实宿主 E2E 证据。

Memory OS 已有天枢侧 Adapter、协议探测、Context Assemble/Render、Observe/Consume、Capture 与 Outbox。当前测试使用本地 fake HTTP server。Project Grant、Descriptor、双仓真实服务、CAS Transaction、Tombstone 和版本矩阵尚未完成真实 E2E。远端读取异常曾被统一降级到本地，补丁已按文档收紧为 fail-closed。

## 二、证据状态矩阵

| 主题 | 快照状态 | 当前主线状态 | 证据与判断 |
|---|---|---|---|
| Engine v2 L1/L2 循环 | `INTEGRATED` | `INTEGRATED` | `runtime/src/core/agent-loop.ts` 执行 L1、质量门、修复上下文和最大循环控制。 |
| Goal Judge | `CODE_PRESENT` | `CODE_PRESENT` | `runtime/src/goal/application/goal-judge.ts` 有确定性判定；`AgentLoop` 未调用。 |
| Goal 达成写入 | `INTEGRATED`，语义违规 | `INTEGRATED`，语义违规 | 快照 `agent-loop.ts:384-388` 由 `model` 写 `achieved`；主线仍有两个同类路径。 |
| Evidence-Gain Loop | `CODE_PRESENT` | `INTEGRATED` | 快照文件存在但主链未导入；主线已接入 `runL2`，默认关闭，异常会警告后继续旧路径。 |
| Delivery | `DESIGN_ONLY` | `CODE_PRESENT` | 快照缺少 `src/delivery/`；主线新增 Router 与 Adapter，未进入 `AgentLoop`。 |
| Outcome | `DESIGN_ONLY` | `CODE_PRESENT` | 主线新增 Recorder，未进入 `AgentLoop`。 |
| Memory Write Gate / Transaction | `DESIGN_ONLY` | `CODE_PRESENT` | 主线新增实现，未形成运行终态写入链。 |
| Corrections Ledger | `INTEGRATED` | `INTEGRATED` | Gate 和 Loop Failure 有真实写入入口，SQLite 持久化。 |
| Pattern Detection | `INTEGRATED` | `INTEGRATED` | Corrections 可进入 PatternDetector。 |
| Experience Writer | `INTEGRATED` | `INTEGRATED` | 可写 Markdown draft 与 SQLite candidate。 |
| Replay / Approval / Promotion / Quarantine / Rollback | `INTEGRATED` 于演进子系统 | `INTEGRATED` 于演进子系统 | Lifecycle 与 Replay 有实现和持久化；运行入口通过 CLI/Orchestrator。 |
| ACTIVE 资产进入下一次 Policy/Skill 编译 | `DESIGN_ONLY` | `CODE_PRESENT`，调用链断开 | 搜索不到生产侧 `compilePolicyBundle`、`compileSkillBundle` 调用。 |
| 外置 Skill 加载/匹配 | `INTEGRATED` | `INTEGRATED` | `skills/manager.ts` 被 CLI 与 skill tool 使用。 |
| Skill Compiler | `CODE_PRESENT` | `CODE_PRESENT` | 仅合同测试调用；preflight 固定通过。 |
| Skill Evaluation Registry | `CODE_PRESENT` | `CODE_PRESENT` | 内存态，生产调用链无入口。 |
| TRAE hook / 文件桥 | `INTEGRATED`，需人工配置 | `INTEGRATED`，需人工配置 | Provider、daemon、文件协议存在；默认目录依赖 CWD。 |
| TRAE IDE 完整宿主集成 | `BLOCKED_EXTERNAL` | `BLOCKED_EXTERNAL` | 缺真实 IDE 宿主 E2E、工作区安装和生命周期证据。 |
| Codex HTTP Provider | `INTEGRATED` | `INTEGRATED` | 调用 `/chat/completions`，依赖 `AWKN_CODEX_API_KEY`。 |
| Codex IDE 完整宿主集成 | `BLOCKED_EXTERNAL` | `BLOCKED_EXTERNAL` | HTTP Provider 不能证明 IDE 宿主接入。 |
| Memory OS 天枢 Adapter | `INTEGRATED` | `INTEGRATED` | 协议探测、Context、Capture、Observe、Consume、Outbox 可达。 |
| Memory OS 合同测试 | `MOCK_OR_FIXTURE_ONLY` | `MOCK_OR_FIXTURE_ONLY` | `memory-backend-adapter.test.ts` 启动本地 HTTP fake server。 |
| Memory OS 双仓真实闭环 | `BLOCKED_EXTERNAL` | `BLOCKED_EXTERNAL` | 缺对端仓库、真实服务、Grant 与双仓 smoke。 |
| Architecture Scan | `REAL_E2E_VERIFIED` 于本地静态扫描 | `REAL_E2E_VERIFIED` 于本地静态扫描 | 本次执行 `blockingViolations=0`，仍记录 20/12/22/1 项架构债。 |
| 完整 Node 门禁 | 未复验 | 未复验 | `npm ci` 被依赖镜像的 `zod@3.25.76` 404 阻断。 |

## 三、闭环可达性图

```text
用户输入
  -> CLI / AgentLoop
  -> runL1 ReAct + Tool Registry
  -> runL2 cycle
  -> typecheck/test/lint/review/budget gates
  -> [断点 P0-01] model 直接写 Goal=achieved
  -> Run=succeeded
  X  Delivery Contract/Receipt 未参与成功判定
  X  Outcome Recorder 未参与成功判定
  X  Memory Write Gate/Transaction 未参与终态链
  X  Candidate Factory/Replay/Approval 未由本次 Run 自动触发
  X  ACTIVE Policy/Skill 未自动进入下一次运行
```

当前主线新增路径：

```text
runL2
  -> EvidenceGainLoop.planCycle
  -> 原有 L1 + gates
  -> EvidenceGainLoop.evaluateCycle
  -> CycleReceipt 写 EventStore
  -> Strategy hint / Stop Decision
  -> [断点 P0-01] SUCCESS 仍由 model 写 Goal=achieved
  X  Delivery Router
  X  Outcome Recorder
  X  Memory Write Gate
  X  Candidate Factory v2
```

演进子系统内部路径：

```text
Gate/Loop failure
  -> Corrections Ledger
  -> Pattern Detector
  -> Experience Writer
  -> Candidate(DRAFT)
  -> Replay Evaluation
  -> Approval / Promotion
  -> ACTIVE / Quarantine / Rollback
  -> [断点 P1-02] ACTIVE 内容未进入 PolicyRegistry/SkillEvaluationRegistry
  -> [断点 P1-02] 下一次 AgentLoop 不读取晋级资产
```

Memory OS 路径：

```text
MemoryBackendRouter
  -> protocol
  -> projects
  -> context/assemble
  -> receipt/render
  -> prompt + receipt/render refs
  -> observe / consume / capture
  -> [外部阻断] Project Grant endpoint 与真实对端未验证
  -> [已修 P0-02] 401/403/协议错误禁止 local fallback
```

## 四、核心调用链证据

### 4.1 Goal 成功判定绕过 Goal Judge

- 快照：`runtime/src/core/agent-loop.ts:343-388`
- 质量门集合：typecheck、test、lint、independent review、budget。
- 成功分支：`goalManager.updateGoal(..., { state: 'achieved' }, 'model')`。
- Goal Judge：`runtime/src/goal/application/goal-judge.ts`。
- 搜索结果：`AgentLoop` 没有导入或调用 Goal Judge。

质量门通过可以证明构建与测试状态，无法独立证明用户交付、外部副作用完成、Acceptance 全覆盖和业务目标达成。

### 4.2 ExecutionCoordinator 范围停在 Context Ready

- `runtime/src/composition/execution-coordinator.ts:236-364` 调用 Input、Intent、Context。
- `:366-403` 可选调用 Claim Resolver。
- `:430-433` 的 `runRefs`、`deliveryRefs`、`memoryDecisionRefs`、`evolutionCandidateRefs` 为空。
- `:445-446` 直接丢弃 `contextReceipt` 与 `claimReceipt` 局部变量。

C01-C09 的完整编排尚未落到该 Coordinator。

### 4.3 Skill Compiler 与运行主链断开

- `runtime/src/skills/manager.ts` 支持扫描目录、解析 `SKILL.md`、启用状态和 trigger 匹配。
- `runtime/src/skills/compiler.ts:86` 定义 `compileSkillBundle`。
- `runtime/src/skills/evaluation-registry.ts:67` 定义 Registry。
- 生产目录搜索不到两者的调用点；调用集中在 `runtime/test/contracts/skill-compiler.test.ts`。
- `compiler.ts:97-98` 丢弃 `preflightContext`。
- `compiler.ts:189-207` 把所有 preflight 结果固定为 PASS。
- `evaluation-registry.ts:65` 明确标注内存态和无持久化。

Outcome/Replay 指标只能由调用方手工传入，当前运行时没有自动取数与激活链。

### 4.4 Evolve 有内部生命周期，下一轮生效链缺失

- `runtime/src/evolve/lifecycle.ts` 支持 activate、quarantine、rollback 与 activation history。
- `lifecycle.ts:195-200` 把 ACTIVE experience 投影到本地 MemoryService；异常被吞掉。
- `runtime/src/evolve/operational-evolution.ts` 可执行 replay、promote 与 authority 治理。
- Policy/Skill Compiler 没有消费这些 ACTIVE candidate。

当前演进结果可以保存在数据库或本地 Memory，运行规则与 Skill 选择没有随之更新。

### 4.5 IDE 兼容边界

- TRAE：`runtime/src/llm/providers/trae.ts` 先调用 hook，再写文件桥请求。
- TRAE 默认桥目录：`resolve(process.cwd(), 'runtime', 'data', 'llm-bridge')`。
- daemon 与 monitor 使用同类 CWD 推导。
- 请求文件直接 `writeFileSync`；多 daemon 没有跨进程 claim/lock。
- Provider `isAvailable()` 固定返回 true。
- Codex：`runtime/src/llm/providers/codex.ts` 调用 OpenAI-compatible `/chat/completions`。

这些代码可支撑 API 与桥接兼容。IDE 宿主安装、启动、工作区定位、关闭恢复和真实消息往返仍需宿主侧验收。

### 4.6 Memory OS 边界

- 当前 Adapter 调用 `/api/v1/protocol`、`/api/v1/projects`、`/api/v1/context/assemble`、Render、Observe、Consume、Capture、Session Start。
- RFC 目标包含 `/api/v1/projects/{projectId}/grant`、Descriptor、Truth Diagnostics、Transaction CAS、Tombstone 等能力。
- 当前 Adapter 没有这些调用。
- 测试由 `node:http` 在进程内模拟对端。

本次补丁修复了路由降级规则。Grant、真实协议矩阵与双仓事务仍由对端工作阻塞。

## 五、缺陷清单

### P0

| ID | 路径 / 符号 | 复现 | 影响 | 正确约束 | 处理 |
|---|---|---|---|---|---|
| P0-01 | `runtime/src/core/agent-loop.ts` / `runL2` | 让全部质量门返回 PASS，观察 Goal history 的 actor=`model` | 模型路径可宣称 Goal 达成；Delivery 和 Acceptance 缺失时仍成功 | 只有 Goal Judge 可生成 `ACHIEVED` | 未直接修。需要 Legacy Goal -> GoalSpec、EvidenceSet、DeliveryPreconditions 的适配层和回归测试。 |
| P0-02 | `runtime/src/memory/router.ts` / `compileAndRender` | 远端返回 401/403、协议 major=2，旧实现返回 local stale context | 授权和协议错误被本地数据掩盖，形成越权绕行与假上下文 | `memory-os` 全错误 fail-closed；`auto` 仅 Transport/5xx 读降级；401/403/协议错误阻断 | 已提供补丁与 5 组测试。 |

### P1

| ID | 路径 / 符号 | 影响 | 建议 |
|---|---|---|---|
| P1-01 | `AgentLoop` 与 `delivery/`、`outcome/`、`memory/write-gate.ts`、`evolve/candidate-factory-v2.ts` | C07-C09 代码无法证明端到端闭环 | 由 `ExecutionCoordinator` 统一编排；每段产出 Receipt Ref；Goal Judge 读取 Delivery 和 Outcome。 |
| P1-02 | Evolve ACTIVE -> Policy/Skill 编译 | 晋级资产对下一次执行无效果 | 建立持久 Registry Adapter；编译时只读取 ACTIVE 版本；Bundle hash 写 CyclePlan 与 Run Receipt。 |
| P1-03 | `skills/compiler.ts` preflight | 权限、依赖、冲突、环境条件被固定判定通过 | 引入可注入 PreflightPort；缺 evaluator 直接拒绝；结果写 CompilerReceipt。 |
| P1-04 | `execution-coordinator.ts:430-446` | Receipt 生成后丢弃，Envelope 缺引用 | 把 Input/Intent/Context/Claim Receipt 作为返回值和 Envelope refs 持久化。 |
| P1-05 | 主线 `AgentLoop` Evidence Loop catch | 显式启用后，计划或评估错误会静默回到旧流程 | flag 启用时 fail-closed 或进入 PAUSE；写结构化诊断 Receipt。 |
| P1-06 | 主线 `delivery/router.ts` / `InMemoryDeliveryAdapter` | 无真实 artifact hash 时填 64 个零并标记 verifiedSuccess | 仅限测试 fixture；生产 composition root 禁止注册；CHAT 交付也需真实 content hash。 |
| P1-07 | TRAE bridge | CWD 错位、请求非原子、多 daemon 重复消费、错误原因丢失 | 强制绝对 `AWKN_LLM_BRIDGE_DIR`；原子请求写；claim 文件；单实例锁；响应透传 error。 |
| P1-08 | Memory OS Adapter / Project Grant | 客户端没有明确 Grant 获取和 Receipt 绑定 | 对端提供 Grant endpoint；Context Receipt 带 grantHash；越界 Item 直接拒绝。 |
| P1-09 | `skills/manager.ts` malformed skill skip | 第三方 Skill 解析错误静默消失 | 返回 load diagnostics；生产 enforce 模式对显式请求 Skill fail-closed。 |

### P2

| ID | 位置 | 影响 | 建议 |
|---|---|---|---|
| P2-01 | ZIP `runtime/package.json` lint | lint 与 typecheck 完全重复 | 主线已改为 Architecture Scan；脚本名称建议改 `check:policy-architecture`，另接 ESLint 或 Biome。 |
| P2-02 | ZIP `scripts/run-tests.mjs` | `verify-*.ts` 未进入默认门禁 | 主线已纳入 root verify；进一步递归发现并输出 skip reason。 |
| P2-03 | `skills/evaluation-registry.ts` | 同 skillId 多版本数据模型较弱，内存重启丢失 | 用 `(skillId, version)` 作为主键并持久化。 |
| P2-04 | `memory/outbox.ts` | 默认路径依赖 CWD，跨进程共享不稳定 | 要求绝对路径或项目根定位；增加文件锁与原子 replace。 |
| P2-05 | README 与开发计划状态词 | “端到端”“真实”“自主”容易覆盖 fixture 和代码存在状态 | 使用本文状态枚举，附 commit、command、host、service endpoint 与 evidence hash。 |

## 六、已知合同测试失败的语义结论

`none` 运算实现为 `!children.some(...)`。每包一层 `none` 等价于一次布尔取反：

- 10 层：偶数次取反，结果与叶节点一致。
- 5 层：奇数次取反，结果与叶节点相反。

ZIP 中约第 149、154 行的两个期望值与该语义冲突，测试断言需要修正，AST 实现无需改动。当前 GitHub 主线已经采用奇偶一致的断言，本次分支没有重复修改该文件。

## 七、补丁说明

补丁文件：`PATCH.diff`

变更文件：

1. `runtime/src/memory/awkn-memory-os-backend.ts`
   - 新增 `MemoryHttpError`，保留 HTTP 状态、方法、路径与响应体。
   - 缺少 `receipt_id` 归类为协议错误。
2. `runtime/src/memory/router.ts`
   - `memory-os` 模式禁止本地降级。
   - `auto` 仅允许 Transport、Timeout、HTTP 5xx 的读取路径降级。
   - 401/403、协议错误、未知错误继续抛出。
3. `runtime/test/contracts/memory-backend-adapter.test.ts`
   - 覆盖 auto transport fallback。
   - 覆盖 explicit memory-os transport fail-closed。
   - 覆盖 401/403 fail-closed。
   - 覆盖协议 major 不兼容。
   - 覆盖 503 在 auto 与 memory-os 的差异。

补丁基于当前主线相同 blob：

- backend base blob：`4112627ff28da56619a7f78d38573a040f3c7eb8`
- router base blob：`f8253929cd1907b21e55f9cf8a5b369664683d70`
- test base blob：`d8377efe215f0dc247c1bd0d4aca47231b0822c7`

## 八、文档修正建议

建议把项目状态页改成以下口径：

| 当前宣称 | 建议文本 |
|---|---|
| “自主执行闭环完成” | “Engine v2 L1/L2 与 Evidence-Gain Loop 已接入；Goal Judge、Delivery、Outcome、Memory Write、Evolve 下一轮生效仍待主链集成。” |
| “Skill 会自我进化” | “Skill 加载与匹配可运行；Compiler、Evaluation Registry 和 Replay 具备代码与合同测试；ACTIVE Skill 自动进入下一次运行尚未接通。” |
| “TRAE/Codex IDE 已支持” | “TRAE hook/文件桥与 Codex-compatible API Provider 可用；真实 IDE 宿主 E2E 尚未验证。” |
| “Memory OS 已端到端打通” | “天枢侧 Adapter 与 fake server 合同测试可运行；Project Grant 与双仓真实服务 smoke 尚未完成。” |
| “lint 通过” | “Architecture policy scan 通过；代码风格与语义 lint 未配置。” |

每个状态声明建议附四项证据：精确 commit、执行命令、运行环境、原始日志或 artifact hash。
