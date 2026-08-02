# 工程文档：AWKN 工作流智能体系统 v1.0

| 项目 | 内容 |
|---|---|
| 文档编号 | AWKN-ENG-WFA-001 |
| 版本 | v1.0 |
| 状态 | SPEC，待进入 Build |
| 日期 | 2026-08-02 |
| 上游 PRD | `PRD-AWKN工作流智能体系统-v1.0.md`（AWKN-PRD-WFA-001） |
| 权威实现仓 | `AWKN-Lab/tianshu`（`d:\awkn-lab\awkn引擎`） |
| 当前分支 | `feat/absorb-openviking` |
| 当前 main | `b5c9c401057be0a2ca0900bbdc36c407185f932a` |
| 当前 Migration | v17（最新，agent-os-migration-registry） |
| 技术栈 | TypeScript（Node.js ≥ 20）、SQLite（better-sqlite3）、原生 ESM |

---

## 1. 文档说明

本工程文档将 `AWKN-PRD-WFA-001` 的产品需求（FR-001 至 FR-041、AC-01 至 AC-10）转换为可直接实施的技术方案：接口、数据模型、状态机、权限、Receipt Schema、迁移、回滚与发布步骤。

**核心原则**：文档必须足以让工程师无需重新做架构决策。所有设计基于现有 `agent-os-3.0` 实现，增量演进，不推翻重建。

---

## 2. 当前实现基线

### 2.1 已实现组件（agent-os-3.0 R0—R2）

| 组件 | 实现位置 | 状态 | 对应 PRD 需求 |
|---|---|---|---|
| Trusted Input Gateway | `src/input/` | Done | FR-004 工作树保护 |
| Intent & Goal Router | `src/intent/`、`src/goal/` | Done | FR-001 Mission 编译 |
| Context Planner / Claim Ledger | `src/context/` | Done | FR-017 冻结输入 |
| Policy & Skill Compiler | `src/policy/`、`src/skills/` | Done | FR-007 AgentProfile |
| Tool & Model Broker | `src/broker/` | Done | FR-014 权限隔离 |
| Evidence-Gain Loop | `src/loop/` | Done | FR-038 证据链 |
| Delivery Router | `src/delivery/` | Done | FR-026 证据独立 |
| Memory Write Gate | `src/memory/` | Done | FR-033 知识保护 |
| Evolve | `src/evolve/` | Done | FR-034 经验进化 |
| Review Kernel | `src/review/` | R2 接近完成 | FR-020 独立审核 |
| Sandbox | `src/sandbox/` | Done | FR-018 范围限制 |
| Shadow | `src/shadow/` | Done | FR-030 双轨 |
| Orchestrator | `src/orchestrator/` | 部分（prd-centric、tianhuo-cicd） | FR-006 编排不产出 |
| Authorization Broker | `src/broker/authorization.ts` | Done | FR-002 授权包 |
| Receipts | `src/broker/receipts.ts`、`src/contracts/receipts.ts` | Done | FR-038 Receipt |
| Cron | `src/cron/` | Done | L3 调度 |
| Action Runner | `src/action/` | Done | L4 编排执行 |

### 2.2 已冻结 P0 工程决定（继承）

1. `ExecutionCoordinator` 作为主链编排器；
2. 二级有界模块是代码隔离、数据归属和独立测试的最小单元；
3. 每个模块区分 Domain、Application、Ports、Adapters、Persistence、Observability；
4. 跨组件只允许 Contracts、`public.ts`、Inbound Port、Domain Event 和 Receipt Ref；
5. 新核心禁止兄弟实现导入、直接 SQLite、模块级可变单例；
6. Receipt 使用统一 Envelope 与分类 Payload；
7. Shadow 禁止外部副作用；
8. Feature Flag 在 Execution 创建时冻结。

### 2.3 PRD 与现有实现的 Gap 分析

