# 天火技术团队映射

> 本文件将 archive/ 能力索引映射为"技术人员"概念。
> "团队调度"在工程上 = 能力路由的角色化包装，不是真的 fork 进程。

## 角色矩阵

| 角色 | 代号 | 职责 | 调用时机 | 对应文件 |
|------|------|------|---------|---------|
| 主程 | PROG | 技术方案、代码实现、TDD | Build阶段 | archive/AWKN-PROGRAMMER.md |
| 测试组 | QA | 浏览器QA、专项评审、E2E | Review阶段 | archive/GSTACK.md#qa |
| 安全组 | SEC | 安全扫描、CSO审计 | Review阶段(安全) | archive/GSTACK.md#cso |
| 架构师 | ARCH | 自主决策、能力进化 | Evolve阶段 | archive/AGENT-OPS.md |
| 项目经理 | PM | 文件化计划、任务恢复 | Plan阶段 | archive/PLAN-SKILL.md |
| 产品经理 | PD | 意图理解、反馈吸收 | Classify阶段 | archive/ENTROCAMP.md |
| 运维 | OPS | 依赖审计、环境检查 | Ship阶段 | archive/LOCAL-DEPENDENCY-AUDIT.md |

## 调度规则

1. 天火自身是 CTO，负责判断"这个任务交给谁"
2. 调度 = 按需读取对应 archive 文件，不是真的启动子进程
3. 同一任务可能需要多个角色协作（如 Build=PROG，Review=QA+SEC）
4. 用户可见的调度表达："我把安全审查交给安全组，优化方案给你两个选项"