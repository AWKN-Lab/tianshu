# 天枢 Agent OS 3.0 总 PRD

> 文档编号：TS-AOS-PRD-000  
> 版本：v0.2 Draft  
> 日期：2026-07-26  
> 产品权威：`AWKN-Lab/tianshu`  
> 基线：Engine v2 + Goal/Loop/Gate/Tool/Memory/Evidence/Evolve

## 一、产品定义

天枢 Agent OS 3.0 是 AWKN 的核心智能体运行与治理引擎。它把天枢自身接收的用户输入、项目上下文、模型、工具、技能、证据、记忆和进化连接为一条可追踪、可恢复、可评测的执行主链。

天枢稳定生成六类结果：

1. 可验证的任务结果；
2. 可追溯的执行证据；
3. 可解释的模型与工具路由；
4. 可恢复的 Run 与 Step 状态；
5. 经过门禁的长期记忆候选；
6. 经过评测的规则与 Skill 进化候选。

## 二、仓库边界

### 2.1 天枢边界

本 PRD 只定义 `AWKN-Lab/tianshu` 的产品、架构、Schema、运行时、测试和发布。

天枢组件属于天枢内部实现，不作为其他仓库的公共组件、公共 SDK、共享服务或统一协议中心。

### 2.2 Memory OS例外

`AWKN-Memory-OS` 是独立记忆模块，可以：

- 独立部署、独立发布、独立使用；
- 通过 `MemoryBackend` 协议挂载到天枢；
- 作为天枢长期 Claim、Experience、Rule、Context Ledger 和持久化事务的可选后端。

Memory OS 与天枢保持双仓、双发布、双测试体系。

### 2.3 其他项目边界

`GUNDAM`、`Value`、`win`、`Mr.Mont`、`life-choice`、`annie`、`subtitle`、`awkn-Feel`、`solo-skill-booster`、`CosmoSpark`、`Pri` 等仓库：

- 不嵌入天枢 Runtime；
- 不调用天枢 Service；
- 不依赖天枢 SDK；
- 不共享天枢 Schema、Registry、Feature Flag 或发布生命周期；
- 不纳入本 PRD 的实施工作包和 Release Gate。

这些项目可以独立研究相同机制，并在各自仓库内重新设计和实现。

## 三、已有基础

当前天枢已经具备：

- L1 ReAct 和 L2 Goal Loop；
- Goal 状态、预算和停止条件；
- Hook、Tool Registry 和工具安全策略；
- 多模型路由和 fallback；
- Run、Step、Event Store 和 Trace；
- Artifact Bundle 与独立 Reviewer；
- 四类运行记忆；
- AWKN Memory OS Backend Adapter；
- Durable Outbox；
- Candidate、Replay、Promotion、Quarantine、Rollback；
- Skills Loader 和外置技能目录。

## 四、当前核心缺口

| 缺口 | 现状风险 |
|---|---|
| 输入缺少统一可信封装 | 脱敏、身份、注入清洗和风险判断分散 |
| 意图与 Goal 路由没有统一契约 | 简单问答、闭环任务、定时任务和自治任务入口混杂 |
| Claim 来源粒度不足 | 模型建议可能在摘要或记忆中被误升级为用户决定 |
| 上下文规划缺少 Manifest | 无法稳定解释哪些上下文被纳入或排除 |
| Policy 与 Skill 缺少编译边界 | 长提示词、规则和流程资产容易冲突和膨胀 |
| Tool 与 Model 分别路由 | 缺少统一成本、能力、风险和授权决策 |
| Loop 关注 Gate 结果 | 每轮是否获得新证据缺少一等状态 |
| Delivery 缺少统一路由 | 对话、文件、应用、外部写入和定时任务没有统一合同 |
| Outcome 归因不完整 | 执行成功、用户采用和业务有效容易混为一个状态 |
| Memory Write Gate 过于隐式 | LLM 响应完成后可能直接沉淀交互，缺少 Claim 级判断 |
| Evolve 偏工程错误 | 需要扩展到 Policy、Skill、Router、Prompt 和项目规则 |

## 五、产品目标

### 5.1 P0目标

