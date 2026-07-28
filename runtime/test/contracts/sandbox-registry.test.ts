import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setSandboxExecutorForTests, type SandboxExecutor } from '../../src/sandbox/index.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { ToolHandler } from '../../src/tools/types.js';

const fake: SandboxExecutor = {
  backend: 'test',
  async executeCommand() {
    return { backend: 'test', status: 'success', exitCode: 0, stdout: 'sandboxed', stderr: '', durationMs: 1, artifacts: [] };
  },
  async writeFile() {
    return { backend: 'test', status: 'success', exitCode: 0, stdout: 'written', stderr: '', durationMs: 1, artifacts: [] };
  },
};

const execTool: ToolHandler = {
  name: 'exec', description: 'exec', source: 'builtin', parameters: {}, permissionLevel: 'confirm',
  execute: async () => { throw new Error('host executor must not run'); },
};

const writeTool: ToolHandler = {
  name: 'write', description: 'write', source: 'builtin', parameters: {}, permissionLevel: 'confirm',
  execute: async () => { throw new Error('host executor must not run'); },
};

afterEach(() => {
  setSandboxExecutorForTests(null);
  delete process.env.AWKN_APPROVED_TOOLS;
});

describe('ToolRegistry sandbox routing', () => {
  it('routes exec through SandboxExecutor', async () => {
    setSandboxExecutorForTests(fake);
    const registry = new ToolRegistry();
    registry.register(execTool);
    const root = mkdtempSync(join(tmpdir(), 'awkn-registry-'));
    const result = await registry.execute('exec', { command: 'echo ok', cwd: root }, {
      sessionId: 's', userId: 'u', callSource: 'main_dialogue', workspaceRoot: root,
      approvedToolNames: ['exec'],
    });
    assert.equal(result, 'sandboxed');
  });

  it('honors AWKN_APPROVED_TOOLS before requesting run approval', async () => {
    process.env.AWKN_APPROVED_TOOLS = 'exec';
    setSandboxExecutorForTests(fake);
    const registry = new ToolRegistry();
    registry.register(execTool);
    const root = mkdtempSync(join(tmpdir(), 'awkn-registry-env-'));
    // runId intentionally omitted: recordSandboxExecution enforces FK on runs table.
    // The env-approval path must succeed without a prior approval request.
    const result = await registry.execute('exec', { command: 'echo ok', cwd: root }, {
      sessionId: 's', userId: 'u', callSource: 'main_dialogue', workspaceRoot: root,
    });
    assert.equal(result, 'sandboxed');
  });

  it('still blocks dangerous exec after environment pre-approval', async () => {
    process.env.AWKN_APPROVED_TOOLS = 'exec';
    setSandboxExecutorForTests(fake);
    const registry = new ToolRegistry();
    registry.register(execTool);
    const root = mkdtempSync(join(tmpdir(), 'awkn-registry-danger-'));
    await assert.rejects(() => registry.execute('exec', {
      command: 'Remove-Item -LiteralPath . -Recurse -Force', cwd: root,
    }, {
      sessionId: 's', userId: 'u', callSource: 'main_dialogue', workspaceRoot: root,
      runId: 'run-danger',
    }), /command denied/);
  });

  it('still blocks outside and sensitive writes after environment pre-approval', async () => {
    process.env.AWKN_APPROVED_TOOLS = 'write';
    setSandboxExecutorForTests(fake);
    const registry = new ToolRegistry();
    registry.register(writeTool);
    const root = mkdtempSync(join(tmpdir(), 'awkn-registry-write-'));
    const context = {
      sessionId: 's', userId: 'u', callSource: 'main_dialogue' as const,
      workspaceRoot: root, runId: 'run-write',
    };
    await assert.rejects(
      () => registry.execute('write', { path: '../outside.txt', content: 'x' }, context),
      /workspace boundary/,
    );
    await assert.rejects(
      () => registry.execute('write', { path: '.env', content: 'x' }, context),
      /sensitive path/,
    );
  });
});
