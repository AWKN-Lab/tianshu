# ADR · SkillDeck 引擎内集成边界

**状态**：Accepted
**日期**：2026-07-28
**决策依据**：`docs/通信方案分析.md`、`.trae/rules/tianshu-dispatch.md`、`skills/awkn-技能治理/registry.json`、`.trae/specs/merge-phase6-mainline-series/spec.md`
**替代关系**：本文档替代原方案 B「仓库外独立工具 + 仓库内桥接」授权确认书。

---

## 一、背景

### 1.1 原方案 B 的设计

原授权确认书（本文件历史版本）提出 SkillDeck 作为独立 Skill 可视化控制台，采用方案 B「仓库外独立工具 + 仓库内桥接」：

- SkillDeck 项目放置在仓库外（候选位置 `~/skilldeck/`、`~/.codex/plugins/skilldeck/`、`D:\awkn-lab\TRAE练习\skilldeck`）。
- 仓库内仅做桥接改造：`skill-cli.py` 新增 4 命令、`registry.json` 新增 `experts[]` 字段、新增桥接 SKILL.md。
- SkillDeck 通过 `AWKN_SKILLS_ROOT` 环境变量指向仓库内 `skills/`，并读取 `registry.json` 同步专家数据。
- 保留 Web + MCP 双形态，依赖 `@modelcontextprotocol/sdk`、`@modelcontextprotocol/ext-apps`、`zod`。

### 1.2 触发改写的新约束

