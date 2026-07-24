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

afterEach(() => setSandboxExecutorForTests(null));

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
});
