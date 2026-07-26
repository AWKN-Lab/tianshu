# Policy & Skill Compiler 工程设计

> 组件编号：C04  
> 版本：v0.2 Draft  
> 工程动作：NEW + UPGRADE  
> 复用：Tool Policy、Skills Manager、Quality Gates、Evolve Candidate生命周期

## 一、职责

Policy & Skill Compiler将天枢分散的自然语言规则、工具政策、项目规范和程序性经验编译为可执行、可测试、可版本冻结的运行包。

两类资产边界：

- **Policy**：决定允许、拒绝、确认、限制和升级条件；
- **Skill**：定义如何完成任务，包括前置检查、执行流程、质量标准、失败恢复和验收。

本Compiler只管理天枢自身资产。其他业务仓库的规则和Skill不进入天枢Registry，也不由天枢发布或回滚。

## 二、编译主链

```text
IntentDecision + GoalSpec + ContextManifest
→ Applicable Policy Discovery
→ Applicable Skill Discovery
→ Dependency Resolution
→ Conflict Detection
→ Priority Resolution
→ Preflight Evaluation
→ Policy AST
→ Skill Execution Plan
→ Bundle Hash
→ Freeze
→ Compiler Receipts
```

## 三、Policy Schema

```yaml
schema: awkn-policy/v1
policyId: tool.external-write.confirm
version: 1.0.0
status: ACTIVE
scope:
  taskProfiles: [all]
  levels: [L1, L2, L3, L4]
priority: 800
condition:
  all:
    - field: action.sideEffect
      equals: external_write
decision: REQUIRE_AUTHORIZATION
requiredActions:
  - build_action_summary
  - bind_target_resource
  - request_explicit_confirmation
prohibitedActions:
  - execute_without_authorization
evidenceRequirements:
  - authorization_receipt
onFailure: BLOCK
```

### 3.1 Policy类型

- Identity Policy；
- Input Policy；
- Privacy Policy；
- Memory Policy；
- Tool Policy；
- Model Routing Policy；
- Freshness Policy；
- Delivery Policy；
- Project Governance Policy；
- Task Profile Policy；
- Evolution Policy。

## 四、Skill Manifest

```yaml
schema: awkn-skill/v2
skillId: awkn-engineering-fix-loop
version: 2.0.0
status: ACTIVE
taskProfiles: [engineering]
levels: [L2]
triggers:
  - build_failure
  - test_failure
requires:
  tools: [read, grep, write, exec]
  capabilities: [git_diff, test_runner]
  context: [goal, failure_evidence]
preflight:
  - workspace_clean_or_declared
  - acceptance_criteria_present
workflow:
  - locate
  - analyze
  - plan
  - edit
  - verify
gates:
  - typecheckGate
  - testGate
  - reviewGate
recovery:
  - restore_checkpoint
  - switch_strategy_after_repeat
outputs:
  - artifact_bundle
  - evidence_delta
evalSuite: engineering-fix-loop-v2
```

## 五、Policy优先级

```text
P1000 Core Constitution
P900  Security / Privacy / Identity
P800  Authorization / Tool / External Side Effect
P700  Tianshu Project Governance
P600  Task Profile Rules
P500  Goal-specific Policies
P400  User Preferences
P300  Skill Defaults
P200  Model Suggestions
```

低优先级规则不能削弱高优先级规则。

## 六、冲突解析

冲突类型：

- `ALLOW vs DENY`；
- `REQUIRE_CONFIRMATION vs AUTO_EXECUTE`；
- 相同条件不同阈值；
- 多个ACTIVE版本；
- Skill依赖不兼容；
- Project Rule与Core Policy重叠；
- 用户偏好与治理规则冲突。

解析顺序：

1. 状态有效性；
2. Scope匹配；
3. Priority；
4. Specificity；
5. Authority；
6. Version；
7. 默认选择更保守结果。

无法解析时返回`POLICY_CONFLICT`并阻断执行。

## 七、编译产物

### 7.1 CompiledPolicyBundle

```ts
export interface CompiledPolicyBundle {
  schema: 'awkn-compiled-policy-bundle/v1';
  bundleId: string;
  executionId: string;
  policies: CompiledPolicy[];
  conflicts: PolicyConflict[];
  decisions: PrecomputedPolicyDecision[];
  compilerVersion: string;
  sourceVersions: Record<string, string>;
  bundleHash: string;
  frozenAt: string;
}
```

### 7.2 CompiledSkillBundle

```ts
export interface CompiledSkillBundle {
  schema: 'awkn-compiled-skill-bundle/v1';
  bundleId: string;
  selectedSkills: SkillRef[];
  rejectedSkills: RejectedSkill[];
  executionGraph: SkillExecutionNode[];
  preflightResults: PreflightResult[];
  gates: GateRef[];
  recoveryPlan: RecoveryAction[];
  bundleHash: string;
  frozenAt: string;
}
```

## 八、Skill选择

```text
SkillScore =
0.30 × TriggerMatch
+ 0.20 × TaskProfileMatch
+ 0.15 × LevelMatch
+ 0.15 × HistoricalSuccess
+ 0.10 × EvidenceQuality
+ 0.10 × CostEfficiency
- 0.20 × CompatibilityRisk
```

