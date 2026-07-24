import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../../src/workflow/event-store.js';

describe('EventStore Run/Step state machine and replay', () => {
  it('projects L2 cycle events into durable Step rows and replays state', () => {
    const store = new EventStore();
    const run = store.createRun({ workflowName: 'state-machine-test', payload: { test: true } });
    assert.throws(() => store.transitionRun(run.id, 'succeeded'), /invalid run transition/);
    store.transitionRun(run.id, 'running');

    store.appendEvent(run.id, 'l2.cycle.started', { cycle: 1 });
    store.appendEvent(run.id, 'l2.cycle.evaluated', {
      cycle: 1,
      results: [{ name: 'typecheck', passed: true }, { name: 'test', passed: true }],
    });

    const steps = store.listSteps(run.id);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]!.step_key, 'l2-cycle:1');
    assert.equal(steps[0]!.status, 'succeeded');

    store.transitionRun(run.id, 'succeeded', { completed: true });
    const replay = store.replayRun(run.id);
    assert.equal(replay.status, 'succeeded');
    assert.equal(replay.steps[steps[0]!.id]?.status, 'succeeded');
    assert.ok(replay.eventCount >= 6);
  });

  it('rejects illegal Step transitions and marks failed cycles', () => {
    const store = new EventStore();
    const run = store.createRun({ workflowName: 'failed-cycle-test' });
    store.transitionRun(run.id, 'running');
    const step = store.createStep({ runId: run.id, stepKey: 'manual', stepType: 'test' });
    assert.throws(() => store.transitionStep(step.id, 'succeeded'), /invalid step transition/);
    store.transitionStep(step.id, 'running');
    store.transitionStep(step.id, 'failed', {}, 'expected failure');
    assert.equal(store.readStep(step.id)?.status, 'failed');
  });
});
