# AWKN-Lab/tianshu 源码级外部工程审计

## 0. 审计基线

- 审计对象：随附工作树 ZIP，本地目录名 `awkn引擎`
- 分支基线：`codex/phase6-runtime-foundation`
- HEAD：`b090fa9535ea3324eb518021cf9b327625fe03e3`
- 上游基线（任务书）：`tianshu/main@b0312e0ab77ba543e5c7e78913dc8d66360a8c89`
- 交付时远程状态：`main@bc3869412e9b683b03ad808304ba682c2d5fe995`，相对审计 HEAD 前进 2 个提交；其中 `dd5039e1dce27081702e68c5c6e8e988806623c4` 声称 Shadow Integration 为 GO。本次沙箱未能独立执行该脚本。
- 源码包 SHA-256：`88c4c23b4ba99ae093f82df1580279aacbc7ce78af963f9cd7d5aeb5c9adc813`
- 审计日期：2026-07-29
- 证据口径：源码调用链、实际执行日志、测试发现规则、设计文档。类型存在、测试夹具、mock server、手动脚本均不计为真实宿主或双仓 E2E。

## 1. 结论先行

当前工作树尚未形成以下完整闭环：

```text
自主执行
→ 自动循环
→ Evidence / Gate
→ Goal Judge
→ Delivery
→ Outcome
→ Memory Write
→ Failure Experience
→ Replay / Evaluation
→ Approval / Promotion
→ ACTIVE Policy / Skill
→ 下一次运行自动生效
```

Engine v2 已具备运行、工具调用、门禁、检查点、部分失败纠正记录等能力。Agent OS 3.0 的 C01-C09 主链仍处于分组件建设与 Shadow 准备阶段。`ExecutionCoordinator` 当前止于 WP02-WP05，Engine v2 的成功出口直接写入 `achieved`，Goal Judge、Delivery、Outcome、Memory Write Gate、自动 Evolve 和下一次编译激活均未接通。

### 1.1 核心主题状态

| 主题 | 状态 | 审计结论 |
|---|---|---|
| Engine v2 自主执行与门禁 | `INTEGRATED` | 默认执行链可达；成功状态仍绕过权威 Goal Judge。 |
| Agent OS C01-C09 主链 | `CODE_PRESENT` | `ExecutionCoordinator` 接通 C01-C03/WP02-WP05；C04-C09 引用为空，未成为默认执行路径。独立 Shadow 脚本存在，补丁后完整执行未在本沙箱复验。 |
| Evidence-Gain Loop | `CODE_PRESENT` | 合约、纯编排器和合同测试存在；未接入 `AgentLoop.runL2`，状态由实例内存和调用方重放输入维持。 |
| Goal Judge | `CODE_PRESENT` | `judgeGoal()` 与合同测试存在；生产执行器没有调用它。 |
| Delivery / Outcome / Memory Write Gate | `DESIGN_ONLY` | 设计文档存在，权威运行文件缺失，默认链无调用边。 |
| Failure correction / generic Evolve | `CODE_PRESENT` | SQLite 生命周期、ReplayEvaluator、OperationalEvolution 可被手动 CLI 或测试驱动；默认运行链没有自动调度。 |
| Skill 外置加载 | `INTEGRATED` | `skills/manager.ts` 可索引、匹配、读取外置技能。 |
| Skill Outcome/Replay 进化 | `CODE_PRESENT` | Compiler 与 EvaluationRegistry 存在；ACTIVE 转换未强制回放条件，版本历史会被覆盖，运行链未注入 ACTIVE 注册表。 |
| TRAE Hook / 文件桥 | `CODE_PRESENT` | 兼容层可生成请求和等待响应；验证脚本使用 mock daemon，缺少真实 TRAE IDE 宿主证据。 |
| TRAE IDE 宿主集成 | `BLOCKED_EXTERNAL` | 无宿主握手、生命周期、配置安装、真实调用回执。 |
| Codex OpenAI-compatible provider | `CODE_PRESENT` | 通过 `/chat/completions` 和 API Key 调用兼容接口。 |
| Codex IDE 宿主集成 | `DESIGN_ONLY` | hooks.json 事件名兼容不构成 IDE 宿主链，仓库中未找到宿主接入实现。 |
| Memory OS TypeScript adapter | `CODE_PRESENT` | v1 protocol/context/capture/observe/consume/session API 已编码。 |
| Memory OS 单仓验证 | `MOCK_OR_FIXTURE_ONLY` | 合同测试启动本地 HTTP 测试服务器；未连接独立 Memory OS 仓库或服务。 |
| Memory OS vNext 双仓闭环 | `BLOCKED_EXTERNAL` | Grant、Descriptor、CAS Transaction、Tombstone、Outcome Attribution、完整 Authority 版本矩阵尚未在本仓形成可运行协议链。 |
| 真实生产闭环 | `BLOCKED_EXTERNAL` | 缺少真实 IDE、真实 Memory OS、真实凭据边界和生产部署验证。本次未使用任何真实凭据。 |

