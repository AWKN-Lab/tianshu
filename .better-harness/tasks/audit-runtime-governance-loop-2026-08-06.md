# Runtime 治理闭环独立验证与批判性审计

**审计时间**：2026-08-06 15:03（Asia/Singapore）  
**审计范围**：`D:\awkn-lab\awkn引擎` 当前 `main`、Runtime 门禁、Cron 治理计划、工作区未提交资产  
**执行方式**：ENO MCP `awkn_exec` + `awkn_fs_read/list`，只读验证；未执行删除、移动、提交、推送

---

## 一、当前结论

Runtime 核心代码具备可构建、可类型编译、架构扫描无新增阻断的状态。治理闭环仍未完成，主要缺口集中在后台调度进程、真实运行证据、Corrections 与 EXP-DRV 生命周期联动、工作区资产收口。

当前发布判定：**CODE_GATE_GREEN_WITH_RUNTIME_GOVERNANCE_GAPS**。

---

## 二、已取得的确定性证据

### 2.1 Git 状态

- 当前分支：`main`
- 远端关系：`main` 与 `tianshu/main` 同步
- 已跟踪改动：3 项
  - `agents/personas/absorb-record.json`：仅 `recordedAt` 时间戳变化
  - `agents/personas/personas.json`：仅 `updatedAt` 时间戳变化
  - `skills/templates/SKILL.example.md`：删除 9 行旧模板
- 未跟踪资产：15 项

### 2.2 Runtime 构建与依赖

- `npm run build`：PASS
- `npm run lint`：PASS
- `npm ls`：PASS，无 missing / invalid dependency
- 实测依赖：MCP SDK 1.30.0、better-sqlite3 11.10.0、cron-parser 5.6.1、TypeScript 5.9.3

### 2.3 架构扫描

- Direct DB Import：42
- Module Singleton：15
- Cross-component Import：32
- Legacy Exception：1
- Blocking Violations：0
- Migration Continuity：OK
- Migration Latest：21

判定：架构门禁允许继续开发；Legacy 债务仍然显著，不能用 `blockingViolations=0` 宣告架构收口。

### 2.4 测试

本次 `npm test` 在 MCP 单次执行 60 秒上限内取得以下证据：

- Node 测试：730
- Pass：728
- Fail：0
- Skip：2
- 核心阶段耗时：43.3 秒
- `mcp-review-server.test.ts` 独立验证：PASS
- 后续进入 `mcp-server.test.ts` initialize 阶段时，外层 MCP 执行达到 60 秒上限

判定：核心测试全绿；当前 Head 的完整 `npm test` 退出码尚未在本次受控执行中取得。历史 `local-ci-full.log` 有完整 PASS 证据，时间早于当前工作区变化，不能替代本次 Head 的完整证明。

---

## 三、Cron 治理计划的关键修正

现有计划 D1 选择“每个 MCP 进程启动 CronEngine”。该方案风险过高，不宜直接实施。

### 风险依据

1. 当前环境已观察到多个 MCP 实例并存。
2. 每个 MCP 实例启动调度器会形成多调度源。
3. SQLite lease 与幂等机制可以降低重复执行概率，无法自动证明跨进程调度安全。
4. MCP stdio server 的职责是请求处理；后台持续任务会增加退出、重启、锁竞争和可观测性复杂度。
5. `runtime/src/mcp/server.ts` 当前没有启动 CronEngine，生产调度链缺口真实存在。

### 修正决策

采用两阶段策略：

- **阶段 A：独立 Cron Worker / Daemon**
  - 单独进程启动 CronEngine。
  - MCP server 保持请求处理边界。
  - 进程具备 PID/lease、健康检查、优雅关闭和重启策略。
- **阶段 B：数据库 Leader Lease**
  - 所有潜在 worker 启动前竞争唯一 leader lease。
  - lease 获取和续约必须使用原子事务。
  - 失去 lease 后立即停止调度。

在跨进程 lease 压测完成前，禁止将 CronEngine 直接挂入每个 MCP server。

---

## 四、工作区资产处置判定

### 4.1 可进入正式提交候选

1. `.better-harness/tasks/plan-runtime-governance-loop-2026-08-06.md`
   - 需先修正 D1 调度器形态。
   - 需把“72 小时观察”拆成手动触发验收与自然周期验收。

2. `EXP-DRV-20260806-001.md`
   - 经验完整，证据、反例、触发词和验收齐全。
   - 保持 DRAFT，等待回放评测后激活。

3. `EXP-DRV-20260806-002.md`
   - 经验完整，具备规则演进价值。
   - 保持 DRAFT，等待不同项目回放验证。

### 4.2 需要脱敏后再提交

`2026-08-06-服务器盘点清理与部署备份策略重构-深度复盘-PDCA报告.md`

