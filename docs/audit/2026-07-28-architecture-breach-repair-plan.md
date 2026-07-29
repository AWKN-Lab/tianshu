# AWKN 引擎架构断层修复计划

> 状态：DRAFT_FOR_APPROVAL
> 日期：2026-07-28 (Asia/Shanghai)
> 审计依据：2026-07-28 批判性架构审计（5 断点全部源码确认）
> 仓库：`D:\awkn-lab\awkn引擎\runtime`
> 文档性质：修复计划，需用户确认后方可执行

---

## 1. 断点依赖关系与修复顺序

```
断点 2（假成功路径）      ← 独立，安全止血，最高优先级
断点 4（process.cwd()）   ← 独立，基础设施修复
断点 3（远端静默降级）    ← 依赖断点 4（路径修复后才能可靠测试）
断点 5（Evolve 最后一跳） ← 部分独立，完整闭环依赖断点 1
断点 1（闭环断层）        ← 最大工作量，Delivery/Outcome 实现
```

**修复顺序**：Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5

---

## 2. Phase 1：假成功路径止血（P0）

### 2.1 问题

三个执行入口直接用 `model` 权限将 Goal 标记为 `achieved`，绕过确定性 GoalJudge：

| 入口 | 文件 | 行号 | 代码 |
|---|---|---|---|
| AgentLoop.runL2 | `src/core/agent-loop.ts` | 389 | `goalManager.updateGoal(goalId, { state: 'achieved' }, 'model')` |
| tianhuo-cicd-loop | `src/orchestrator/tianhuo-cicd-loop.ts` | 115 | 同上 |
| prd-centric-loop | `src/orchestrator/prd-centric-loop.ts` | 186 | 同上 |

GoalManager 允许 `model` 权限直接设置 `achieved`（`src/goal/goal-manager.ts:199`）。
确定性 GoalJudge 已存在（`src/goal/application/goal-judge.ts:21`）但未被调用。

### 2.2 修复方案

**方案 A（推荐）：三入口接入 GoalJudge，禁止 model 直接标记 achieved**

1. **修改 GoalManager.updateGoal**（`goal-manager.ts`）：
   - 移除 `'model'` 权限对 `state: 'achieved'` 的写入能力
   - 只允许 `'judge'` 权限写入 `achieved`
   - 保留 `'model'` 权限对 `hao`（验收项）的更新能力

2. **修改三个入口**，替换直接标记为 GoalJudge 调用：
   ```typescript
   // 替换前：
   goalManager.updateGoal(goalId, { state: 'achieved' }, 'model');
   
   // 替换后：
   const judgement = judgeGoal({
     goalId,
     haoResults: goal.hao.map(h => ({ id: h.id, passed: h.passed })),
     gateResults: collectGateResults(),
   });
   if (judgement.verdict === 'ACHIEVED') {
     goalManager.updateGoal(goalId, { state: 'achieved' }, 'judge');
   }
   ```

3. **新增负向测试**：验证 model 权限无法直接标记 achieved

**方案 B（保守）：保留 model 标记但增加 Judge 审计**

- model 仍可标记 achieved，但必须附带 GoalJudge 结果
- 如果 GoalJudge verdict 不是 ACHIEVED，记录 WARNING 但不阻断

**推荐**：方案 A。安全优先，假成功路径必须彻底关闭。

### 2.3 验收标准

- [ ] `model` 权限无法将 Goal 标记为 `achieved`
- [ ] 三个入口调用 `judgeGoal()` 并基于 verdict 决策
- [ ] 负向测试：model 直接标记 achieved 抛出 `PermissionError`
- [ ] 现有测试中固化旧行为的脚本已更新

---

## 3. Phase 2：process.cwd() 路径绝对化（P1）

### 3.1 问题

多个关键路径依赖 `process.cwd()`，跨 IDE/CLI/daemon 进程存在路径分裂：

| 文件 | 行号 | 默认路径 |
|---|---|---|
| `src/memory/outbox.ts` | 33 | `resolve(process.cwd(), 'data', 'memory-os-outbox.jsonl')` |
| `src/llm/providers/trae.ts` | 11 | `resolve(process.cwd(), 'runtime', 'data', 'llm-bridge')` |
| `src/core/agent-loop.ts` | 46 | `cwd: process.cwd()` |
| `src/cli.ts` | 296,309,550,572,651 | 多处 `process.cwd()` |
| `src/evolve/operational-evolution.ts` | 181 | `this.options.cwd ?? process.cwd()` |

