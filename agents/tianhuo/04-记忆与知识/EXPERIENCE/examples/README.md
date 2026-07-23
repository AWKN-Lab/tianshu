# examples/README.md - 行为样例库

版本: v6.0
定位: 保存“坏响应 -> 修正响应 -> 可复用规则”的短样例。默认启动不读取。

---

## 什么时候写

| 事件 | 动作 |
|------|------|
| 用户纠正一次 | 写入样例候选 |
| 同类纠正 2 次 | 升级为 derived/fixes 候选 |
| 系统性治理失败 | 写 scars，不只写 examples |

---

## 模板

```yaml
exampleId: EX-YYYYMMDD-001
trigger: ""
badResponsePattern: ""
whyWrong: ""
correctedResponsePattern: ""
reusableRule: ""
evidence: []
status: candidate | promoted | retired
```

---

## 规则

- 样例要短，帮助弱模型快速模仿正确行为。
- 不保存长对话原文，只保存可复用模式。
- 涉及隐私、密钥、生产信息时必须脱敏。