本次审计没有认定任何四大主题达到 `REAL_E2E_VERIFIED`。

## 2. 证据矩阵

### 2.1 自主执行、自动循环与交付闭环

| 证据 | 状态 | 代码位置 | 判断 |
|---|---|---|---|
| R2 Coordinator 的范围声明 | `CODE_PRESENT` | `runtime/src/composition/execution-coordinator.ts:13-14,193-201` | 文件明确声明无持久化、无 Shadow Diff；编排 WP02-WP05。 |
| C07-C09 引用 | `CODE_PRESENT` | `runtime/src/composition/execution-coordinator.ts:262-264,305-307,431-433` | `deliveryRefs`、`memoryDecisionRefs`、`evolutionCandidateRefs` 在所有返回路径均为空数组。 |
| Engine v2 成功出口 | `INTEGRATED` | `runtime/src/core/agent-loop.ts:343-388` | 门禁通过后直接调用 `goalManager.updateGoal(..., {state:'achieved'}, 'model')`。 |
| 其他成功出口 | `INTEGRATED` | `runtime/src/orchestrator/tianhuo-cicd-loop.ts:121-123`; `runtime/src/orchestrator/prd-centric-loop.ts:183-190` | 两个执行器同样由模型来源直接标记 `achieved`。 |
| Goal Manager 权限 | `INTEGRATED` | `runtime/src/goal/goal-manager.ts:151-199` | 状态机检查存在；模型仍可生成 `achieved`。 |
| 权威 Goal Judge | `CODE_PRESENT` | `runtime/src/goal/application/goal-judge.ts:21-105` | 纯函数实现存在；源码调用搜索只发现测试、适配器与声明，生产执行器未调用。 |
| R2 Shadow 自述 | `CODE_PRESENT` | `runtime/src/shadow/shadow-execution.ts:92,444-451`; `runtime/src/adapter/legacy-goal-manager-adapter.ts:8-25` | 源码注释明确记录 R2 Goal Judge 未接入，Engine v2 仅可后置推断。 |
| Delivery Router | `DESIGN_ONLY` | `runtime/src/delivery/router.ts` 缺失 | 无权威运行实现。 |
| Outcome Recorder | `DESIGN_ONLY` | `runtime/src/outcome/recorder.ts` 缺失 | 无权威运行实现。 |
| Memory Write Gate | `DESIGN_ONLY` | `runtime/src/memory/write-gate.ts` 缺失 | 无成功结果到长期记忆的权威门禁。 |

### 2.2 Evidence-Gain Loop

| 证据 | 状态 | 代码位置 | 判断 |
|---|---|---|---|
| Public Contract | `CODE_PRESENT` | `runtime/src/contracts/evidence-loop.ts`; `runtime/src/contracts/public.ts` | 新合约已进入 public export。 |
| Loop 编排器 | `CODE_PRESENT` | `runtime/src/loop/evidence-loop.ts:1-20,165-188` | 文件定义纯编排层，并写明上层 `AgentLoop.runL2` 负责执行。当前 `AgentLoop` 无调用。 |
| 恢复能力 | `CODE_PRESENT` | `runtime/src/loop/evidence-loop.ts:373-391` | `replayHistory()` 只消费调用方提供的 `StrategyAttempt[]`，没有 EventStore 读取或持久化写入。 |
| 测试 | `MOCK_OR_FIXTURE_ONLY` | `runtime/test/contracts/evidence-loop.test.ts` | 合同逻辑可测，未证明真实工具、模型、恢复和副作用去重链。 |

### 2.3 Skill 加载、评测和进化

