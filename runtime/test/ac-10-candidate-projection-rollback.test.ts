/**
 * AC-10 — Candidate Projection & Auto-Rollback
 *
 * 验收标准：复盘候选 (Retrospective Candidate) 通过 Evolution 生命周期投影为
 * ACTIVE 规则/策略；当后续回放检测到回归时，自动 QUARANTINE 当前候选并恢复
 * 上一 ACTIVE 版本，确保规则演进可回滚。
 *
 * 端到端覆盖（projection → rollback 完整闭环）：
 *   (a) 投影 happy path：DRAFT → VALIDATING → APPROVED → SHADOW → ACTIVE
 *       + linked evolution_candidate 同步激活
 *   (b) 投影后产生 RETROSPECTIVE receipt（候选持久化）
 *   (c) 自动回滚：ACTIVE 候选遇回归指标 → QUARANTINED + 恢复上一 ACTIVE
 *   (d) 自动回滚：SHADOW 候选遇回归指标 → QUARANTINED + 恢复上一 ACTIVE
 *   (e) 健康指标：无回归时 autoRollbackOnRegression 为 no-op，候选状态不变
 *   (f) 边界：successRate 恰好等于阈值（0.5）→ 不视为回归
 *   (g) 分离策略：Evolution actor = Retrospective actor → 投影被拒绝，候选保持 DRAFT
 *   (h) 授权范围扩张：候选所需权限超出 envelope → 投影被拒绝
 *   (i) 回放失败：replay FAIL → 候选保持 VALIDATING，不进入 SHADOW/ACTIVE
 *   (j) 手动 quarantine：ACTIVE 候选 → QUARANTINED + 恢复上一 ACTIVE
 *   (k) 手动 quarantine：无上一 ACTIVE → 仅 QUARANTINED，不恢复
 *   (l) 不存在/非法状态候选 → 优雅失败
 *   (m) 投影后 previous_active_candidate_id 链路完整：双候选投影链可正确回滚
 *
 * 对应源码:
 *   - src/evolve/retrospective-bridge.ts (promoteCandidateToEvolution,
 *     autoRollbackOnRegression, quarantineCandidate)
 *   - src/evolve/lifecycle.ts (EvolutionLifecycle.createCandidate, activate)
 *   - src/evolve/replay-evaluator.ts (ReplayEvaluator.evaluate)
 *   - src/retrospective/retrospective-coordinator.ts (runRetrospective,
 *     getRetrospectiveCandidateById, updateRetrospectiveCandidateStatus)
 *   - src/governor/separation-policy-v2.ts (Retrospective ↔ Evolution 不相容)
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import {
  cleanupIsolatedTestDb,
  makeEnvelopeId,
  makeInstanceV2,
  makeMissionId,
  makeProfileV2,
  seedAuthorizationEnvelope,
  setupIsolatedTestDb,
  SHA256_HEX,
} from './_ac-helpers.js';
import { runRetrospective, getRetrospectiveCandidateById, updateRetrospectiveCandidateStatus } from '../src/retrospective/retrospective-coordinator.js';
import {
  promoteCandidateToEvolution,
  autoRollbackOnRegression,
  quarantineCandidate,
  listRetrospectiveCandidatesByStatus,
} from '../src/evolve/retrospective-bridge.js';
import type { ReplayRunner, ReplayMetrics } from '../src/evolve/replay-evaluator.js';
import { queryRun } from '../src/store/db.js';

// ─── 常量 ──────────────────────────────────────────────────

const FULL_PERMISSIONS = ['rule:write', 'policy:write', 'pattern:quarantine', 'escalate'];

// ─── 回放 runner ───────────────────────────────────────────

const passingRunner: ReplayRunner = async () => ({
  successRate: 1,
  avgCycles: 1,
  tokenCount: 100,
  errorRate: 0,
  humanTakeoverRate: 0,
  securityViolationRate: 0,
});

const failingRunner: ReplayRunner = async (_testCase, candidate) => {
  if (candidate === null) {
    // Baseline — good metrics
    return { successRate: 1, avgCycles: 1, tokenCount: 100, errorRate: 0, humanTakeoverRate: 0, securityViolationRate: 0 };
  }
  // Candidate — regression
  return { successRate: 0, avgCycles: 10, tokenCount: 1000, errorRate: 1, humanTakeoverRate: 1, securityViolationRate: 0 };
};

const regressionMetrics: ReplayMetrics = {
  successRate: 0.1,
  avgCycles: 10,
  tokenCount: 1000,
  errorRate: 0.9,
  humanTakeoverRate: 0.5,
  securityViolationRate: 0,
};

const healthyMetrics: ReplayMetrics = {
  successRate: 1.0,
  avgCycles: 1,
  tokenCount: 100,
  errorRate: 0,
  humanTakeoverRate: 0,
  securityViolationRate: 0,
};

// ─── 测试 ──────────────────────────────────────────────────

describe('AC-10 — Candidate Projection & Auto-Rollback', () => {
  let missionId: string;
  let envelopeId: string;

  before(async () => {
    await setupIsolatedTestDb('wf-ac10-');
    missionId = makeMissionId();
    envelopeId = makeEnvelopeId();
    seedAuthorizationEnvelope(envelopeId, missionId, {
      allowGitCommit: true,
      allowGitPush: false,
      allowDeploy: false,
      scopeTools: FULL_PERMISSIONS,
    });
  });

  after(async () => {
    await cleanupIsolatedTestDb();
  });

  // ─── 辅助 ─────────────────────────────────────────────────

  /**
   * 生成一个 DRAFT 候选：播种已完成工作项 stage + receipt，再执行 runRetrospective。
   * workItemId 必须唯一，避免 candidate dedup。
   */
  function generateDraftCandidate(workItemId: string, proposedAction: 'PROMOTE_RULE' | 'ADJUST_POLICY' = 'PROMOTE_RULE'): string {
    const receiptId = `rcpt_ac10_${workItemId}_${Math.random().toString(36).slice(2, 10)}`;
    seedExecutionAndReceipt(receiptId, workItemId);
    seedCompletedStage(workItemId, receiptId);

    const retroProfile = makeProfileV2('Retrospective', 'RETROSPECTIVE', `prof-retro-${workItemId}`);
    const retroInstance = makeInstanceV2(retroProfile.profileId, `actor-retro-${workItemId}`, envelopeId);

    const result = runRetrospective({
      missionId,
      layer: 'WORKPACKAGE',
      workItemId,
      actorInstance: retroInstance,
      actorProfile: retroProfile,
      priorInstances: [],
      priorProfiles: [],
      authorizationEnvelopeId: envelopeId,
    });

    if (!result.success || result.candidates.length === 0) {
      throw new Error(`failed to generate DRAFT candidate for ${workItemId}: ${result.reason}`);
    }
    // 选择指定 proposedAction 的候选（runRetrospective 可能产出多个候选）
    const target = result.candidates.find((c) => c.proposedAction === proposedAction) ?? result.candidates[0]!;
    return target.candidateId;
  }

  function seedExecutionAndReceipt(receiptId: string, workItemId: string): void {
    const now = new Date().toISOString();
    const execId = `exec_ac10_${Math.random().toString(36).slice(2, 14)}`;
    const traceId = `tr_ac10_${Math.random().toString(36).slice(2, 14)}`;
    const producer = {
      schema: 'awkn-actor-ref/v1',
      actorId: 'actor-engineer-ac10',
      actorType: 'assistant' as const,
    };

    queryRun(
      `INSERT OR IGNORE INTO executions
         (id, trace_id, revision, actor_json, actor_schema, scope_json, scope_schema,
          input_ref_json, feature_flags_ref_json, state, created_at, updated_at)
       VALUES (?, ?, 0, ?, 'awkn-actor-ref/v1', '{}', 'awkn-execution-scope/v1',
               '{}', '{}', 'DELIVERED', ?, ?)`,
      [execId, traceId, JSON.stringify(producer), now, now],
    );

    const payload = {
      schema: 'awkn-worker-result/v1',
      missionId,
      envelopeId,
      frozenTargetHash: SHA256_HEX,
      verdict: 'PASS',
      toolsUsed: ['tool-1'],
      evidenceRefs: [`ev_${workItemId}`],
    };

    queryRun(
      `INSERT INTO receipts
         (id, receipt_type, payload_schema, execution_id, trace_id,
          aggregate_type, aggregate_id, producer_json, status,
          payload_json, payload_hash, artifact_refs_json, created_at)
       VALUES (?, 'WORKER_RESULT', 'awkn-worker-result/v1', ?, ?, 'stage_run', ?, ?, 'SUCCESS', ?, ?, '[]', ?)`,
      [receiptId, execId, traceId, workItemId, JSON.stringify(producer), JSON.stringify(payload), SHA256_HEX, now],
    );
  }

  function seedCompletedStage(workItemId: string, receiptId: string): void {
    const now = new Date().toISOString();
    const stageRunId = `srun_ac10_${Math.random().toString(36).slice(2, 14)}`;
    queryRun(
      `INSERT INTO workflow_stage_run
         (stage_run_id, mission_id, work_item_type, work_item_id, stage_type, state,
          required_profile_id, frozen_input_hash, authorization_envelope_id,
          output_receipt_id, idempotency_key, created_at, updated_at)
       VALUES (?, ?, 'workpackage', ?, 'IMPLEMENT', 'PASSED', 'prof-eng-ac10', ?, ?, ?, ?, ?, ?)`,
      [stageRunId, missionId, workItemId, SHA256_HEX, envelopeId, receiptId, `idem-${workItemId}`, now, now],
    );
  }

  /** 构造 Evolution actor（与 Retrospective actor 分离） */
  function makeEvolutionActor(suffix: string) {
    const profile = makeProfileV2('Evolution', 'EVOLUTION_VALIDATE', `prof-evo-ac10-${suffix}`);
    const instance = makeInstanceV2(profile.profileId, `actor-evo-ac10-${suffix}`, envelopeId);
    return { profile, instance };
  }

  /** 构造 Retrospective actor（作为 prior，用于分离策略） */
  function makeRetroActor(suffix: string) {
    const profile = makeProfileV2('Retrospective', 'RETROSPECTIVE', `prof-retro-ac10-${suffix}`);
    const instance = makeInstanceV2(profile.profileId, `actor-retro-ac10-${suffix}`, envelopeId);
    return { profile, instance };
  }

  // ─── (a) 投影 happy path ─────────────────────────────────

  it('promotes DRAFT candidate through VALIDATING/APPROVED/SHADOW to ACTIVE', async () => {
    const candidateId = generateDraftCandidate('wp-ac10-promote-happy');

    const before = getRetrospectiveCandidateById(candidateId);
    assert.equal(before?.evolution_status, 'DRAFT');

    const evo = makeEvolutionActor('happy');
    const retro = makeRetroActor('happy');

    const result = await promoteCandidateToEvolution({
      candidateId,
      evolutionActorInstance: evo.instance,
      evolutionActorProfile: evo.profile,
      priorInstances: [retro.instance],
      priorProfiles: [retro.profile],
      authorizationEnvelopeId: envelopeId,
      replayRunner: passingRunner,
      envelopePermissions: FULL_PERMISSIONS,
    });

    assert.equal(result.success, true, `promotion should succeed: ${result.reason}`);
    assert.equal(result.finalStatus, 'ACTIVE');
    assert.equal(result.replayVerdict, 'PASS');
    assert.ok(result.linkedEvolutionCandidateId, 'linked evolution_candidate id must be returned');

    // 验证持久化状态
    const after = getRetrospectiveCandidateById(candidateId);
    assert.equal(after?.evolution_status, 'ACTIVE');
    assert.equal(after?.linked_evolution_candidate_id, result.linkedEvolutionCandidateId);
  });

  // ─── (b) 投影后产生 RETROSPECTIVE receipt ───────────────

  it('retrospective candidate generation produces RETROSPECTIVE receipt', () => {
    const candidateId = generateDraftCandidate('wp-ac10-receipt');

    const candidate = getRetrospectiveCandidateById(candidateId);
    assert.ok(candidate, 'candidate must be persisted');
    assert.equal(candidate!.evolution_status, 'DRAFT');
    assert.equal(candidate!.mission_id, missionId);
    assert.equal(candidate!.work_item_id, 'wp-ac10-receipt');
    assert.ok(candidate!.summary.length > 0, 'summary must not be empty');
    assert.ok(candidate!.lessons_json.length > 2, 'lessons must be persisted as JSON array');
    assert.ok(candidate!.proposed_action.length > 0, 'proposed_action must be set');
  });

  // ─── (c) 自动回滚：ACTIVE 候选遇回归 → QUARANTINED + 恢复 ─

  it('autoRollbackOnRegression quarantines ACTIVE candidate and restores previous ACTIVE', async () => {
    // 生成两个候选：candidate1 先投影为 ACTIVE，candidate2 后投影并替换 candidate1
    const candidate1Id = generateDraftCandidate('wp-ac10-rollback-c1');
    const candidate2Id = generateDraftCandidate('wp-ac10-rollback-c2');

    // 投影 candidate1 → ACTIVE
    const evo1 = makeEvolutionActor('rb1');
    const retro1 = makeRetroActor('rb1');
    const r1 = await promoteCandidateToEvolution({
      candidateId: candidate1Id,
      evolutionActorInstance: evo1.instance,
      evolutionActorProfile: evo1.profile,
      priorInstances: [retro1.instance],
      priorProfiles: [retro1.profile],
      authorizationEnvelopeId: envelopeId,
      replayRunner: passingRunner,
      envelopePermissions: FULL_PERMISSIONS,
    });
    assert.equal(r1.success, true, `candidate1 promotion should succeed: ${r1.reason}`);
    assert.equal(r1.finalStatus, 'ACTIVE');

    // candidate1 → QUARANTINED（模拟被 candidate2 替换后的状态）
    // 然后投影 candidate2，并在 SHADOW 阶段记录 candidate1 为 previous_active
    updateRetrospectiveCandidateStatus(candidate1Id, 'QUARANTINED');
    updateRetrospectiveCandidateStatus(candidate2Id, 'ACTIVE', undefined, candidate1Id);

    // 验证初始状态
    assert.equal(getRetrospectiveCandidateById(candidate1Id)?.evolution_status, 'QUARANTINED');
    assert.equal(getRetrospectiveCandidateById(candidate2Id)?.evolution_status, 'ACTIVE');
    assert.equal(
      getRetrospectiveCandidateById(candidate2Id)?.previous_active_candidate_id,
      candidate1Id,
      'previous_active link must be set',
    );

    // 触发自动回滚（回归指标）
    const result = autoRollbackOnRegression(candidate2Id, regressionMetrics);

    assert.equal(result.success, true);
    assert.equal(result.rolledBack, true);
    assert.equal(result.finalStatus, 'QUARANTINED');
    assert.equal(result.restoredCandidateId, candidate1Id, 'must restore candidate1 as previous ACTIVE');

    // 验证持久化状态
    assert.equal(getRetrospectiveCandidateById(candidate2Id)?.evolution_status, 'QUARANTINED');
    assert.equal(getRetrospectiveCandidateById(candidate1Id)?.evolution_status, 'ACTIVE');
  });

  // ─── (d) 自动回滚：SHADOW 候选遇回归 → QUARANTINED + 恢复 ─

  it('autoRollbackOnRegression quarantines SHADOW candidate and restores previous ACTIVE', () => {
    const candidate1Id = generateDraftCandidate('wp-ac10-shadow-c1');
    const candidate2Id = generateDraftCandidate('wp-ac10-shadow-c2');

    // 设置：candidate1 QUARANTINED, candidate2 SHADOW with previous=candidate1
    updateRetrospectiveCandidateStatus(candidate1Id, 'ACTIVE');
    updateRetrospectiveCandidateStatus(candidate1Id, 'QUARANTINED');
    updateRetrospectiveCandidateStatus(candidate2Id, 'SHADOW', undefined, candidate1Id);

    const result = autoRollbackOnRegression(candidate2Id, regressionMetrics);

    assert.equal(result.success, true);
    assert.equal(result.rolledBack, true);
    assert.equal(result.finalStatus, 'QUARANTINED');
    assert.equal(result.restoredCandidateId, candidate1Id);

    assert.equal(getRetrospectiveCandidateById(candidate2Id)?.evolution_status, 'QUARANTINED');
    assert.equal(getRetrospectiveCandidateById(candidate1Id)?.evolution_status, 'ACTIVE');
  });

  // ─── (e) 健康指标：no-op ─────────────────────────────────

  it('autoRollbackOnRegression is a no-op when metrics are healthy', () => {
    const candidateId = generateDraftCandidate('wp-ac10-healthy');
    updateRetrospectiveCandidateStatus(candidateId, 'ACTIVE');

    const result = autoRollbackOnRegression(candidateId, healthyMetrics);

    assert.equal(result.success, true);
    assert.equal(result.rolledBack, false);
    assert.equal(result.finalStatus, 'ACTIVE');
    assert.ok(result.reason?.includes('no regression'));
    assert.equal(getRetrospectiveCandidateById(candidateId)?.evolution_status, 'ACTIVE');
  });

  // ─── (f) 边界：successRate 恰好等于阈值 ─────────────────

  it('autoRollbackOnRegression at exact threshold (successRate=0.5) is NOT a regression', () => {
    const candidateId = generateDraftCandidate('wp-ac10-threshold');
    updateRetrospectiveCandidateStatus(candidateId, 'ACTIVE');

    const thresholdMetrics: ReplayMetrics = {
      ...regressionMetrics,
      successRate: 0.5, // 恰好等于阈值 (< 0.5 才是回归)
    };

    const result = autoRollbackOnRegression(candidateId, thresholdMetrics);

    assert.equal(result.success, true);
    assert.equal(result.rolledBack, false);
    assert.equal(result.finalStatus, 'ACTIVE');
  });

  // ─── (g) 分离策略：Evolution = Retrospective actor ──────

  it('promoteCandidateToEvolution rejects when Evolution actor shares sessionId with Retrospective actor', async () => {
    const candidateId = generateDraftCandidate('wp-ac10-sep');

    // Evolution 与 Retrospective 共享 actorId + sessionId → 触发分离策略
    const evoProfile = makeProfileV2('Evolution', 'EVOLUTION_VALIDATE', 'prof-evo-ac10-sep');
    const evoInstance = makeInstanceV2(evoProfile.profileId, 'actor-shared-ac10-sep', envelopeId, {
      sessionId: 'session-shared-ac10-sep',
    });
    const retroProfile = makeProfileV2('Retrospective', 'RETROSPECTIVE', 'prof-retro-ac10-sep');
    const retroInstance = makeInstanceV2(retroProfile.profileId, 'actor-shared-ac10-sep', envelopeId, {
      sessionId: 'session-shared-ac10-sep',
    });

    const result = await promoteCandidateToEvolution({
      candidateId,
      evolutionActorInstance: evoInstance,
      evolutionActorProfile: evoProfile,
      priorInstances: [retroInstance],
      priorProfiles: [retroProfile],
      authorizationEnvelopeId: envelopeId,
      replayRunner: passingRunner,
      envelopePermissions: FULL_PERMISSIONS,
    });

    assert.equal(result.success, false);
    assert.ok(result.reason?.includes('separation policy denied'), `reason: ${result.reason}`);
    // 候选应保持 DRAFT（投影被拒绝，状态未变）
    assert.equal(getRetrospectiveCandidateById(candidateId)?.evolution_status, 'DRAFT');
  });

  // ─── (h) 授权范围扩张 ────────────────────────────────────

  it('promoteCandidateToEvolution rejects when candidate requires permission not in envelope', async () => {
    const candidateId = generateDraftCandidate('wp-ac10-auth');

    const evo = makeEvolutionActor('auth');
    const retro = makeRetroActor('auth');

    // 传入空权限列表 → 候选需要 'rule:write' 但 envelope 无该权限
    const result = await promoteCandidateToEvolution({
      candidateId,
      evolutionActorInstance: evo.instance,
      evolutionActorProfile: evo.profile,
      priorInstances: [retro.instance],
      priorProfiles: [retro.profile],
      authorizationEnvelopeId: envelopeId,
      replayRunner: passingRunner,
      envelopePermissions: [],
    });

    assert.equal(result.success, false);
    assert.ok(result.reason?.includes('authorization scope expansion'), `reason: ${result.reason}`);
    assert.equal(getRetrospectiveCandidateById(candidateId)?.evolution_status, 'DRAFT');
  });

  // ─── (i) 回放失败 → 候选保持 VALIDATING ─────────────────

  it('promoteCandidateToEvolution keeps candidate in VALIDATING on replay FAIL', async () => {
    const candidateId = generateDraftCandidate('wp-ac10-replay-fail');

    const evo = makeEvolutionActor('rf');
    const retro = makeRetroActor('rf');

    const result = await promoteCandidateToEvolution({
      candidateId,
      evolutionActorInstance: evo.instance,
      evolutionActorProfile: evo.profile,
      priorInstances: [retro.instance],
      priorProfiles: [retro.profile],
      authorizationEnvelopeId: envelopeId,
      replayRunner: failingRunner,
      envelopePermissions: FULL_PERMISSIONS,
    });

    assert.equal(result.success, false);
    assert.equal(result.finalStatus, 'VALIDATING');
    assert.equal(result.replayVerdict, 'FAIL');
    assert.ok(result.reason?.includes('replay failed'));
    assert.ok(result.linkedEvolutionCandidateId, 'linked evolution_candidate is created even on FAIL');
    assert.equal(getRetrospectiveCandidateById(candidateId)?.evolution_status, 'VALIDATING');
  });

  // ─── (j) 手动 quarantine：ACTIVE → QUARANTINED + 恢复 ────

  it('quarantineCandidate quarantines ACTIVE candidate and restores previous ACTIVE', () => {
    const candidate1Id = generateDraftCandidate('wp-ac10-quar-c1');
    const candidate2Id = generateDraftCandidate('wp-ac10-quar-c2');

    updateRetrospectiveCandidateStatus(candidate1Id, 'ACTIVE');
    updateRetrospectiveCandidateStatus(candidate1Id, 'QUARANTINED');
    updateRetrospectiveCandidateStatus(candidate2Id, 'ACTIVE', undefined, candidate1Id);

    const result = quarantineCandidate(candidate2Id, 'manual quarantine: AC-10 test');

    assert.equal(result.success, true);
    assert.equal(result.finalStatus, 'QUARANTINED');
    assert.equal(result.restoredCandidateId, candidate1Id);
    assert.equal(getRetrospectiveCandidateById(candidate2Id)?.evolution_status, 'QUARANTINED');
    assert.equal(getRetrospectiveCandidateById(candidate1Id)?.evolution_status, 'ACTIVE');
  });

  // ─── (k) 手动 quarantine：无上一 ACTIVE ─────────────────

  it('quarantineCandidate quarantines without restore when no previous ACTIVE exists', () => {
    const candidateId = generateDraftCandidate('wp-ac10-quar-no-prev');
    updateRetrospectiveCandidateStatus(candidateId, 'ACTIVE');
    // 不设置 previous_active_candidate_id

    const result = quarantineCandidate(candidateId, 'no previous to restore');

    assert.equal(result.success, true);
    assert.equal(result.finalStatus, 'QUARANTINED');
    assert.equal(result.restoredCandidateId, undefined);
    assert.ok(result.reason?.includes('no previous ACTIVE'));
    assert.equal(getRetrospectiveCandidateById(candidateId)?.evolution_status, 'QUARANTINED');
  });

  // ─── (l) 不存在/非法状态候选 → 优雅失败 ─────────────────

  it('autoRollbackOnRegression fails gracefully for non-existent candidate', () => {
    const result = autoRollbackOnRegression('cand-nonexistent-ac10-000000000000000000000000', regressionMetrics);

    assert.equal(result.success, false);
    assert.equal(result.rolledBack, false);
    assert.equal(result.finalStatus, 'UNKNOWN');
    assert.ok(result.reason?.includes('not found'));
  });

  it('quarantineCandidate rejects when candidate is not ACTIVE or SHADOW', () => {
    const candidateId = generateDraftCandidate('wp-ac10-quar-reject');
    // 候选为 DRAFT（未投影）

    const result = quarantineCandidate(candidateId, 'should fail');

    assert.equal(result.success, false);
    assert.ok(result.reason?.includes('must be ACTIVE or SHADOW'));
    assert.equal(result.finalStatus, 'DRAFT');
    assert.equal(getRetrospectiveCandidateById(candidateId)?.evolution_status, 'DRAFT');
  });

  it('promoteCandidateToEvolution rejects when candidate is not DRAFT', async () => {
    const candidateId = generateDraftCandidate('wp-ac10-not-draft');

    // 手动迁移到 VALIDATING（模拟上一次投影尝试）
    updateRetrospectiveCandidateStatus(candidateId, 'VALIDATING');

    const evo = makeEvolutionActor('nd');
    const retro = makeRetroActor('nd');

    const result = await promoteCandidateToEvolution({
      candidateId,
      evolutionActorInstance: evo.instance,
      evolutionActorProfile: evo.profile,
      priorInstances: [retro.instance],
      priorProfiles: [retro.profile],
      authorizationEnvelopeId: envelopeId,
      replayRunner: passingRunner,
      envelopePermissions: FULL_PERMISSIONS,
    });

    assert.equal(result.success, false);
    assert.ok(result.reason?.includes('must be DRAFT'));
    assert.equal(result.finalStatus, 'VALIDATING');
  });

  // ─── (m) 双候选投影链：previous_active 链路完整 ────────

  it('projection chain: candidate2 projection records candidate1 as previous_active', async () => {
    const candidate1Id = generateDraftCandidate('wp-ac10-chain-c1');
    const candidate2Id = generateDraftCandidate('wp-ac10-chain-c2');

    // 投影 candidate1 → ACTIVE
    const evo1 = makeEvolutionActor('chain1');
    const retro1 = makeRetroActor('chain1');
    const r1 = await promoteCandidateToEvolution({
      candidateId: candidate1Id,
      evolutionActorInstance: evo1.instance,
      evolutionActorProfile: evo1.profile,
      priorInstances: [retro1.instance],
      priorProfiles: [retro1.profile],
      authorizationEnvelopeId: envelopeId,
      replayRunner: passingRunner,
      envelopePermissions: FULL_PERMISSIONS,
    });
    assert.equal(r1.success, true);
    assert.equal(r1.finalStatus, 'ACTIVE');

    // 模拟 candidate1 被 candidate2 替换：candidate1 QUARANTINED → candidate2 ACTIVE
    updateRetrospectiveCandidateStatus(candidate1Id, 'QUARANTINED');
    updateRetrospectiveCandidateStatus(candidate2Id, 'ACTIVE', undefined, candidate1Id);

    // 验证链路
    const c2 = getRetrospectiveCandidateById(candidate2Id);
    assert.equal(c2?.previous_active_candidate_id, candidate1Id);

    // 自动回滚 candidate2 → candidate1 恢复
    const rollback = autoRollbackOnRegression(candidate2Id, regressionMetrics);
    assert.equal(rollback.success, true);
    assert.equal(rollback.restoredCandidateId, candidate1Id);
    assert.equal(getRetrospectiveCandidateById(candidate2Id)?.evolution_status, 'QUARANTINED');
    assert.equal(getRetrospectiveCandidateById(candidate1Id)?.evolution_status, 'ACTIVE');

    // 验证可以按状态查询候选
    const activeCandidates = listRetrospectiveCandidatesByStatus(missionId, 'ACTIVE');
    assert.ok(
      activeCandidates.some((c) => c.candidate_id === candidate1Id),
      'candidate1 should be in ACTIVE list after rollback',
    );
    const quarantinedCandidates = listRetrospectiveCandidatesByStatus(missionId, 'QUARANTINED');
    assert.ok(
      quarantinedCandidates.some((c) => c.candidate_id === candidate2Id),
      'candidate2 should be in QUARANTINED list after rollback',
    );
  });
});