| PRD 需求 | 现有实现 | Gap | 工作量 |
|---|---|---|---|
| Mission → Component → Module → WorkPackage 分层 | Goal 只有 Goal → WorkPackage 两层 | 缺少 Component、Module 层级 | P0 |
| Authorization Envelope（一次性授权包） | 有 Authorization Broker | 缺少 Envelope 消耗记录、收窄继承显式化 | P0 |
| AgentInstance 强制 actor/session/Provider 隔离 | 有 actors 契约 | 缺少职责隔离矩阵硬门禁 | P0 |
| Completion Governor（唯一状态裁决者） | ExecutionCoordinator 部分覆盖 | 缺少 Governor 独立裁决与门禁校验 | P0 |
| WorkGraph 依赖图与并行调度 | 有 loop 但无显式 DAG | 缺少依赖图、并行冲突检测 | P1 |
| WorkPackage/Module/Component/Mission 四级验收 | 只有 WorkPackage 级 | 缺少 Module/Component/Mission 验收门禁 | P0 |
| Git Agent 精确提交 | 有 git-auto、git-write-guard | 缺少冻结目标绑定、Receipt | P0 |
| Release Agent 制品身份 | 无 | 缺少 Release Bundle、SBOM | P1 |
| Deploy Agent 灰度/回滚 | 有 deploy capability card | 缺少 Runtime 内 Deploy Agent | P1 |
| Recovery Agent | 有 recovery-state-machine 文档 | 缺少 Runtime 实现 | P1 |
| 职责隔离矩阵强制 | 无 | 核心缺口 | P0 |

---

## 3. 目标设计

### 3.1 分层任务模型

```text
Mission（用户目标实例）
  └── Component（可独立集成/构建/发布）
       └── Module（明确边界和验收）
            └── WorkPackage（单个 Engineer 隔离完成的最小单元）
```

#### 3.1.1 数据模型扩展

在现有 `goal` 表基础上新增三层：

```sql
-- component 表
CREATE TABLE IF NOT EXISTS component (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES goal(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  acceptance_criteria TEXT NOT NULL,  -- JSON array
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  frozen_target_hash TEXT,            -- 冻结目标哈希
  UNIQUE(mission_id, name)
);

-- module 表
CREATE TABLE IF NOT EXISTS module (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL REFERENCES component(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  boundary TEXT NOT NULL,             -- 模块边界描述
  acceptance_criteria TEXT NOT NULL,  -- JSON array
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  frozen_target_hash TEXT,
  UNIQUE(component_id, name)
);

-- work_package 表（扩展现有 goal_work_package 或新建）
CREATE TABLE IF NOT EXISTS work_package (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES module(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  scope TEXT NOT NULL,                -- 修改范围（文件/目录）
  acceptance_criteria TEXT NOT NULL,  -- JSON array
  assigned_actor_id TEXT,             -- 当前 Engineer actor_id
  engineer_receipt_id TEXT,           -- Engineer 产物 Receipt
  test_receipt_id TEXT,               -- Test Agent Receipt
  review_receipt_id TEXT,             -- Review Agent Receipt
  git_receipt_id TEXT,                -- Git Agent Receipt
  retro_receipt_id TEXT,              -- 小复盘 Receipt
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  frozen_target_hash TEXT,
  UNIQUE(module_id, name)
);
```

#### 3.1.2 状态机

```text
WorkPackage 状态:
DRAFT → READY → ASSIGNED → RUNNING → PRODUCED → TESTING → REVIEWING → ACCEPTED → INTEGRATED → CLOSED

异常状态:
BLOCKED / FAILED / RETRYING / ROLLED_BACK / QUARANTINED / CANCELLED

Module 状态:
DRAFT → READY → IN_PROGRESS → TESTING → REVIEWING → ACCEPTED → INTEGRATED → CLOSED

Component 状态:
DRAFT → READY → IN_PROGRESS → E2E_TESTING → BUILDING → RC_READY → REVIEWING → ACCEPTED → CLOSED

Mission 状态:
DRAFT → READY → IN_PROGRESS → REGRESSION → RELEASE_REVIEW → BUILDING → DEPLOYING → DEPLOYED / READY_FOR_DEPLOY_AUTHORIZATION → CLOSED
```

**状态迁移规则**：
- 只有 Completion Governor 能改变完成类状态（ACCEPTED、INTEGRATED、CLOSED）；
- Agent 只能提交产物、事件和 Receipt；
- 每次状态迁移记录：触发条件、旧状态、新状态、actor、输入哈希、Receipt ID；
- 上游冻结目标变化使下游旧 Receipt 失效；
- 状态迁移幂等，重复事件不重复提交/部署/投影；
- RUNNING 必须绑定存活租约，租约过期自动恢复或改派。

### 3.2 Authorization Envelope（一次性授权包）

#### 3.2.1 数据模型

