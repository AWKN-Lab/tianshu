# 数据模型与 Migration 设计

> 文档编号：TS-AOS-DATA-014  
> 版本：v1.0 Draft  
> 关联：PR #25、Issue #29  
> 数据库：SQLite / better-sqlite3

## 一、当前基线

当前数据库迁移链：

| Version | 名称 | 入口 |
|---:|---|---|
| 1 | initial-runtime-schema | `migrations.ts` |
| 2 | engine-v2-run-event-artifact-model | `migrations.ts` |
| 3 | sandbox-execution-audit | `migrations.ts` |
| 4 | durable-cron-work-queue | `migrations.ts` |
| 5 | run-trace-id | `migrations.ts` |
| 6 | evolution-candidate-lifecycle | `migrations.ts` |
| 7 | runtime-memory-os | `migrations.ts` |
| 8 | operational-evolution-loop | 独立迁移入口 |
| 9 | historical-replay-success-target | 独立迁移入口 |
| 10 | memory-os-authority-projection | 独立迁移入口 |

Agent OS 3.0 从 v11 开始。v11 起所有迁移统一注册到一个 Migration Registry，独立迁移函数逐步改为 Registry Adapter，避免调用顺序隐式决定 Schema。

## 二、设计决定

1. SQLite 保持 WAL、`foreign_keys=ON`；
2. `ExecutionEnvelope` 使用“当前投影 + append-only Event”模式；
3. `receipts` 使用统一表，分类 Payload 通过 `payload_schema` 校验；
4. Claim 正文首版保存在本地数据库，写前执行 DLP；高敏正文可外置 Artifact，仅保存脱敏摘要与 Ref；
5. EventStore 与业务投影在同一 SQLite 事务中写入；
6. 外部副作用采用 Intent/Completion Receipt，跨系统一致性使用 Outbox/Saga；
7. v11—v19 坚持 additive-first，不删除 Engine v2 表和列；
8. Migration 失败时，Engine v2 只在“未提交新版本且旧 Schema 完整”条件下继续运行；
9. 每次 Migration 前生成数据库备份、Schema Manifest 和文件 Hash；
10. JSON 列必须配套 `*_schema` 或 Payload 内含 `schema`。

## 三、Migration Registry v2

```ts
interface MigrationV2 {
  version: number;
  name: string;
  phase: 'expand' | 'backfill' | 'verify' | 'contract';
  up(db: Database): void;
  verify(db: Database): MigrationVerification;
  rollbackPolicy: 'restore_backup' | 'reverse_if_empty' | 'forward_fix_only';
}
```

新增 `schema_migration_runs`：

```sql
CREATE TABLE schema_migration_runs (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('expand','backfill','verify','contract')),
  status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed')),
  database_sha256_before TEXT,
  database_sha256_after TEXT,
  schema_manifest_json TEXT NOT NULL DEFAULT '{}',
  error_text TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_schema_migration_runs_version
  ON schema_migration_runs(version, started_at);
```

Migration 必须在独占迁移锁下执行。应用启动发现 `started` 且无 `finished_at` 的记录时，进入诊断模式，不继续写业务数据。

## 四、版本规划

| Version | 主题 | 主要表 |
|---:|---|---|
| 11 | Core Execution & Receipt | executions、execution_snapshots、receipts、domain_events |
| 12 | Claim Ledger v3 | claims、claim_sources、claim_derivations、claim_confirmations、claim_conflicts、claim_events |
| 13 | Context / Policy / Skill | context_manifests、context_items、compiled_policy_bundles、compiled_skill_bundles |
| 14 | Broker / Authorization | authorizations、model_route_receipts、tool_execution_receipts、conversation_action_ledger |
| 15 | Evidence Loop | evidence、evidence_links、cycle_plans、cycle_receipts、strategy_attempts |
| 16 | Delivery / Outcome | deliveries、delivery_receipts、outcomes、outcome_* |
| 17 | Memory Write | memory_write_decisions、memory_transactions、memory_transaction_operations |
| 18 | Evolve / Authority | evolution v2 扩展、authority_outbox v2、protocol_sessions |
| 19 | Backfill / Index / Compatibility | Legacy 回填、视图、最终索引、验证标记 |

## 五、v11 Core Execution & Receipt

### 5.1 executions