Phase 6 合并主线规范（`.trae/specs/merge-phase6-mainline-series/spec.md`）要求所有集成必须位于引擎项目目录 `d:\awkn-lab\awkn引擎\` 内：

- 禁止外部目录部署 SkillDeck。
- 禁止通过外部仓库（如 `D:\awkn-lab\TRAE练习\skilldeck`）写入引擎治理数据。
- 禁止通过环境变量桥接的方式规避目录约束。
- runtime/ 仍保持纯本地架构硬约束（不引入 MCP SDK、不引入 ws/express/http 服务器）。

### 1.3 原方案 B 与新规范的冲突点

| 原方案 B 设计点 | Phase 6 规范要求 | 冲突 |
|-----------------|-----------------|------|
| SkillDeck 放仓库外 | 必须位于引擎目录内 | 冲突 |
| 通过 `AWKN_SKILLS_ROOT` 桥接 | 禁止外部目录部署 | 冲突 |
| 外部项目独立 git 管理 | 集成纳入引擎仓库 | 冲突 |
| Web + MCP 双形态在仓库外 | runtime 纯本地，MCP 依赖禁入 runtime | 需重新定位形态归属 |
| DeepSeek 外部 LLM 链路 | 外部 LLM 链路需独立审批 | 需推迟 |

---

## 二、决策

### 2.1 集成边界

SkillDeck 后续可视化组件仅可放入 `integrations/skilldeck/`，禁止外部目录部署和外部仓库写入。

具体约束：

1. SkillDeck 后续可视化组件仅可放入 `integrations/skilldeck/`。
2. 不创建或修改外部项目（如 `D:\awkn-lab\TRAE练习\skilldeck`）。
3. 不上线未经批准的外部 LLM 链路。
4. `integrations/skilldeck/` 本阶段只提交 ADR 和协议边界文档。
5. runtime/ 保持纯本地，不引入 MCP SDK 或 HTTP 服务器。

### 2.2 原授权点改写

原授权确认书第四节的 7 个授权点改写如下：

| 原授权点 | 原推荐方案 | 本 ADR 决策 |
|---------|-----------|-------------|
| 1. SkillDeck 项目位置 | A.1 `~/skilldeck/`（仓库外独立工具） | **改为「仅 `integrations/skilldeck/`」**。原 A.1/A.2/A.3/A.4 全部废弃。 |
| 2. skill-cli.py 新增 4 命令 | B.1 全部新增 | 维持 B.1（能力迁移到 skill-cli.py 原则）。具体落地节奏由后续 PR 决定。 |
| 3. registry.json schema 扩展 | C.1 新增 `experts[]` | 维持 C.1。具体落地节奏由后续 PR 决定。 |
| 4. SkillDeck LLM 调用链路 | D.1 保留 DeepSeek API | **改为「本阶段不上线外部 LLM 链路」**。后续如需上线须独立 ADR。 |
| 5. SkillDeck 默认 Skill 目录对齐 | E.1 `AWKN_SKILLS_ROOT` | 不再适用。SkillDeck 不再作为仓库外独立工具存在，目录对齐方案随形态迁移至 `integrations/skilldeck/` 后由后续 PR 决定。 |
| 6. 桥接 SKILL.md 是否创建 | F.1 创建 `skills/.system/skilldeck-bridge/SKILL.md` | 不再适用。桥接 SKILL.md 作为过渡文档保留，等待 PR 3 中 `integrations/skilldeck/` 建立后归档。 |
| 7. MCP 插件形态保留与否 | G.1 保留 Web + MCP 双形态 | **改为「本阶段不引入 MCP 依赖到引擎内」**。MCP 插件形态是否在 `integrations/skilldeck/` 内独立承载，由后续 PR 3 独立审核。 |

### 2.3 替代方案采纳

本 ADR 采纳方案 A 与方案 C 的组合原则：

- **方案 A 的「引擎内集成」原则**：所有 SkillDeck 相关文件必须位于引擎项目目录内。
- **方案 C 的「能力迁移到 skill-cli.py」原则**：核心治理能力（cards / invoke-text / expert / auto-tag）由 `skills/awkn-技能治理/skill-cli.py` 承载，可视化组件作为前端展示层。

原方案 A 整体纳入 runtime/ 的做法仍然否决（违反 runtime 纯本地硬约束）。
原方案 C 丢弃 Web UI 和 MCP 插件形态的做法仍然否决（损失可视化体验）。
原方案 B 仓库外独立工具的做法整体废弃（违反 Phase 6 引擎内集成要求）。

---

## 三、影响

### 3.1 对原方案 B 路径的影响

- 原方案 B 的「仓库外独立工具」路径全部废弃。
- `D:\awkn-lab\TRAE练习\skilldeck` 项目不再纳入本引擎集成范围，本阶段不创建、不修改、不引用。
- 原设计的 `AWKN_SKILLS_ROOT` 环境变量桥接方案不再使用。
- 原设计的 DeepSeek 外部 LLM 链路本阶段不上线。

### 3.2 对引擎目录结构的影响

- 新增 `integrations/skilldeck/` 目录，本阶段仅含 ADR 与协议边界文档。
- 后续 PR 可在 `integrations/skilldeck/` 内放置可视化组件（Web UI 或 MCP 插件形态），但必须通过 Phase 6 PR 3 的独立审核。
- runtime/ 目录零修改。
- `agents/tianhuo/archive/` 目录零修改。
- `skills/awkn-技能治理/skill-cli.py` 和 `registry.json` 本阶段不修改。

### 3.3 对原授权确认书执行计划的影响

- 原执行计划 Phase 1（仓库内桥接改造）中的 skill-cli.py 4 命令和 registry.json schema 扩展，维持作为后续 PR 的能力迁移目标，但本 ADR 不直接授权落地，需由后续 PR 独立审核。
- 原执行计划 Phase 2（SkillDeck 改造，仓库外）整体废弃。
- 原执行计划 Phase 3（文档同步）中 `skills/.system/skilldeck-bridge/SKILL.md` 作为过渡文档保留，等待归档；其他文档同步项不再适用。

---

## 四、本阶段提交范围

本 ADR 改写仅涉及两个文件：

1. `docs/2026-07-28-授权确认书-skilldeck吸收方案.md`（本文件，由授权确认书改写为 ADR）。
2. `integrations/skilldeck/ADR.md`（新建，与本文档保持一致）。

不创建其他文件，不修改 runtime/、agents/tianhuo/archive/、skill-cli.py、registry.json。

---

## 五、回滚

本 ADR 改写可通过 `git revert` 单个 commit 回滚到原授权确认书（方案 B 仓库外独立工具版本）。

回滚后状态：

- 原方案 B 的 7 个授权点恢复为「待用户填写选择」状态。
- `integrations/skilldeck/` 目录随 revert 一并删除。
- 桥接 SKILL.md 不受影响（本阶段未修改）。

---

## 六、历史与过渡文档

### 6.1 桥接 SKILL.md 过渡状态

`skills/.system/skilldeck-bridge/SKILL.md`（原方案 B 阶段产物）作为过渡文档保留，不删除。

标注：**等待 PR 3 中 `integrations/skilldeck/` 建立后归档**。PR 3 应将该 SKILL.md 的有效内容迁移至 `integrations/skilldeck/` 内的协议边界文档，并将原 SKILL.md 标注为「已归档，不再生效」。

### 6.2 原方案 B 设计的存档价值

原方案 B 的设计思路（环境变量桥接、Web + MCP 双形态、DeepSeek 链路）作为历史方案保留在 git 历史中，可通过 `git log` 查看。后续如 Phase 6 规范修订或 SkillDeck 形态再决策时，可作为参考。

---

## 七、关联

- 规范：`.trae/specs/merge-phase6-mainline-series/spec.md`
- 引擎内 ADR：`integrations/skilldeck/ADR.md`
- 桥接过渡文档：`skills/.system/skilldeck-bridge/SKILL.md`（等待归档）
- skill-cli.py 命令入口：`skills/awkn-技能治理/skill-cli.py`（cards / invoke-text / expert / auto-tag，后续 PR 落地）
- 治理权威源：`skills/awkn-技能治理/registry.json`
- runtime 通信约束：`docs/通信方案分析.md`
- 调度规则：`.trae/rules/tianshu-dispatch.md`

---

**ADR 结束。**
