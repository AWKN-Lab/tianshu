# Runtime Memory OS

## 四类记忆

| 类型 | 作用 | 默认范围 |
|---|---|---|
| `working` | 最近交互与短时上下文 | Session，默认 24 小时 TTL |
| `project_semantic` | 项目事实、约束、架构决策 | Project |
| `task_trajectory` | Run、Step、Gate 与结果轨迹 | Project |
| `engineering_experience` | 可复用工程规则与失败经验 | Project 或 global |

## 检索

运行时使用无外部依赖的特征哈希向量，并融合：

```text
0.50 × semantic cosine
+ 0.22 × lexical overlap
+ 0.18 × importance
+ 0.10 × recency
```

主对话模型调用前自动注入相关记忆。Prompt、当前指令与仓库证据拥有更高优先级。

## 生命周期

```text
active → superseded / invalid / expired
```

同一 `type + scope + key` 每次写入都会生成递增版本。回滚会复制目标历史版本并生成新的递增版本，历史不可改写。

## 压缩

`memory_compress` 使用确定性的抽取式压缩，记录 source IDs，并将来源条目标记为 superseded。压缩记录保存在 `memory_compactions`。

## CLI

```bash
npm run memory -- put --type project_semantic --scope tianshu --key architecture --content "SQLite + event sourcing"
npm run memory -- search --query "event recovery" --scope tianshu
npm run memory -- context --query "how to recover a run" --project tianshu
npm run memory -- versions --type project_semantic --scope tianshu --key architecture
npm run memory -- rollback --type project_semantic --scope tianshu --key architecture --version 1
npm run memory -- compress --type engineering_experience --scope global --key consolidated-rules
npm run memory -- gc
```