```sql
CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  actor_json TEXT NOT NULL,
  actor_schema TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  scope_schema TEXT NOT NULL,
  input_ref_json TEXT NOT NULL,
  intent_ref_json TEXT,
  goal_ref_json TEXT,
  context_ref_json TEXT,
  policy_bundle_ref_json TEXT,
  skill_bundle_ref_json TEXT,
  broker_plan_ref_json TEXT,
  run_refs_json TEXT NOT NULL DEFAULT '[]',
  delivery_refs_json TEXT NOT NULL DEFAULT '[]',
  outcome_ref_json TEXT,
  memory_decision_refs_json TEXT NOT NULL DEFAULT '[]',
  evolution_candidate_refs_json TEXT NOT NULL DEFAULT '[]',
  feature_flags_ref_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'RECEIVED','TRUSTED','ROUTED','CONTEXT_READY','COMPILED','AUTHORIZED',
    'RUNNING','DELIVERING','DELIVERED','OUTCOME_PENDING','OUTCOME_RECORDED',
    'CLOSED','BLOCKED','WAITING_USER','WAITING_AUTHORIZATION','RETRYING',
    'DEGRADED','PARTIAL','FAILED','CANCELLED'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE(trace_id, id)
);
CREATE INDEX idx_executions_trace ON executions(trace_id);
CREATE INDEX idx_executions_state_updated ON executions(state, updated_at);
```

CAS 更新：

```sql
UPDATE executions
SET state = ?, revision = revision + 1, updated_at = ?
WHERE id = ? AND revision = ?;
```

`changes=0` 返回 `AOS_EXECUTION_REVISION_CONFLICT`。

### 5.2 execution_snapshots

```sql
CREATE TABLE execution_snapshots (
  execution_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  snapshot_schema TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, revision),
  FOREIGN KEY (execution_id) REFERENCES executions(id)
);
```

Snapshot 是加速投影，不承担事件权威。默认每 25 个 Event 或进入终态时生成。

### 5.3 receipts

```sql
CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  receipt_type TEXT NOT NULL,
  payload_schema TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  run_id TEXT,
  step_id TEXT,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  producer_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SUCCESS','FAILURE','PARTIAL','UNKNOWN')),
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  artifact_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES executions(id)
);
CREATE UNIQUE INDEX idx_receipts_payload_dedupe
  ON receipts(receipt_type, aggregate_id, payload_hash);
CREATE INDEX idx_receipts_execution_type
  ON receipts(execution_id, receipt_type, created_at);
CREATE INDEX idx_receipts_run ON receipts(run_id, created_at);
```

### 5.4 domain_events

保留现有 `events` 供 Engine v2 使用，新 Event Store 使用：

```sql
CREATE TABLE domain_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_revision INTEGER NOT NULL,
  execution_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  receipt_ids_json TEXT NOT NULL DEFAULT '[]',
  payload_schema TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES executions(id),
  UNIQUE(aggregate_id, aggregate_revision)
);
CREATE INDEX idx_domain_events_execution
  ON domain_events(execution_id, occurred_at);
CREATE INDEX idx_domain_events_aggregate
  ON domain_events(aggregate_id, aggregate_revision);
```

## 六、v12 Claim Ledger v3

### 6.1 claims

```sql
CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  content TEXT,
  content_ref_json TEXT,
  content_hash TEXT NOT NULL,
  originator TEXT NOT NULL CHECK (originator IN ('human','assistant','system','external')),
  speaker TEXT NOT NULL CHECK (speaker IN ('human','assistant','system','tool')),
  claim_type TEXT NOT NULL,
  epistemic_status TEXT NOT NULL CHECK (epistemic_status IN (
    'proposed','asserted','derived','observed','disputed','superseded','expired'
  )),
  confirmation_level TEXT NOT NULL CHECK (confirmation_level IN ('none','direction','option','field')),
  authority REAL NOT NULL CHECK (authority >= 0 AND authority <= 1),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  sensitivity_class TEXT NOT NULL,
  project_id TEXT,
  user_id TEXT,
  valid_from TEXT,
  valid_until TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (content IS NOT NULL OR content_ref_json IS NOT NULL)
);
CREATE INDEX idx_claims_scope_status
  ON claims(project_id, user_id, epistemic_status, updated_at);
CREATE INDEX idx_claims_content_hash ON claims(content_hash);
```

### 6.2 来源与派生