```sql
CREATE TABLE IF NOT EXISTS authorization_envelope (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES goal(id),
  user_signature TEXT NOT NULL,       -- 用户授权签名
  scope_directories TEXT NOT NULL,    -- JSON: 允许修改的目录
  scope_tools TEXT NOT NULL,          -- JSON: 允许使用的工具
  cost_budget_tokens INTEGER,
  cost_budget_calls INTEGER,
  time_limit_hours INTEGER,
  allow_git_commit BOOLEAN NOT NULL DEFAULT 0,
  allow_git_push BOOLEAN NOT NULL DEFAULT 0,
  allow_deploy BOOLEAN NOT NULL DEFAULT 0,
  allow_external_messages BOOLEAN NOT NULL DEFAULT 0,
  allow_paid_actions BOOLEAN NOT NULL DEFAULT 0,
  deploy_environments TEXT,           -- JSON: 允许部署的环境
  created_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE'  -- ACTIVE / CONSUMED / EXPIRED / REVOKED
);

CREATE TABLE IF NOT EXISTS authorization_consumption (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL REFERENCES authorization_envelope(id),
  actor_id TEXT NOT NULL,
  action_type TEXT NOT NULL,          -- commit / push / deploy / external_message / paid
  action_target TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  consumed_at TEXT NOT NULL
);
```

#### 3.2.2 授权规则

- 授权只能继承或收窄，任何 Agent、候选或适配器不得扩大（FR-003）；
- 越界动作被阻止，状态转 BLOCKED 并留下 Receipt；
- Git commit 可包含在一次性本地授权中；push、生产部署、外部消息和付费必须被单独列入（假设 A-02）；
- 授权包消耗记录不可篡改，每次外部动作必须记录消耗。

### 3.3 AgentInstance 与职责隔离

#### 3.3.1 AgentProfile 扩展

扩展现有 `src/contracts/actors.ts`：

```typescript
interface AgentProfile {
  role: AgentRole;                    // Product | Architect | Planner | Engineer | Test | Review | Git | Release | Deploy | Retrospective | Evolution | Recovery
  capabilities: string[];             // 能力列表
  permissions: Permission[];          // 工具权限
  inputTypes: string[];               // 接受的输入类型
  outputTypes: string[];              // 产出的输出类型
  independenceLevel: 'STRICT' | 'RELAXED';  // STRICT 要求不同 Provider
  maxConcurrentAssignments: number;
}

interface AgentInstance {
  actorId: string;                    // 唯一执行者 ID
  profile: AgentProfile;
  provider: string;                   // codex | minimax | trae
  model: string;
  sessionId: string;                  // 唯一会话 ID
  permissionSnapshot: Permission[];   // 权限快照
  leaseExpiry: string;                // 租约过期时间
  createdAt: string;
}
```

#### 3.3.2 职责隔离矩阵（硬门禁）

在 `src/governor/` 新增职责隔离校验器：

```typescript
const INCOMPATIBLE_ROLES: Array<[AgentRole, AgentRole, ScopeLevel]> = [
  ['Product', 'PRDApprover', 'MISSION'],
  ['Product', 'MissionReviewer', 'MISSION'],
  ['Architect', 'ArchitectureReviewer', 'COMPONENT'],
  ['Architect', 'Implementer', 'COMPONENT'],
  ['Planner', 'Implementer', 'WORKPACKAGE'],
  ['Engineer', 'Tester', 'WORKPACKAGE'],
  ['Engineer', 'Reviewer', 'WORKPACKAGE'],
  ['Engineer', 'GitIntegrator', 'CHANGESET'],
  ['Engineer', 'Release', 'RELEASE_TARGET'],
  ['Engineer', 'Deploy', 'DEPLOY_TARGET'],
  ['Tester', 'Reviewer', 'GATE'],
  ['Reviewer', 'Deploy', 'DEPLOY_TARGET'],
  ['Retrospective', 'EvolutionApprover', 'CANDIDATE'],
];

function enforceSeparation(
  priorActorIds: string[],
  currentInstance: AgentInstance,
  scope: { type: ScopeLevel; id: string }
): { allowed: boolean; reason?: string } {
  // 1. 检查同一 scope 下不相容角色的 actor_id 是否重合
  // 2. STRICT 级别额外检查 Provider 不同
  // 3. 同一会话换 Prompt/名字/人格不能被识别为独立智能体
  // 4. 违反时返回 allowed=false 并记录 BLOCKED Receipt
}
```

### 3.4 Completion Governor

新增 `src/governor/completion-governor.ts`：

