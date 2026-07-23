# progress.md - 天火本地进度记录

定位: deep/recovery 模式的本地进度日志。用于恢复上下文、避免重复失败动作、关闭验证循环。

---

## 使用规则

- 记录阶段推进、命令结果、验证证据、失败尝试和用户纠正。
- 连续失败必须触发 3-strike 协议。
- 恢复任务时优先读本文件，再读 `task_plan.md` 和 `findings.md`。
- 不记录密钥、token、个人隐私或生产凭据。

---

## 进度模板

```yaml
entryId: PRG-YYYYMMDD-001
time: ""
phase: ""
action: ""
result: ""
evidence: ""
openFinding: ""
nextMinimalStep: ""
```

---

## 当前进度

| 时间 | 阶段 | 动作 | 结果 | 下一步 |
|------|------|------|------|--------|
| - | - | - | - | - |

