# 测试矩阵与 Release Runbook

> 文档编号：TS-AOS-TEST-017  
> 版本：v1.0 Draft  
> 关联：PR #25、Issue #32、WP-AOS-18/19  
> 目标：建立“验收标准 → 测试 ID → 机器证据 → Release Gate”闭环

## 一、测试原则

1. 文档完成不能替代机器验证；
2. 每个 P0/P1 验收标准必须绑定测试 ID；
3. 契约、状态机、Migration、Replay、权限和外部副作用使用确定性测试；
4. LLM Judge 只能作为一个 Gate，不能代替确定性 Gate；
5. Shadow 差异、性能和安全回归具有发布阻断阈值；
6. Linux 与 Windows 同等属于发布平台；
7. AWKN Memory OS 使用独立仓测试和协议 Smoke；
8. 其他 AWKN 业务仓库不得成为测试运行依赖。

## 二、测试 ID

格式：

```text
AOS-<LEVEL>-<DOMAIN>-<NNN>
```

Level：

```text
UT   Unit
CT   Contract
IT   Integration
RP   Replay
GD   Golden
CH   Chaos
SC   Security
PF   Performance
IN   Independence
RL   Release
```

示例：

```text
AOS-CT-HASH-001
AOS-SC-AUTH-004
AOS-RP-EVENT-003
AOS-RL-RC-001
```

## 三、目录

```text
runtime/test/
├── unit/
├── contract/
├── integration/
├── replay/
├── golden/
├── chaos/
├── security/
├── performance/
├── independence/
├── fixtures/
│   ├── contracts/
│   ├── databases/
│   ├── executions/
│   ├── memory-protocol/
│   └── shadow/
└── release/
```

## 四、WP 测试矩阵

| WP | 核心测试 | Test ID 前缀 | 发布证据 |
|---|---|---|---|
| 00 Baseline | clean install、现有 check、能力快照、性能 | `AOS-RL-BASE` | baseline-manifest.json |
| 01 Contracts | Zod、Canonical JSON、Hash、Fixture | `AOS-CT-CONTRACT` | contract-report.json |
| 02 Input | DLP、身份、文件、注入、Receipt | `AOS-SC-INPUT` | input-security-report.json |
| 03 Intent/Goal | L0—L4、澄清、Loop Eligibility、Goal Judge 输入 | `AOS-GD-INTENT` | routing-golden.json |
| 04 Claim | 来源、派生、确认、冲突、误归因 | `AOS-CT-CLAIM` | claim-lineage-report.json |
| 05 Context | Utility、Freshness、Token、权限、健康空结果 | `AOS-IT-CONTEXT` | context-shadow.json |
| 06 Policy | 优先级、冲突、Bundle Hash、冻结 | `AOS-CT-POLICY` | policy-compile-report.json |
| 07 Skill | Preflight、依赖图、Gate、恢复 | `AOS-CT-SKILL` | skill-compile-report.json |
| 08 Model Broker | 路由、fallback、Capability、Reviewer 独立性 | `AOS-IT-MODEL` | model-route-report.json |
| 09 Tool Broker | 授权、幂等、副作用验证、补偿 | `AOS-SC-TOOL` | tool-auth-report.json |
| 10 Risk | 多步累计、恢复连续性、授权升级 | `AOS-UT-RISK` | cumulative-risk.json |
| 11 Loop | Expected Evidence、Delta、Strategy、No-Gain | `AOS-RP-LOOP` | loop-replay-report.json |
| 12 Delivery | Chat/File/Connector/Schedule、Partial | `AOS-IT-DELIVERY` | delivery-report.json |
| 13 Outcome | 五层结果、UNKNOWN、后续观测、归因 | `AOS-CT-OUTCOME` | outcome-report.json |
| 14 Memory Gate | 来源、确认、敏感、Retention、Skip/Block | `AOS-SC-MEMGATE` | memory-gate-report.json |
| 15 Memory Tx | CAS、幂等、Tombstone、Outbox | `AOS-IT-MEMTX` | memory-tx-report.json |
| 16 Evolve | 指纹、回放、单活、隔离、回滚 | `AOS-RP-EVOLVE` | evolve-report.json |
| 17 Memory Protocol | 协商、Grant、错误、双仓 Fixture | `AOS-CT-MEMPROTO` | protocol-smoke.json |
| 18 Observability | Trace、Receipt、Metric、Hash、脱敏 | `AOS-CT-OBS` | observability-report.json |
| 19 RC | 全矩阵、回滚、Manifest、Artifact Hash | `AOS-RL-RC` | release-evidence/ |