1. 建立天枢单仓权威架构；
2. 建立统一 `ExecutionEnvelope`；
3. 建立 Claim Lineage 和 Confirmation Scope；
4. 建立 Context Manifest；
5. 建立 Policy、Skill 编译与版本冻结；
6. 建立 Tool & Model Broker；
7. 将 Loop 升级为 Evidence-Gain Loop；
8. 建立 Delivery Contract；
9. 建立 Outcome 分层和 Memory Write Gate；
10. 保持现有 Engine v2 能力兼容。

### 5.2 P1目标

1. 支持 AWKN Memory OS 独立运行与可插拔挂载；
2. 支持模型路由回执和可见降级；
3. 支持会话累计风险；
4. 支持 Policy、Skill、Prompt、Router 和 Gate 候选统一回放评测；
5. 支持 Artifact 型持久化应用交付；
6. 支持主链 Shadow Mode、可观测迁移和一键回滚。

### 5.3 非目标

本阶段不承担：

- 重写全部现有运行时；
- 将其他仓库业务逻辑迁入天枢；
- 为其他仓库提供运行时、SDK、服务或协议兼容；
- 把 AWKN Memory OS 合并进天枢仓库；
- 自动批准高风险外部操作；
- 基于未经验证的模型内部架构假设进行实现。

## 六、目标用户与系统角色

### 6.1 直接用户

- AWKN 项目负责人；
- 使用天枢执行工程、调研、文档和自动化任务的开发者；
- 审核天枢 Policy、Skill、模型路由和发布证据的治理人员。

### 6.2 系统角色

| 角色 | 权限 |
|---|---|
| Human User | 提出目标、确认决策、授权外部操作 |
| Runtime | 创建 Run、执行主链、维护状态 |
| Planner | 拆解目标、声明预期证据 |
| Executor | 调用模型、Skill 和 Tool |
| Reviewer | 独立验证 Artifact 与 Evidence |
| Policy Authority | 决定天枢政策版本和优先级 |
| Memory Authority | 维护天枢本地记忆或挂载 Memory OS |
| Evolution Authority | 评测、晋级、隔离和回滚候选 |

## 七、核心运行主链

```text
InputEnvelope
   ↓
TrustedInput
   ↓
IntentDecision + GoalSpec
   ↓
ContextManifest
   ↓
CompiledPolicyBundle + CompiledSkillBundle
   ↓
BrokerPlan
   ↓
Run / Step / Evidence-Gain Loop
   ↓
DeliveryBundle
   ↓
OutcomeRecord
   ↓
MemoryWriteDecision
   ↓
EvolutionCandidates
```

### 7.1 主链原则

- 每个阶段都有结构化输入和输出；
- 每个阶段保留版本、来源和时间；
- 关键阶段可以拒绝继续；
- 失败进入可恢复状态；
- 外部副作用执行前完成授权；
- 成功终态需要 fresh evidence；
- 记忆和进化通过独立门禁；
- 主链不得调用其他业务仓库作为运行组件。

## 八、L0—L4执行层级

| 层级 | 名称 | 目标 | 典型输出 |
|---|---|---|---|
| L0 | Analysis | 解释、比较、判断，不创建持久执行 Run | Chat Delivery |
| L1 | Turn | 一轮或少量工具调用完成任务 | Result + Tool Receipt |
| L2 | Goal Loop | 围绕确定性验收标准循环 | Run + Gates + Artifact Bundle |
| L3 | Scheduled | 按时间、事件或条件恢复执行 | Durable Job + Checkpoint |
| L4 | Orchestrated | 天枢内部多 Agent、多步骤、跨工具协同 | Workflow Graph + Multi-party Evidence |

### 8.1 路由约束

- L0 不写长期记忆，除非用户明确提供耐久信息且 Memory Write Gate 通过；
- L1 可以使用工具，但需要单步授权和执行回执；
- L2 必须创建 Goal、Run 和停止条件；
- L3 必须有 Schedule、幂等键和恢复策略；
- L4 必须经过架构冻结、风险评估和人工授权。

## 九、核心领域对象

### 9.1 ExecutionEnvelope