| 证据 | 状态 | 代码位置 | 判断 |
|---|---|---|---|
| 外置技能加载 | `INTEGRATED` | `runtime/src/skills/manager.ts:59-98` | 目录扫描和按名称记录可运行；畸形第三方技能在 `:88` 静默跳过。 |
| 版本保存 | `CODE_PRESENT` | `runtime/src/skills/manager.ts:59`; `runtime/src/skills/evaluation-registry.ts:68-71` | Map 主键为 skill name/skillId，同 ID 新版本覆盖旧 manifest，无法保留完整版本链。 |
| Compiler 预检 | `CODE_PRESENT` | `runtime/src/skills/compiler.ts:93-98,189-207` | `preflightContext` 未使用，所有预检结果固定 `passed:true`。 |
| Compiler 候选状态 | `CODE_PRESENT` | `runtime/src/skills/compiler.ts:116-145` | `APPROVED` 与 `ACTIVE` 均可被选入；兼容风险固定为 0。 |
| Evaluation Registry 持久化 | `CODE_PRESENT` | `runtime/src/skills/evaluation-registry.ts:65-71` | 注释标记 Mode 0、内存态。进程退出后状态丢失。 |
| ACTIVE 约束 | `CODE_PRESENT` | `runtime/src/skills/evaluation-registry.ts:136-160,215-268` | `transition(...,'ACTIVE')` 没有调用 `checkActiveConditions()`；检查函数需调用方另行执行。 |
| 回放 | `CODE_PRESENT` | `runtime/src/evolve/replay-evaluator.ts:24,104-170` | 支持注入 `ReplayRunner`；测试和手工流程提供 runner，默认 AgentLoop 没有自动入口。 |
| 通用候选激活 | `CODE_PRESENT` | `runtime/src/evolve/lifecycle.ts:132-176,193-207` | SQLite ACTIVE/rollback 可运行；激活后只投影通用 engineering memory，异常被静默忽略。 |
| 下一次 Skill/Policy 编译 | `DESIGN_ONLY` | 全仓生产调用搜索 | 未找到 ACTIVE EvolutionCandidate 自动生成 Policy/Skill 版本并注入下一次 Compiler 的调用链。 |

### 2.4 TRAE、Codex 与桥接

| 证据 | 状态 | 代码位置 | 判断 |
|---|---|---|---|
| Codex API Provider | `CODE_PRESENT` | `runtime/src/llm/providers/codex.ts:15-16,33-83` | 使用 `AWKN_CODEX_API_KEY` 和 OpenAI-compatible `/chat/completions`。 |
| Codex hook 格式 | `CODE_PRESENT` | `runtime/src/core/hook-manager.ts:26-38,72-91` | 解析 hooks.json 事件名并执行命令；未发现 Codex IDE 宿主安装、握手或会话回执。 |
| TRAE Hook | `CODE_PRESENT` | `runtime/src/llm/providers/trae.ts:27-55` | 尝试 `pre_llm_call`，无结果后进入文件桥。 |
| TRAE 文件桥 | `CODE_PRESENT` | `runtime/src/llm/providers/trae.ts:58-106`; `runtime/scripts/bridge-daemon.ts:112-230` | 请求/响应文件和 daemon 轮询存在。 |
| 可用性探测 | `CODE_PRESENT` | `runtime/src/llm/providers/trae.ts:109-111` | `isAvailable()` 恒为 true，无法证明 Hook 或 daemon 存活，可能导致 120 秒超时后才失败。 |
| daemon provider 循环规避 | `INTEGRATED` | `runtime/scripts/bridge-daemon.ts:14-16,80-87` | daemon 直接调用 codex/minimax，避开 LlmRouter。 |
| 真实 IDE E2E | `BLOCKED_EXTERNAL` | 仓库与本次环境 | 本次没有 TRAE/Codex IDE 宿主、宿主事件回执或真实 API Key。 |

### 2.5 Memory OS

