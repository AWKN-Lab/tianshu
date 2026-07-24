# Durable Run/Step State and Replay

## Run 状态

```text
created → queued/running → waiting_tool/waiting_approval/retrying
        → succeeded/failed/cancelled/budget_exceeded/policy_blocked
```

终态禁止继续迁移。非法迁移会直接抛错，不会只写一条看似成功的状态记录。

## Step 状态

```text
created → queued/running → waiting_tool/waiting_approval/retrying
        → succeeded/failed/cancelled/policy_blocked
```

L2 的 `l2.cycle.started` 与 `l2.cycle.evaluated` 事件会自动投影为 `l2_cycle` Step。已有 AgentLoop 无需维护第二套状态写入逻辑。

## Replay

`EventStore.replayRun(runId)` 只读取追加事件，重建 Run 状态和所有 Step 状态。数据库中的 Run/Step 行承担查询视图，事件流承担追责与重放依据。

L1 checkpoint 继续由 `LoopStateManager` 保存完整消息、ReAct 状态、轮数和 Token；事件重放负责恢复工作流状态，两者分别处理模型上下文恢复和业务状态恢复。
