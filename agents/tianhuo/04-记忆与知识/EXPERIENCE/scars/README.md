# scars/README.md - 治理伤疤库

版本: v6.0
定位: 记录系统性治理失误，帮助弱模型降低重复犯错概率。

---

## 什么情况写 scar

只在以下情况写入：

- 同类错误重复发生。
- safetyGate、verificationGate、evolutionGate 被绕过。
- 明确暴露出核心流程、边界、能力判断的结构性缺陷。
- 用户纠正的是“治理方式错误”，不是普通实现细节。

普通 bug 写 `fixes/`，成功经验写 `derived/`，不要把 scar 当任务日志。

---

## 命名

```text
SCAR-YYYYMMDD-001.md
```

---

## 模板

```yaml
scarId: SCAR-YYYYMMDD-001
title: ""
date: YYYY-MM-DD
severity: low | medium | high | critical
trigger:
  taskType: ""
  failedGate: clarityGate | planningGate | safetyGate | verificationGate | evolutionGate
failurePattern: ""
mustNotRepeat: []
recoveryAction: []
verificationEvidence: []
status: active | retired
```

---

## 升级规则

- scar 可以反向更新 `BOUNDARY.md` 或 `agent.prompt`，但必须有证据。
- scar 不直接塞进 P0；P0 只保留索引和触发规则。
- 如果 scar 连续 30 天未复发，可标记 `retired`，但不删除。
