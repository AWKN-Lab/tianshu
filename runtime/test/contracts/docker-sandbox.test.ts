import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDockerArgs } from '../../src/sandbox/docker-executor.js';

describe('DockerSandboxExecutor contract', () => {
  it('uses a locked-down container contract', () => {
    const args = buildDockerArgs({
      command: 'npm test',
      workspaceRoot: '/workspace/project',
      cwd: '/workspace/project/runtime',
      sessionId: 'session',
    });
    assert.ok(args.includes('--network'));
    assert.ok(args.includes('none'));
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('--cap-drop'));
    assert.ok(args.includes('ALL'));
    assert.ok(args.includes('--pids-limit'));
    assert.ok(args.includes('--mount'));
    assert.equal(args.at(-1), 'npm test');
  });
});
