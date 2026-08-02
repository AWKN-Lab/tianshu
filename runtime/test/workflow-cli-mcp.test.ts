/**
 * FR-037~FR-041: CLI + MCP 单内核适配测试
 *
 * 验证：
 * 1. CLI `workflow` 子命令存在且可执行（providers/status）
 * 2. MCP `awkn_workflow_*` 工具已注册（4 个）
 * 3. CLI 和 MCP 封装同一 WorkflowRuntime（单内核，无第二份状态）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_SOURCE = resolve(__dirname, '..', 'src', 'cli.ts');
const MCP_SOURCE = resolve(__dirname, '..', 'src', 'mcp', 'server.ts');

const ENV = {
  ...process.env,
  AWKN_DB_PATH: ':memory:',
  AWKN_DISABLE_EVOLVE: '1',
  AWKN_LLM_PROVIDER: 'mock',
};

function runCli(...args: string[]): string {
  return execFileSync(process.execPath, ['--import', 'tsx', CLI_SOURCE, 'workflow', ...args], {
    cwd: resolve(__dirname, '..'),
    env: ENV,
    timeout: 30000,
    encoding: 'utf-8',
  });
}

describe('FR-037~FR-041: CLI workflow 子命令', () => {

  it('workflow providers 返回有效 JSON 含 count 字段', () => {
    const output = runCli('providers');
    const parsed = JSON.parse(output);
    assert.ok(typeof parsed.count === 'number');
    assert.ok(Array.isArray(parsed.providers));
  });

  it('workflow status 对不存在的 mission 返回零状态', () => {
    const output = runCli('status', '--mission', 'msn_nonexistent_test');
    const parsed = JSON.parse(output);
    assert.equal(parsed.totalStages, 0);
    assert.equal(parsed.isComplete, false);
  });

  it('workflow replay 对不存在的 mission 返回空历史', () => {
    const output = runCli('replay', '--mission', 'msn_nonexistent_replay');
    const parsed = JSON.parse(output);
    assert.equal(parsed.totalStages, 0);
    assert.ok(Array.isArray(parsed.stageRuns));
  });

  it('CLI 源码包含所有 6 个 workflow 子命令', () => {
    const source = readFileSync(CLI_SOURCE, 'utf-8');
    for (const sub of ['start', 'status', 'resume', 'cancel', 'replay', 'providers']) {
      assert.ok(
        source.includes(`case '${sub}'`),
        `CLI 缺少 workflow ${sub} 子命令`,
      );
    }
  });
});

describe('FR-037~FR-041: MCP awkn_workflow_* 工具注册', () => {
  it('MCP 源码注册了 4 个 awkn_workflow_* 工具', () => {
    const source = readFileSync(MCP_SOURCE, 'utf-8');
    const expectedTools = [
      'awkn_workflow_start',
      'awkn_workflow_status',
      'awkn_workflow_resume',
      'awkn_workflow_cancel',
    ];
    for (const tool of expectedTools) {
      assert.ok(
        source.includes(`'${tool}'`),
        `MCP server 未注册工具 ${tool}`,
      );
    }
  });

  it('MCP 工具封装同一 WorkflowRuntime（单内核）', () => {
    const source = readFileSync(MCP_SOURCE, 'utf-8');
    // MCP 必须导入与 CLI 相同的 workflow-runtime 函数
    assert.ok(
      source.includes("from '../workflow/workflow-runtime.js'"),
      'MCP 未导入 workflow-runtime（可能创建第二份状态）',
    );
    // 禁止 MCP 创建独立调度逻辑
    assert.ok(
      !source.includes('awkn_workflow_schedule'),
      'MCP 不应创建独立调度工具',
    );
  });
});