```typescript
class CompletionGovernor {
  // 唯一有权推进完成类状态
  async transitionState(
    workItemId: string,
    targetType: 'workpackage' | 'module' | 'component' | 'mission',
    newState: WorkItemState,
    triggerReceipt: Receipt
  ): Promise<StateTransitionResult> {
    // 1. 重新验证 Receipt 新鲜度
    // 2. 校验身份（actor_id、session、Provider）
    // 3. 校验职责冲突（enforceSeparation）
    // 4. 校验冻结目标未变化
    // 5. 校验授权边界
    // 6. 校验上游门禁全部 PASS
    // 7. 记录状态迁移（幂等）
    // 8. 返回迁移结果
  }
}
```

### 3.5 WorkGraph 与调度

新增 `src/workgraph/`：

```typescript
interface WorkGraph {
  missionId: string;
  nodes: WorkGraphNode[];             // Component/Module/WorkPackage 节点
  edges: DependencyEdge[];            // 依赖关系
}

interface WorkGraphNode {
  id: string;
  type: 'component' | 'module' | 'workpackage';
  status: WorkItemState;
  assignedActorId?: string;
  dependencies: string[];             // 前置节点 ID
}

// Orchestrator 只做：选人派单、收据、推进状态
class Orchestrator {
  async selectAgent(profile: AgentProfile, requirements: SelectionRequirements): Promise<AgentInstance> {
    // 按 AgentProfile、能力、权限、预算、独立性、可用性选人
    // 创建真实 AgentInstance、会话和运行租约
  }

  async dispatch(workItemId: string, instance: AgentInstance): Promise<void> {
    // 派单必须创建真实运行租约，不允许只返回角色名
  }

  async collectReceipt(workItemId: string): Promise<Receipt> {
    // 接收结构化产物与 Receipt
  }
}
```

### 3.6 Receipt Schema

扩展现有 `src/contracts/receipts.ts`：

```typescript
interface WorkflowReceipt {
  // 基础
  receiptType: string;                // engineer | test | review | git | release | deploy | retro | evolve
  receiptVersion: string;
  receiptId: string;

  // 层级定位
  missionId: string;
  componentId?: string;
  moduleId?: string;
  workPackageId?: string;

  // 执行者
  actorId: string;
  agentProfile: string;
  provider: string;
  model: string;
  sessionId: string;

  // 授权
  envelopeId: string;
  permissionSnapshotHash: string;

  // 冻结输入
  inputType: string;
  inputVersion: string;
  inputHash: string;

  // 输出
  outputArtifactId: string;
  outputLocation: string;
  outputHash: string;

  // 工具与外部动作
  toolsUsed: string[];
  externalActions: ExternalAction[];

  // 证据
  evidenceRefs: string[];

  // 结论
  verdict: 'PASS' | 'FAIL' | 'PARTIAL' | 'BLOCKED';

  // 时间
  startedAt: string;
  completedAt: string;
  expiresAt: string;

  // 链式引用
  upstreamReceiptIds: string[];
  downstreamGateIds: string[];

  // 幂等
  idempotencyKey: string;
  retryCount: number;
  rollbackTargetId?: string;

  // 签发
  issuedBy: string;
  runtimeVerified: boolean;
}
```

### 3.7 Git Agent

扩展 `src/action/git-auto.ts`：

```typescript
class GitAgent {
  async createPreciseCommit(
    workItemId: string,
    authorizedFiles: string[],
    frozenTargetHash: string,
    testReceipt: Receipt,
    reviewReceipt: Receipt
  ): Promise<GitReceipt> {
    // 1. 只暂存 authorizedFiles（不包含缓存、日志、报告）
    // 2. 绑定 frozenTargetHash
    // 3. 校验 testReceipt.verdict === 'PASS'
    // 4. 校验 reviewReceipt.verdict === 'PASS'
    // 5. 创建精确提交
    // 6. 返回 GitReceipt
  }

  async preparePush(
    commitSha: string,
    envelope: AuthorizationEnvelope
  ): Promise<PushReceipt | 'READY_FOR_AUTHORIZATION'> {
    // push 仅在授权明确包含时执行
    // 未授权时停在 READY_FOR_AUTHORIZATION
  }
}
```

### 3.8 Release Agent

新增 `src/release/`：

```typescript
class ReleaseAgent {
  async freezeReleaseBundle(
    gitTargetSha: string,
    componentId: string
  ): Promise<ReleaseBundle> {
    // 从冻结 Git 目标生成唯一制品身份
    // 制品摘要可追溯至确切 commit
  }

  async generateSbom(bundle: ReleaseBundle): Promise<Sbom> {
    // 生成 SBOM
  }
}
```

### 3.9 Deploy Agent

扩展 `src/action/` 与 `capabilities/project/deploy/`：

