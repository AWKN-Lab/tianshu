# 天阶 Review 交接协议

Review 输入必须包含冻结 Git 目标、实现 Actor、规格引用和验收标准；输出必须引用唯一 Review Receipt。

门禁规则：目标变化为 `STALE`，Provider 或子任务未完成为 `PARTIAL`，契约、证据或位置非法为 `INVALID`，存在未解决 Critical/High 为 `FAIL`，只有全覆盖且无阻断项为 `PASS`。任何非 PASS 状态均不可映射为 Gate PASS。

整改由工程阶段执行，审核者不得修改代码后为同一目标签发 PASS。修复会产生新目标指纹，必须重新计划和审核。