```sql
CREATE TABLE claim_sources (
  claim_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_uri TEXT,
  source_span_json TEXT,
  source_hash TEXT,
  observed_at TEXT,
  PRIMARY KEY (claim_id, source_id),
  FOREIGN KEY (claim_id) REFERENCES claims(id)
);

CREATE TABLE claim_derivations (
  claim_id TEXT NOT NULL,
  parent_claim_id TEXT NOT NULL,
  derivation_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (claim_id, parent_claim_id),
  FOREIGN KEY (claim_id) REFERENCES claims(id),
  FOREIGN KEY (parent_claim_id) REFERENCES claims(id)
);
```

### 6.3 确认、冲突与事件

```sql
CREATE TABLE claim_confirmations (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('direction','option','field')),
  field_path TEXT,
  actor_json TEXT NOT NULL,
  source_ref_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (claim_id) REFERENCES claims(id)
);

CREATE TABLE claim_conflicts (
  id TEXT PRIMARY KEY,
  left_claim_id TEXT NOT NULL,
  right_claim_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN','RESOLVED','SUPERSEDED')),
  resolution_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (left_claim_id) REFERENCES claims(id),
  FOREIGN KEY (right_claim_id) REFERENCES claims(id)
);

CREATE TABLE claim_events (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_schema TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (claim_id) REFERENCES claims(id)
);
```

## 七、v13 Context、Policy、Skill

```sql
CREATE TABLE context_manifests (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  schema_id TEXT NOT NULL,
  query_plan_json TEXT NOT NULL,
  token_budget INTEGER NOT NULL CHECK (token_budget >= 0),
  selected_token_count INTEGER NOT NULL CHECK (selected_token_count >= 0),
  receipt_id TEXT,
  render_id TEXT,
  backend TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0,1)),
  manifest_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES executions(id),
  FOREIGN KEY (receipt_id) REFERENCES receipts(id)
);

CREATE TABLE context_items (
  manifest_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  claim_id TEXT,
  source_ref_json TEXT NOT NULL,
  utility_score REAL NOT NULL,
  token_count INTEGER NOT NULL,
  freshness_json TEXT,
  authority REAL NOT NULL,
  sensitivity_class TEXT NOT NULL,
  selected_reason_codes_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (manifest_id, ordinal),
  FOREIGN KEY (manifest_id) REFERENCES context_manifests(id),
  FOREIGN KEY (claim_id) REFERENCES claims(id)
);
CREATE UNIQUE INDEX idx_context_item_unique
  ON context_items(manifest_id, item_type, item_id);
```

```sql
CREATE TABLE compiled_policy_bundles (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  schema_id TEXT NOT NULL,
  source_versions_json TEXT NOT NULL,
  policies_json TEXT NOT NULL,
  conflicts_json TEXT NOT NULL DEFAULT '[]',
  decisions_json TEXT NOT NULL DEFAULT '[]',
  compiler_version TEXT NOT NULL,
  bundle_hash TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES executions(id)
);

CREATE TABLE compiled_skill_bundles (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  schema_id TEXT NOT NULL,
  selected_skills_json TEXT NOT NULL,
  rejected_skills_json TEXT NOT NULL DEFAULT '[]',
  execution_graph_json TEXT NOT NULL,
  preflight_results_json TEXT NOT NULL,
  gates_json TEXT NOT NULL,
  recovery_plan_json TEXT NOT NULL,
  bundle_hash TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES executions(id)
);
CREATE UNIQUE INDEX idx_policy_bundle_hash
  ON compiled_policy_bundles(execution_id, bundle_hash);
CREATE UNIQUE INDEX idx_skill_bundle_hash
  ON compiled_skill_bundles(execution_id, bundle_hash);
```

## 八、v14 Broker 与 Authorization

### 8.1 authorizations

```sql
CREATE TABLE authorizations (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  actor_json TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  allowed_tool_ids_json TEXT NOT NULL,
  allowed_operations_json TEXT NOT NULL,
  target_constraints_json TEXT NOT NULL,
  risk_ceiling TEXT NOT NULL CHECK (risk_ceiling IN ('R0','R1','R2','R3','R4','R5')),
  max_uses INTEGER NOT NULL CHECK (max_uses >= 1),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  reserved_count INTEGER NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING','ACTIVE','CONSUMED','REVOKED','EXPIRED')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (execution_id) REFERENCES executions(id),
  CHECK (used_count + reserved_count <= max_uses)
);
CREATE INDEX idx_authorizations_execution_status
  ON authorizations(execution_id, status, expires_at);
```