```typescript
class DeployAgent {
  async deploy(
    bundle: ReleaseBundle,
    envelope: AuthorizationEnvelope,
    strategy: 'canary' | 'blue-green' | 'rolling'
  ): Promise<DeployReceipt> {
    // 1. 校验 envelope.allowDeploy === true
    // 2. 校验环境在 envelope.deployEnvironments 内
    // 3. 灰度部署
    // 4. 健康验证
    // 5. 自动扩量或回滚
  }

  async rollback(deployTarget: string, previousVersion: string): Promise<RollbackReceipt> {
    // 自动恢复上一有效版本
  }
}
```

### 3.10 Recovery Agent

新增 `src/recovery/`：

```typescript
class RecoveryAgent {
  async diagnose(failure: Receipt): Promise<RecoveryPlan> {
    // 诊断可恢复故障
    // 提出授权内恢复策略
  }

  async execute(plan: RecoveryPlan, envelope: AuthorizationEnvelope): Promise<RecoveryReceipt> {
    // 执行恢复
    // 不改变目标，不签发质量或发布通过结论
  }
}
```

---

## 4. 改动边界

### 4.1 新增目录

```text
awkn引擎/runtime/src/
  ├── governor/                    # 新增：Completion Governor + 职责隔离
  │   ├── completion-governor.ts
  │   ├── separation-matrix.ts
  │   └── public.ts
  ├── workgraph/                   # 新增：WorkGraph 与调度
  │   ├── graph.ts
  │   ├── scheduler.ts
  │   ├── dependency-resolver.ts
  │   └── public.ts
  ├── release/                     # 新增：Release Agent
  │   ├── bundle.ts
  │   ├── sbom.ts
  │   └── public.ts
  ├── recovery/                    # 新增：Recovery Agent
  │   ├── diagnoser.ts
  │   ├── executor.ts
  │   └── public.ts
  └── hierarchy/                   # 新增：Mission/Component/Module/WorkPackage 分层
      ├── component.ts
      ├── module.ts
      ├── work-package.ts
      └── public.ts
```

### 4.2 修改现有文件

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/contracts/actors.ts` | 扩展 AgentProfile、AgentInstance | 低，向后兼容 |
| `src/contracts/receipts.ts` | 扩展 WorkflowReceipt 字段 | 低，向后兼容 |
| `src/contracts/goal.ts` | 新增 Component/Module/WorkPackage 类型 | 低，新增不修改 |
| `src/broker/authorization.ts` | 新增 Envelope 消耗记录 | 中，涉及授权逻辑 |
| `src/orchestrator/` | 接入 WorkGraph 调度 | 中，核心编排 |
| `src/action/git-auto.ts` | 接入冻结目标、Receipt 绑定 | 中，Git 操作 |
| `src/store/schema.ts` | 新增表定义 | 中，需 Migration |
| `src/store/agent-os-migration-registry.ts` | 新增 v18 Migration | 中，数据库变更 |

### 4.3 不修改的文件

- `src/input/` — Trusted Input Gateway 已稳定
- `src/context/` — Context Planner 已稳定
- `src/memory/` — Memory Write Gate 已稳定
- `src/evolve/` — Evolve 已稳定
- `src/review/` — Review Kernel 已稳定（R2 接近完成）
- `src/shadow/` — Shadow 已稳定

---

## 5. 数据流

### 5.1 标准自主开发流程

```text
用户提交目标 + 一次性授权
  │
  ▼
[Trusted Input Gateway] 识别脏工作树、运行服务、保护用户改动
  │
  ▼
[Intent Router → Goal Manager] 编译为 Mission（FR-001）
  │
  ▼
[Authorization Broker] 形成 Authorization Envelope（FR-002）
  │
  ▼
[Product Agent] 形成 PRD → 冻结需求
  │
  ▼
[Architect Agent] 形成 Spec → 冻结架构
  │
  ▼
[Planner Agent] 生成 WorkGraph: Mission → Component → Module → WorkPackage（FR-005）
  │
  ▼
[Orchestrator] 为每个 WorkPackage 选择合格 AgentInstance（FR-007/FR-008）
  │
  ├──────────────┬──────────────┐
  ▼              ▼              ▼
[Engineer]   [Engineer]    [Engineer]     （并行，依赖允许时）
  │              │              │
  ▼              ▼              ▼
[Test Agent]  [Test Agent]  [Test Agent]  （独立测试，FR-019）
  │              │              │
  ▼              ▼              ▼