```json
{
  "executionId": "exec_xxx",
  "traceId": "w3c-trace-id",
  "userId": "u_xxx",
  "projectId": "tianshu",
  "sessionId": "session_xxx",
  "input": {},
  "intent": {},
  "goal": {},
  "context": {},
  "policy": {},
  "skills": {},
  "broker": {},
  "run": {},
  "delivery": {},
  "outcome": {},
  "memory": {},
  "evolution": {}
}
```

### 9.2 Claim

Claim 统一表达事实、偏好、决定、建议、假设、预测和观测。

关键字段：

- `originator`
- `speaker`
- `claimType`
- `epistemicStatus`
- `confirmationScope`
- `sourceRefs`
- `derivedFrom`
- `validFrom`
- `validUntil`
- `sensitivityClass`
- `authority`

### 9.3 Evidence

证据等级：

```text
E0  无证据
E1  模型陈述
E2  工具输出
E3  可复现测试或权威数据
E4  用户确认或外部系统最终状态
E5  多源一致且经过独立审核
```

### 9.4 Outcome

- `EXECUTION_OUTCOME`：执行是否完成；
- `DELIVERY_OUTCOME`：交付是否成功；
- `ADOPTION_OUTCOME`：用户是否采用；
- `BUSINESS_OUTCOME`：业务结果是否达成；
- `LEARNING_OUTCOME`：是否产生可复用经验。

## 十、功能需求

### FR-01 Trusted Input Gateway

- 校验输入来源和文件存在性；
- 绑定用户、项目、会话和权限；
- 执行脱敏、注入清洗和内容风险分类；
- 生成不可变 Input Receipt；
- 保留原始 Hash。

### FR-02 Intent & Goal Router

- 判断 L0—L4；
- 区分分析、执行、持续任务和外部副作用；
- 识别缺失信息；
- 通过 Clarification Value Gate 决定提问、带假设继续或直接执行；
- L2以上生成 GoalSpec、验收条件、预算和停止策略。

### FR-03 Context Planner

- 检索 Claim、天枢项目状态、Skill、Policy 和外部事实；
- 计算相关度、决策影响、时效、权限和 Token 成本；
- 生成 Included、Excluded 及原因；
- 冻结 Context Manifest Hash；
- 对时间敏感事实执行刷新门。

### FR-04 Policy & Skill Compiler

- 根据任务选择天枢 Policy Pack 和 Skill Pack；
- 解析优先级、冲突和覆盖范围；
- 生成可执行 Bundle；
- 冻结版本和 Hash；
- 禁止运行时临时改写 ACTIVE Policy。

### FR-05 Tool & Model Broker

- 根据能力、成本、延迟、权限、数据范围和风险选择模型与工具；
- 区分请求模型和实际模型；
- 记录 fallback；
- 生成 Authorization Token；
- 计算会话累计风险；
- 执行后校验真实副作用。

### FR-06 Evidence-Gain Loop

每轮记录：

- 当前假设；
- 预期证据；
- 执行动作；
- 实际证据；
- Evidence Delta；
- 偏差类型；
- 下一策略；
- 继续、切换或停止决定。

连续多轮没有 Evidence Delta 时，系统停止、换策略或请求人工介入。

### FR-07 Delivery Router

支持：

- Chat；
- File；
- Visual；
- Artifact App；
- Connected System；
- Scheduled Task。

Delivery 必须有格式、目标位置、副作用和完成证明。

### FR-08 Evidence & Outcome

- 将 Run、Step、Model、Tool、Gate、Delivery 关联到同一 Trace；
- 记录执行与业务结果的差异；
- 允许后续补充 Outcome；
- 支持结果归因和校准。

### FR-09 Memory Write Gate

写入前判断：

- 来源是否可证明；
- 是否由用户明确陈述或确认；
- 是否具有未来复用价值；
- 是否涉及敏感信息；
- 是否属于临时状态；
- 是否与现有 Claim 重复或冲突；
- 是否需要用户确认；
- 写入本地后端或挂载的 Memory OS。

### FR-10 Evolve

支持候选：

- Policy Candidate；
- Skill Candidate；
- Prompt Candidate；
- Router Candidate；
- Gate Candidate；
- Context Candidate；
- Delivery Candidate。

候选必须经过回放、评测、晋级、隔离和回滚。

## 十一、非功能需求

### 11.1 可审计