原子预占：

```sql
UPDATE authorizations
SET reserved_count = reserved_count + 1, revision = revision + 1
WHERE id = ? AND revision = ? AND status = 'ACTIVE'
  AND expires_at > ? AND used_count + reserved_count < max_uses;
```

### 8.2 路由与执行回执投影

```sql
CREATE TABLE model_route_receipts (
  receipt_id TEXT PRIMARY KEY,
  requested_provider TEXT,
  selected_provider TEXT NOT NULL,
  selected_model TEXT NOT NULL,
  fallback_chain_json TEXT NOT NULL DEFAULT '[]',
  capability_snapshot_hash TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (receipt_id) REFERENCES receipts(id)
);

CREATE TABLE tool_execution_receipts (
  receipt_id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  authorization_id TEXT,
  idempotency_key TEXT NOT NULL,
  side_effect_class TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  external_ref_json TEXT,
  FOREIGN KEY (receipt_id) REFERENCES receipts(id),
  FOREIGN KEY (authorization_id) REFERENCES authorizations(id),
  UNIQUE(tool_id, idempotency_key)
);
```

### 8.3 累计风险

```sql
CREATE TABLE conversation_action_ledger (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  risk_before TEXT NOT NULL,
  risk_after TEXT NOT NULL,
  factors_json TEXT NOT NULL,
  receipt_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES executions(id),
  UNIQUE(execution_id, sequence_no)
);
```

## 九、v15 Evidence Loop

```sql
CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  run_id TEXT,
  step_id TEXT,
  evidence_type TEXT NOT NULL,
  evidence_level INTEGER NOT NULL CHECK (evidence_level BETWEEN 0 AND 5),
  content_hash TEXT NOT NULL,
  content_ref_json TEXT,
  location TEXT,
  observed_at TEXT NOT NULL,
  freshness_json TEXT,
  producer_json TEXT NOT NULL,
  verified_by_json TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (execution_id) REFERENCES executions(id)
);
CREATE INDEX idx_evidence_execution_type
  ON evidence(execution_id, evidence_type, observed_at);

CREATE TABLE evidence_links (
  evidence_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (evidence_id, target_type, target_id, relation),
  FOREIGN KEY (evidence_id) REFERENCES evidence(id)
);
```

```sql
CREATE TABLE cycle_plans (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  cycle_number INTEGER NOT NULL CHECK (cycle_number >= 1),
  objective TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  expected_evidence_json TEXT NOT NULL,
  planned_actions_json TEXT NOT NULL,
  selected_strategy TEXT NOT NULL,
  policy_bundle_hash TEXT NOT NULL,
  skill_bundle_hash TEXT NOT NULL,
  context_manifest_hash TEXT NOT NULL,
  budget_slice_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, cycle_number)
);

CREATE TABLE cycle_receipts (
  id TEXT PRIMARY KEY,
  cycle_plan_id TEXT NOT NULL,
  evidence_delta_json TEXT NOT NULL,
  deviation_type TEXT,
  strategy_decision TEXT NOT NULL,
  next_strategy TEXT,
  gate_receipt_ids_json TEXT NOT NULL DEFAULT '[]',
  token_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (cycle_plan_id) REFERENCES cycle_plans(id)
);

CREATE TABLE strategy_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  cycle_plan_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  action_fingerprint TEXT NOT NULL,
  result_fingerprint TEXT NOT NULL,
  evidence_delta_score REAL NOT NULL,
  failure_type TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (cycle_plan_id) REFERENCES cycle_plans(id)
);
CREATE INDEX idx_strategy_attempt_fingerprint
  ON strategy_attempts(run_id, action_fingerprint, result_fingerprint);
```

## 十、v16 Delivery 与 Outcome