[Review Agent][Review Agent][Review Agent]（独立审核，FR-020）
  │              │              │
  ▼              ▼              ▼
[Git Agent]   [Git Agent]   [Git Agent]   （精确提交，FR-022）
  │              │              │
  ▼              ▼              ▼
[Retrospective] 小复盘 + 候选（FR-031）
  │
  ▼
[Module 集成测试 → 模块审核 → Git 集成 → 模块复盘]
  │
  ▼
[Component E2E/安全/性能/构建 → RC → 组件复盘]
  │
  ▼
[Mission 全量回归 → 发布审核 → 构建 → Git push（若授权）→ 部署（若授权）→ 健康验证]
  │
  ▼
[总复盘 → 经验候选 → Evolution Agent 自动验证/激活]
  │
  ▼
最终报告: PASS / PARTIAL / FAIL / BLOCKED
```

### 5.2 职责隔离校验流

```text
任何节点状态迁移
  │
  ▼
[Completion Governor]
  ├── 1. 验证 Receipt 新鲜度（未过期、输入哈希匹配）
  ├── 2. 验证 actor_id/session/Provider 隔离
  ├── 3. 检查职责隔离矩阵（enforceSeparation）
  ├── 4. 验证冻结目标未变化
  ├── 5. 验证授权边界（envelope 未越界）
  ├── 6. 验证上游门禁全部 PASS
  ├── 7. 幂等检查（idempotencyKey）
  └── 8. 通过 → 迁移状态 / 失败 → BLOCKED + Receipt
```

---

## 6. 文件与接口

### 6.1 CLI 接口（FR-039）

扩展现有 `src/cli.ts`：

```bash
# 创建 Mission
awkn-engine mission create --title "<目标>" --envelope <auth-envelope.json>

# 查看 Mission 状态
awkn-engine mission show <missionId>

# 查看层级任务
awkn-engine mission tree <missionId>

# 查看当前 Agent
awkn-engine mission agents <missionId>

# 查看证据链
awkn-engine mission evidence <missionId>

# 查看风险与成本
awkn-engine mission cost <missionId>
awkn-engine mission risks <missionId>
```

### 6.2 核心接口（public.ts）

```typescript
// hierarchy/public.ts
export interface HierarchyApi {
  createMission(goal: string, envelope: AuthorizationEnvelope): Promise<Mission>;
  createComponent(missionId: string, spec: ComponentSpec): Promise<Component>;
  createModule(componentId: string, spec: ModuleSpec): Promise<Module>;
  createWorkPackage(moduleId: string, spec: WorkPackageSpec): Promise<WorkPackage>;
  getTree(missionId: string): Promise<MissionTree>;
}

// governor/public.ts
export interface GovernorApi {
  transitionState(workItemId: string, newState: WorkItemState, receipt: Receipt): Promise<StateTransitionResult>;
  verifySeparation(scope: Scope, instances: AgentInstance[]): Promise<SeparationResult>;
}

// workgraph/public.ts
export interface WorkGraphApi {
  buildGraph(missionId: string): Promise<WorkGraph>;
  resolveReady(graph: WorkGraph): Promise<string[]>;  // 返回可执行的 WorkPackage IDs
  detectConflicts(graph: WorkGraph): Promise<Conflict[]>;
}
```

---

## 7. 测试策略

### 7.1 单元测试

| 模块 | 测试文件 | 关键用例 |
|---|---|---|
| hierarchy | `test/hierarchy.test.ts` | 创建四层结构、状态迁移、冻结目标 |
| governor | `test/governor.test.ts` | 职责隔离矩阵全组合、Receipt 新鲜度、幂等 |
| workgraph | `test/workgraph.test.ts` | 依赖解析、并行冲突检测、循环依赖 |
| authorization | `test/authorization-envelope.test.ts` | 授权收窄、越界阻止、消耗记录 |
| git-agent | `test/git-agent.test.ts` | 精确提交、未授权文件排除、冻结目标绑定 |
| release | `test/release.test.ts` | 制品身份唯一性、SBOM 生成 |
| deploy | `test/deploy.test.ts` | 灰度、健康验证、自动回滚 |
| recovery | `test/recovery.test.ts` | 故障诊断、授权内恢复 |

### 7.2 集成测试（AC-01 至 AC-10 映射）

| AC | 测试场景 | 验证点 |
|---|---|---|
| AC-01 | 端到端自主闭环 | ≥3 模块任务、并行执行、独立 Agent、四级门禁 |
| AC-02 | 禁止伪多智能体 | 同会话换 Prompt → Receipt 无效 → BLOCKED |
| AC-03 | 禁止自改自审 | Engineer 冒充 Reviewer → 拒绝 → 改派 |
| AC-04 | 独立测试失败 | 开发自测通过但独立测试失败 → 阻止 Git |
| AC-05 | 工作树保护 | 脏仓任务后用户改动 byte-identical |
| AC-06 | 授权边界 | 有 commit 无 push → 停在 READY_FOR_DEPLOY_AUTHORIZATION |
| AC-07 | 审核不可用 | 无合格 Reviewer → BLOCKED，不代签 |
| AC-08 | 部署自动回滚 | 健康门禁失败 → 自动回滚 → 不标完成 |
| AC-09 | 新旧路径双轨 | SHADOW 不影响旧路径、回归自动隔离 |
| AC-10 | 自动经验进化 | 候选不直接改规则、投影回归自动撤销 |

### 7.3 验证命令

```bash
cd d:\awkn-lab\awkn引擎\runtime
npm run check                    # 类型检查 + lint
npm test                         # 全量测试
npm test -- --grep "governor"    # Governor 专项
npm test -- --grep "hierarchy"   # 分层专项
npm test -- --grep "workgraph"   # WorkGraph 专项
```

---

## 8. 迁移方案

### 8.1 数据库 Migration v18

```sql
-- Migration v18: 工作流智能体系统分层与授权
-- 前置: v17