### 3.2 修复方案

**方案 A（推荐）：引入 WorkspaceResolver 统一解析工作区根目录**

1. **新增 `src/core/workspace-resolver.ts`**：
   ```typescript
   export class WorkspaceResolver {
     private static root: string | null = null;
     
     static setRoot(path: string): void {
       this.root = resolve(path);
     }
     
     static getRoot(): string {
       if (this.root) return this.root;
       // 回退：从 AWKN_WORKSPACE_ROOT 环境变量获取
       const envRoot = process.env.AWKN_WORKSPACE_ROOT;
       if (envRoot) return this.root = resolve(envRoot);
       // 最终回退：process.cwd()（但记录警告）
       console.warn('[AWKN] WorkspaceResolver falling back to process.cwd()');
       return process.cwd();
     }
     
     static resolve(...segments: string[]): string {
       return resolve(this.getRoot(), ...segments);
     }
   }
   ```

2. **修改所有 `process.cwd()` 调用点**：
   - `outbox.ts`：`WorkspaceResolver.resolve('data', 'memory-os-outbox.jsonl')`
   - `trae.ts`：`WorkspaceResolver.resolve('runtime', 'data', 'llm-bridge')`
   - `agent-loop.ts`：`WorkspaceResolver.getRoot()`
   - `cli.ts`：启动时调用 `WorkspaceResolver.setRoot()`

3. **IDE hook 启动时注入**：
   - 在 IDE hook 初始化时设置 `AWKN_WORKSPACE_ROOT` 环境变量
   - 或调用 `WorkspaceResolver.setRoot()` 显式注入

**方案 B（最小改动）：强制要求环境变量**

- 所有路径必须从环境变量获取，不提供 `process.cwd()` 回退
- 缺少环境变量时抛出 `WorkspaceNotConfiguredError`

**推荐**：方案 A。保留回退能力但发出警告，避免破坏现有流程。

### 3.3 验收标准

- [ ] 所有 `process.cwd()` 调用点替换为 `WorkspaceResolver`
- [ ] IDE hook 启动时注入 `AWKN_WORKSPACE_ROOT`
- [ ] 跨进程路径一致性测试通过（CLI/daemon/hook 使用同一 outbox 文件）
- [ ] 缺少环境变量时发出明确警告

---

## 4. Phase 3：远端降级分类与 fail-closed（P0）

### 4.1 问题

`src/memory/router.ts:82-93` 的 `compileAndRender` 方法用单个 catch 吞掉所有远端错误：

```typescript
try {
  return await this.remote.compileContext(input);
} catch {  // ← 401/403/Grant缺失/协议缺失/网络错误全部被吞
  const fallback = await this.local.compileContext(input);
  return { ...fallback, stale: true };
}
```

`flushAuthorityOutbox(5).catch(() => ...)` 也静默吞掉错误。

### 4.2 修复方案

**方案 A（推荐）：错误分类 + fail-closed 策略**

1. **定义远端错误类型**（`src/memory/remote-errors.ts`）：
   ```typescript
   export type RemoteErrorType =
     | 'AUTH_FAILURE'        // 401/403
     | 'GRANT_MISSING'       // 权限不足
     | 'PROTOCOL_MISSING'    // 协议特性缺失
     | 'NETWORK_ERROR'       // 连接超时/拒绝
     | 'SERVER_ERROR'        // 5xx
     | 'UNKNOWN';            // 其他
   
   export class RemoteMemoryError extends Error {
     constructor(public type: RemoteErrorType, message: string, public statusCode?: number) {
       super(message);
     }
   }
   ```

2. **修改 `AwknMemoryOsBackend.compileContext`**，抛出分类错误而非通用 Error

3. **修改 `MemoryBackendRouter.compileAndRender`**：
   ```typescript
   try {
     return await this.remote.compileContext(input);
   } catch (error) {
     if (error instanceof RemoteMemoryError) {
       // AUTH_FAILURE 和 GRANT_MISSING 不可降级
       if (error.type === 'AUTH_FAILURE' || error.type === 'GRANT_MISSING') {
         throw error;  // fail-closed
       }
       // PROTOCOL_MISSING 不可降级（版本不兼容可能导致数据损坏）
       if (error.type === 'PROTOCOL_MISSING') {
         throw error;  // fail-closed
       }
       // NETWORK_ERROR 和 SERVER_ERROR 可降级
       const fallback = await this.local.compileContext(input);
       return { 
         ...fallback, 
         stale: true,
         staleReason: error.type,  // ← 记录降级原因
         staleAt: new Date().toISOString(),
       };
     }
     throw error;  // 未知错误 fail-closed
   }
   ```