```sql
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  delivery_type TEXT NOT NULL,
  primary_delivery INTEGER NOT NULL DEFAULT 0 CHECK (primary_delivery IN (0,1)),
  contract_schema TEXT NOT NULL,
  contract_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PLANNED','RUNNING','SUCCEEDED','PARTIAL','FAILED','CANCELLED')),
  target_ref_json TEXT,
  artifact_ref_json TEXT,
  content_hash TEXT,
  started_at TEXT,
  finished_at TEXT,
  FOREIGN KEY (execution_id) REFERENCES executions(id)
);
CREATE UNIQUE INDEX idx_delivery_primary
  ON deliveries(execution_id) WHERE primary_delivery = 1;

CREATE TABLE delivery_receipts (
  delivery_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  PRIMARY KEY (delivery_id, receipt_id),
  FOREIGN KEY (delivery_id) REFERENCES deliveries(id),
  FOREIGN KEY (receipt_id) REFERENCES receipts(id)
);
```

```sql
CREATE TABLE outcomes (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE,
  schema_id TEXT NOT NULL,
  execution_status TEXT NOT NULL,
  delivery_status TEXT NOT NULL,
  adoption_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  business_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  learning_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  observed_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES executions(id)
);

CREATE TABLE outcome_evidence (
  outcome_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (outcome_id, evidence_id, relation),
  FOREIGN KEY (outcome_id) REFERENCES outcomes(id),
  FOREIGN KEY (evidence_id) REFERENCES evidence(id)
);

CREATE TABLE outcome_attribution (
  id TEXT PRIMARY KEY,
  outcome_id TEXT NOT NULL,
  contributor_type TEXT NOT NULL,
  contributor_id TEXT NOT NULL,
  method TEXT NOT NULL,
  weight REAL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (outcome_id) REFERENCES outcomes(id)
);

CREATE TABLE outcome_observations (
  id TEXT PRIMARY KEY,
  outcome_id TEXT NOT NULL,
  source_ref_json TEXT NOT NULL,
  observation_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  FOREIGN KEY (outcome_id) REFERENCES outcomes(id)
);
```

## 十一、v17 Memory Write

```sql
CREATE TABLE memory_write_decisions (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  candidate_type TEXT NOT NULL,
  source_claim_ids_json TEXT NOT NULL,
  source_receipt_ids_json TEXT NOT NULL,
  confirmation_level TEXT NOT NULL,
  sensitivity_class TEXT NOT NULL,
  retention_policy TEXT NOT NULL,
  backend TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('WRITE','SKIP','BLOCK','DEFER')),
  reason_codes_json TEXT NOT NULL,
  decision_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES executions(id)
);

CREATE TABLE memory_transactions (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  expected_revision INTEGER,
  status TEXT NOT NULL CHECK (status IN ('PENDING','COMMITTED','CONFLICT','FAILED','DEFERRED')),
  remote_revision INTEGER,
  receipt_id TEXT,
  conflict_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES executions(id),
  FOREIGN KEY (decision_id) REFERENCES memory_write_decisions(id)
);

CREATE TABLE memory_transaction_operations (
  transaction_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  operation TEXT NOT NULL,
  payload_schema TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  PRIMARY KEY (transaction_id, ordinal),
  FOREIGN KEY (transaction_id) REFERENCES memory_transactions(id)
);
```

## 十二、v18 Evolve 与 Authority

扩展 `evolution_candidates`：

```text
candidate_type
scope_json
source_receipt_ids_json
evaluation_suite_id
baseline_manifest_hash
candidate_manifest_hash
active_revision
rollback_candidate_id
```

新增：

```sql
CREATE TABLE authority_outbox_v2 (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_schema TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','SENDING','SUCCEEDED','FAILED','QUARANTINED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error_code TEXT,
  last_error_text TEXT,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_authority_outbox_ready
  ON authority_outbox_v2(status, next_attempt_at, created_at);

CREATE TABLE memory_protocol_sessions (
  id TEXT PRIMARY KEY,
  endpoint_hash TEXT NOT NULL,
  project_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  feature_set_json TEXT NOT NULL,
  schema_versions_json TEXT NOT NULL,
  grant_hash TEXT NOT NULL,
  compatibility_status TEXT NOT NULL,
  negotiated_at TEXT NOT NULL,
  expires_at TEXT
);
```

## 十三、v19 Backfill 与兼容

### 13.1 Engine v2 Run/Event

- 为每个需要进入新主链的历史 Run 生成 imported Execution；
- `runs.trace_id` 作为 Trace Ref；
- 历史 Event 映射到 `domain_events` 时标记 `payload_schema=awkn-legacy-event/v1`；
- 不回写或重排原 `events.id`；
- 不能推导的 Actor 使用 `system/imported_legacy`。

### 13.2 Legacy Memory

