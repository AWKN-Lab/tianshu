/**
 * Outcome Record Contract Tests (Phase 6 / C08 / WP-AOS-13)
 *
 * 设计文档: `docs/agent-os-3.0/08-Delivery-Evidence-Memory-Evolve.md` 第三、四节
 *
 * 覆盖设计文档第十节测试 1-3, 10 + 额外测试:
 *  1. 文件创建成功但交付失败时 Delivery 为 FAILED
 *  2. 执行成功且用户未反馈时 Adoption 为 UNKNOWN
 *  3. Memory Candidate 缺少来源时被拒绝（不在 C08 范围，跳过）
 * 10. Delivery 失败可以形成 Learning Outcome
 *
 * 额外测试：
 * - 五层 Outcome 状态独立查询
 * - OutcomeAttribution 计算正确
 * - schema 验证
 * - fail-closed: 未知状态归为 UNKNOWN
 * - 五层状态不可合并
 * - 执行失败仍可能产生 Learning Outcome
 * - 无证据不可生成 Outcome
 * - Hash 稳定性
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OutcomeRecordSchema,
  OutcomeStateSchema,
  OutcomeAttributionSchema,
  OutcomeAttributionMethodSchema,
  WeightedRefSchema,
  computeOutcomeRecordHash,
  computeOutcomeAttributionHash,
  createOutcomeId,
  DEFAULT_UNOBSERVED_OUTCOME,
  OUTCOME_LAYERS,
  type OutcomeRecord,
  type OutcomeAttribution,
  type OutcomeState,
  type WeightedRef,
} from '../../src/contracts/outcome.js';
import type { ActorRef } from '../../src/contracts/actors.js';
import { createAwknId } from '../../src/contracts/ids.js';
import { toUtcTimestamp } from '../../src/contracts/time.js';
import type { EvidenceRecord } from '../../src/contracts/evidence.js';
import type { DeliveryBundle } from '../../src/contracts/delivery.js';
import {
  buildOutcomeRecord,
  deriveExecutionOutcome,
  deriveDeliveryOutcome,
  deriveAdoptionOutcome,
  deriveBusinessOutcome,
  deriveLearningOutcome,
  computeOutcomeConfidence,
  getOutcomeLayer,
  isLayerSucceeded,
  isLayerFailed,
  isLayerUnknown,
  OutcomeRecorderError,
  type RunFinalState,
} from '../../src/outcome/recorder.js';
import {
  buildRuleBasedAttribution,
  buildEmptyAttribution,
  DEFAULT_ATTRIBUTION_WEIGHTS,
  ATTRIBUTION_BUILDER_VERSION,
  OutcomeAttributionError,
  type AttributionInput,
} from '../../src/outcome/attribution.js';

// ============================================================================
// Fixtures
// ============================================================================

const NOW = toUtcTimestamp('2026-07-28T10:00:00.000Z');
const EXECUTION_ID = createAwknId('execution');
const RUN_ID = createAwknId('run');
const SHA256_HEX = 'a'.repeat(64);

function makeActor(overrides: Partial<ActorRef> = {}): ActorRef {
  return {
    schema: 'awkn-actor-ref/v1',
    actorId: 'observer-1',
    actorType: 'system',
    projectId: 'proj-1',
    ...overrides,
  };
}

function makeEvidenceRecord(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    schema: 'awkn-evidence/v2',
    evidenceId: createAwknId('evidence'),
    executionId: EXECUTION_ID,
    traceId: createAwknId('trace'),
    claimIds: [createAwknId('claim')],
    type: 'tool_output',
    level: 2,
    contentHash: SHA256_HEX,
    sourceRef: {
      schema: 'awkn-source-ref/v1',
      sourceKind: 'tool_observation',
      sourceId: 'tool-1',
    },
    observedAt: NOW,
    producer: makeActor(),
    verifiedBy: [],
    ...overrides,
  };
}

function makeDeliveryBundle(overrides: Partial<DeliveryBundle> = {}): DeliveryBundle {
  return {
    schema: 'awkn-delivery-bundle/v1',
    bundleId: createAwknId('delivery'),
    executionId: EXECUTION_ID,
    contracts: [
      {
        schema: 'awkn-delivery-contract/v1',
        deliveryId: createAwknId('delivery'),
        executionId: EXECUTION_ID,
        mode: 'FILE',
        sideEffect: 'local_write',
        requiresAuthorization: false,
        primary: true,
        requiredArtifacts: [],
        successPredicate: { fileWritten: true },
        failurePolicy: 'FAIL',
      },
    ],
    artifacts: [],
    receipts: [],
    primaryDeliveryId: '',
    state: 'PENDING',
    createdAt: NOW,
    ...overrides,
  };
}

function makeRunFinalState(overrides: Partial<RunFinalState> = {}): RunFinalState {
  return {
    executionId: EXECUTION_ID,
    runId: RUN_ID,
    executionSucceeded: true,
    evidenceRecords: [makeEvidenceRecord()],
    observer: makeActor(),
    observedAt: NOW,
    ...overrides,
  };
}

function makeWeightedRef(overrides: Partial<WeightedRef> = {}): WeightedRef {
  return {
    ref: 'ref-1',
    refType: 'claim',
    weight: 0.5,
    reason: 'test contributor',
    ...overrides,
  };
}

function makeOutcomeAttribution(overrides: Partial<OutcomeAttribution> = {}): OutcomeAttribution {
  return {
    schema: 'awkn-outcome-attribution/v1',
    contributingClaims: [],
    contributingPolicies: [],
    contributingSkills: [],
    contributingModels: [],
    contributingTools: [],
    confidence: 0.5,
    method: 'rule_based',
    explanation: 'test attribution',
    ...overrides,
  };
}

// ============================================================================
// Section 1: Schema 验证测试
// ============================================================================

describe('Outcome: Schema 验证', () => {
  describe('OutcomeStateSchema', () => {
    it('包含 SUCCEEDED / FAILED / PARTIAL / CANCELLED / PENDING / UNKNOWN', () => {
      const values = OutcomeStateSchema.options;
      assert.equal(values.length, 6);
      for (const expected of ['SUCCEEDED', 'FAILED', 'PARTIAL', 'CANCELLED', 'PENDING', 'UNKNOWN'] as const) {
        assert.ok(values.includes(expected), `missing state: ${expected}`);
      }
    });

    it('rejects unknown state', () => {
      const result = OutcomeStateSchema.safeParse('INVALID');
      assert.equal(result.success, false);
    });
  });

  describe('OutcomeAttributionMethodSchema', () => {
    it('包含 rule_based / counterfactual / human_review / mixed', () => {
      const values = OutcomeAttributionMethodSchema.options;
      assert.equal(values.length, 4);
      for (const expected of ['rule_based', 'counterfactual', 'human_review', 'mixed'] as const) {
        assert.ok(values.includes(expected), `missing method: ${expected}`);
      }
    });
  });

  describe('WeightedRefSchema', () => {
    it('validates a valid weighted ref', () => {
      const result = WeightedRefSchema.safeParse(makeWeightedRef());
      assert.equal(result.success, true);
    });

    it('rejects weight out of [0, 1]', () => {
      const result = WeightedRefSchema.safeParse({
        ...makeWeightedRef(),
        weight: 1.5,
      });
      assert.equal(result.success, false);
    });

    it('rejects negative weight', () => {
      const result = WeightedRefSchema.safeParse({
        ...makeWeightedRef(),
        weight: -0.1,
      });
      assert.equal(result.success, false);
    });

    it('rejects invalid refType', () => {
      const result = WeightedRefSchema.safeParse({
        ...makeWeightedRef(),
        refType: 'invalid' as never,
      });
      assert.equal(result.success, false);
    });
  });

  describe('OutcomeAttributionSchema', () => {
    it('validates a valid attribution', () => {
      const result = OutcomeAttributionSchema.safeParse(makeOutcomeAttribution({
        contributingClaims: [makeWeightedRef({ refType: 'claim' })],
      }));
      assert.equal(result.success, true);
    });

    it('rejects duplicate claim ref', () => {
      const ref = makeWeightedRef({ ref: 'dup-1', refType: 'claim' });
      const result = OutcomeAttributionSchema.safeParse(makeOutcomeAttribution({
        contributingClaims: [ref, { ...ref, weight: 0.3 }],
      }));
      assert.equal(result.success, false);
    });

    it('rejects claim ref with wrong refType', () => {
      const result = OutcomeAttributionSchema.safeParse(makeOutcomeAttribution({
        contributingClaims: [makeWeightedRef({ refType: 'policy' })],
      }));
      assert.equal(result.success, false);
    });

    it('rejects policy ref with wrong refType', () => {
      const result = OutcomeAttributionSchema.safeParse(makeOutcomeAttribution({
        contributingPolicies: [makeWeightedRef({ refType: 'claim' })],
      }));
      assert.equal(result.success, false);
    });

    it('rejects confidence out of [0, 1]', () => {
      const result = OutcomeAttributionSchema.safeParse(makeOutcomeAttribution({
        confidence: 1.5,
      }));
      assert.equal(result.success, false);
    });
  });

  describe('OutcomeRecordSchema', () => {
    it('validates a valid outcome record', () => {
      const record = buildOutcomeRecord(makeRunFinalState());
      const result = OutcomeRecordSchema.safeParse(record);
      assert.equal(result.success, true, `should validate: ${result.success ? '' : JSON.stringify(result.error.issues)}`);
    });

    it('rejects record with empty evidenceIds', () => {
      const result = OutcomeRecordSchema.safeParse({
        ...buildOutcomeRecord(makeRunFinalState()),
        evidenceIds: [],
      });
      assert.equal(result.success, false);
    });

    it('rejects record with duplicate evidenceIds', () => {
      const eid = createAwknId('evidence');
      const result = OutcomeRecordSchema.safeParse({
        ...buildOutcomeRecord(makeRunFinalState()),
        evidenceIds: [eid, eid],
      });
      assert.equal(result.success, false);
    });

    it('rejects record with invalid outcomeId prefix', () => {
      const result = OutcomeRecordSchema.safeParse({
        ...buildOutcomeRecord(makeRunFinalState()),
        outcomeId: 'invalid_id',
      });
      assert.equal(result.success, false);
    });

    it('rejects record with attribution.confidence > overall confidence', () => {
      const result = OutcomeRecordSchema.safeParse({
        ...buildOutcomeRecord(makeRunFinalState()),
        confidence: 0.5,
        attribution: makeOutcomeAttribution({ confidence: 0.9 }),
      });
      assert.equal(result.success, false);
    });

    it('accepts record with attribution.confidence <= overall confidence', () => {
      const result = OutcomeRecordSchema.safeParse({
        ...buildOutcomeRecord(makeRunFinalState()),
        confidence: 0.9,
        attribution: makeOutcomeAttribution({ confidence: 0.5 }),
      });
      assert.equal(result.success, true);
    });
  });
});

// ============================================================================
// Section 2: 测试 1 - 文件创建成功但交付失败时 Delivery 为 FAILED
// ============================================================================

describe('测试 1: 文件创建成功但交付失败时 Delivery 为 FAILED', () => {
  it('执行成功 + Delivery Bundle FAILED → deliveryOutcome = FAILED', () => {
    // 文件创建成功（执行成功）
    const failedBundle = makeDeliveryBundle({
      state: 'FAILED',
      receipts: [
        {
          schema: 'awkn-delivery-receipt/v1',
          receiptId: createAwknId('receipt'),
          deliveryId: '',
          actualLocation: '/tmp/file.md',
          toolReportedStatus: 'FAILURE',
          verificationStatus: 'VERIFIED',
          reversible: true,
          failureReason: 'file write permission denied',
          createdAt: NOW,
        },
      ],
    });
    // 修正 deliveryId 引用
    failedBundle.receipts[0]!.deliveryId = failedBundle.contracts[0]!.deliveryId;
    failedBundle.primaryDeliveryId = failedBundle.contracts[0]!.deliveryId;

    const state = makeRunFinalState({
      executionSucceeded: true, // 文件创建成功
      deliveryBundle: failedBundle,
    });

    const record = buildOutcomeRecord(state);
    // 执行成功
    assert.equal(record.executionOutcome, 'SUCCEEDED');
    // 交付失败（与执行状态分离）
    assert.equal(record.deliveryOutcome, 'FAILED');
    // 不可合并：执行成功 ≠ 交付成功
    assert.notEqual(record.executionOutcome, record.deliveryOutcome);
  });

  it('deriveDeliveryOutcome: SUCCEEDED Bundle → SUCCEEDED', () => {
    const bundle = makeDeliveryBundle({ state: 'SUCCEEDED' });
    assert.equal(deriveDeliveryOutcome(bundle), 'SUCCEEDED');
  });

  it('deriveDeliveryOutcome: FAILED Bundle → FAILED', () => {
    const bundle = makeDeliveryBundle({ state: 'FAILED' });
    assert.equal(deriveDeliveryOutcome(bundle), 'FAILED');
  });

  it('deriveDeliveryOutcome: PARTIAL Bundle → PARTIAL', () => {
    const bundle = makeDeliveryBundle({ state: 'PARTIAL' });
    assert.equal(deriveDeliveryOutcome(bundle), 'PARTIAL');
  });

  it('deriveDeliveryOutcome: PENDING Bundle → PENDING', () => {
    const bundle = makeDeliveryBundle({ state: 'PENDING' });
    assert.equal(deriveDeliveryOutcome(bundle), 'PENDING');
  });

  it('deriveDeliveryOutcome: 无 Bundle → UNKNOWN (fail-closed)', () => {
    assert.equal(deriveDeliveryOutcome(undefined), 'UNKNOWN');
  });
});

// ============================================================================
// Section 3: 测试 2 - 执行成功且用户未反馈时 Adoption 为 UNKNOWN
// ============================================================================

describe('测试 2: 执行成功且用户未反馈时 Adoption 为 UNKNOWN', () => {
  it('执行成功 + 无 adoptionSignal → adoptionOutcome = UNKNOWN', () => {
    const state = makeRunFinalState({
      executionSucceeded: true,
      adoptionSignal: null, // 用户未反馈
      deliveryBundle: makeDeliveryBundle({ state: 'SUCCEEDED' }),
    });
    const record = buildOutcomeRecord(state);
    assert.equal(record.executionOutcome, 'SUCCEEDED');
    assert.equal(record.adoptionOutcome, 'UNKNOWN'); // 不可推断为 SUCCEEDED
    assert.equal(record.businessOutcome, 'UNKNOWN');
  });

  it('执行成功 + adoptionSignal=ADOPTED → adoptionOutcome = SUCCEEDED', () => {
    const state = makeRunFinalState({
      executionSucceeded: true,
      adoptionSignal: 'ADOPTED',
      deliveryBundle: makeDeliveryBundle({ state: 'SUCCEEDED' }),
    });
    const record = buildOutcomeRecord(state);
    assert.equal(record.adoptionOutcome, 'SUCCEEDED');
  });

  it('执行成功 + adoptionSignal=REJECTED → adoptionOutcome = FAILED', () => {
    const state = makeRunFinalState({
      executionSucceeded: true,
      adoptionSignal: 'REJECTED',
      deliveryBundle: makeDeliveryBundle({ state: 'SUCCEEDED' }),
    });
    const record = buildOutcomeRecord(state);
    assert.equal(record.adoptionOutcome, 'FAILED');
  });

  it('执行成功 + adoptionSignal=PARTIAL → adoptionOutcome = PARTIAL', () => {
    const state = makeRunFinalState({
      executionSucceeded: true,
      adoptionSignal: 'PARTIAL',
      deliveryBundle: makeDeliveryBundle({ state: 'SUCCEEDED' }),
    });
    const record = buildOutcomeRecord(state);
    assert.equal(record.adoptionOutcome, 'PARTIAL');
  });

  it('deriveAdoptionOutcome: undefined → UNKNOWN', () => {
    assert.equal(deriveAdoptionOutcome(undefined), 'UNKNOWN');
  });

  it('deriveAdoptionOutcome: null → UNKNOWN', () => {
    assert.equal(deriveAdoptionOutcome(null), 'UNKNOWN');
  });

  it('关键规则：测试通过 ≠ 用户采用（不可合并状态）', () => {
    const state = makeRunFinalState({
      executionSucceeded: true, // 测试通过
      adoptionSignal: null, // 但用户未采用
    });
    const record = buildOutcomeRecord(state);
    // 执行成功但采用未知
    assert.equal(record.executionOutcome, 'SUCCEEDED');
    assert.equal(record.adoptionOutcome, 'UNKNOWN');
    assert.notEqual(record.executionOutcome, record.adoptionOutcome);
  });

  it('关键规则：文件创建 ≠ 用户下载（不可合并状态）', () => {
    const state = makeRunFinalState({
      executionSucceeded: true, // 文件创建成功
      deliveryBundle: makeDeliveryBundle({ state: 'SUCCEEDED' }), // 交付成功
      adoptionSignal: null, // 但用户未下载
    });
    const record = buildOutcomeRecord(state);
    assert.equal(record.executionOutcome, 'SUCCEEDED');
    assert.equal(record.deliveryOutcome, 'SUCCEEDED');
    assert.equal(record.adoptionOutcome, 'UNKNOWN'); // 文件创建 ≠ 用户下载
  });
});

// ============================================================================
// Section 4: 测试 10 - Delivery 失败可以形成 Learning Outcome
// ============================================================================

describe('测试 10: Delivery 失败可以形成 Learning Outcome', () => {
  it('Delivery 失败 + learningSignal=LEARNED → learningOutcome = SUCCEEDED', () => {
    const failedBundle = makeDeliveryBundle({ state: 'FAILED' });
    // 修正 primaryDeliveryId
    failedBundle.primaryDeliveryId = failedBundle.contracts[0]!.deliveryId;
    const state = makeRunFinalState({
      executionSucceeded: true,
      deliveryBundle: failedBundle, // Delivery 失败
      learningSignal: 'LEARNED', // 但产生了学习
    });
    const record = buildOutcomeRecord(state);
    // Delivery 失败
    assert.equal(record.deliveryOutcome, 'FAILED');
    // 但 Learning 成功（从失败中学习）
    assert.equal(record.learningOutcome, 'SUCCEEDED');
  });

  it('deriveLearningOutcome: LEARNED → SUCCEEDED', () => {
    assert.equal(deriveLearningOutcome('LEARNED'), 'SUCCEEDED');
  });

  it('deriveLearningOutcome: NOT_LEARNED → FAILED', () => {
    assert.equal(deriveLearningOutcome('NOT_LEARNED'), 'FAILED');
  });

  it('deriveLearningOutcome: null → UNKNOWN', () => {
    assert.equal(deriveLearningOutcome(null), 'UNKNOWN');
  });

  it('deriveLearningOutcome: undefined → UNKNOWN', () => {
    assert.equal(deriveLearningOutcome(undefined), 'UNKNOWN');
  });

  it('执行失败 + learningSignal=LEARNED → 仍可产生 Learning Outcome', () => {
    const state = makeRunFinalState({
      executionSucceeded: false, // 执行失败
      learningSignal: 'LEARNED', // 但从失败中学习
    });
    const record = buildOutcomeRecord(state);
    assert.equal(record.executionOutcome, 'FAILED');
    assert.equal(record.learningOutcome, 'SUCCEEDED'); // 执行失败仍可学习
  });

  it('关键规则：用户采用 ≠ 建议有效（不可合并状态）', () => {
    const state = makeRunFinalState({
      executionSucceeded: true,
      adoptionSignal: 'ADOPTED', // 用户采用了
      businessSignal: null, // 但业务结果未知
    });
    const record = buildOutcomeRecord(state);
    assert.equal(record.adoptionOutcome, 'SUCCEEDED');
    assert.equal(record.businessOutcome, 'UNKNOWN'); // 用户采用 ≠ 建议有效
  });

  it('关键规则：邮件工具返回成功 ≠ 收件人收到', () => {
    const state = makeRunFinalState({
      executionSucceeded: true,
      deliveryBundle: makeDeliveryBundle({ state: 'SUCCEEDED' }), // 工具报告成功
      adoptionSignal: null, // 但收件人是否收到未知
    });
    const record = buildOutcomeRecord(state);
    assert.equal(record.deliveryOutcome, 'SUCCEEDED');
    assert.equal(record.adoptionOutcome, 'UNKNOWN'); // 不可推断
  });
});

// ============================================================================
// Section 5: 五层 Outcome 状态独立查询
// ============================================================================

describe('五层 Outcome 状态独立查询', () => {
  it('OUTCOME_LAYERS 包含五个字段', () => {
    assert.equal(OUTCOME_LAYERS.length, 5);
    assert.ok(OUTCOME_LAYERS.includes('executionOutcome'));
    assert.ok(OUTCOME_LAYERS.includes('deliveryOutcome'));
    assert.ok(OUTCOME_LAYERS.includes('adoptionOutcome'));
    assert.ok(OUTCOME_LAYERS.includes('businessOutcome'));
    assert.ok(OUTCOME_LAYERS.includes('learningOutcome'));
  });

  it('getOutcomeLayer: 各层独立查询', () => {
    const record = buildOutcomeRecord(makeRunFinalState({
      executionSucceeded: true,
      deliveryBundle: makeDeliveryBundle({ state: 'SUCCEEDED' }),
      adoptionSignal: 'ADOPTED',
      businessSignal: 'ACHIEVED',
      learningSignal: 'LEARNED',
    }));
    assert.equal(getOutcomeLayer(record, 'executionOutcome'), 'SUCCEEDED');
    assert.equal(getOutcomeLayer(record, 'deliveryOutcome'), 'SUCCEEDED');
    assert.equal(getOutcomeLayer(record, 'adoptionOutcome'), 'SUCCEEDED');
    assert.equal(getOutcomeLayer(record, 'businessOutcome'), 'SUCCEEDED');
    assert.equal(getOutcomeLayer(record, 'learningOutcome'), 'SUCCEEDED');
  });

  it('isLayerSucceeded / isLayerFailed / isLayerUnknown', () => {
    const record = buildOutcomeRecord(makeRunFinalState({
      executionSucceeded: true,
      deliveryBundle: makeDeliveryBundle({ state: 'FAILED' }),
      adoptionSignal: null,
      businessSignal: null,
      learningSignal: null,
    }));
    assert.equal(isLayerSucceeded(record, 'executionOutcome'), true);
    assert.equal(isLayerFailed(record, 'deliveryOutcome'), true);
    assert.equal(isLayerUnknown(record, 'adoptionOutcome'), true);
    assert.equal(isLayerUnknown(record, 'businessOutcome'), true);
    assert.equal(isLayerUnknown(record, 'learningOutcome'), true);
  });

  it('默认未观察层为 UNKNOWN (fail-closed)', () => {
    assert.equal(DEFAULT_UNOBSERVED_OUTCOME, 'UNKNOWN');
  });

  it('deriveExecutionOutcome: CANCELLED 优先', () => {
    const state = makeRunFinalState({
      executionSucceeded: true,
      executionCancelled: true,
    });
    assert.equal(deriveExecutionOutcome(state), 'CANCELLED');
  });

  it('deriveExecutionOutcome: PARTIAL 优先于 SUCCEEDED', () => {
    const state = makeRunFinalState({
      executionSucceeded: true,
      executionPartial: true,
    });
    assert.equal(deriveExecutionOutcome(state), 'PARTIAL');
  });

  it('deriveExecutionOutcome: FAILED 当 executionSucceeded=false', () => {
    const state = makeRunFinalState({
      executionSucceeded: false,
    });
    assert.equal(deriveExecutionOutcome(state), 'FAILED');
  });

  it('deriveBusinessOutcome: ACHIEVED → SUCCEEDED', () => {
    assert.equal(deriveBusinessOutcome('ACHIEVED'), 'SUCCEEDED');
  });

  it('deriveBusinessOutcome: NOT_ACHIEVED → FAILED', () => {
    assert.equal(deriveBusinessOutcome('NOT_ACHIEVED'), 'FAILED');
  });

  it('deriveBusinessOutcome: PARTIAL → PARTIAL', () => {
    assert.equal(deriveBusinessOutcome('PARTIAL'), 'PARTIAL');
  });

  it('computeOutcomeConfidence: 证据越多置信度越高', () => {
    const state1 = makeRunFinalState({
      evidenceRecords: [makeEvidenceRecord()],
    });
    const state2 = makeRunFinalState({
      evidenceRecords: [
        makeEvidenceRecord(),
        makeEvidenceRecord({ evidenceId: createAwknId('evidence') }),
        makeEvidenceRecord({ evidenceId: createAwknId('evidence') }),
      ],
    });
    assert.ok(computeOutcomeConfidence(state2) > computeOutcomeConfidence(state1));
  });

  it('computeOutcomeConfidence: 上限 0.95', () => {
    const state = makeRunFinalState({
      evidenceRecords: Array.from({ length: 20 }, () => makeEvidenceRecord({ evidenceId: createAwknId('evidence') })),
      adoptionSignal: 'ADOPTED',
      businessSignal: 'ACHIEVED',
    });
    assert.ok(computeOutcomeConfidence(state) <= 0.95);
  });
});

// ============================================================================
// Section 6: OutcomeAttribution 计算正确
// ============================================================================

describe('OutcomeAttribution 计算正确', () => {
  it('buildRuleBasedAttribution: 无任何 bundle 时产生空归因', () => {
    const attribution = buildRuleBasedAttribution({
      executionOutcome: 'SUCCEEDED',
      deliveryOutcome: 'SUCCEEDED',
    });
    assert.equal(attribution.method, 'rule_based');
    assert.equal(attribution.contributingClaims.length, 0);
    assert.equal(attribution.contributingPolicies.length, 0);
    assert.equal(attribution.contributingSkills.length, 0);
    assert.equal(attribution.contributingModels.length, 0);
    assert.equal(attribution.contributingTools.length, 0);
    // 基础置信度 0.5
    assert.equal(attribution.confidence, 0.5);
  });

  it('buildRuleBasedAttribution: 有 evidenceRecords → 提取 claim', () => {
    const eid = createAwknId('evidence');
    const claimId = createAwknId('claim');
    const evidence: EvidenceRecord = {
      schema: 'awkn-evidence/v2',
      evidenceId: eid,
      executionId: EXECUTION_ID,
      traceId: createAwknId('trace'),
      claimIds: [claimId],
      type: 'tool_output',
      level: 2,
      contentHash: SHA256_HEX,
      sourceRef: {
        schema: 'awkn-source-ref/v1',
        sourceKind: 'tool_observation',
        sourceId: 'tool-1',
      },
      observedAt: NOW,
      producer: makeActor(),
      verifiedBy: [],
    };
    const attribution = buildRuleBasedAttribution({
      evidenceRecords: [evidence],
      executionOutcome: 'SUCCEEDED',
      deliveryOutcome: 'SUCCEEDED',
    });
    assert.equal(attribution.contributingClaims.length, 1);
    assert.equal(attribution.contributingClaims[0]!.ref, claimId);
    assert.equal(attribution.contributingClaims[0]!.refType, 'claim');
    assert.ok(attribution.confidence > 0.5); // 有 evidence 加成
  });

  it('buildRuleBasedAttribution: 失败时 tool 权重提升', () => {
    const toolReceipt = {
      schema: 'awkn-tool-execution-receipt/v1' as const,
      toolCallId: createAwknId('toolCall'),
      toolId: 'file.write',
      requestHash: SHA256_HEX,
      resultHash: SHA256_HEX,
      sideEffect: 'local_write' as const,
      resourceRefs: ['file://path'],
      reportedSuccess: false,
      verifiedSuccess: false,
      reversible: true,
      createdAt: NOW,
    };
    const successAttribution = buildRuleBasedAttribution({
      toolReceipts: [toolReceipt],
      executionOutcome: 'SUCCEEDED',
      deliveryOutcome: 'SUCCEEDED',
    });
    const failedAttribution = buildRuleBasedAttribution({
      toolReceipts: [toolReceipt],
      executionOutcome: 'FAILED',
      deliveryOutcome: 'FAILED',
    });
    const successToolWeight = successAttribution.contributingTools[0]!.weight;
    const failedToolWeight = failedAttribution.contributingTools[0]!.weight;
    assert.ok(failedToolWeight > successToolWeight, `failed weight ${failedToolWeight} should be > success weight ${successToolWeight}`);
  });

  it('buildRuleBasedAttribution: 失败时 model 权重提升', () => {
    // 构造最小 BrokerPlan
    const brokerPlan = {
      schema: 'awkn-broker-plan/v1' as const,
      brokerPlanId: createAwknId('brokerPlan'),
      executionId: EXECUTION_ID,
      modelRoutes: [
        {
          schema: 'awkn-model-route-plan/v1' as const,
          routeId: createAwknId('modelRoute'),
          taskRole: 'executor' as const,
          selectedProviderId: 'trae',
          selectedModelId: 'gpt-5',
          reasonCodes: ['CAPABILITY_MATCH'],
          fallbackChain: [],
          capabilityDelta: [],
          estimatedInputTokens: 100,
          estimatedOutputTokens: 50,
          estimatedLatencyMs: 1000,
        },
      ],
      toolRoutes: [],
      providerChoices: [],
      authorizationRequirements: [],
      cumulativeRisk: {
        schema: 'awkn-risk-snapshot/v1' as const,
        baseActionRisk: 'R1' as const,
        dataAggregationRisk: 'R0' as const,
        irreversibility: 'R0' as const,
        crossSystemPropagation: 'R0' as const,
        financialImpact: 'R0' as const,
        identityRepresentation: 'R0' as const,
        repetitionFactor: 1,
        verifiedCompensation: false,
        cumulativeRisk: 'R1' as const,
      },
      costBudget: {
        schema: 'awkn-cost-budget/v1' as const,
        estimatedInputTokens: 100,
        estimatedOutputTokens: 50,
        estimatedCostUsd: 0.01,
        budgetCeilingUsd: 1.0,
        budgetConsumedUsd: 0,
      },
      planHash: SHA256_HEX,
      frozenAt: NOW,
    };
    const successAttribution = buildRuleBasedAttribution({
      brokerPlan,
      executionOutcome: 'SUCCEEDED',
      deliveryOutcome: 'SUCCEEDED',
    });
    const failedAttribution = buildRuleBasedAttribution({
      brokerPlan,
      executionOutcome: 'FAILED',
      deliveryOutcome: 'SUCCEEDED',
    });
    const successModelWeight = successAttribution.contributingModels[0]!.weight;
    const failedModelWeight = failedAttribution.contributingModels[0]!.weight;
    assert.ok(failedModelWeight > successModelWeight, `failed weight ${failedModelWeight} should be > success weight ${successModelWeight}`);
  });

  it('buildRuleBasedAttribution: confidence 上限 0.95', () => {
    const eid = createAwknId('evidence');
    const claimId = createAwknId('claim');
    const evidence: EvidenceRecord = {
      schema: 'awkn-evidence/v2',
      evidenceId: eid,
      executionId: EXECUTION_ID,
      traceId: createAwknId('trace'),
      claimIds: [claimId],
      type: 'tool_output',
      level: 2,
      contentHash: SHA256_HEX,
      sourceRef: {
        schema: 'awkn-source-ref/v1',
        sourceKind: 'tool_observation',
        sourceId: 'tool-1',
      },
      observedAt: NOW,
      producer: makeActor(),
      verifiedBy: [],
    };
    const attribution = buildRuleBasedAttribution({
      evidenceRecords: [evidence],
      executionOutcome: 'SUCCEEDED',
      deliveryOutcome: 'SUCCEEDED',
    });
    assert.ok(attribution.confidence <= 0.95);
  });

  it('buildEmptyAttribution: 产生低置信度归因', () => {
    const attribution = buildEmptyAttribution();
    assert.equal(attribution.confidence, 0.1);
    assert.equal(attribution.method, 'rule_based');
    assert.equal(attribution.contributingClaims.length, 0);
  });

  it('ATTRIBUTION_BUILDER_VERSION 是非空字符串', () => {
    assert.ok(ATTRIBUTION_BUILDER_VERSION.length > 0);
  });

  it('DEFAULT_ATTRIBUTION_WEIGHTS: toolFailureBoost > 0', () => {
    assert.ok(DEFAULT_ATTRIBUTION_WEIGHTS.toolFailureBoost > 0);
    assert.ok(DEFAULT_ATTRIBUTION_WEIGHTS.modelFailureBoost > 0);
  });

  it('buildOutcomeRecord: 自动构建 attribution', () => {
    const record = buildOutcomeRecord(makeRunFinalState());
    assert.ok(record.attribution);
    assert.equal(record.attribution!.method, 'rule_based');
    // attribution.confidence 不超过整体 confidence
    assert.ok(record.attribution!.confidence <= record.confidence);
  });

  it('buildOutcomeRecord: 接受显式 attribution', () => {
    const explicitAttribution = makeOutcomeAttribution({
      confidence: 0.3,
      explanation: 'explicit attribution',
    });
    const record = buildOutcomeRecord(makeRunFinalState({
      attribution: explicitAttribution,
    }));
    assert.equal(record.attribution?.explanation, 'explicit attribution');
  });
});

// ============================================================================
// Section 7: Recorder 错误处理
// ============================================================================

describe('OutcomeRecorder 错误处理', () => {
  it('无 executionId → 抛错', () => {
    assert.throws(
      () => buildOutcomeRecord(makeRunFinalState({ executionId: '' })),
      (err: unknown) => err instanceof OutcomeRecorderError && err.code === 'MISSING_EXECUTION_ID',
    );
  });

  it('无 observer → 抛错', () => {
    assert.throws(
      () => buildOutcomeRecord(makeRunFinalState({ observer: undefined as never })),
      (err: unknown) => err instanceof OutcomeRecorderError && err.code === 'MISSING_OBSERVER',
    );
  });

  it('无证据 → 抛错 (fail-closed)', () => {
    assert.throws(
      () => buildOutcomeRecord(makeRunFinalState({ evidenceRecords: [] })),
      (err: unknown) => err instanceof OutcomeRecorderError && err.code === 'NO_EVIDENCE',
    );
  });

  it('evidenceIds 去重', () => {
    const eid = createAwknId('evidence');
    const evidence = makeEvidenceRecord({ evidenceId: eid });
    const record = buildOutcomeRecord(makeRunFinalState({
      evidenceRecords: [evidence, { ...evidence }], // 重复 evidenceId
    }));
    // 去重后只剩一个
    assert.equal(record.evidenceIds.length, 1);
    assert.equal(record.evidenceIds[0], eid);
  });
});

// ============================================================================
// Section 8: Hash 稳定性
// ============================================================================

describe('Hash 稳定性', () => {
  it('相同内容（不同 outcomeId）产生相同 record hash', () => {
    const state = makeRunFinalState();
    const record1 = buildOutcomeRecord(state);
    // 复制 record1 但重新生成 outcomeId
    const record2: OutcomeRecord = {
      ...record1,
      outcomeId: createOutcomeId(),
    };
    const hash1 = computeOutcomeRecordHash(record1);
    const hash2 = computeOutcomeRecordHash(record2);
    assert.equal(hash1, hash2);
  });

  it('不同 executionOutcome 产生不同 hash', () => {
    const successRecord = buildOutcomeRecord(makeRunFinalState({ executionSucceeded: true }));
    const failedRecord = buildOutcomeRecord(makeRunFinalState({ executionSucceeded: false }));
    const hash1 = computeOutcomeRecordHash(successRecord);
    const hash2 = computeOutcomeRecordHash(failedRecord);
    assert.notEqual(hash1, hash2);
  });

  it('hash 是 64 位 hex 字符串', () => {
    const record = buildOutcomeRecord(makeRunFinalState());
    const hash = computeOutcomeRecordHash(record);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it('attribution hash 是 64 位 hex 字符串', () => {
    const attribution = buildRuleBasedAttribution({
      executionOutcome: 'SUCCEEDED',
      deliveryOutcome: 'SUCCEEDED',
    });
    const hash = computeOutcomeAttributionHash(attribution);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });
});

// ============================================================================
// Section 9: ID 生成
// ============================================================================

describe('ID 生成', () => {
  it('createOutcomeId 生成 out_ 前缀 ID', () => {
    const id = createOutcomeId();
    assert.match(id, /^out_[0-9a-f]{32}$/);
  });
});

// ============================================================================
// Section 10: 五层状态不可合并（综合测试）
// ============================================================================

describe('五层状态不可合并（综合测试）', () => {
  it('执行成功 + 交付成功 + 用户未采用 + 业务未观察 + 学习未观察', () => {
    const record = buildOutcomeRecord(makeRunFinalState({
      executionSucceeded: true,
      deliveryBundle: makeDeliveryBundle({ state: 'SUCCEEDED' }),
      adoptionSignal: null,
      businessSignal: null,
      learningSignal: null,
    }));
    assert.equal(record.executionOutcome, 'SUCCEEDED');
    assert.equal(record.deliveryOutcome, 'SUCCEEDED');
    assert.equal(record.adoptionOutcome, 'UNKNOWN');
    assert.equal(record.businessOutcome, 'UNKNOWN');
    assert.equal(record.learningOutcome, 'UNKNOWN');
  });

  it('执行失败 + 交付失败 + 学习成功（从失败中学习）', () => {
    const failedBundle = makeDeliveryBundle({ state: 'FAILED' });
    failedBundle.primaryDeliveryId = failedBundle.contracts[0]!.deliveryId;
    const record = buildOutcomeRecord(makeRunFinalState({
      executionSucceeded: false,
      deliveryBundle: failedBundle,
      learningSignal: 'LEARNED',
    }));
    assert.equal(record.executionOutcome, 'FAILED');
    assert.equal(record.deliveryOutcome, 'FAILED');
    assert.equal(record.learningOutcome, 'SUCCEEDED'); // 从失败中学习
  });

  it('执行取消 → CANCELLED', () => {
    const record = buildOutcomeRecord(makeRunFinalState({
      executionSucceeded: false,
      executionCancelled: true,
    }));
    assert.equal(record.executionOutcome, 'CANCELLED');
  });

  it('执行部分成功 → PARTIAL', () => {
    const record = buildOutcomeRecord(makeRunFinalState({
      executionSucceeded: true,
      executionPartial: true,
    }));
    assert.equal(record.executionOutcome, 'PARTIAL');
  });
});