4. **修改 `flushAuthorityOutbox` 调用**，不再用 `.catch()` 吞错：
   ```typescript
   // 替换前：
   await this.flushAuthorityOutbox(5).catch(() => ({ delivered: 0, failed: 1, pending: 0 }));
   
   // 替换后：
   try {
     await this.flushAuthorityOutbox(5);
   } catch (error) {
     // 记录但继续执行（outbox 有重试机制）
     log.warn('authority outbox flush failed', { error });
   }
   ```

**方案 B（保守）：只标记 staleReason，不 fail-closed**

- 所有错误都可降级，但必须记录 `staleReason`
- 调用方可检查 `staleReason` 决定是否继续

**推荐**：方案 A。认证/权限/协议错误 fail-closed 是安全底线。

### 4.3 验收标准

- [ ] 401/403 错误抛出 `RemoteMemoryError(AUTH_FAILURE)`，不降级
- [ ] Grant 缺失抛出 `RemoteMemoryError(GRANT_MISSING)`，不降级
- [ ] 协议缺失抛出 `RemoteMemoryError(PROTOCOL_MISSING)`，不降级
- [ ] 网络错误降级到本地，但标记 `staleReason: 'NETWORK_ERROR'`
- [ ] `flushAuthorityOutbox` 不再用 `.catch()` 吞错
- [ ] 负向测试：AUTH_FAILURE 场景验证 fail-closed

---

## 5. Phase 4：Evolve 最后一跳——消费端实现（P1）

### 5.1 问题

ACTIVE candidate 发布为 `engineering_experience` 记忆（`lifecycle.ts:217-222`），但：
- 发布失败被静默吞掉（`catch { /* optional projection */ }`）
- 没有任何执行入口读取 `engineering_experience` 并重编译 Policy/Skill
- "下一次运行自动生效"的最后一跳断开

### 5.2 修复方案

**方案 A（推荐）：实现 PolicyReloader，在 AgentLoop 启动时加载 ACTIVE candidate**

1. **新增 `src/evolve/policy-reloader.ts`**：
   ```typescript
   export class PolicyReloader {
     constructor(
       private readonly memoryService: MemoryService,
       private readonly lifecycle: EvolutionLifecycle,
     ) {}
     
     /**
      * 在 AgentLoop 启动时调用。
      * 读取所有 ACTIVE candidate 的 engineering_experience 记忆，
      * 重编译 Policy/Skill 并注入当前执行环境。
      */
     async reloadActivePolicies(): Promise<ReloadResult> {
       const activeCandidates = this.lifecycle.listActiveCandidates();
       const policies: CompiledPolicy[] = [];
       
       for (const candidate of activeCandidates) {
         const memory = this.memoryService.getLatest(
           'engineering_experience', projectId(), candidate.experience_id
         );
         if (!memory) {
           // 记忆丢失，candidate 需要标记为 QUARANTINED
           this.lifecycle.transition(candidate.id, 'QUARANTINED', 'memory_lost');
           continue;
         }
         const compiled = this.compilePolicy(memory.content, memory.metadata);
         policies.push(compiled);
       }
       
       return { count: policies.length, policies };
     }
     
     private compilePolicy(content: string, metadata: unknown): CompiledPolicy {
       // 解析 candidate content，编译为可执行 Policy
     }
   }
   ```

2. **修改 AgentLoop 启动流程**（`agent-loop.ts`）：
   ```typescript
   // 在 runL1/runL2 启动时调用
   const reloader = new PolicyReloader(getMemoryService(), evolutionLifecycle);
   const { count, policies } = await reloader.reloadActivePolicies();
   this.policyRegistry.inject(policies);
   ```

3. **修改 `publishEngineeringMemory`**，不再静默吞错：
   ```typescript
   private publishEngineeringMemory(candidate: EvolutionCandidate, action: 'activate' | 'rollback'): void {
     try {
       getMemoryService().put({ ... });
     } catch (error) {
       // 发布失败是严重问题，不能静默
       throw new Error(
         `Failed to publish engineering memory for candidate ${candidate.id}: ${error}`
       );
     }
   }
   ```

**方案 B（保守）：只在 CLI `awkn evolve apply` 时手动加载**

