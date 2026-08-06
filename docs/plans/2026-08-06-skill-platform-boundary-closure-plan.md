# AWKN Skill 平台边界收口执行计划

- 计划版本：1.0.0
- 日期：2026-08-06
- 涉及仓库：`AWKN-Lab/skills`、`AWKN-Lab/tianshu`
- 来源资产目录：`D:\awkn-lab\skill-sources`
- 目标：彻底落实“Skill 是可发现能力入口，自动流是执行系统，来源仓是外部资产库，Runtime 数据是可变状态”的边界。

---

## 一、当前状态

### 已完成

1. `awkn-技能测评` 已收缩为 4.0.0 薄入口。
2. `awkn-技能治理` 已收缩为 3.0.0 薄入口。
3. 测评执行实现已迁入 `tianshu/packages/skill-evaluator`。
4. 治理执行实现已迁入 `tianshu/packages/skill-governance`。
5. 自动流入口已迁入 `tianshu/workflows/skill-platform`。
6. 治理状态默认路径已调整为 `tianshu/runtime/data/skill-governance`。
7. 13 个嵌套组件文件已移除 Skill frontmatter，停止独立发现。
8. 新执行包与边界测试 15 项通过；旧兼容入口测试 17 项通过。

### 尚未完成

1. 旧目录仍物理存在于两个 Skill 中。
2. 当前物理迁移脚本缺少完整事务、哈希校验和自动回滚。
3. `runtime_service` 与 `workflow_entry` 目前只是 Skill 元数据声明，Runtime MCP 尚未注册真正的 `skill-evaluator` 和 `skill-governance` 工具。
4. 新 Python package 仍通过路径注入运行，缺少正式包清单、依赖锁定和安装验证。
5. `AWKN-Lab/skills` 工作区混有大量既有 Qoder Marketplace 删除，尚未与本轮迁移隔离。
6. `AWKN-Lab/skills` 当前分支指针和工作区内容未完成正式收口与 PR 合并。
7. `tianshu` 中新增的 `packages/skill-*`、`workflows/skill-platform` 仍是未跟踪文件。
8. `skill-sources` 尚未成为正式版本化资产仓，也没有完整来源索引、License、上游地址和内容摘要。
9. 边界测试目前主要位于 `tianshu`，在干净克隆且不存在独立 skills 仓时无法完整证明 `AWKN-Lab/skills` 自身合规。
10. IDE/MCP 真实端到端调用尚未验证。
11. 旧兼容脚本、嵌套迁移标记和缓存目录尚未正式退役。

---

## 二、目标目录

### AWKN-Lab/skills

```text
skills/
├─ awkn-技能测评/
│  ├─ SKILL.md
│  └─ references/
│     └─ assessment-contract.md
└─ awkn-技能治理/
   ├─ SKILL.md
   └─ references/
      └─ governance-contract.md
```

对 `execution_mode: orchestrated` 的系统型 Skill，目录禁止包含：

```text
scripts/
skills/
absorbed-skills/
data/
logs/
telemetry/
receipts/
.pytest_cache/
__pycache__/
```

### AWKN-Lab/tianshu

```text
tianshu/
├─ packages/
│  ├─ skill-evaluator/
│  └─ skill-governance/
├─ workflows/
│  └─ skill-platform/
│     ├─ evaluate.py
│     └─ govern.py
├─ runtime/
│  ├─ src/skill-platform/
│  ├─ test/skill-platform/
│  └─ data/skill-governance/
└─ scripts/
   └─ test-skill-platform-boundaries.*
```

### skill-sources

```text
skill-sources/
├─ index.json
├─ qoder-marketplace-2026-08/
├─ antigravity-awesome-skills/
├─ awesome-claude-skills/
├─ zh-original/
└─ zh-references/
```

---

## 三、执行阶段

## P0-1：冻结并隔离两个工作区

### 动作

1. 保存当前两个仓库的完整状态、分支、暂存区和未跟踪文件清单。
2. 在 `AWKN-Lab/skills` 基于 `origin/feat/skill-hierarchy-v1` 建立独立收口分支。
3. 在 `AWKN-Lab/tianshu` 基于最新 `main` 建立独立运行时分支。
4. 将 Qoder Marketplace 既有删除与本轮边界迁移分开，禁止放入同一提交。
5. 为当前混合工作区生成补丁或备份回执，确保可以恢复。

### 验收

- 两个新分支的基线 SHA 明确。
- `git status --short` 中每项变更均有归属标签：本轮迁移、既有删除、其他项目变更。
- 不存在无法解释的删除或覆盖。

### 回滚

- 删除新建收口分支，恢复原工作区补丁。
- 不修改远端 `main`。

---

## P0-2：重写物理迁移器

当前 `scripts/migrate-skill-boundaries.ps1` 不可直接执行 `-Apply`，原因：

1. dry-run 仍会创建目标目录。
2. `Move-Item` 前后没有文件数量、总字节和 SHA256 清单校验。
3. 目标冲突可能在中途终止，留下部分已移动状态。
4. 没有事务日志和反向回滚脚本。
5. 没有检查当前 Qoder 大量删除是否已有对应目标副本。

