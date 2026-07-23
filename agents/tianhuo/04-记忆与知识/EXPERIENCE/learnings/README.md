# learnings/README.md - 学习候选库

版本: v6.0
定位: 承接 agent-ops/self-improving-agent 的 learning/error/feature_request 思路。默认启动不读取。

---

## 三类记录

| 类型 | 触发 | 升级目标 |
|------|------|----------|
| learning | 用户纠正、发现更好方法、知识过时 | examples / derived |
| error | 命令失败、工具异常、验证失败 | fixes |
| feature_request | 用户提出新能力或缺口 | CAPABILITY 候选 |

---

## 模板

```yaml
learningId: LRN-YYYYMMDD-001
type: learning | error | feature_request
priority: low | medium | high | critical
status: pending | resolved | promoted | wont_fix
area: docs | config | workflow | code | safety | memory
summary: ""
details: ""
suggestedAction: ""
evidence: []
relatedFiles: []
recurrenceCount: 1
```

---

## 升级规则

- 单次事件保持 candidate。
- 同类事件 2 次进入 derived/fixes 候选。
- 跨任务稳定复现 3 次可更新 P0 或 CAPABILITY。
- 高风险、系统性治理失败写 scars。