- 不自动加载，需要用户手动执行 `awkn evolve apply`
- 优点：可控；缺点：不自动

**推荐**：方案 A。自动生效是自进化的核心价值，手动应用不算"自进化"。

### 5.3 验收标准

- [ ] `PolicyReloader` 实现并接入 AgentLoop 启动流程
- [ ] ACTIVE candidate 的 engineering_experience 记忆被读取并编译
- [ ] `publishEngineeringMemory` 失败时抛出错误，不静默吞掉
- [ ] 记忆丢失的 candidate 被标记为 QUARANTINED
- [ ] E2E 测试：activate candidate → 重启 AgentLoop → Policy 生效

---

## 6. Phase 5：Delivery/Outcome 实现——主链闭环（P0）

### 6.1 问题

ExecutionCoordinator 只编排 Input/Intent/Context/Claim，返回内存 ExecutionHandle。`delivery/` 和 `outcome/` 目录不存在。执行结果不持久化，进程退出即丢失。

### 6.2 修复方案

**方案 A（推荐）：按 Agent OS 3.0 设计文档实现最小可用 Delivery/Outcome**

1. **实现 `src/delivery/` 目录**（WP-AOS-12）：
   - `delivery/contracts.ts`：DeliveryBundle、DeliveryReceipt schema
   - `delivery/router.ts`：根据 `deliveryExpectation` 路由到 CLI/File/Connector/Schedule
   - `delivery/receipt-builder.ts`：构建交付回执

2. **实现 `src/outcome/` 目录**（WP-AOS-13）：
   - `outcome/recorder.ts`：记录五层结果（technical/goal/user/business/time）
   - `outcome/attribution.ts`：归因到 evidence 和 delivery
   - `outcome/observation.ts`：后续观测追加

3. **修改 ExecutionCoordinator**，在 Context Assembly 后调用 Delivery：
   ```typescript
   createExecution(request: CreateExecutionRequest): ExecutionHandle {
     // ... 现有 Step 1-4 (Input/Intent/Context/Claim) ...
     
     // Step 5: Delivery（根据 flag 值决定是否执行）
     if (flagSnapshot.get('delivery') === 'enforce') {
       const deliveryBundle = this.deps.ports.deliveryRouter.route({
         executionId,
         intent: routedIntent,
         deliveryExpectation: request.deliveryExpectation,
       });
       envelope.deliveryRefs = [deliveryBundle.id];
     }
     
     // Step 6: Outcome（始终记录，即使 delivery 未执行）
     const outcomeRecord = this.deps.ports.outcomeRecorder.record({
       executionId,
       deliveryRefs: envelope.deliveryRefs,
       technicalVerification: 'NOT_RUN',  // 初始状态
     });
     envelope.outcomeRef = outcomeRecord.id;
     
     return { envelope, flagSnapshot, inputReceipt };
   }
   ```

4. **持久化 ExecutionHandle**：
   - 在 ExecutionCoordinator 返回后，由调用方写入 EventStore
   - 或在 Coordinator 内部增加 `persistExecution()` 方法

5. **接入 AgentLoop**，在执行完成后更新 Outcome：
   ```typescript
   // AgentLoop 执行完成后
   outcomeRecorder.update(executionId, {
     technicalVerification: gateResults.allPassed ? 'PASSED' : 'FAILED',
     goalConformance: judgement.verdict === 'ACHIEVED' ? 'CONFIRMED' : 'VIOLATED',
   });
   ```

**方案 B（最小改动）：只实现 Outcome 记录，Delivery 延后**

- 只实现 outcome/recorder.ts，记录执行结果
- Delivery 延后到 WP-AOS-12 完整实现

**推荐**：方案 B 作为 Phase 5a（先止血），方案 A 作为 Phase 5b（完整闭环）。先确保执行结果被记录，再实现交付机制。

### 6.3 验收标准

**Phase 5a（Outcome 最小实现）**：
- [ ] `outcome/recorder.ts` 实现五层结果记录
- [ ] ExecutionCoordinator 返回的 Handle 包含 outcomeRef
- [ ] AgentLoop 执行完成后更新 Outcome
- [ ] Outcome 持久化到 SQLite

**Phase 5b（Delivery 完整实现）**：
- [ ] `delivery/router.ts` 支持 CLI/File/Connector/Schedule 四种交付方式
- [ ] ExecutionCoordinator 根据_flag 决定是否执行 Delivery
- [ ] Delivery 结果写入 DeliveryReceipt
- [ ] E2E 测试：执行 → 交付 → 结果记录 → 归因

