# 天火声明式工具元数据

> 版本：v1.0
> 来源：Alice 工程方法论"接口长寿"原则
> 用途：为天火所有工具声明元数据，支持工具管理、安全检查、并发控制

---

## 一、元数据字段定义

| 字段 | 类型 | 说明 |
|------|------|------|
| `readOnly` | boolean | 是否只读操作 |
| `destructive` | boolean | 是否为破坏性操作（删除/覆盖/不可逆） |
| `concurrentSafe` | boolean | 是否支持并发调用 |
| `maxResultSize` | string | 结果大小上限（如 "10KB", "100KB"） |
| `subAgentAllowed` | boolean | 子 Agent 是否可用 |
| `skillOwner` | string | 所属 Skill 包 |

---

## 二、工具清单及元数据

### 内建工具

| 工具 | readOnly | destructive | concurrentSafe | maxResultSize | subAgentAllowed | skillOwner |
|------|---------|------------|---------------|-------------|----------------|-----------|
| 文件搜索/读取 | ✅ | ❌ | ✅ | 50KB | ✅ | 内建 |
| 代码编写/修改 | ❌ | ⚠️ | ❌ | 无限制 | ❌ | awkn-工程师 |
| API 调用 | 视接口定 | 视接口定 | ❌ | 10KB | ❌ | 内建 |
| 意图对齐 | ✅ | ❌ | ✅ | 5KB | ✅ | 内建 |
| Card 出牌 | ✅ | ❌ | ✅ | 2KB | ✅ | 内建 |

### Skill 工具

| 工具 | readOnly | destructive | concurrentSafe | maxResultSize | subAgentAllowed | skillOwner |
|------|---------|------------|---------------|-------------|----------------|-----------|
| 部署操作 | ❌ | ⚠️ | ❌ | 10KB | ❌ | awkn-部署 |
| 代码审查 | ✅ | ❌ | ✅ | 100KB | ✅ | awkn-审核 |
| 测试执行 | ⚠️ | ⚠️ | ❌ | 50KB | ❌ | awkn-工程师 |
| 文档生成 | ❌ | ⚠️ | ✅ | 200KB | ✅ | awkn-工程文档 |
| 复盘总结 | ❌ | ❌ | ✅ | 50KB | ✅ | AWKN 复盘总结 |
| 浏览器自动化 | ⚠️ | ⚠️ | ❌ | 无限制 | ❌ | gstack |

---

## 三、破坏性工具标记规范

### 判断标准

以下情况必须标记 `destructive: true`：
- 覆盖现有文件（写入已存在的文件）
- 删除文件/目录
- 修改生产环境配置
- 执行不可逆的数据操作
- 修改天火核心文件（agent.prompt / SOUL.md / BOUNDARY.md / MEMORY.md）

### 双重确认机制

`destructive: true` 的工具在执行前必须：
1. safetyGate 拦截并说明影响
2. 用户明确确认
3. 记录执行原因

---

## 四、并发安全规则

`concurrentSafe: false` 的工具：
- 同一对话中不能并发调用
- 必须等待前一次调用完成再进行下一次
- 违例：天火报错"此工具不支持并发，请等待"

---

## 五、更新规则

工具元数据变更必须：
1. 在本文件更新对应工具行
2. 在 `archive/TOOL-SERVICE-BOUNDARY.md` 同步更新
3. 变更记录写入 CHANGELOG 节
4. 高风险变更（destructive/readOnly）需用户确认

---

## 六、CHANGELOG

| 日期 | 变更 | 原因 |
|------|------|------|
| 2026-05-28 | 初始版本 v1.0 | Alice 方法论接口长寿原则落地 |