- 所有关键决策有 Receipt；
- 所有 Receipt 有 Trace ID；
- 所有 Bundle 有版本和 Hash；
- 用户决定可回溯到原始消息。

### 11.2 可恢复

- Run、Step、Delivery 和 Outbox 使用幂等键；
- 支持从最后安全检查点恢复；
- 外部副作用需要补偿或明确不可逆；
- 部分成功不能被记录成整体成功。

### 11.3 安全

- 默认最小权限；
- 工具路径和敏感文件受限；
- 高风险操作需要再次确认；
- 模型、记忆和 Skill 都视为不可信输入；
- 日志默认脱敏。

### 11.4 性能

- Trusted Input Gateway P95 < 150ms，文件深度扫描除外；
- Policy/Skill 编译缓存命中 P95 < 50ms；
- Context Planning 本地模式 P95 < 300ms；
- Hook 同步路径 P95 < 200ms；
- Receipt 写入 P95 < 100ms；
- 恢复 Run 不重复执行已确认副作用。

### 11.5 兼容性

- Node.js >= 20；
- 保持现有 CLI 可用；
- 保持 `MemoryBackend` 兼容；
- 现有 Tool Handler 通过天枢内部 Adapter 升级；
- 现有 LLM Provider 通过天枢内部 Broker Adapter 升级；
- Schema 采用增量 Migration。

## 十二、指标

| 指标 | 目标 |
|---|---:|
| 无证据完成声明率 | 0 |
| 用户决定误归因率 | 0 |
| 重复外部副作用率 | 0 |
| Context 无关注入率 | < 5% |
| L2 无证据重复轮次 | < 10% |
| Tool 未授权执行率 | 0 |
| 模型 fallback 未记录率 | 0 |
| Memory 写入来源缺失率 | 0 |
| 故障恢复成功率 | >= 95% |

## 十三、发布阶段

### Phase A：契约冻结

- ExecutionEnvelope；
- Claim；
- ContextManifest；
- PolicyBundle；
- BrokerPlan；
- EvidenceDelta；
- DeliveryContract；
- OutcomeRecord；
- MemoryWriteDecision。

### Phase B：入口与上下文

- Trusted Input Gateway；
- Intent & Goal Router；
- Context Planner；
- Claim Ledger。

### Phase C：执行与交付

- Policy & Skill Compiler；
- Tool & Model Broker；
- Evidence-Gain Loop；
- Delivery Router。

### Phase D：记忆与进化

- Memory Write Gate；
- Outcome Attribution；
- Evolve Candidate 扩展；
- Memory OS vNext Adapter。

### Phase E：天枢发布加固

- Shadow Mode差异收敛；
- 兼容性迁移；
- Chaos与恢复测试；
- Linux与Windows验证；
- Release Manifest与Artifact Hash；
- Agent OS 3.0 RC。

## 十四、P0验收标准

1. 同一输入可生成确定性 `ExecutionEnvelope` 核心字段；
2. L0—L4 路由有契约测试；
3. 用户简单确认不会冻结模型产生的全部细节；
4. Context Manifest 可以解释 Included 与 Excluded；
5. Policy 和 Skill Bundle 有版本、Hash 和冲突结果；
6. 模型 fallback 生成 Route Receipt；
7. 工具外部副作用需要有效 Authorization Token；
8. Evidence-Gain Loop 连续无增量时停止或切换；
9. Delivery 失败不能产生成功 Outcome；
10. Memory 写入必须包含来源和写入原因；
11. Evolve Candidate 无回放证据时不能 ACTIVE；
12. `npm run check` 全部通过；
13. 现有 Engine v2 契约测试无回归；
14. 除 Memory OS 外不存在其他仓库运行依赖。

## 十五、决策记录

| 决策 | 结论 |
|---|---|
| 总框架位置 | 天枢仓库 |
| Memory OS关系 | 独立项目，可作为天枢 Memory Backend 挂载 |
| 其他仓库关系 | 完全独立，只能参考机制，不接入代码、协议、运行时或发布体系 |
| 文档策略 | 天枢总 PRD + 天枢组件工程文档 + Memory OS挂载协议 + 独立项目进化参考 |
| 实施策略 | 增量升级天枢现有运行时，禁止全量重写 |