### 改造要求

1. `-Plan`：纯只读，不创建目录。
2. `-Apply`：先复制到 staging，不直接移动源目录。
3. 对源和 staging 生成：
   - 文件总数
   - 总字节
   - 每文件 SHA256
   - 集合摘要
4. 校验一致后原子切换目标目录。
5. 最后才将旧目录移动到带时间戳备份区。
6. 生成 `migration-receipt.json` 和 `rollback.ps1`。
7. 任一步失败都恢复源目录并标记 `ROLLED_BACK`。

### 验收

- `-Plan` 前后文件系统无变化。
- staging 与源清单完全一致。
- 故意制造目标冲突时，源目录保持完整。
- 故意中断迁移后，rollback 能恢复原布局。

---

## P0-3：完成物理边界迁移

### 动作

1. 将 `awkn-技能治理/absorbed-skills/*` 迁至 `D:\awkn-lab\skill-sources`。
2. 将以下旧内容迁入备份区：
   - 两个 Skill 的 `scripts/`
   - 两个 Skill 的嵌套 `skills/`
   - 治理 `data/logs/telemetry/skill-cli.py`
   - 缓存目录
3. 在 `AWKN-Lab/skills` 使用 Git 正式删除这些已跟踪路径。
4. 将 `README/QUICKSTART/CHANGELOG` 中仍有价值的内容合并进根 `SKILL.md` 或 `references/`，然后移出根 Skill 目录。
5. 清除所有迁移标记型嵌套 `SKILL.md`。

### 验收

两个目录最终只包含：

```text
SKILL.md
references/
```

执行：

```text
git ls-files awkn-技能治理 awkn-技能测评
```

不得出现禁止目录。

---

## P0-4：Runtime 真接线

当前 `runtime/src/mcp/server.ts` 只提供 Skill 列表、匹配和查看，没有测评与治理执行工具。

### 动作

1. 新建 Runtime 适配层：

```text
runtime/src/skill-platform/evaluator-adapter.ts
runtime/src/skill-platform/governance-adapter.ts
runtime/src/skill-platform/python-runner.ts
```

2. 使用参数数组调用 Python，不拼接 shell 字符串。
3. 强制：
   - 路径规范化与工作区边界
   - 超时
   - 最大输出大小
   - JSON 输入输出
   - stderr 与 exit code 记录
   - 取消与失败处理
4. MCP 注册两个权威工具：

```text
awkn_skill_evaluate
awkn_skill_govern
```

5. `awkn_skill_govern` 使用 `operation: inspect|plan|apply|rollback`。
6. 为两个工具增加明确的 `inputSchema`、`outputSchema`、`structuredContent` 和权限 annotations。
7. Runtime 解析薄 Skill 中的 `runtime_service`，确认服务存在；服务缺失时返回明确错误，禁止静默降级到旧脚本。

### 验收

- MCP 工具列表可见两个新工具。
- `awkn_skill_evaluate` 可对样例 Skill 返回通过 Schema 的 AssessmentResult。
- `awkn_skill_govern plan` 不写状态。
- `apply` 未授权时阻断。
- 合法 DRAFT 写入 Runtime 数据目录并生成 Receipt。
- rollback 恢复前态。
- outputSchema 与 structuredContent 完全一致。

---

## P0-5：双仓 CI 正式化

### AWKN-Lab/skills CI

新增独立仓门禁：

1. 每个一级正式 Skill 最多一个可发现 `SKILL.md`。
2. 两个 orchestrated Skill 禁止污染目录。
3. 根 Skill 引用的 `runtime_service`、契约版本、工作流 ID 格式合法。
4. 不要求本地存在 `tianshu` checkout。
5. 禁止第三方 Marketplace、插件容器和运行状态入仓。

### AWKN-Lab/tianshu CI

新增：

1. `skill-evaluator` 单元测试。
2. `skill-governance` 单元测试。
3. workflow CLI smoke。
4. Runtime adapter 测试。
5. MCP contract 测试。
6. lint、build、全量 test。

### 验收

- 两个仓库分别在干净克隆中通过。
- CI 不依赖开发机固定绝对路径。
- 当前 32 项回归全部保留，并增加 Runtime E2E 测试。

---

## P0-6：提交与合并顺序

为了避免薄 Skill 先发布但 Runtime 尚不可用，按以下顺序提交：

### PR-A：AWKN-Lab/tianshu

包含：

- `packages/skill-evaluator`
- `packages/skill-governance`
- `workflows/skill-platform`
- Runtime 适配和 MCP 工具
- Runtime 数据目录说明
- 测试和 CI

PR-A 合并条件：Runtime E2E 全通过。

### 迁移操作

- 执行来源仓和旧目录物理迁移。
- 生成清单和回执。

### PR-B：AWKN-Lab/skills

包含：

- 两个薄 Skill
- 静态 references
- 禁止路径门禁
- 对旧 scripts、嵌套 skills、absorbed-skills、data/logs/telemetry 的正式删除

