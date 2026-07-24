# Durable Cron Worker

## 数据流

```text
Cron schedule
→ idempotent enqueue
→ worker lease
→ heartbeat
→ action executor
→ success / exponential retry / dead letter
```

## 幂等键

定时执行使用 `job_id + scheduled_at`，手动触发使用随机执行键。相同调度时隙只能生成一条 work item。

HTTP Action 自动添加 `Idempotency-Key` 请求头。Tool 与 Script Action 通过 ToolRegistry 和 Sandbox 执行。

## Lease

Worker 领取任务时写入 `lease_owner` 与 `lease_expires_at`。过期 lease 在下一次领取前恢复为 retry，其他 Worker 可以安全接管。

## 重试与死信

失败后按指数退避重试，默认最大 3 次。超过阈值后写入 `cron_dead_letters`，保留 payload、错误和尝试次数。