强制规则：

- 用户明确点名Skill时优先检查是否适用；
- 文件、代码、文档等任务可以配置必读Skill；
- Skill前置条件不满足时不得宣称已执行；
- 多个Skill组合需要依赖图和输入输出匹配；
- Skill自然语言内容不能修改Policy；
- Skill来源必须属于天枢外置Skill Root或天枢内置资产；
- 其他业务仓库的Skill文件只能作为研究材料读取，不能直接注册为ACTIVE Skill。

## 九、Skill作为程序性记忆

Skill沉淀：

- 环境差异；
- 工具限制；
- 成功流程；
- 常见失败；
- 验收命令；
- 回滚方式；
- 适用和禁用条件；
- 历史评测结果。

Skill内容可以由天枢配置的外置目录提供。天枢保存索引、版本、Hash、评测和使用Receipt。

## 十、版本与冻结

每次Run冻结：

- Policy Bundle Hash；
- Skill Bundle Hash；
- Prompt Template Version；
- Tool Schema Version；
- Model Capability Snapshot；
- Task Profile Version。

运行中Registry更新不能改变已启动Run。新版本在下一Run生效，除非用户明确重启当前Run。

## 十一、Registry边界

### 11.1 允许注册

- 天枢Core Policy；
- 天枢Project Governance Policy；
- 天枢Task Profile Policy；
- 天枢内置Skill；
- `AWKN_SKILLS_ROOT`指向的天枢Skill资产；
- 经过天枢Evolve批准的Policy和Skill候选。

### 11.2 禁止注册

- GUNDAM Policy或Skill；
- Value投资规则；
- win酒店规则；
- Mr.Mont、annie、subtitle等其他产品资产；
- 从其他仓库动态下载的可执行Skill；
- 未经过来源校验和评测的外部规则。

### 11.3 外部材料处理

其他仓库文档可以作为`external_document`进入调研上下文。系统可以总结其机制并生成天枢候选，但候选必须重新建模、重新评测、重新发布，且不能保留跨仓运行依赖。

## 十二、Compiler Receipt

```json
{
  "schema": "awkn-compiler-receipt/v1",
  "executionId": "exec_xxx",
  "policyBundleId": "pb_xxx",
  "skillBundleId": "sb_xxx",
  "selectedPolicies": ["core.identity@1.0.0"],
  "selectedSkills": ["awkn-engineering-fix-loop@2.0.0"],
  "conflicts": [],
  "preflightPassed": true,
  "bundleHash": "sha256",
  "compilerVersion": "1.0.0"
}
```

## 十三、现有代码改造

### REUSE

- `runtime/src/tools/policy.ts`
- `runtime/src/skills/manager.ts`
- `runtime/src/gates/quality-gates.ts`
- `runtime/src/evolve/`
- `runtime/src/memory/authority.ts`

### UPGRADE

- ToolPolicy成为Policy Evaluator Adapter；
- Skills Manager输出SkillRef和版本Hash；
- Gate定义进入Skill Manifest引用；
- Evolve支持Policy和Skill Candidate；
- ACTIVE版本保持单活；
- Scope字段使用`taskProfiles`和天枢Project Scope。

### NEW

- `policy/registry.ts`
- `policy/compiler.ts`
- `policy/resolver.ts`
- `policy/ast.ts`
- `policy/bundle-store.ts`
- `skills/compiler.ts`
- `skills/evaluation-registry.ts`

### DEPRECATE

- `domains`和`Domain Adapter Version`字段；
- 其他业务项目Policy/Skill直接注册；
- 跨仓库Registry同步；
- 未评测外部Skill运行。

## 十四、进化治理

Policy和Skill候选生命周期：

```text
DRAFT
→ VALIDATING
→ APPROVED
→ ACTIVE
→ QUARANTINED / RETIRED
```

ACTIVE条件：

- Schema合法；
- 冲突检查通过；
- 基线回放无安全回归；
- 目标指标改善或保持；
- 高影响项目规则经过人工批准；
- 生成发布Manifest和Hash；
- 独立性扫描通过。

## 十五、测试

1. 高优先级DENY覆盖低优先级ALLOW；
2. 用户偏好不能取消强制授权；
3. 多ACTIVE版本被拒绝；
4. 不兼容Skill组合被拒绝；
5. 缺少前置条件时Preflight失败；
6. Bundle Hash对相同输入稳定；
7. Registry更新不改变运行中Bundle；
8. Skill文本中的指令不能改写Policy AST；
9. Candidate无回放不能ACTIVE；
10. Quarantine后新Run不再使用该版本；
11. 其他业务仓库Skill不能被注册；
12. 外部材料生成候选后仍需独立评测。

## 十六、验收

- 每个L1以上执行都有Policy/Skill Bundle；
- Bundle可重放；
- 冲突有确定性结果；
- 规则和Skill版本可查询；
- ACTIVE更新经过评测和发布证据；
- 现有天枢外置Skills目录继续兼容；
- Registry无其他业务项目运行资产。