PR-B 合并条件：PR-A 已可用，来源资产已验证迁出。

### PR-C：skill-sources

包含：

- 来源集合
- 来源索引
- 上游地址
- License
- 内容摘要
- 安全状态

若暂不建立远端仓，必须明确标记为本地资产库，不能假装已版本化。

---

## P1-1：Python package 正式化

### 动作

1. 为两个 package 增加 `pyproject.toml`。
2. 定义 CLI entry points。
3. 锁定依赖和 Python 版本。
4. 去除 workflow 中的 `sys.path` 注入。
5. 在干净虚拟环境安装并运行测试。
6. 增加 Windows 路径、中文目录和无 `jsonschema` 环境测试。

### 验收

- `pip install -e` 或构建 wheel 成功。
- 从任意 cwd 调用 CLI 均可运行。
- 不依赖 Skill 目录脚本。

---

## P1-2：来源仓治理

### 动作

1. 明确 `skill-sources` 的最终形态：独立 Git 仓、Git LFS 仓或对象存储索引。
2. 每个来源集合记录：
   - source_id
   - upstream_url
   - upstream_version
   - fetched_at
   - license
   - content_digest
   - security_status
   - promotion_status
3. 建立候选 Skill 提取流程。
4. 对 `零号审稿人/qualitative-audit` 等已识别真 Skill 单独测评、审批后发布到 Skills 一级目录。
5. 插件容器、canvas、hooks、图标和 Marketplace 元数据不得跟随真 Skill 发布。

### 验收

- 任一正式 Skill 可追溯到唯一来源记录。
- 任一来源资产不会被 IDE 当作正式 Skill 发现。

---

## P1-3：旧状态与数据迁移

### 动作

1. 盘点旧 `awkn-技能治理/data` 是否存在有效状态、Receipt、索引和健康矩阵。
2. 对有效治理状态执行格式迁移。
3. 历史索引和健康矩阵标记来源摘要、生成器版本和状态：`CURRENT|STALE|INVALID`。
4. 空索引与实际 Skill 不一致时重新生成。
5. 运行数据目录加入备份、权限和保留策略。

### 验收

- 没有有效治理记录丢失。
- 旧状态可追溯到迁移 Receipt。
- Runtime 不读取 Skill 目录中的旧 data。

---

## P1-4：IDE 实机验收

至少验证：

1. TRAE
2. Claude Code 或 Codex
3. ChatGPT MCP

### 场景

1. IDE 只发现两个根 Skill。
2. 用户提出“测评某 Skill”，自动路由到 `awkn_skill_evaluate`。
3. 用户提出“登记/审批/激活/回滚”，自动路由到 `awkn_skill_govern`。
4. 子目录来源 Skill 不出现在发现列表。
5. Runtime 服务不可用时返回明确错误。

---

## P2：兼容层退役

在 Runtime 与 IDE 验收通过后：

1. 删除两个 Skill 中的所有兼容脚本。
2. 删除旧兼容测试。
3. 删除迁移期嵌套组件标记。
4. 删除迁移脚本或归档到 `docs/migrations/tools`。
5. 将边界规则固化为仓库级政策和 CI。
6. 发布正式版本：
   - `awkn-技能测评 4.0.0`
   - `awkn-技能治理 3.0.0`
   - `skill-evaluator 1.0.0`
   - `skill-governance 1.0.0`

---

## 四、最终退出标准

全部满足后，本次任务才可关闭：

1. 两个 Skill 目录只含 `SKILL.md + references/`。
2. 来源仓、自动流、执行包、Runtime 数据均已物理分离。
3. `runtime/src/mcp/server.ts` 注册真实测评与治理工具。
4. MCP 输入输出契约通过 Schema 回归。
5. 新旧 32 项回归继续通过，Runtime E2E 新增用例通过。
6. 两个仓库在干净克隆中 CI 全绿。
7. `AWKN-Lab/skills` 无无法解释的大规模删除。
8. `skill-sources` 有完整来源索引和内容摘要。
9. 迁移 Receipt、备份和 rollback 均存在且已验证。
10. PR-A、PR-B 按顺序合并，远端 `main` 与本地一致。
11. IDE 只发现正式根 Skill，并能真实调用 Runtime 服务。
12. 旧兼容脚本和嵌套 Skill 已退役。

---

## 五、立即执行顺序

```text
1. P0-1 冻结并隔离工作区
2. P0-2 重写安全迁移器
3. P0-4 Runtime 真接线
4. P0-5 双仓 CI
5. 提交并合并 PR-A
6. P0-3 执行物理迁移
7. 提交并合并 PR-B
8. P1-1 Python package 正式化
9. P1-2 来源仓治理
10. P1-3 历史数据迁移
11. P1-4 IDE 实机验收
12. P2 兼容层退役
```

本计划以“运行时先可用、来源资产先保全、Skill 仓最后删旧内容”为强制顺序，避免出现 Skill 已发布但执行服务缺失，或来源文件删除后无法恢复的窗口。