| 证据 | 状态 | 代码位置 | 判断 |
|---|---|---|---|
| v1 adapter | `CODE_PRESENT` | `runtime/src/memory/awkn-memory-os-backend.ts:100-238` | 包含 protocol、projects、assemble/render、capture、observe、consume、session start。 |
| Protocol feature gate | `CODE_PRESENT` | `runtime/src/memory/awkn-memory-os-backend.ts:100-109` | 检查 major 和两个 feature；只请求 `/api/v1/projects`，未获取项目 Grant。 |
| Project Grant | `DESIGN_ONLY` | `docs/agent-os-3.0/18-Memory-OS-vNext双仓实施RFC.md:161-203`; adapter 无 grant endpoint | RFC 将 `/projects/{projectId}/grant` 标为 vNext 目标，源码没有 Grant 类型、hash、expiry、operation/scope 验证。 |
| Context Receipt / Render | `CODE_PRESENT` | `runtime/src/memory/awkn-memory-os-backend.ts:125-178` | v1 组装与渲染已编码。 |
| Observe / Consume | `CODE_PRESENT` | `runtime/src/memory/awkn-memory-os-backend.ts:206-227` | v1 调用已编码。 |
| Transaction CAS / Tombstone / Attribution | `DESIGN_ONLY` | RFC endpoint 表；`runtime/src/memory/transaction.ts` 缺失 | 目标协议未进入当前 adapter contract。 |
| Authority | `CODE_PRESENT` | `runtime/src/memory/authority.ts:132-166`; `runtime/src/evolve/operational-evolution.ts:333-493` | Rule 生命周期客户端和投影逻辑存在；无 Grant、Descriptor、完整版本矩阵。 |
| 单仓测试 | `MOCK_OR_FIXTURE_ONLY` | `runtime/test/contracts/memory-backend-adapter.test.ts:21-75` | Node 本地 HTTP server 返回固定协议和 Context。 |
| 双仓 smoke | `BLOCKED_EXTERNAL` | 仓库与本次环境 | 未发现连接独立 Memory OS 服务的标准 CI smoke；本次未连接真实服务。 |

## 3. 闭环可达性图

### 3.1 当前默认 Engine v2 路径

```text
CLI / Cron / Orchestrator
  → AgentLoop.runL1 / runL2                                      [INTEGRATED]
  → LLM Router / Tool execution                                 [INTEGRATED]
  → typecheck / test / lint-alias / review / budget gates       [INTEGRATED]
  → goalManager.updateGoal(state=achieved, source=model)         [P0 断点：Goal Judge authority bypass]
  → run succeeded                                               [INTEGRATED]
  × judgeGoal()                                                 [未调用]
  × Delivery Router                                             [运行实现缺失]
  × Outcome Recorder                                            [运行实现缺失]
  × Success Memory Write Gate                                   [运行实现缺失]
  × automatic Pattern Detection / Experience Writer             [未接入]
  × Replay + Approval + Promotion automatic scheduling          [未接入]
  × ACTIVE Policy/Skill injected into next compile/run           [未接入]
```

失败路径存在局部能力：

```text
AgentLoop failure
  → correction evidence / checkpoint attempts                   [部分接入]
  → optional writes wrapped by catch                            [可能静默降级]
  × automatic pattern aggregation                               [未接入]
  × candidate creation and replay                               [未接入]
```

### 3.2 Agent OS R2 Coordinator 路径

```text
ExecutionCoordinator.createExecution
  → Trusted Input Gateway                                       [INTEGRATED in coordinator]
  → Intent / Goal Router                                        [INTEGRATED in coordinator]
  → Context Planner / Claim Ledger                              [INTEGRATED in coordinator]
  → CONTEXT_READY / ROUTED / RECEIVED snapshot                  [可达]
  × Policy & Skill Compiler                                     [未由 coordinator 调用]
  × Tool & Model Broker                                         [未由 coordinator 调用]
  × Evidence-Gain Loop                                          [未由 coordinator 调用]
  × Goal Judge                                                  [未由 coordinator 调用]
  × Delivery / Outcome / Memory / Evolve refs                   [始终为空]
```

### 3.3 手动 Evolve 路径

```text
Manual CLI / test
  → OperationalEvolution
  → ReplayEvaluator(runner supplied by caller)
  → APPROVED
  → EvolutionLifecycle.activate()
  → generic engineering memory projection
  × versioned SkillEvaluationRegistry linkage
  × PolicyRegistry linkage
  × next AgentLoop compile input
```

## 4. 缺陷清单

### 4.1 P0