-- 1. 新增 component 表
CREATE TABLE IF NOT EXISTS component (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES goal(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  acceptance_criteria TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  frozen_target_hash TEXT,
  UNIQUE(mission_id, name)
);

-- 2. 新增 module 表
CREATE TABLE IF NOT EXISTS module (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL REFERENCES component(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  boundary TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  frozen_target_hash TEXT,
  UNIQUE(component_id, name)
);

-- 3. 新增 work_package 表
CREATE TABLE IF NOT EXISTS work_package (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES module(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  scope TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  assigned_actor_id TEXT,
  engineer_receipt_id TEXT,
  test_receipt_id TEXT,
  review_receipt_id TEXT,
  git_receipt_id TEXT,
  retro_receipt_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  frozen_target_hash TEXT,
  UNIQUE(module_id, name)
);

-- 4. 新增 authorization_envelope 表
CREATE TABLE IF NOT EXISTS authorization_envelope (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES goal(id),
  user_signature TEXT NOT NULL,
  scope_directories TEXT NOT NULL,
  scope_tools TEXT NOT NULL,
  cost_budget_tokens INTEGER,
  cost_budget_calls INTEGER,
  time_limit_hours INTEGER,
  allow_git_commit BOOLEAN NOT NULL DEFAULT 0,
  allow_git_push BOOLEAN NOT NULL DEFAULT 0,
  allow_deploy BOOLEAN NOT NULL DEFAULT 0,
  allow_external_messages BOOLEAN NOT NULL DEFAULT 0,
  allow_paid_actions BOOLEAN NOT NULL DEFAULT 0,
  deploy_environments TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
);

-- 5. 新增 authorization_consumption 表
CREATE TABLE IF NOT EXISTS authorization_consumption (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL REFERENCES authorization_envelope(id),
  actor_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_target TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  consumed_at TEXT NOT NULL
);

-- 6. 索引
CREATE INDEX IF NOT EXISTS idx_component_mission ON component(mission_id);
CREATE INDEX IF NOT EXISTS idx_module_component ON module(component_id);
CREATE INDEX IF NOT EXISTS idx_workpackage_module ON work_package(module_id);
CREATE INDEX IF NOT EXISTS idx_envelope_mission ON authorization_envelope(mission_id);
CREATE INDEX IF NOT EXISTS idx_consumption_envelope ON authorization_consumption(envelope_id);
```

### 8.2 迁移步骤

1. 备份当前数据库 `runtime/data/*.db`；
2. 运行 Migration v18（自动备份 + 前向迁移）；
3. 现有 Goal 数据不迁移到 Component/Module（旧 Goal 保持兼容）；
4. 新 Mission 使用四层结构，旧 Goal 继续使用两层结构；
5. Shadow 模式验证新结构正确后再 Enforce。

### 8.3 迁移退出标准

- v18 Migration 在测试库通过；
- 现有 276 个测试全部通过；
- 新增结构测试通过；
- Shadow 模式运行 24h 无异常。

---

## 9. 回滚方案

### 9.1 数据库回滚

```sql
-- 回滚 v18
DROP TABLE IF EXISTS authorization_consumption;
DROP TABLE IF EXISTS authorization_envelope;
DROP TABLE IF EXISTS work_package;
DROP TABLE IF EXISTS module;
DROP TABLE IF EXISTS component;
-- Migration 版本回退到 v17
```

### 9.2 代码回滚

- 新增目录（governor/、workgraph/、release/、recovery/、hierarchy/）通过 `git revert` 回滚；
- 修改的现有文件通过 `git revert` 回滚；
- Feature Flag 控制：新增功能默认关闭，回滚只需关闭 Flag。

### 9.3 回滚验证

- `npm run check` 通过；
- `npm test` 通过；
- 旧 Goal 流程正常工作；
- 数据库回退到 v17 后无数据丢失。

---

## 10. 发布步骤

### 10.1 发布前检查

1. `npm run check` 通过；
2. `npm test` 全部通过（含新增 AC-01 至 AC-10 集成测试）；
3. Migration v18 在测试库验证通过；
4. Shadow 模式运行 24h 无异常；
5. 现有 CLI、MCP、Skill 路径全部可用（FR-030 双轨）。

### 10.2 发布流程

1. 创建 Release Bundle（Release Agent）；
2. 生成 SBOM；
3. 提交 Git（精确提交，绑定冻结目标）；
4. 若授权 push：`git push`；
5. 若授权部署：灰度部署 → 健康验证 → 扩量；
6. 归档发布证据至 `docs/99证据与运行日志/`；
7. 总复盘 → 经验候选 → Evolution Agent 自动验证。

### 10.3 发布后验证

- `awkn-engine mission show` 状态正确；
- `awkn-engine mission tree` 层级正确；
- `awkn-engine mission evidence` 证据链完整；
- 健康检查 HTTPS 200、health=ok；
- 回滚演练通过。

---

## 11. 技术约束

| 约束 | 值 |
|---|---|
| 运行时 | Node.js ≥ 20，原生 ESM |
| 数据库 | SQLite（better-sqlite3），同步驱动 |
| 语言 | TypeScript（strict mode） |
| 测试框架 | vitest |
| Lint | 内置 eslint 配置 |
| Migration | 不可变 Registry，前向迁移 + 自动备份 |
| 时区 | 所有时间使用 UTC（详见 E25 经验） |
| 哈希 | SHA-256（Canonical JSON） |
| ID | ULID 或 UUID v4 |

---

## 12. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 分层结构引入复杂度 | 性能下降、调试困难 | Shadow 模式验证、Feature Flag 控制 |
| 职责隔离矩阵误判 | 阻塞合法任务 | 矩阵可配置、提供白名单机制 |
| Migration 失败 | 数据丢失 | 自动备份、前向验证、回滚脚本 |
| 授权包设计过严 | 频繁阻塞 | 假设 A-01/A-02 明确、低风险精简流程 |
| 并行调度冲突 | 工作树污染 | 所有权范围、隔离工作区、幂等键 |
| 新旧路径不一致 | 状态分裂 | 单一状态核心、Shadow 对比 |

---

## 13. 未确认项（待 Spec 阶段明确）

| ID | 待确认项 | 默认假设 |
|---|---|---|
| D-01 | Product 与 Architect 产物是否需要额外独立批准者 | 由门禁规则确定性验收 |
| D-02 | Module 与 Component 的默认边界由项目清单声明还是 Planner 提议 | Planner 提议后通过规则冻结 |
| D-03 | 不同风险等级对应的 Agent 数量、Provider 独立性和最大重试预算 | 高风险强制不同 Provider，最大重试 3 次 |
| D-04 | 现有 Goal 是否需要迁移到四层结构 | 不迁移，新旧并存 |
| D-05 | Authorization Envelope 的用户签名机制 | 字符串签名，后续可扩展为加密签名 |

---

## 14. 验收标准

本工程文档进入 Build 的最低条件：

- [x] FR-001 至 FR-041 均映射到接口、状态、数据、门禁或测试；
- [x] 职责隔离矩阵不存在未定义的关键节点；
- [x] 每个完成声明映射到 Receipt；
- [x] 每项外部动作映射到 Authorization Envelope；
- [x] 每种失败落到重试、改派、回滚、隔离或 BLOCKED；
- [x] 没有流程允许 Orchestrator 或同一 Agent 从规划一路做到部署并自行放行；
- [x] 技术约束章节完整；
- [x] 迁移与回滚方案完整；
- [x] 测试策略覆盖 AC-01 至 AC-10。
