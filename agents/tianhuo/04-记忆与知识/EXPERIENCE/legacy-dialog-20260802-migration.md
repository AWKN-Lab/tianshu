# 对话经验迁徙清单（2026-08-02 复盘）

- 来源：`opencode 会话`（env 污染修复闭环 + 收口执行闭环两次复盘）
- 迁徙日期：2026-08-02
- 候选数量：8
- 状态：全部 DRAFT，版本 1；没有候选被自动激活

| 原候选 | 候选 ID | 类型 | 主题 | 建议目标 |
|---|---|---|---|---|
| 复盘①-1 | EXP-DLG-20260802-001 | SKILL | CICD 挂本地过 ≠ 中间态，先查 env 差异 | 调试排查类技能/项目 AGENTS.md |
| 复盘①-2 | EXP-DLG-20260802-002 | PROJECT_RULE | 测试读 env 必须 beforeEach 清理，自给自足是根治 | 项目 AGENTS.md |
| 复盘①-3 | EXP-DLG-20260802-003 | PROJECT_RULE | .env 是机器间漂移源，测试不得依赖 | 项目 AGENTS.md |
| 复盘①-4 | EXP-DLG-20260802-004 | GATE | PowerShell native 命令退出码必须用 $LASTEXITCODE | 脚本规范/仓库 lint |
| 复盘②-1 | EXP-DLG-20260802-005 | SKILL | diff 范围确认先验证 remote 名 | awkn-git 技能 |
| 复盘②-2 | EXP-DLG-20260802-006 | GATE | 不可逆 git 操作前先建备份引用 | awkn-git 技能 |
| 复盘②-3 | EXP-DLG-20260802-007 | PROJECT_RULE | 动并行会话产物前先证归属 | 项目 AGENTS.md |
| 复盘②-4 | EXP-DLG-20260802-008 | GATE | push 前双层敏感扫描（提交 diff + 未跟踪文件） | awkn-git 技能/CI 门禁 |