| ID | 缺陷 | 路径 / 符号 | 复现 | 影响 | 正确约束 | 处理 |
|---|---|---|---|---|---|---|
| P0-01 | 模型可直接生成 `achieved` | `core/agent-loop.ts:385`; `goal/goal-manager.ts:151-199`; 两个 orchestrator | 构造所有 gate 通过的 L2 run，观察 source=`model` 的 achieved 更新 | 未经权威 GoalJudgement 即宣称成功 | Goal 只有 Goal Judge 可生成 `ACHIEVED` | 未补丁。需要统一成功出口、GoalJudgement 持久化、旧执行器迁移和回归矩阵。局部改一处会留下旁路。 |
| P0-02 | Agent OS 闭环断在 Context 后 | `composition/execution-coordinator.ts:200-433` | 调用 coordinator，检查 snapshot 引用 | C04-C09 无执行，默认主链无法复现完整 Agent OS 闭环 | Engine v2 默认；R2 按 Mode 0→Shadow→Enforce 逐组件接入 | 未补丁。远程 `dd5039e` 声称独立 Shadow 脚本 GO；本审计没有复验该运行，不能据此认证完整闭环。 |
| P0-03 | Memory 上下文读取曾对所有远端错误降级 | `memory/router.ts:86-98`; `llm/router.ts:116-135` | 远端返回 401/403 或协议错误 | 本地 stale context 绕过授权与协议失败 | 401/403、Grant、协议不兼容必须 fail-closed | **已补丁**：显式 memory-os 全部 fail-closed；auto 仅 transport/5xx 降级；LLM 层不再吞错。 |
| P0-04 | Project Grant 客户端缺失 | `memory/awkn-memory-os-backend.ts:100-140`; RFC `:161-203` | 服务返回 200 protocol/projects 后继续 assemble，客户端没有 grant hash/operation/scope 校验 | 无法证明跨项目读取、写入和治理边界 | 每个项目、操作、memory class、scope 均由服务端 Grant 最终授权 | 未伪造。需要对端实现 endpoint 与双仓契约测试；当前状态 `BLOCKED_EXTERNAL`。 |
| P0-05 | ACTIVE Skill 可绕过强制评测条件 | `skills/evaluation-registry.ts:136-160,215-268` | 注册 APPROVED manifest 后直接 `transition(id,'ACTIVE')` | 未满足 replay、样本量、独立 review 或冲突检查也能激活 | ACTIVE 转换必须原子执行条件检查并持久化证据引用 | 未补丁。需版本化数据模型和调用链迁移。 |

### 4.2 P1

| ID | 缺陷 | 路径 / 符号 | 影响 | 处理 |
|---|---|---|---|---|
| P1-01 | 10 层 `none` 合同测试预期反转 | `test/contracts/policy-ast-deep.test.ts:147-154`; 实现 `policy/ast.ts:119-123` | 合同门禁 2 失败；机械改实现会破坏布尔语义 | **已补丁**：10 次取反保持叶值，修测试名称与断言。 |
| P1-02 | TRAE bridge 默认路径依赖 CWD | `llm/providers/trae.ts`; `scripts/bridge-daemon.ts` | IDE hook、CLI、daemon 从不同目录启动时读写不同队列 | **已补丁**：统一模块推导的仓库绝对路径；相对环境变量直接报错。 |
| P1-03 | bridge 请求文件非原子写 | `llm/providers/trae.ts:58-75` | daemon 可能读取半写 JSON | **已补丁**：临时文件写入后 rename。 |
| P1-04 | daemon provider 初始化失败后继续空轮询 | `scripts/bridge-daemon.ts:197-228` | 日志宣称 fallback，实际没有 provider、没有 mock 响应，进程表现为假运行 | **已补丁**：显式设置非零退出；mock 仅由 `AWKN_BRIDGE_MOCK=1` 启用。 |
| P1-05 | Memory Outbox 默认路径依赖 CWD | `memory/outbox.ts:1-50` | 多进程形成分裂 outbox，恢复与重放不完整 | **已补丁**：仓库绝对默认路径；环境配置要求绝对路径。 |
| P1-06 | TRAE `isAvailable()` 恒真 | `llm/providers/trae.ts:109-111` | Router 可能选择不存在的宿主或 daemon，等待超时 | 剩余风险。需要 hook 注册探测或 daemon heartbeat/lease。 |
| P1-07 | Outbox 缺少跨进程锁/claim | `memory/outbox.ts:51-104`; `bridge-daemon.ts:208-229` | 多 daemon 或并发 writer 可能重复处理、覆盖或丢失记录 | 剩余风险。需 claim 文件、原子 lease、idempotency 和 crash recovery 测试。 |
| P1-08 | `verify-*.ts` 不在标准测试发现范围 | `scripts/run-tests.mjs:20-29`; `.github/workflows/runtime-ci.yml:50` | Bridge、cron、evolve、hook 等验证脚本不会由 `npm run check` 自动执行 | 剩余风险。应迁移为 `.test.ts` 或新增明确 CI gate。 |
| P1-09 | lint 名称与行为不一致 | `runtime/package.json:13` | `npm run lint` 只重复 typecheck，无法捕获未使用、危险 catch、复杂度和风格规则 | 文档已修正；工程脚本待引入 ESLint 或重命名。 |
| P1-10 | Skill preflight 固定通过 | `skills/compiler.ts:93-98,189-207` | 依赖、冲突和运行前条件无法阻断编译 | 剩余风险。需接入真实 preflight evaluator 和 receipt。 |