- `memory_entries` 映射为 Claim 或 Experience Candidate；
- 来源不明的记录 `authority <= 0.3`；
- Conversation Summary 写为 `derived`；
- 不自动设置 `confirmation_level=field`；
- 原始 ID 保存为 `externalRef`；
- DLP 不通过的正文进入 Quarantine 清单，不进入 Claim Ledger。

### 13.3 Approvals

- `approvals` 可生成历史 Authorization Receipt；
- 不生成可复用 Authorization Token；
- 缺少 Target Scope 的记录仅用于审计。

### 13.4 Usage 与 Model Calls

- `usage`、`model_calls` 保持原表；
- 新 ModelRouteReceipt 引用历史记录；
- Token/Cost 数据不复制多份，Outcome 和 Receipt 使用 Ref。

### 13.5 兼容视图

可创建只读 View 支持旧诊断命令：

```sql
CREATE VIEW IF NOT EXISTS v_agent_os_runs AS
SELECT r.*, e.id AS execution_id, e.state AS execution_state
FROM runs r
LEFT JOIN executions e ON json_extract(e.run_refs_json, '$[0].id') = r.id;
```

View 只用于查询，不作为写入口。

## 十四、JSON 与校验

SQLite JSON 列写入前 MUST：

1. Zod 校验；
2. Canonicalize；
3. 生成 Hash；
4. 在 Repository 层绑定 Schema；
5. 禁止直接拼接未校验 JSON。

读取时：

- Schema major 未知返回错误；
- Hash 不一致进入 Quarantine；
- Event Replay 遇到损坏 Payload 立即停止；
- 普通诊断查询可跳过损坏行并明确报告。

## 十五、Append-only 与可变投影

Append-only：

- domain_events；
- receipts；
- claim_events；
- claim_confirmations；
- evidence；
- cycle_receipts；
- outcome_observations；
- authority_outbox 历史尝试日志。

可变投影：

- executions；
- claims；
- authorizations；
- deliveries；
- outcomes；
- memory_transactions；
- evolution_candidates。

可变投影必须具备 revision 或受事务状态机保护。

## 十六、测试数据库与 Shadow 隔离

- Unit：内存 SQLite；
- Migration：复制真实 Fixture 数据库；
- Integration：临时文件数据库 + WAL；
- Shadow：同库独立表前缀或独立数据库，正式默认独立数据库；
- Production：禁止 Shadow 写正式外部副作用；
- CI Fixture 覆盖 v1、v7、v10 和损坏迁移中断状态。

## 十七、性能索引与基线

P0 查询：

- Execution by id/trace/state；
- Event by aggregate revision；
- Receipt by execution/type；
- Claim by scope/status/contentHash；
- Context Manifest by execution；
- Authorization by tokenHash/status；
- Evidence by execution/type；
- Outbox ready queue；
- Outcome by execution；
- Candidate by type/status/fingerprint。

WP00 记录当前 P50/P95。新表查询在 10 万 Event、10 万 Receipt、5 万 Claim Fixture 下执行 Explain Plan，禁止关键查询全表扫描。

## 十八、Migration 执行与回滚

### 执行

```text
停止写入
→ 备份数据库
→ 生成 Schema Manifest/Hash
→ expand
→ backfill batch
→ verify
→ 启动 shadow
→ 解除写入
```

Backfill 每批提交并保存 cursor，支持断点恢复。

### 回滚

- Migration 事务未提交：SQLite 自动回滚；
- 已提交但新写路径未启用：恢复备份或停用新表；
- 已产生新数据：优先 forward-fix，禁止覆盖旧库；
- 外部 Memory OS 已写入：通过补偿事务或 Tombstone，不能仅恢复本地文件；
- 破坏性 contract 阶段只允许 WP19 后单独版本执行。

## 十九、验收

1. 空库可从 v1 完整迁移到 v19；
2. v7、v8、v9、v10 Fixture 均可升级；
3. 重复运行不会重复应用 Migration；
4. 中途崩溃能检测未完成迁移；
5. Legacy Memory 不被误升级为 Human Confirmed；
6. Event 与 Projection 在同一事务保持一致；
7. Authorization 并发使用不超额；
8. Shadow 数据不污染正式外部状态；
9. 关键查询索引与性能报告完成；
10. 备份恢复、Forward Fix 和 Memory OS 补偿均有演练证据。