---

## 7. 执行计划总览

| Phase | 断点 | 优先级 | 工作量 | 依赖 | 风险 |
|---|---|---|---|---|---|
| Phase 1 | 断点 2 假成功路径 | P0 | 小 | 无 | 现有测试可能依赖旧行为 |
| Phase 2 | 断点 4 process.cwd() | P1 | 中 | 无 | 需要修改多个入口 |
| Phase 3 | 断点 3 远端静默降级 | P0 | 中 | Phase 2 | fail-closed 可能阻断现有流程 |
| Phase 4 | 断点 5 Evolve 最后一跳 | P1 | 中 | 无（部分） | Policy 编译器需要设计 |
| Phase 5a | 断点 1 Outcome 最小实现 | P0 | 中 | 无 | 新增组件需要测试 |
| Phase 5b | 断点 1 Delivery 完整实现 | P0 | 大 | Phase 5a | 最大工作量，需要完整设计 |

### 7.1 建议执行顺序

```
Week 1: Phase 1（安全止血）+ Phase 2（基础设施）
Week 2: Phase 3（远端降级分类）+ Phase 4（Evolve 消费端）
Week 3-4: Phase 5a（Outcome 最小实现）→ Phase 5b（Delivery 完整实现）
```

### 7.2 每阶段退出条件

每个 Phase 完成后必须满足：
1. 代码修改通过 `npm test`
2. 新增负向测试覆盖安全场景
3. `architecture-scan.mjs` 不报新的违规
4. 改动提交到独立分支，不直接合并 master

---

## 8. 需要用户确认的授权项

### 8.1 修复方案选择

| Phase | 方案选择 | 推荐 |
|---|---|---|
| Phase 1 | A（彻底关闭 model 标记）/ B（保留但审计） | **A** |
| Phase 2 | A（WorkspaceResolver）/ B（强制环境变量） | **A** |
| Phase 3 | A（fail-closed 分类）/ B（只标记原因） | **A** |
| Phase 4 | A（自动加载）/ B（手动 apply） | **A** |
| Phase 5 | A（完整实现）/ B（先 Outcome 后 Delivery） | **B（分步）** |

### 8.2 执行授权

- [ ] 是否授权执行 Phase 1（修改 GoalManager + 3 个入口）？
- [ ] 是否授权执行 Phase 2（新增 WorkspaceResolver + 修改所有 cwd 调用点）？
- [ ] Phase 3 的 fail-closed 策略可能导致现有流程中断，是否接受？
- [ ] Phase 4 的 PolicyReloader 需要设计 Policy 编译器，是否授权设计？
- [ ] Phase 5 的工作量最大，是否授权分步执行（5a → 5b）？

### 8.3 不在本次修复范围

- GitHub Actions Runner 恢复（组织策略问题）
- Memory OS Schema v19+ 迁移（属于功能扩展）
- Agent OS 3.0 完整实现（属于新版本开发）
- 现有测试脚本的大规模重构（只修改受影响的测试）

---

## 9. 风险与回滚

### 9.1 风险

1. **Phase 1**：修改 GoalManager 可能破坏现有 Goal 流程 → 需要完整回归测试
2. **Phase 3**：fail-closed 可能导致远端不可用时系统完全不可用 → 需要提供 `AWKN_MEMORY_FAIL_OPEN=1` 紧急开关
3. **Phase 5**：新增 Delivery/Outcome 组件可能引入新的架构违规 → 需要 architecture-scan 验证

### 9.2 回滚策略

每个 Phase 使用独立分支（`fix/phaseN-*`），如果出现问题：
1. `git revert` 对应 commit
2. 如果 master 已合并，创建 hotfix 分支回滚
3. Phase 1 回滚后恢复 model 标记能力（临时措施）

---

## 10. 结论

5 个断点不是"尚未开发"的问题，而是"已开发组件之间的连接断裂"。修复的核心是**打通连接**，而非重新开发组件：

- 断点 2：GoalJudge 已存在，只需接入
- 断点 3：错误分类只需修改 catch 逻辑
- 断点 4：WorkspaceResolver 是轻量封装
- 断点 5：PolicyReloader 是消费端补全
- 断点 1：Delivery/Outcome 是按设计文档实现

按 Phase 1 → 5 顺序执行，每个 Phase 独立可验收，可独立回滚。
