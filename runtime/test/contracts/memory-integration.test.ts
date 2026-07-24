import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../../src/workflow/event-store.js';
import { getMemoryService } from '../../src/memory/service.js';
import { builtinTools } from '../../src/tools/builtin/index.js';

const previousProjectId = process.env.AWKN_PROJECT_ID;

afterEach(() => {
  if (previousProjectId === undefined) delete process.env.AWKN_PROJECT_ID;
  else process.env.AWKN_PROJECT_ID = previousProjectId;
});

describe('runtime memory integration', () => {
  it('persists a terminal Run as task trajectory memory', () => {
    const projectId = `trajectory-${Date.now()}-${Math.random()}`;
    process.env.AWKN_PROJECT_ID = projectId;
    const store = new EventStore();
    const run = store.createRun({ workflowName: 'memory-integration', payload: { projectId } });
    store.transitionRun(run.id, 'running');
    store.appendEvent(run.id, 'l2.cycle.started', { cycle: 1 });
    store.appendEvent(run.id, 'l2.cycle.evaluated', {
      cycle: 1,
      results: [{ name: 'typecheck', passed: true }],
    });
    store.transitionRun(run.id, 'succeeded', { outcome: 'completed' });

    const results = getMemoryService().search({
      query: 'memory integration completed run',
      types: ['task_trajectory'],
      scopeIds: [projectId],
      limit: 10,
    });
    assert.ok(results.some((result) => result.entry.source_run_id === run.id));
  });

  it('exposes memory tools to the Agent tool registry bootstrap', () => {
    const names = new Set(builtinTools.map((tool) => tool.name));
    for (const name of ['memory_search', 'memory_write', 'memory_versions', 'memory_invalidate', 'memory_rollback', 'memory_compress']) {
      assert.ok(names.has(name), `${name} should be registered`);
    }
  });
});