当前包含：

- 服务器公网 IP
- 服务器目录与服务布局
- 数据库规模与运维细节
- 部署路径和容量信息

处置要求：

- 公网 IP 替换为资产代号。
- 服务器绝对路径按必要性保留或泛化。
- SHA256 只保留校验结论，删除可识别前缀。
- 私有运维证据移入受限仓库或本地审计区。

### 4.3 不应按当前形态提交

1. `runtime/scripts/merge-execute.ps1`
2. `runtime/scripts/merge-fix.ps1`
3. `runtime/scripts/merge-fix2.ps1`

原因：一次性、破坏性、包含 Move/Remove/robocopy，存在路径推断和重复执行风险。建议删除本地副本；若必须留证据，移入任务归档并改为不可执行文本。

4. `runtime/scripts/audit-skills.ps1`

当前具备一定复用价值，但存在硬编码绝对路径、规则误报、无参数、无结构化输出。应完成以下改造后再入库：

- 参数化 `-SkillsRoot`
- 输出 JSON + Markdown
- 区分技能目录、插件包、归档目录
- 支持 include/exclude
- 断链规则处理 `file://`、跨技能引用和仓库根路径
- 只读运行，明确 exit code

5. `runtime/scripts/*.txt` 本次新增结果文件

这些文件属于一次性比对输出：`absorbed-map`、`audit-result`、`merge-hits`、`missing-now`、`skill-compare`、`skill-list-0804`、`verify-leftover`。建议删除，或迁移到带日期的审计报告目录；禁止长期堆积在可执行脚本目录。

### 4.4 Persona 时间戳改动

两个 Persona JSON 只有时间戳变化，没有语义内容变化。建议恢复，避免生成式时间戳制造无价值提交和合并冲突。

### 4.5 `SKILL.example.md` 删除

技术验证未发现 Runtime 对该文件的依赖，删除不会阻断 build/lint/核心测试。根 `.gitignore` 已将 `/skills/` 定义为外置资产，旧路径与当前边界存在冲突。

处置建议：接受旧文件删除，同时把技能模板迁移至 `docs/templates/SKILL.example.md` 或技能治理仓库，保证 fresh clone 仍有规范入口。

---

## 五、修正版执行顺序

### WP-1：工作区收口

1. 恢复两个 Persona 纯时间戳变化。
2. 删除 10 个一次性 txt 输出。
3. 删除 3 个破坏性 merge 脚本。
4. 参数化 `audit-skills.ps1`，未完成改造前不提交。
5. 对服务器复盘报告执行脱敏。
6. 保留两个 EXP-DRV 和治理计划。
7. 将 Skill 模板迁入 docs 或独立技能治理仓库。

### WP-2：Cron 独立运行时

1. 新增独立 Cron Worker 入口。
2. 加数据库 leader lease。
3. 加失败指标：`last_attempt_at`、`failed_count`。
4. 加跨进程并发测试。
5. 手动触发治理任务并保存成功 Receipt。
6. 再进行 72 小时自然周期观察。

### WP-3：Corrections 与 EXP-DRV 联动

1. 保留 Corrections `open/resolved` 语义。
2. EXP-DRV 保留 `DRAFT/ACTIVE/ARCHIVED` 语义。
3. 使用显式映射层，避免直接把两套状态枚举混写。
4. 同 fingerprint 去重。
5. resolve 时绑定 `experience_id`。
6. Replay PASS 后驱动 EXP-DRV 激活，并回写关联 Receipt。

### WP-4：完整门禁

1. `npm run build`
2. `npm run lint`
3. `npm test` 完整退出码 0
4. `npm run test:contracts`
5. `npm run test:verify`
6. Linux Runner Replay
7. GitHub Actions Run ID 与耗时证据

---

## 六、当前卡点

1. ENO `awkn_exec` 单次最长 60 秒，当前 `npm test` 总链可能超过限制；需要 GitHub Actions、独立本地终端或拆分测试入口取得完整退出码。
2. ENO 当前执行白名单不允许文件删除、移动、Git restore、commit、push。
3. GPT workspace 连接器账户连接失败，暂时无法使用完整本地编辑与 shell 能力。
4. Cron 真实生产运行需要独立 daemon 或 leader lease 实现，当前代码尚未接线。

---

## 七、退出判定

当前状态允许继续开发，暂不满足治理闭环完成条件。

完成判定必须同时具备：

- 工作区已清理并提交；
- 完整 test / contracts / verify 全部取得当前 Head 的退出码 0；
- 独立 Cron Worker 有成功运行证据；
- 多实例调度没有重复执行；
- Corrections 可追溯绑定 EXP-DRV；
- 服务器复盘材料完成脱敏；
- GitHub Actions Run ID 已归档。
