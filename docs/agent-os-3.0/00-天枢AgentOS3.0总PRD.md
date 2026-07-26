# 天枢 Agent OS 3.0 总 PRD

> 文档编号：TS-AOS-PRD-000  
> 版本：v0.1 Draft  
> 日期：2026-07-26  
> 产品权威：`AWKN-Lab/tianshu`  
> 基线：Engine v2 + Goal/Loop/Gate/Tool/Memory/Evidence/Evolve

## 一、产品定义

天枢 Agent OS 3.0 是 AWKN 的核心智能体运行与治理引擎。它把用户输入、项目上下文、模型、工具、技能、证据、记忆和进化连接为一条可追踪、可恢复、可评测的执行主链。

产品输出不是单一聊天结果。天枢需要稳定生成以下六类结果：

1. 可验证的任务结果；
2. 可追溯的执行证据；
3. 可解释的模型与工具路由；
4. 可恢复的 Run 与 Step 状态；
5. 经过门禁的长期记忆候选；
6. 经过评测的规则与 Skill 进化候选。

## 二、背景与问题

### 2.1 已有基础

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

### 2.2 当前核心缺口

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
| Evolve 偏工程错误 | 需要扩展到 Policy、Skill、Router、Prompt 和领域规则 |

## 三、产品目标

### 3.1 P0目标

1. 建立天枢单核权威架构；
2. 建立统一 `ExecutionEnvelope`；
3. 建立 Claim Lineage 和 Confirmation Scope；
4. 建立 Context Manifest；
5. 建立 Policy、Skill 编译与版本冻结；
6. 建立 Tool & Model Broker；
7. 将 Loop 升级为 Evidence-Gain Loop；
8. 建立 Delivery Contract；
9. 建立 Outcome 分层和 Memory Write Gate；
10. 保持现有 Engine v2 能力兼容。

### 3.2 P1目标

1. 支持 AWKN Memory OS 独立运行与可插拔挂载；
2. 支持 Value、win、Mr.Mont 等项目按组件接入；
3. 支持模型路由回执和可见降级；
4. 支持会话累计风险；
5. 支持 Policy、Skill、Prompt 候选统一回放评测；
6. 支持 Artifact 型持久化应用交付。

### 3.3 非目标

本阶段不承担：

- 重写全部现有运行时；
- 将所有垂直业务逻辑迁入天枢；
- 把 AWKN Memory OS 合并进天枢仓库；
- 为每个模型实现统一能力；
- 自动批准高风险外部操作；
- 基于未经验证的模型内部架构假设进行实现。

## 四、目标用户与角色

### 4.1 直接用户

- AWKN 项目负责人；
- 使用天枢执行工程任务的开发者；
- 通过垂直产品调用天枢的业务用户；
- 审核规则、Skill 和模型路由的治理人员。

### 4.2 系统角色

| 角色 | 权限 |
|---|---|
| Human User | 提出目标、确认决策、授权外部操作 |
| Runtime | 创建 Run、执行主链、维护状态 |
| Planner | 拆解目标、声明预期证据 |
| Executor | 调用模型、Skill 和 Tool |
| Reviewer | 独立验证 Artifact 与 Evidence |
| Policy Authority | 决定政策版本和优先级 |
| Memory Authority | 维护持久 Claim、Experience 和 Rule |
| Evolution Authority | 评测、晋级、隔离和回滚候选 |
| Domain Adapter | 提供投资、酒店、健康等领域契约 |

## 五、核心运行主链

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

### 5.1 主链原则

- 每个阶段都有结构化输入和输出；
- 每个阶段保留版本、来源和时间；
- 关键阶段可以拒绝继续；
- 失败进入可恢复状态；
- 外部副作用执行前完成授权；
- 成功终态需要 fresh evidence；
- 记忆和进化通过独立门禁。

## 六、L0—L4执行层级