## 五、Core Contract 测试

### 5.1 Canonical JSON

必须覆盖：

- Object 字段不同顺序得到相同 Hash；
- Unicode NFC；
- CRLF/LF text 字段；
- `-0 → 0`；
- null 与 omitted 差异；
- Array 保序；
- Set 语义字段先排序；
- NaN/Infinity/BigInt 拒绝；
- 缺时区时间拒绝；
- Windows/Linux 产生相同 bytes。

P0：`AOS-CT-HASH-001` 至 `AOS-CT-HASH-012`。

### 5.2 Schema

- 未知 major 拒绝；
- 未知字段 strict reject；
- 非法枚举拒绝；
- v2 → v3 Claim 映射；
- Receipt Payload Schema 与 Envelope；
- Event aggregate revision；
- Authorization Token 作用域。

## 六、状态机测试

每个状态机由转换矩阵自动生成：

```text
合法 from/to
非法 from/to
expectedRevision 冲突
重复 idempotencyKey
Required Receipt 缺失
Actor/Policy 不允许
事务中断
Replay 后 Projection Hash
```

P0 用例：

- `DELIVERED → RUNNING` 拒绝；
- `PARTIAL` 不自动升级；
- Goal 只有 GoalJudge 可 Achieved；
- Authorization 撤销后调用阻断；
- Tool 成功、验证失败进入 uncertain/compensation；
- Memory Conflict 不覆盖式重试。

## 七、Engine v2 回归

冻结 WP00 时记录现有：

- `npm ci`；
- `npm run check`；
- `runL1()` 代表任务；
- `runL2()` Gate 循环；
- Provider 路由和 fallback；
- Tool Registry；
- Goal/Checkpoint；
- EventStore；
- Memory local/auto；
- Evolve Replay。

每个新组件 enforce 前必须运行 Engine v2 回归。Legacy 行为差异必须出现在 Shadow Diff，不允许静默变化。

## 八、Agent OS Golden Case

首批 Golden Case：

| ID | 任务 | 关键验收 |
|---|---|---|
| ENG-01 | 修复 TypeScript 编译错误 | typecheck/test/lint、文件 diff、无回归 |
| ENG-02 | 增加 SQLite Migration | 空库/旧库升级、重复运行、回滚证据 |
| REPO-01 | 审查 PR | 只读、不产生写入、引用具体文件 |
| DOC-01 | 生成工程文档 | 文件存在、目录链接、术语一致 |
| TOOL-01 | 创建外部记录 | 授权、幂等、Side-effect Verification |
| TOOL-02 | 外部调用超时 | 查询远端状态、禁止盲重试 |
| MEM-01 | 用户明确长期决定 | 正确写入、来源和确认字段 |
| MEM-02 | Assistant 建议 | 不写为用户决定 |
| CONTEXT-01 | Memory OS 健康空结果 | Receipt 有效、无 Render、stale=false |
| CONTEXT-02 | Memory OS 5xx | auto 可 stale fallback |
| AUTH-01 | 401/403 | 禁止本地降级规避 |
| LOOP-01 | 连续无增量 | Strategy Switch 后停止 |
| DELIVERY-01 | 用户要求文件 | 实际 File Delivery，不以聊天替代 |
| OUTCOME-01 | 交付完成、采用未知 | Adoption/Business 保持 UNKNOWN |
| EVOLVE-01 | Candidate 回归 | 自动 Quarantine，不进入 ACTIVE |

