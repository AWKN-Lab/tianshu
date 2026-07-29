# REMAINING-RISKS

## 一、本仓库缺口

### 1. Goal Judge 主链

`AgentLoop.runL2` 仍可由 `model` 写入 `achieved`。修复需要以下输入桥：

- Legacy Goal -> GoalSpec v3；
- Quality Gate -> Acceptance Evaluation；
- Artifact Bundle -> Evidence Source Binding；
- Delivery Receipt -> Delivery Precondition；
- Budget/Policy/Constraint -> Judge Input；
- Judge Receipt -> Goal State Transition。

验收：删除所有非 Judge 的 `state='achieved'` 写入口；合同测试扫描调用者；L2 成功测试必须提供完整 Judge Receipt。

### 2. C07-C09 主链

Delivery、Outcome、Memory Write、Evolve v2 有独立实现，`AgentLoop` 尚未调用。需要由 `ExecutionCoordinator` 统一编排，并把每段 Receipt Ref 写入 `ExecutionEnvelope`。

验收：一次隔离运行可查询 Input、Intent、Context、Policy、Skill、Cycle、Delivery、Outcome、Memory Write、Evolution Candidate 的完整引用链。

### 3. Skill 生效

需要持久化 Skill Registry、真实 preflight、Outcome 历史聚合、Replay gate、ACTIVE 单活、Bundle hash 绑定与下一轮加载。

验收：候选 Skill 经 replay 和审批激活后，新 run 的 `CompiledSkillBundle` 必须含该精确版本；quarantine 后的新 run 必须排除该版本。

### 4. Policy 生效

需要把 ACTIVE Policy Registry 接到 Intent/Goal/Context 编译阶段，并把 Policy Bundle hash 写入 CyclePlan 和 Run Receipt。

### 5. TRAE bridge

剩余风险：

- 默认目录依赖 CWD；
- request 文件非原子写；
- 多 daemon 无 claim/lock；
- `isAvailable()` 固定 true；
- provider 初始化失败的日志与行为不一致；
- error response 未完整回传给调用方；
- 凭据与工作区边界没有宿主级验证。

### 6. 测试与静态检查

当前主线把 `lint` 映射为 Architecture Scan。代码风格、未使用变量、危险 Promise、复杂度和 import 规则仍需独立工具。verify 发现机制当前只扫描 `runtime/test` 根目录。

## 二、Memory OS 对端缺口

需要对端仓库或服务提供：

- Protocol Descriptor；
- Project Grant endpoint 与 grantHash；
- Context Receipt/Render 的 Grant 绑定；
- Observe/Consume 的权限与幂等语义；
- Transaction CAS；
- Tombstone；
- Authority Rule 生命周期；
- Outcome Attribution；
- Truth Diagnostics；
- 兼容版本矩阵；
- 双仓 fixture 与真实 service smoke。

本次补丁只修复天枢读路径的降级规则。Authority Outbox Processor 仍会在内部把发送失败计数化，调用方可能看不到授权失败的结构化错误；该路径需要独立收紧。

## 三、真实 TRAE/Codex IDE 验证缺口

每个宿主至少执行以下场景：

1. 从两个不同 CWD 启动 IDE、CLI 和 daemon，确认共享绝对桥目录。
2. 正常请求、超时、daemon 崩溃、重启恢复。
3. 两个 daemon 竞争同一 request，确保只执行一次。
4. Provider 初始化失败，调用方收到原始诊断。
5. Shadow 路径不产生外部副作用。
6. 工作区切换后，凭据和消息不跨项目泄漏。
7. Codex IDE 宿主路径与 Codex-compatible HTTP Provider 分开记录证据。

## 四、生产验证缺口

以下结论不能由单元测试或 fake server替代：

- 外部连接器实际交付成功；
- 收件人收到邮件或消息；
- 用户下载或采用生成文件；
- Memory OS 对端持久化、消费和回放成功；
- 进程崩溃后的 Outbox 恢复；
- 多进程并发与文件锁；
- 长时间运行的预算、暂停、恢复和回滚；
- ACTIVE Policy/Skill 对后续运行的稳定影响。

建议先在 Shadow 模式执行固定场景集，归档请求、Receipt、数据库快照、对端日志和 artifact hash。通过后按组件进入 Enforce。

## 五、双仓验收计划

### 阶段 A：合同冻结

- 双仓共享 protocol fixture；
- 版本、feature、schema、Grant 字段冻结；
- 401/403/412/426/5xx/timeout 行为矩阵冻结。

### 阶段 B：本地双进程 smoke

- 启动真实 Memory OS 服务进程；
- 天枢通过 HTTP 完成 negotiate、Grant、assemble、render、observe、consume、capture；
- 禁止 mock transport。

### 阶段 C：故障注入

- 401、403、Grant missing、protocol incompatible、schema incompatible、503、timeout；
- 核对 fail-closed、stale fallback、Outbox 和 UNKNOWN 状态。

### 阶段 D：恢复与幂等

- 重放相同 idempotency key；
- CAS 冲突；
- daemon 与服务进程重启；
- Tombstone 后查询和回放。

### 阶段 E：主链 Shadow

- Engine v2 保持默认；
- 新组件只生成 Receipt 和 Diff；
- 0 Safety Regression 后逐组件进入 Enforce。
