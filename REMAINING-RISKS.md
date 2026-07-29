# REMAINING-RISKS

## 1. 本仓库缺口

### 1.1 Goal 权威与成功出口

- `AgentLoop`、`TianhuoCicdLoop`、`PrdCentricLoop` 仍可用 `source='model'` 写入 `achieved`。
- `judgeGoal()` 没有成为所有成功出口的唯一入口。
- 迁移需包含 GoalJudgement receipt、EventStore、恢复、Shadow Diff、旧适配器和所有执行器。
- 在迁移完成前，任何“自主任务成功”都只能按 Engine v2 现有门禁语义解释，不能提升为 Agent OS 3.0 权威闭环结论。

### 1.2 R2 主链

- `ExecutionCoordinator` 当前接通 WP02-WP05。
- Policy/Skill Compiler、Broker、Evidence Loop、Goal Judge、Delivery、Outcome、Memory Write、Evolve 尚未成为 Coordinator 的可达调用边。
- `deliveryRefs`、`memoryDecisionRefs`、`evolutionCandidateRefs` 仍为空。
- 本次未能执行最新 Shadow Integration 脚本。远程 `dd5039e` 声称 GO，计划文档仍混有 NO_GO/GO 两套状态；发布判定需由最新 report artifact 和跨平台复验重新确认。

### 1.3 Skill / Evolve

- Skill registry 为进程内状态，没有稳定恢复。
- manifest 以 skillId 覆盖版本，缺少 `(skillId, version)` 历史链。
- APPROVED→ACTIVE 没有强制执行 `checkActiveConditions()`。
- Compiler 的 preflight 固定通过，compatibility risk 固定为 0。
- 通用 EvolutionCandidate 的 ACTIVE 状态没有自动生成并发布可供下一次 Policy/Skill Compiler 消费的版本化资产。
- rollback 与 quarantine 没有覆盖下一次运行缓存失效和多进程一致性。

### 1.4 测试与 CI

- `npm run lint` 只执行 `tsc --noEmit`。
- `verify-*.ts` 不由标准 runner 发现。
- architecture scan 的 20 个 direct DB import、12 个 module singleton、22 个跨组件 import 和 1 个 legacy exception 仍为债务。
- 本次完整门禁受内部 npm 依赖 404 阻塞，提交后必须在可安装依赖的环境复验。

### 1.5 文件队列

- Bridge request 已改为原子 rename，response 也采用临时文件 rename。
- 多 daemon 之间仍没有 claim/lease；两个进程可能同时处理同一 request。
- MemoryOutbox append/replace 缺少跨进程锁，flush 与 enqueue 并发时可能发生记录覆盖。
- TRAE provider 的 `isAvailable()` 恒真，缺少 daemon heartbeat 或 Hook 存活探测。

## 2. 对端 AWKN Memory OS 缺口

本仓 adapter 已覆盖部分 v1 API；以下 vNext 能力需要独立 Memory OS 仓库提供权威实现：

- Protocol Descriptor 和兼容版本矩阵；
- `GET /api/v1/projects/{projectId}/grant`；
- Grant hash、revision、expiry、allowed operations、memory classes、actor/source scopes；
- Context v2 receipt/render 与 grant hash 绑定；
- CAS persistence transaction；
- idempotency 状态查询与冲突处理；
- Tombstone 与依赖传播；
- Outcome Attribution；
- Rule Authority 的 revision/rollback 语义；
- Diagnostics truth endpoint；
- 服务端 DLP/Persistence Guard；
- 401/403、scope violation、protocol/schema mismatch 的稳定错误合约。

### 2.1 双仓验收计划

1. 冻结两仓 commit SHA、SDK schema hash 和 Golden fixture hash。
2. 启动真实 Memory OS 测试服务，禁用本地 fake server。
3. 取得 `clientId=tianshu` 的最小 Project Grant；不使用生产 token。
4. 验证允许范围内的 assemble/render/consume/observe/transaction。
5. 注入 401、403、grant expiry、grant revision change、scope violation、protocol major mismatch、schema mismatch。
6. 验证上述授权与协议错误均 fail-closed，`auto` 只在 transport/5xx 生成 stale degradation receipt。
7. 注入网络中断、重复 idempotency key、CAS conflict、进程崩溃和 outbox replay。
8. 验证 tombstone、rollback、authority single-active、outcome attribution。
9. 输出两仓命令、日志、receipt ID、hash、通过/失败/跳过数量。

完成该计划后，Memory OS 主题才具备 `REAL_E2E_VERIFIED` 的候选证据。

## 3. 真实 TRAE / Codex IDE 验证缺口

### 3.1 TRAE

需要真实宿主提供：

- Hook 安装和配置来源；
- `pre_llm_call` 输入/输出 schema；
- 宿主启动、重启、升级后的生命周期；
- 文件桥目录由 IDE hook、CLI、daemon 三方共享的绝对路径证明；
- daemon heartbeat/lease；
- 并发请求、超时、错误 response、崩溃恢复；
- 凭据由 daemon/provider 边界持有，request 文件不得携带密钥；
- Shadow 模式无真实外部副作用。

### 3.2 Codex

当前 `CodexProvider` 只证明 OpenAI-compatible API 形态。真实 Codex IDE 验证还需：

- IDE 宿主调用入口；
- hooks.json 的真实加载路径与会话事件；
- 宿主对 tool call、cancel、timeout、resume 的处理；
- IDE 与 API provider 的命名和能力区分；
- 无 API Key 情况下的明确 unavailable 状态。

## 4. 生产验证缺口

- 本次没有部署、发布或生产数据操作。
- 没有真实 Token、Cookie、私钥、验证码或 API Key。
- 没有迁移真实 SQLite/Memory OS 数据。
- 没有验证多实例、容器重启、磁盘满、只读文件系统、时钟漂移、证书过期、限流和长时间运行。
- 没有 Windows + Node 20 的补丁后完整门禁。
- 没有验证 GitHub Actions 对本分支新提交的真实结果。

## 5. 建议的后续顺序

1. 在可安装依赖的 CI 上复验本补丁。
2. 将 Goal Judge 设为所有成功出口的唯一 authority，并保留 Engine v2 默认路径和 Shadow 比较。
3. 把 Evidence Loop 接入 EventStore，完成恢复与副作用去重。
4. 实现 Delivery、Outcome、Memory Write Gate 的最小垂直链。
5. 将 Skill registry 版本化并让 ACTIVE 转换原子执行回放门槛。
6. 接入 ACTIVE Policy/Skill 的下一次编译输入，完成可观察 rollback。
7. 与独立 Memory OS 仓执行双仓验收。
8. 在真实 TRAE/Codex IDE 中执行宿主 E2E。