每个 Golden Case 保存：输入、冻结配置、Expected ExecutionEnvelope、Expected Receipt Set、Expected Event Sequence 和 Artifact Hash。

## 九、Goal Judge 专项

### 9.1 假阳性

- LLM 无 Tool Call，但验收未完成；
- 文件存在但内容 Schema 错误；
- 单元测试通过但 lint 失败；
- Tool 返回 200，但外部状态未变化；
- Delivery 成功，但 Required Constraint 失败；
- Reviewer PASS，但确定性 Gate FAIL；
- Evidence 过期；
- Partial 被错误聚合为 Success。

目标：P0/P1 Golden Case 假阳性为 0。

### 9.2 假阴性

- 验收全部完成但文本总结缺失；
- 健康空 Context 被判失败；
- 根因确认形成有效 Evidence Delta；
- Required Evidence 来自等价工具；
- Outcome 允许 UNKNOWN 时未获得后续数据。

Goal Judge 结果必须可解释，保存每条 Acceptance/Constraint 的 Evaluator 版本和 Evidence Ref。

## 十、Provider 与 Model Broker

覆盖：

- 显式 Provider；
- 默认 Provider；
- callSource 路由；
- Provider 不可用；
- 5xx/Transport fallback；
- `fallbackPolicy=none`；
- fallback 后能力下降；
- 请求模型与实际模型不一致；
- Reviewer 与执行模型独立；
- 使用量写入失败不掩盖模型结果；
- Route Receipt 内容与 Trace 一致。

安全规则：如果 fallback 无法满足 Required Capability，返回 `CAPABILITY_GAP`，不能为了继续而使用不合格模型。

## 十一、Tool、Authorization 与副作用

必须覆盖：

1. 无授权外部写入阻断；
2. Token Scope 不符；
3. Token 过期、撤销、耗尽；
4. 并发预占不超 maxUses；
5. 相同幂等键只执行一次；
6. 超时且远端状态未知；
7. 部分成功；
8. 可补偿动作；
9. 补偿失败；
10. Shadow DryRun 无副作用；
11. 多步累计风险升级；
12. L3/L4 恢复后风险连续。

测试使用 Fake External System，记录每次调用和幂等键。CI 禁止访问生产端点。

## 十二、Context 与 Memory

### Context

- 候选权限过滤；
- Project Scope；
- Freshness；
- Utility 排序；
- Token 裁剪；
- Sensitive Item；
- Source Span；
- 健康空 Context；
- Immutable Render Hash；
- Receipt/Render 对应；
- Shadow 与旧 Memory Enrichment 差异。

### Memory Write Gate

- 用户明确决定可写；
- 简单“好”只确认方向；
- Assistant 生成内容不能写成用户陈述；
- 外部搜索结果不自动写用户记忆；
- 临时状态不进入长期记忆；
- 敏感数据阻断；
- Tombstone 和依赖传播；
- 同一 Interaction 不重复写入。

## 十三、Migration 测试

数据库 Fixture：

```text
empty-v0.db
schema-v1.db
schema-v7.db
schema-v8.db
schema-v9.db
schema-v10.db
migration-interrupted.db
corrupted-json.db
legacy-memory-mixed.db
```

每个 Fixture 执行：

```text
backup
→ migrate to latest
→ verify schema
→ verify row counts
→ verify backfill
→ rerun migration
→ open Engine v2 read path
→ replay
```

必须测试：

- v10 → v19；
- Migration 中断；
- 磁盘空间不足模拟；
- Constraint 失败；
- WAL/lock；
- Windows 文件占用；
- 恢复备份；
- 新数据产生后的 forward-fix。

## 十四、Replay

Replay 输入：Event、Receipt、Artifact Ref、Frozen Bundle、Capability Snapshot。

验证：

- Projection Hash 相同；
- GoalJudgement 相同；
- Policy/Skill Bundle Hash 相同；
- 不重新执行外部副作用；
- 未知 Event major 停止；
- 损坏 Payload 进入 Quarantine；
- L3/L4 恢复使用原 Flag Snapshot。

## 十五、Chaos