| 层级 | 名称 | 目标 | 典型输出 |
|---|---|---|---|
| L0 | Analysis | 解释、比较、判断，不创建持久执行 Run | Chat Delivery |
| L1 | Turn | 一轮或少量工具调用完成任务 | Result + Tool Receipt |
| L2 | Goal Loop | 围绕确定性验收标准循环 | Run + Gates + Artifact Bundle |
| L3 | Scheduled | 按时间、事件或条件恢复执行 | Durable Job + Checkpoint |
| L4 | Orchestrated | 多 Agent、多步骤、跨系统协同 | Workflow Graph + Multi-party Evidence |

### 6.1 路由约束

- L0 不写长期记忆，除非用户明确提供耐久信息且 Memory Write Gate 通过；
- L1 可以使用工具，但需要单步授权和执行回执；
- L2 必须创建 Goal、Run 和停止条件；
- L3 必须有 Schedule、幂等键和恢复策略；
- L4 必须经过架构冻结、风险评估和人工授权。

## 七、核心领域对象

### 7.1 ExecutionEnvelope

贯穿主链的根对象：

```json
{
  "executionId": "exec_xxx",
  "traceId": "w3c-trace-id",
  "userId": "u_xxx",
  "projectId": "project_xxx",
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

### 7.2 Claim

Claim 是事实、偏好、决定、建议、假设、预测和观测的统一声明对象。

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

### 7.3 Evidence

Evidence 记录某个 Claim、Step、Gate 或 Outcome 的证明材料。

证据等级：

```text
E0  无证据
E1  模型陈述
E2  工具输出
E3  可复现测试或权威数据
E4  用户确认或外部系统最终状态
E5  多源一致且经过独立审核
```

### 7.4 Outcome

Outcome 分为：

- `EXECUTION_OUTCOME`：执行是否完成；
- `DELIVERY_OUTCOME`：交付是否成功；
- `ADOPTION_OUTCOME`：用户是否采用；
- `BUSINESS_OUTCOME`：业务结果是否达成；
- `LEARNING_OUTCOME`：是否产生可复用经验。

## 八、功能需求

### FR-01 Trusted Input Gateway

系统必须：

- 校验输入来源和文件存在性；
- 绑定用户、项目、会话和权限；
- 执行脱敏、注入清洗和内容风险分类；
- 生成不可变 Input Receipt；
- 保留原始 Hash，避免清洗后失去来源证明。

### FR-02 Intent & Goal Router

系统必须：

- 判断 L0—L4；
- 区分分析、执行、持续任务和外部副作用；
- 识别缺失信息；
- 通过 Clarification Value Gate 决定提问、带假设继续或直接执行；
- L2以上生成 GoalSpec、验收条件、预算和停止策略。

### FR-03 Context Planner

系统必须：

- 检索 Claim、项目状态、Skill、Policy 和外部事实；
- 计算相关度、决策影响、时效、权限和 Token 成本；
- 生成 Included、Excluded 及原因；
- 冻结 Context Manifest Hash；
- 对时间敏感事实执行刷新门。

### FR-04 Policy & Skill Compiler

系统必须：

- 根据任务选择 Policy Pack 和 Skill Pack；
- 解析优先级、冲突和覆盖范围；
- 生成可执行 Bundle；
- 冻结版本和 Hash；
- 禁止运行时临时改写 ACTIVE Policy。

### FR-05 Tool & Model Broker

系统必须：

- 根据能力、成本、延迟、权限、数据范围和风险选择模型与工具；
- 区分请求模型和实际模型；
- 记录 fallback；
- 生成 Authorization Token；
- 计算会话累计风险；
- 执行后校验真实副作用。

### FR-06 Evidence-Gain Loop

每轮必须记录：

- 当前假设；
- 预期证据；
- 执行动作；
- 实际证据；
- Evidence Delta；
- 偏差类型；
- 下一策略；
- 继续、切换或停止决定。

连续多轮没有 Evidence Delta 时，系统应停止、换策略或请求人工介入。

### FR-07 Delivery Router

系统必须在以下交付模式间路由：

- Chat；
- File；
- Visual；
- Artifact App；
- Connected System；
- Scheduled Task。

Delivery 必须有格式、目标位置、副作用和完成证明。

### FR-08 Evidence & Outcome

系统必须：

- 将 Run、Step、Model、Tool、Gate、Delivery 关联到同一 Trace；
- 记录执行与业务结果的差异；
- 允许后续补充 Outcome；
- 支持结果归因；
- 生成校准数据。

### FR-09 Memory Write Gate

系统必须在写入前判断：

- 来源是否可证明；
- 是否由用户明确陈述或确认；
- 是否具有未来复用价值；
- 是否涉及敏感信息；
- 是否属于临时状态；
- 是否与现有 Claim 重复或冲突；
- 是否需要用户确认；
- 写入哪个 Memory Backend。

### FR-10 Evolve

系统必须支持以下候选：

- Policy Candidate；
- Skill Candidate；
- Prompt Candidate；
- Router Candidate；
- Gate Candidate；
- Domain Rule Candidate。

候选必须经过回放、评测、晋级、隔离和回滚。

## 九、非功能需求

### 9.1 可审计

- 所有关键决策有 Receipt；
- 所有 Receipt 有 Trace ID；
- 所有 Bundle 有版本和 Hash；
- 用户决定可回溯到原始消息。

### 9.2 可恢复

- Run、Step、Delivery 和 Outbox 使用幂等键；
- 支持从最后安全检查点恢复；
- 外部副作用需要补偿或明确不可逆；
- 部分成功不能被记录成整体成功。

### 9.3 安全

- 默认最小权限；
- 工具路径和敏感文件受限；
- 高风险操作需要再次确认；
- 模型、记忆和 Skill 都视为不可信输入；
- 日志默认脱敏。

### 9.4 性能

P0目标：

- Trusted Input Gateway P95 < 150ms，文件深度扫描除外；
- Policy/Skill 编译缓存命中 P95 < 50ms；
- Context Planning 本地模式 P95 < 300ms；
- Hook 同步路径 P95 < 200ms；
- Receipt 写入 P95 < 100ms；
- 恢复 Run 不重复执行已确认副作用。

### 9.5 兼容性

- Node.js >= 20；
- 保持现有 CLI 可用；
- 保持 `MemoryBackend` 兼容；
- 现有 Tool Handler 通过 Adapter 接入；
- 现有 LLM Provider 通过 Broker Adapter 接入；
- Schema 采用增量 Migration。

## 十、指标

### 10.1 质量指标

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

### 10.2 效率指标

| 指标 | 目标 |
|---|---:|
| 同类任务平均循环数下降 | >= 20% |
| 无效模型调用下降 | >= 20% |
| Context Token 平均下降 | >= 15% |
| 故障恢复成功率 | >= 95% |
| Skill 复用率 | 持续提升 |

## 十一、发布阶段

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

### Phase E：垂直项目试点

顺序建议：

1. `win`：Decision Bundle 与假设门；
2. `Value`：Freshness 与交易风险；
3. `Mr.Mont`：Claim 确认与决策校准；
4. `GUNDAM`：治理和透明度 UI；
5. `annie`、`subtitle`：领域安全和流水线证据。

## 十二、P0验收标准

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
13. 现有 Engine v2 契约测试无回归。

## 十三、决策记录

| 决策 | 结论 |
|---|---|
| 总框架位置 | 天枢仓库 |
| Memory OS关系 | 独立项目，可作为天枢 Memory Backend 挂载 |
| GUNDAM关系 | Codex专属产品，吸收协议但不承担总框架 |
| 垂直项目关系 | 按组件吸收，领域能力留在各项目 |
| 文档策略 | 总 PRD + 组件工程文档 + 接入矩阵 + 工作包 |
| 实施策略 | 增量升级现有运行时，禁止全量重写 |