### 4.3 P2

| ID | 缺陷 | 路径 / 符号 | 影响 | 建议 |
|---|---|---|---|---|
| P2-01 | 畸形外置 Skill 静默跳过 | `skills/manager.ts:77-89` | 运维无法区分空目录与解析失败 | 记录诊断 receipt，保留失败文件路径和原因。 |
| P2-02 | Skill manifest 按 ID 覆盖版本 | `skills/evaluation-registry.ts:68-97` | 无法审计历史版本、baseline 与 candidate | 以 `(skillId, version)` 为主键，ACTIVE 指针单独存储。 |
| P2-03 | 进化记忆投影失败被吞掉 | `evolve/lifecycle.ts:193-207` | ACTIVE 与记忆投影状态分叉 | 写 outbox/receipt，投影失败进入可观测重试。 |
| P2-04 | Architecture Scan 的部分债务为报告项 | 实际输出：direct DB 20、singleton 12、cross-component 22、legacy exception 1 | 阻塞数为 0 仍保留架构债务 | 为新增核心逐步提升 strict roots，冻结例外预算。 |
| P2-05 | 文档 Release Gate 自相矛盾 | `docs/agent-os-3.0/21-...md:179-203,430-434` | 同文档同时记录 NO_GO 与 GO；远程 `dd5039e` 又提供后续 GO 声明 | 未直接改写。应以最新可复现 report artifact、commit、平台矩阵和命令输出重建单一状态。 |

## 5. 本次最小补丁

### 5.1 代码与测试

1. `runtime/test/contracts/policy-ast-deep.test.ts`
2. `runtime/src/memory/awkn-memory-os-backend.ts`
3. `runtime/src/memory/router.ts`
4. `runtime/src/llm/router.ts`
5. `runtime/src/memory/outbox.ts`
6. `runtime/src/llm/bridge-path.ts`（新增）
7. `runtime/src/llm/providers/trae.ts`
8. `runtime/scripts/bridge-daemon.ts`
9. `runtime/test/contracts/memory-backend-adapter.test.ts`
10. `runtime/test/contracts/bridge-path.test.ts`（新增）

### 5.2 文档

1. `README.md`
2. `runtime/README.md`
3. `AUDIT.md`
4. `TEST-EVIDENCE.md`
5. `REMAINING-RISKS.md`

补丁没有修改真实数据库、真实用户数据、远程 Memory OS、API Key、Token、Cookie、私钥、部署配置或发布权限。

## 6. 文档修正建议

建议统一使用以下证据词汇：

- “Contract implemented”：合约与类型已存在。
- “Component implemented”：组件代码与单组件测试存在。
- “Integrated in Engine v2 / R2 Coordinator”：明确接入哪条运行路径。
- “Fixture verified”：测试服务器或 mock daemon 已验证。
- “Real host E2E verified”：提供真实 TRAE/Codex IDE 回执、运行命令和不可变日志。
- “Dual-repo Memory OS E2E verified”：提供两仓 commit、协议矩阵、Grant、Receipt、CAS、Outbox 和故障注入日志。
- “Release Gate GO”：仅在规定场景、平台和阻塞项全部通过后使用。

当前 README 可继续展示 Agent OS 3.0 目标主链，同时应保留 Mode 0/Shadow/Enforce 状态、默认 Engine v2 路径、真实 E2E 范围和外部阻塞条件。