| 场景 | 预期 |
|---|---|
| Provider 5xx | 合法 fallback 或 Capability Gap |
| Provider 全部失败 | Run Failed/Pause，有 Receipt |
| Tool Timeout | Side-effect Unknown，先查询 |
| SQLite busy | 有界重试，不重复副作用 |
| Receipt 写入失败 | 关键状态不提交 |
| Memory OS 5xx | auto stale fallback |
| Memory OS 401/403 | Block，不降级 |
| Outbox 损坏 | Quarantine |
| Outbox 积压 | 本地/远端状态分开显示 |
| 进程在外部调用后崩溃 | Recovery 查询远端 |
| 网络恢复 | 幂等重放成功 |
| 同一错误重复 | Strategy Switch / No-Gain Stop |

## 十六、安全测试

- Prompt Injection 外部文档不可注册 ACTIVE Policy；
- Secret 不进入 Trace/Receipt/Event；
- 跨 Project Claim 被拒绝；
- Authorization Token 正文不持久化；
- 路径穿越；
- Tool 参数 Schema 绕过；
- 外部数据伪装 System Instruction；
- User Claim/Assistant Claim 误归因；
- Memory Delete 越权；
- Feature Flag 未授权 Override；
- 401/403 降级绕过；
- Shadow 外部写入。

## 十七、Independence Scan

CI 扫描：

```text
package.json / lockfile
TypeScript import
环境变量
HTTP endpoint
Docker/compose
GitHub Actions
Release Manifest
测试 Fixture
```

允许：

- `AWKN-Memory-OS` 可选端点和协议 Fixture；
- GitHub、Drive、Web 等用户授权的通用外部数据源。

禁止：

- GUNDAM、Value、win、Mr.Mont、annie、subtitle 等业务仓运行依赖；
- 其他项目 SDK、Service、数据库或 Feature Flag；
- 测试通过网络调用其他业务项目。

## 十八、性能基线

WP00 记录真实值。P0 默认发布阈值：

| 指标 | 阻断条件 |
|---|---|
| P95 主链延迟 | 相对基线回归 >15%，无批准例外 |
| Token / Verified Evidence | 回归 >20% |
| SQLite Event Append P95 | >20ms 本地基线环境 |
| Receipt Write P95 | >20ms 本地基线环境 |
| Context Planner P95 | >200ms，不含远端网络 |
| Shadow 额外外部调用 | 任何写调用 |
| Replay Projection Mismatch | >0 |
| Memory 重复写入率 | >0 |
| Authorization 越界率 | >0 |

阈值在 WP00 后可以通过评审调整，调整必须写入版本化 Baseline Manifest。

## 十九、CI Pipeline

建议工作流：

```text
01 docs-and-links
02 install-and-static
03 unit
04 contract-and-golden
05 migration-matrix
06 integration
07 replay
08 security
09 independence
10 windows-linux
11 memory-protocol-smoke
12 performance-smoke
13 release-evidence
```

### 19.1 docs-and-links

- Markdown 链接；
- 文档编号和版本；
- Schema ID、Event Name、Error Code 重复和冲突；
- WP 与测试 ID 映射；
- README 导航完整。

### 19.2 install-and-static

```text
npm ci
npm run check
```

如需拆分，仍以 `npm run check` 为总 Gate。

### 19.3 Matrix

```yaml
os: [ubuntu-latest, windows-latest]
node: [20]
```

## 二十、Release Evidence 目录

```text
release-evidence/<version>/
├── release-manifest.json
├── baseline-manifest.json
├── dependency-manifest.json
├── schema-manifest.json
├── migration-report.json
├── contract-report.json
├── golden-report.json
├── replay-report.json
├── shadow-report.json
├── security-report.json
├── independence-report.json
├── performance-report.json
├── memory-protocol-smoke.json
├── windows-report.json
├── linux-report.json
├── sbom-or-dependency-list.json
└── artifact-hashes.txt
```

## 二十一、Release Manifest

