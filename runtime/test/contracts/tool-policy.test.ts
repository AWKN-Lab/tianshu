import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolPolicy } from '../../src/tools/policy.js';
import type { ToolHandler } from '../../src/tools/types.js';

const writeTool: ToolHandler = {
  name: 'write',
  description: 'write',
  parameters: {},
  source: 'builtin',
  permissionLevel: 'confirm',
  execute: async () => 'ok',
};

const execTool: ToolHandler = {
  name: 'exec',
  description: 'exec',
  parameters: {},
  source: 'builtin',
  permissionLevel: 'confirm',
  execute: async () => 'ok',
};

afterEach(() => {
  delete process.env.AWKN_APPROVED_TOOLS;
  delete process.env.AWKN_ALLOW_OUTSIDE_WORKSPACE;
  delete process.env.AWKN_ALLOW_SENSITIVE_PATHS;
  delete process.env.AWKN_TOOL_POLICY_MODE;
});

describe('ToolPolicy', () => {
  it('requires explicit approval for mutating tools', () => {
    const root = mkdtempSync(join(tmpdir(), 'awkn-policy-'));
    const decision = toolPolicy.evaluate(writeTool, { path: 'a.txt' }, {
      sessionId: 's', userId: 'u', callSource: 'main_dialogue', workspaceRoot: root,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.approvalRequired, true);
  });

  it('allows an approved write inside workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'awkn-policy-'));
    const decision = toolPolicy.evaluate(writeTool, { path: 'a.txt' }, {
      sessionId: 's', userId: 'u', callSource: 'main_dialogue', workspaceRoot: root,
      approvedToolNames: ['write'],
    });
    assert.equal(decision.allowed, true);
  });

  it('blocks paths escaping workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'awkn-policy-'));
    const decision = toolPolicy.evaluate(writeTool, { path: '../outside.txt' }, {
      sessionId: 's', userId: 'u', callSource: 'main_dialogue', workspaceRoot: root,
      approvedToolNames: ['write'],
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /workspace boundary/);
  });

  it('blocks destructive commands after approval', () => {
    const root = mkdtempSync(join(tmpdir(), 'awkn-policy-'));
    const decision = toolPolicy.evaluate(execTool, { command: 'rm -rf /', cwd: root }, {
      sessionId: 's', userId: 'u', callSource: 'main_dialogue', workspaceRoot: root,
      approvedToolNames: ['exec'],
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /command denied/);
  });
});
