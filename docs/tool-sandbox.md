# Tool Sandbox

## 默认执行策略

`exec` 默认使用 Docker 后端：

```text
network=none
read-only root filesystem
cap-drop=ALL
no-new-privileges
pids-limit=64
memory=512m
cpus=1
/tmp tmpfs
workspace bind mount
```

镜像可通过 `AWKN_SANDBOX_IMAGE` 配置。默认镜像为 `node:22-bookworm-slim`。

受限宿主进程后端只用于受控开发环境：

```bash
AWKN_SANDBOX_BACKEND=process
AWKN_ALLOW_PROCESS_SANDBOX=1
```

## 文件写入

`write` 使用工作区内原子临时文件替换，保存写入前后 SHA-256、字节数和目标路径。

## 人工审批

L2 Run 中的 confirm 工具没有预授权时会生成 pending approval 并阻断执行：

```bash
npm run approval -- list pending
npm run approval -- approve <approval-id> <actor>
npm run approval -- deny <approval-id> <actor>
```

下一次调用会按 `run_id + tool_name` 读取最近的已批准记录；调用方也可显式携带 `approvalId`。

## 审计

`sandbox_executions` 保存：backend、命令哈希、工作目录、状态、退出码、stdout、stderr、耗时和产物哈希。
