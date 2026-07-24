# Evolution Evaluation and Promotion

经验候选采用以下生命周期：

```text
DRAFT → VALIDATING → APPROVED → ACTIVE
              └────→ QUARANTINED
ACTIVE ────────────→ QUARANTINED / RETIRED
```

## 回放指标

- 成功率
- 平均循环数
- Token 消耗
- 错误率
- 人工接管率
- 安全违规率

候选经验只有达到全部阈值才能进入 `APPROVED`。安全违规、错误率或人工接管率上升会触发 `QUARANTINED`。ACTIVE 版本可定期重跑基准集，出现回归时自动隔离。

## 激活与回滚

激活新版本时，同一 `experience_id` 的旧 ACTIVE 版本进入 RETIRED。激活历史保存前后版本，`rollback` 可恢复上一 ACTIVE，并隔离当前版本。

## CLI

```bash
npm run evolution -- create --experience EXP-001 --path ./experience.md
npm run evolution -- list DRAFT
npm run evolution -- activate <candidate-id>
npm run evolution -- quarantine <candidate-id> reason
npm run evolution -- rollback EXP-001
```
