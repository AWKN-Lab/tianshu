/**
 * AC-01 — Parallel WorkPackage Stage Initialization
 *
 * 验收标准：同一 Mission 下多个 WorkPackage 可并行初始化阶段，
 * 各 WorkPackage 的 StageRun 互不干扰（独立 stageRunId、独立状态、
 * 独立 idempotencyKey），且 getWorkflowStatus 能正确汇总全 Mission 状态。
 *
 * 对应源码: src/workflow/workflow-runtime.ts, src/workflow/stage-orchestrator.ts
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import {
  cleanupIsolatedTestDb,
  initWorkPackageStages,
  makeEnvelopeId,
  makeMissionId,
  makeWorkPackageId,
  seedAuthorizationEnvelope,
  setupIsolatedTestDb,
  SHA256_HEX,
} from './_ac-helpers.js';
import { getWorkflowStatus, initializeWorkItemStages } from '../src/workflow/workflow-runtime.js';
import { getReadyStages, getWorkItemStages, initializeStages } from '../src/workflow/stage-orchestrator.js';

describe('AC-01 — Parallel WorkPackage Stage Initialization', () => {
  let missionId: string;
  let envelopeId: string;

  before(async () => {
    await setupIsolatedTestDb('wf-ac01-');
    missionId = makeMissionId();
    envelopeId = makeEnvelopeId();
    seedAuthorizationEnvelope(envelopeId, missionId);
  });

  after(async () => {
    await cleanupIsolatedTestDb();
  });

  it('initializes three workpackages in the same mission with independent StageRuns', () => {
    const wp1 = makeWorkPackageId();
    const wp2 = makeWorkPackageId();
    const wp3 = makeWorkPackageId();

    const stages1 = initWorkPackageStages(missionId, wp1, envelopeId, 'prof-wp1');
    const stages2 = initWorkPackageStages(missionId, wp2, envelopeId, 'prof-wp2');
    const stages3 = initWorkPackageStages(missionId, wp3, envelopeId, 'prof-wp3');

    // WORKPACKAGE_TEMPLATE has 6 stages each
    assert.equal(stages1.length, 6);
    assert.equal(stages2.length, 6);
    assert.equal(stages3.length, 6);

    // All stageRunIds must be unique across workpackages
    const allIds = [
      ...stages1.map((s) => s.stageRunId),
      ...stages2.map((s) => s.stageRunId),
      ...stages3.map((s) => s.stageRunId),
    ];
    const uniqueIds = new Set(allIds);
    assert.equal(uniqueIds.size, allIds.length, 'stageRunIds must be unique across workpackages');

    // All idempotencyKeys must be unique
    const allKeys = [
      ...stages1.map((s) => s.idempotencyKey),
      ...stages2.map((s) => s.idempotencyKey),
      ...stages3.map((s) => s.idempotencyKey),
    ];
    const uniqueKeys = new Set(allKeys);
    assert.equal(uniqueKeys.size, allKeys.length, 'idempotencyKeys must be unique');

    // All initial states should be READY
    for (const stage of [...stages1, ...stages2, ...stages3]) {
      assert.equal(stage.state, 'READY');
      assert.equal(stage.missionId, missionId);
      assert.equal(stage.authorizationEnvelopeId, envelopeId);
    }
  });

  it('each workpackage has independent entry point (IMPLEMENT) ready', () => {
    const wp1 = makeWorkPackageId();
    const wp2 = makeWorkPackageId();

    initWorkPackageStages(missionId, wp1, envelopeId, 'prof-entry-1');
    initWorkPackageStages(missionId, wp2, envelopeId, 'prof-entry-2');

    const ready1 = getReadyStages(missionId, 'workpackage', wp1);
    const ready2 = getReadyStages(missionId, 'workpackage', wp2);

    // Each workpackage has exactly one ready entry stage (IMPLEMENT)
    assert.equal(ready1.length, 1);
    assert.equal(ready1[0]!.stageType, 'IMPLEMENT');
    assert.equal(ready2.length, 1);
    assert.equal(ready2[0]!.stageType, 'IMPLEMENT');

    // The ready stages belong to different work items
    assert.notEqual(ready1[0]!.stageRunId, ready2[0]!.stageRunId);
    assert.notEqual(ready1[0]!.workItemId, ready2[0]!.workItemId);
  });

  it('getWorkflowStatus aggregates all stages across parallel workpackages', () => {
    const wp1 = makeWorkPackageId();
    const wp2 = makeWorkPackageId();

    initWorkPackageStages(missionId, wp1, envelopeId, 'prof-status-1');
    initWorkPackageStages(missionId, wp2, envelopeId, 'prof-status-2');

    const status = getWorkflowStatus(missionId);

    // 2 workpackages × 6 stages = 12 total stages (plus any from prior tests in this mission)
    assert.ok(status.totalStages >= 12, `expected >= 12 stages, got ${status.totalStages}`);
    assert.ok(status.readyStages >= 2, `expected >= 2 ready entry stages, got ${status.readyStages}`);
    assert.equal(status.failedStages, 0);
    assert.equal(status.blockedStages, 0);
    assert.equal(status.runningStages, 0);
    assert.equal(status.isComplete, false);
  });

  it('getWorkItemStages returns only stages for the specified workpackage', () => {
    const wp1 = makeWorkPackageId();
    const wp2 = makeWorkPackageId();

    initWorkPackageStages(missionId, wp1, envelopeId, 'prof-isolation-1');
    initWorkPackageStages(missionId, wp2, envelopeId, 'prof-isolation-2');

    const stages1 = getWorkItemStages(missionId, 'workpackage', wp1);
    const stages2 = getWorkItemStages(missionId, 'workpackage', wp2);

    assert.equal(stages1.length, 6);
    assert.equal(stages2.length, 6);

    // Verify isolation: no stageRunId overlap
    const ids1 = new Set(stages1.map((s) => s.stageRunId));
    for (const s of stages2) {
      assert.ok(!ids1.has(s.stageRunId), 'stageRunId must not appear in both workpackages');
    }

    // Verify all stages belong to their respective work items
    for (const s of stages1) {
      assert.equal(s.workItemId, wp1);
    }
    for (const s of stages2) {
      assert.equal(s.workItemId, wp2);
    }
  });

  it('initializeWorkItemStages (workflow-runtime entry) produces same structure', () => {
    const wp = makeWorkPackageId();
    const stages = initializeWorkItemStages(
      missionId,
      'workpackage',
      wp,
      'prof-runtime-entry',
      envelopeId,
      SHA256_HEX,
    );

    assert.equal(stages.length, 6);
    const types = stages.map((s) => s.stageType).sort();
    assert.deepEqual(types, [
      'CODE_REVIEW',
      'GIT_INTEGRATE',
      'IMPLEMENT',
      'RETROSPECTIVE',
      'SECURITY_REVIEW',
      'TEST',
    ]);
  });

  it('re-initializing the same workpackage is rejected (idempotency)', () => {
    const wp = makeWorkPackageId();
    initWorkPackageStages(missionId, wp, envelopeId, 'prof-idem');

    // Second initialization should throw due to UNIQUE constraint on idempotency_key
    assert.throws(() => {
      initWorkPackageStages(missionId, wp, envelopeId, 'prof-idem');
    });

    // Original 6 stages are still the only stages
    const all = getWorkItemStages(missionId, 'workpackage', wp);
    assert.equal(all.length, 6);
  });

  it('initializeStages directly on different work item types coexist in one mission', () => {
    // A mission may contain workpackage + module + component work items in parallel
    const wpId = makeWorkPackageId();
    const modId = `mod_${makeWorkPackageId().slice(3)}`; // reuse hex portion
    const compId = `comp_${makeWorkPackageId().slice(5)}`;

    const wpStages = initializeStages({
      missionId,
      workItemType: 'workpackage',
      workItemId: wpId,
      requiredProfileId: 'prof-multi-wp',
      authorizationEnvelopeId: envelopeId,
      frozenInputHash: SHA256_HEX,
    });
    const modStages = initializeStages({
      missionId,
      workItemType: 'module',
      workItemId: modId,
      requiredProfileId: 'prof-multi-mod',
      authorizationEnvelopeId: envelopeId,
      frozenInputHash: SHA256_HEX,
    });
    const compStages = initializeStages({
      missionId,
      workItemType: 'component',
      workItemId: compId,
      requiredProfileId: 'prof-multi-comp',
      authorizationEnvelopeId: envelopeId,
      frozenInputHash: SHA256_HEX,
    });

    // WORKPACKAGE=6, MODULE=5, COMPONENT=7
    assert.equal(wpStages.length, 6);
    assert.equal(modStages.length, 5);
    assert.equal(compStages.length, 7);

    // All stageRunIds unique
    const allIds = [
      ...wpStages.map((s) => s.stageRunId),
      ...modStages.map((s) => s.stageRunId),
      ...compStages.map((s) => s.stageRunId),
    ];
    assert.equal(new Set(allIds).size, allIds.length);
  });
});
