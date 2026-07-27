---
name: awkn-工程文档
protection: 🔴
displayName: "AWKN 工程文档"
description: "DSPRBSE Specify/Build 交接文档生成器。负责把 PRD、技术方案和实现结果转成接口文档、数据库文档、测试用例、部署说明、变更记录和工程交接包。触发词：工程文档、接口文档、技术文档、数据库文档、测试用例、交接文档、文档补齐。"
aliases: ["工程文档", "技术文档", "接口文档", "数据库文档", "测试用例", "交接文档", "文档补齐", "docx", "prd-engineering"]
version: v2.5.1
dspbrbse-phase: "Specify/Build Handoff"
category: 工程文档
tags: ["documentation", "handoff", "api-docs", "database-docs", "test-cases", "docx"]
triggers:
  - keyword: 工程文档
    description: "用户需要生成或补齐工程交接文档"
  - keyword: 接口文档
    description: "用户需要 API/接口说明"
  - keyword: 数据库文档
    description: "用户需要表结构、字段、索引、迁移说明"
  - keyword: 测试用例
    description: "用户需要从需求或实现生成测试用例"
  - keyword: 交接文档
    description: "用户需要给工程师/审核/部署交接的材料"
  - keyword: 技术文档
    description: "用户需要技术设计、实现说明或运维说明"
owns:
  - PRD -> 工程文档包
  - 技术方案 -> 实现说明/接口说明
  - 代码结果 -> 变更说明/测试说明
  - 发布前 -> 部署说明/回滚说明
  - 文档格式化 -> Markdown/DOCX 输出
do-not-touch:
  - PRD 需求定义主流程（awkn-prd）
  - 代码实现（awkn-工程师）
  - 正式审查（awkn-审核）
  - 正式部署（awkn-部署）
---

# AWKN 工程文档

## 核心定位

本技能负责把需求、方案、代码和发布信息整理成可交接、可审查、可维护的工程文档。它不是 Build 执行者，也不是 Review 门禁；它是 PRD、工程师、审核和部署之间的文档桥。

## 典型输出

| 输入 | 输出 |
|---|---|
| PRD / 用户故事 | 工程任务包、接口草案、验收用例 |
| 技术方案 | 架构说明、模块边界、数据流说明 |
| 代码变更 | 变更记录、影响范围、测试说明 |
| 数据库改动 | 表结构文档、迁移说明、回滚说明 |
| 发布准备 | 部署说明、健康检查清单、回滚步骤 |

## 工作流

1. 读取项目规则、PRD、技术方案或实现结果。
2. 识别文档类型：接口、数据库、测试、部署、交接、复盘。
3. 提取事实，不补编未确认的接口、字段或行为。
4. 按目标读者组织结构：工程师、审核者、部署者、产品方。
5. 输出 Markdown 为默认格式；用户明确要求时再生成 DOCX/PDF。
6. 标注未确认项和依赖项，交给对应技能继续处理。

## 输出选择矩阵

| 用户意图 | 默认输出 | 推荐模板 |
|---|---|---|
| "补工程文档/交接文档" | 工程交接包 | `templates/engineering-handoff-package.md` |
| "接口文档/API文档" | 接口清单、请求响应、错误码、鉴权、示例 | `templates/engineering-handoff-package.md#接口文档` |
| "数据库文档" | 表结构、索引、迁移、回滚、数据风险 | `templates/engineering-handoff-package.md#数据库文档` |
| "测试用例" | 验收用例、集成用例、回归用例、失败场景 | `templates/engineering-handoff-package.md#测试用例` |
| "部署说明" | 环境变量、构建命令、健康检查、回滚步骤 | `templates/engineering-handoff-package.md#部署说明` |
| "变更记录" | 变更摘要、影响范围、测试证据、未确认项 | `templates/report-template.md` |

## 使用示例

### 示例 1：从代码变更生成交接包

```text
用户：帮我把这次价值猎手潮汐页改动补一份工程交接文档。
技能动作：
1. 读取相关变更、路由、数据文件和测试结果。
2. 输出工程交接包：变更摘要、影响范围、接口/数据变更、测试证据、部署与回滚。
3. 将无法从代码确认的事项列入"未确认项"，不编造接口或字段。
```

### 示例 2：从 PRD 生成接口草案

```text
用户：根据这个 PRD 生成接口文档。
技能动作：
1. 只提取 PRD 已确认的实体、动作、权限和验收标准。
2. 给出接口草案、字段说明、错误码、鉴权约束和测试用例。
3. 对缺少字段类型、状态枚举、分页规则的部分标注为待确认。
```

### 示例 3：发布前补齐部署说明

```text
用户：上线前帮我补部署说明和回滚方案。
技能动作：
1. 读取构建脚本、环境变量、Nginx/PM2/云函数等实际配置。
2. 输出部署步骤、健康检查、回滚步骤、风险点和负责人确认项。
3. 高风险操作只写确认清单，不代替部署技能执行上线。
```

## 路由关系

- 上游：`awkn-prd` 提供 PRD、用户故事、验收标准。
- 上游：`awkn-工程师` 提供技术方案、实现说明、测试证据。
- 下游：`awkn-审核` 消费测试用例、变更说明、风险清单。
- 下游：`awkn-部署` 消费部署说明、健康检查和回滚步骤。

## 目录约定

- `references/doc-processing/`：DOCX/PDF 等文档处理参考能力。
- `references/documentation-output-matrix.md`：文档类型、输入证据、输出结构和质量门禁。
- `templates/`：可复用文档模板。
- `examples/`：历史交付样例。

## 文档质量规则

### 设计文档必须包含"技术约束"章节（2026-05-24 新增）

**触发条件**：写技术方案/设计文档（给 AI 或人执行）时

**操作**：
1. 在文档中增加一节"项目技术约束"，至少包含：
   - 数据库类型和驱动（同步/异步、SQLite/MySQL/PostgreSQL）
   - 连接模式（上下文管理器 / 手动 close / ORM）
   - 表名约定（与实际 schema.sql 一致）
   - 框架版本和关键依赖（FastAPI/SQLAlchemy/PyJWT 版本）
   - 认证中间件返回值类型约定
2. 代码示例中的 import 路径必须与实际项目目录结构一致
3. 每个 API 端点定义标注同步/异步

**禁止**：
- 禁止只写"怎么做"不写"在什么环境下做"
- 禁止代码示例中的路径/表名与实际项目不一致

**验证标准**：文档中的技术约束章节与实际代码（schema.sql / connection.py / 现有 API 文件）完全一致

## Delta Specs（增量变更）

> 来源：awkn-程序员天阶功法 v2.9.0 瘦身下沉

```
/propose <变更名>  → 创建 changes/<name>/proposal.md
/specs             → 查看/更新 specs/<domain>/spec.md
/design            → 创建 changes/<name>/design.md
/tasks             → 创建 changes/<name>/tasks.md
/apply             → 执行实施
/archive           → 归档变更，合并到 specs/
```

---

## 版本记录

- `v2.5.1`：新增"设计文档必须包含技术约束章节"规则（来源：E22 智影字幕通用户管理体系改造复盘）。
- `v2.5.0`：补充工程文档输出矩阵、使用示例、交接包模板和样例，提升可触发性与可交付性。
- `v2.4.0`：修正入口污染。此前本文件误写为 `awkn-工程师`，现恢复为工程文档专属入口。