```json
{
  "schema": "awkn-release-manifest/v1",
  "version": "agent-os-3.0.0-rc.1",
  "repository": "AWKN-Lab/tianshu",
  "commitSha": "...",
  "nodeVersion": "20.x",
  "schemaVersion": 19,
  "contractBundleHash": "...",
  "featureFlagDefaults": {},
  "memoryProtocol": {},
  "artifacts": [],
  "evidenceRefs": [],
  "previousStableVersion": "...",
  "createdAt": "..."
}
```

Manifest 必须绑定精确 Commit，不允许使用移动 Branch 名作为发布证据。

## 二十二、RC 发布 Runbook

### 22.1 发布前

1. 冻结 PR 和依赖；
2. 确认 Main Commit；
3. 运行完整 CI；
4. 生成数据库备份；
5. 运行 Migration Dry Run；
6. 验证 Feature Flag 默认值；
7. Memory OS 兼容矩阵和 Smoke；
8. 生成 Manifest、依赖清单和 Artifact Hash；
9. 完成 rollback rehearsal；
10. Release Owner 签署 Gate。

### 22.2 发布

```text
部署代码，Flag 默认 0/shadow
→ 应用 additive Migration
→ 启动健康检查
→ 验证 baseline command
→ 开启 shadow
→ 观察差异和性能
→ 分层灰度 enforce
→ 生成发布后 Evidence
```

### 22.3 发布后检查

- Error Rate；
- Shadow Blocking Diff；
- Authorization 拒绝；
- Side-effect Unknown；
- Goal Judge 假阳性样本；
- Outbox 积压；
- Memory 重复写；
- Provider fallback；
- P95/Token；
- Windows/Linux 客户端问题。

## 二十三、回滚 Runbook

触发：

- 安全或权限回归；
- 重复外部副作用；
- Goal 假阳性；
- Replay 不一致；
- Migration 数据损坏；
- Memory OS 权威冲突；
- P0 生产故障。

步骤：

```text
暂停新 Execution
→ Flag enforce 降为 shadow/0
→ 停止外部写路径
→ 标记受影响 Execution
→ 查询 Side-effect 状态
→ 执行补偿/Tombstone
→ 恢复上一稳定代码
→ 按 Schema 兼容决定保留新表或恢复备份
→ 验证 Engine v2 baseline
→ 生成 Incident Receipt
```

禁止：

- 删除本地 Event 掩盖副作用；
- 对状态未知的动作盲重试；
- 用 401/403 降级到 local 绕过；
- 在未确认 Memory OS 写入状态时覆盖本地 revision。

## 二十四、事故处置

事故记录必须包含：

- 时间线；
- Commit/Release Manifest；
- Feature Flag Snapshot；
- 受影响 Execution/Run；
- Event/Receipt/Trace Ref；
- 外部副作用状态；
- 数据库和 Memory OS 状态；
- 临时缓解；
- 根因；
- 修复测试；
- Evolve Candidate 是否创建。

事故产出的规则只能进入 Candidate，需回放评测后生效。

## 二十五、RC Gate

RC 必须全部满足：

- 精确 Commit；
- `npm ci`、`npm run check`；
- Contract/Golden 全绿；
- v1/v7/v10 → v19 Migration；
- Replay 一致；
- Shadow 零容忍项为 0；
- Provider fallback；
- Tool 授权、幂等、补偿；
- Goal Judge 假阳性为 0；
- Memory OS Protocol Smoke；
- Windows/Linux；
- Performance 阈值；
- Independence Scan；
- Release Manifest 与 Artifact Hash；
- 回滚演练。

## 二十六、验收

1. 每个 WP 验收项有测试 ID；
2. 每个测试 ID 有机器报告或明确人工证据；
3. Shadow Diff 格式和阈值冻结；
4. 安全、权限、副作用和 Goal 假阳性使用零容忍阈值；
5. Release 与 Rollback Runbook 可执行；
6. RC 可绑定 Commit、Schema、配置、Protocol 和 Artifact Hash；
7. 当前 PR 只完成测试与发布设计，不宣称代码或 CI 已实现。