# Skills Directory

该目录是天枢的仓库级 Skills 挂载点。大型本地 Skill 库不提交到 Git，由运行时在启动时扫描外置目录。

## 默认行为

未设置环境变量时，运行时扫描仓库根目录的 `skills/`，启动目录不会改变解析结果。

## 外置本地 Skill 库

```powershell
$env:AWKN_SKILLS_ROOT="D:\awkn-lab\skills"
```

```bash
export AWKN_SKILLS_ROOT=/opt/awkn/skills
```

兼容变量：`SKILLS_DIR`。

每个 Skill 使用独立目录，并包含 `SKILL.md`：

```text
skills/
└── example/
    └── SKILL.md
```

仓库仅保留目录骨架、格式模板和加载协议。1G 以上的本地 Skill 内容继续留在本地资产目录。
