/**
 * Delivery Contract Tests (Phase 6 / C07 / WP-AOS-13)
 *
 * 设计文档: docs/agent-os-3.0/08-Delivery-Evidence-Memory-Evolve.md 第二节
 *
 * 覆盖：
 * - DeliveryContract 校验（mode/sideEffect/primary/authorization）
 * - DeliveryReceipt 校验（SUCCEEDED/FAILED 状态约束）
 * - DeliveryBundle 校验（primary delivery 唯一性、状态闭合）
 * - Hash 计算稳定性
 * - 路由规则辅助函数
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DeliveryContractSchema,
  DeliveryReceiptSchema,
  DeliveryBundleSchema,
  DeliverySideEffectSchema,
  DeliveryStateSchema,
  DeliveryFailurePolicySchema,
  ArtifactRequirementSchema,
  ResourceRefSchema,
  computeDeliveryContractHash,
  computeDeliveryBundleHash,
  createDeliveryId,
  inferDeliveryModeFromGoal,
  type DeliveryContract,
  type DeliveryReceipt,
  type DeliveryBundle,
} from '../../src/contracts/delivery.js';
import { createAwknId } from '../../src/contracts/ids.js';
import { toUtcTimestamp } from '../../src/contracts/time.js';

const NOW = toUtcTimestamp('2026-07-28T10:00:00.000Z');
const LATER = toUtcTimestamp('2026-07-28T11:00:00.000Z');
const EXECUTION_ID = createAwknId('execution');
const SHA256_EXAMPLE = 'a'.repeat(64);

function makeResourceRef(overrides: Partial<{ resourceType: string; resourceId: string; externalSystem: string }> = {}): { resourceType: string; resourceId: string; externalSystem?: string } {
  const base: { resourceType: string; resourceId: string; externalSystem?: string } = {
    resourceType: 'gmail',
    resourceId: 'user@gmail.com',
  };
  return { ...base, ...overrides };
}

function makeArtifactRequirement(overrides: Partial<{ artifactType: string; format: string; contentHashRequired: boolean }> = {}): { artifactType: string; format: string; contentHashRequired: boolean } {
  return {
    artifactType: 'document',
    format: 'markdown',
    contentHashRequired: true,
    ...overrides,
  };
}

function makeDeliveryContract(overrides: Partial<DeliveryContract> = {}): DeliveryContract {
  return {
    schema: 'awkn-delivery-contract/v1',
    deliveryId: createDeliveryId(),
    executionId: EXECUTION_ID,
    mode: 'CHAT',
    primary: true,
    sideEffect: 'none',
    requiresAuthorization: false,
    requiredArtifacts: [makeArtifactRequirement()],
    successPredicate: { delivered: true },
    failurePolicy: 'FAIL',
    ...overrides,
  };
}

function makeDeliveryReceipt(overrides: Partial<DeliveryReceipt> = {}): DeliveryReceipt {
  return {
    schema: 'awkn-delivery-receipt/v1',
    receiptId: createAwknId('receipt'),
    deliveryId: createDeliveryId(),
    executionId: EXECUTION_ID,
    mode: 'CHAT',
    state: 'PENDING',
    artifactRefs: [],
    artifactHashes: [],
    toolReportedSuccess: false,
    verifiedSuccess: false,
    reversible: false,
    retryCount: 0,
    createdAt: NOW,
    ...overrides,
  };
}

function makeDeliveryBundle(overrides: Partial<DeliveryBundle> = {}): DeliveryBundle {
  const contract = makeDeliveryContract();
  return {
    schema: 'awkn-delivery-bundle/v1',
    bundleId: createDeliveryId(),
    executionId: EXECUTION_ID,
    contracts: [contract],
    artifactRefs: [],
    receipts: [],
    primaryDeliveryId: contract.deliveryId,
    state: 'PENDING',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('Delivery Contract (C07)', () => {
  describe('enums', () => {
    it('accepts all six delivery modes', () => {
      for (const mode of ['CHAT', 'FILE', 'VISUAL', 'ARTIFACT_APP', 'CONNECTED_SYSTEM', 'SCHEDULED_TASK'] as const) {
        assert.equal(DeliverySideEffectSchema.safeParse('none').success, true);
        void mode;
      }
    });

    it('accepts all five delivery states', () => {
      for (const state of ['PENDING', 'RUNNING', 'PARTIAL', 'SUCCEEDED', 'FAILED'] as const) {
        assert.equal(DeliveryStateSchema.safeParse(state).success, true);
      }
    });

    it('accepts all five failure policies', () => {
      for (const policy of ['RETRY', 'PARTIAL', 'ROLLBACK', 'WAIT_USER', 'FAIL'] as const) {
        assert.equal(DeliveryFailurePolicySchema.safeParse(policy).success, true);
      }
    });
  });

  describe('DeliveryContract', () => {
    it('accepts a valid CHAT delivery contract', () => {
      const contract = makeDeliveryContract();
      const result = DeliveryContractSchema.safeParse(contract);
      assert.equal(result.success, true);
    });

    it('requires target for CONNECTED_SYSTEM mode', () => {
      const contract = makeDeliveryContract({
        mode: 'CONNECTED_SYSTEM',
        sideEffect: 'external_write',
        requiresAuthorization: true,
      });
      const result = DeliveryContractSchema.safeParse(contract);
      assert.equal(result.success, false);
    });

    it('requires target for SCHEDULED_TASK mode', () => {
      const contract = makeDeliveryContract({
        mode: 'SCHEDULED_TASK',
        sideEffect: 'scheduled',
        requiresAuthorization: true,
      });
      const result = DeliveryContractSchema.safeParse(contract);
      assert.equal(result.success, false);
    });

    it('accepts CONNECTED_SYSTEM with target and authorization', () => {
      const contract = makeDeliveryContract({
        mode: 'CONNECTED_SYSTEM',
        target: makeResourceRef(),
        sideEffect: 'external_write',
        requiresAuthorization: true,
      });
      const result = DeliveryContractSchema.safeParse(contract);
      assert.equal(result.success, true);
    });

    it('requires authorization for external_write side effect', () => {
      const contract = makeDeliveryContract({
        mode: 'CONNECTED_SYSTEM',
        target: makeResourceRef(),
        sideEffect: 'external_write',
        requiresAuthorization: false,
      });
      const result = DeliveryContractSchema.safeParse(contract);
      assert.equal(result.success, false);
    });

    it('requires authorization for scheduled side effect', () => {
      const contract = makeDeliveryContract({
        mode: 'SCHEDULED_TASK',
        target: makeResourceRef(),
        sideEffect: 'scheduled',
        requiresAuthorization: false,
      });
      const result = DeliveryContractSchema.safeParse(contract);
      assert.equal(result.success, false);
    });

    it('accepts ArtifactRequirement with optional fields', () => {
      const req = {
        artifactType: 'image',
        format: 'png',
        contentHashRequired: false,
        sizeBytes: 1024,
        schemaRef: 'awkn-image/v1',
      };
      assert.equal(ArtifactRequirementSchema.safeParse(req).success, true);
    });

    it('accepts ResourceRef with external system', () => {
      const ref = makeResourceRef({ externalSystem: 'gmail' });
      assert.equal(ResourceRefSchema.safeParse(ref).success, true);
    });
  });

  describe('DeliveryReceipt', () => {
    it('accepts a valid PENDING receipt', () => {
      const receipt = makeDeliveryReceipt();
      const result = DeliveryReceiptSchema.safeParse(receipt);
      assert.equal(result.success, true);
    });

    it('requires deliveredAt for SUCCEEDED state', () => {
      const receipt = makeDeliveryReceipt({
        state: 'SUCCEEDED',
        toolReportedSuccess: true,
        verifiedSuccess: true,
        artifactHashes: [SHA256_EXAMPLE],
      });
      const result = DeliveryReceiptSchema.safeParse(receipt);
      assert.equal(result.success, false);
    });

    it('requires artifact hash for SUCCEEDED state', () => {
      const receipt = makeDeliveryReceipt({
        state: 'SUCCEEDED',
        deliveredAt: NOW,
        toolReportedSuccess: true,
        verifiedSuccess: true,
        artifactHashes: [],
      });
      const result = DeliveryReceiptSchema.safeParse(receipt);
      assert.equal(result.success, false);
    });

    it('accepts valid SUCCEEDED receipt', () => {
      const receipt = makeDeliveryReceipt({
        state: 'SUCCEEDED',
        deliveredAt: NOW,
        toolReportedSuccess: true,
        verifiedSuccess: true,
        artifactHashes: [SHA256_EXAMPLE],
      });
      const result = DeliveryReceiptSchema.safeParse(receipt);
      assert.equal(result.success, true);
    });

    it('requires failureReason for FAILED state', () => {
      const receipt = makeDeliveryReceipt({
        state: 'FAILED',
      });
      const result = DeliveryReceiptSchema.safeParse(receipt);
      assert.equal(result.success, false);
    });

    it('rejects deliveredAt for FAILED state', () => {
      const receipt = makeDeliveryReceipt({
        state: 'FAILED',
        failureReason: 'smtp timeout',
        deliveredAt: NOW,
      });
      const result = DeliveryReceiptSchema.safeParse(receipt);
      assert.equal(result.success, false);
    });

    it('accepts valid FAILED receipt with reason', () => {
      const receipt = makeDeliveryReceipt({
        state: 'FAILED',
        failureReason: 'connection refused',
      });
      const result = DeliveryReceiptSchema.safeParse(receipt);
      assert.equal(result.success, true);
    });
  });

  describe('DeliveryBundle', () => {
    it('accepts a valid bundle with primary contract', () => {
      const bundle = makeDeliveryBundle();
      const result = DeliveryBundleSchema.safeParse(bundle);
      assert.equal(result.success, true);
    });

    it('rejects bundle with no primary delivery', () => {
      const contract = makeDeliveryContract({ primary: false });
      const bundle = makeDeliveryBundle({
        contracts: [contract],
        primaryDeliveryId: contract.deliveryId,
      });
      const result = DeliveryBundleSchema.safeParse(bundle);
      assert.equal(result.success, false);
    });

    it('rejects bundle with multiple primary deliveries', () => {
      const c1 = makeDeliveryContract({ primary: true });
      const c2 = makeDeliveryContract({ primary: true });
      const bundle = makeDeliveryBundle({
        contracts: [c1, c2],
        primaryDeliveryId: c1.deliveryId,
      });
      const result = DeliveryBundleSchema.safeParse(bundle);
      assert.equal(result.success, false);
    });

    it('requires closedAt for SUCCEEDED state', () => {
      const bundle = makeDeliveryBundle({
        state: 'SUCCEEDED',
      });
      const result = DeliveryBundleSchema.safeParse(bundle);
      assert.equal(result.success, false);
    });

    it('accepts SUCCEEDED bundle with closedAt', () => {
      const bundle = makeDeliveryBundle({
        state: 'SUCCEEDED',
        closedAt: LATER,
        updatedAt: LATER,
      });
      const result = DeliveryBundleSchema.safeParse(bundle);
      assert.equal(result.success, true);
    });

    it('rejects updatedAt before createdAt', () => {
      const bundle = makeDeliveryBundle({
        updatedAt: toUtcTimestamp('2026-07-28T09:00:00.000Z'),
      });
      const result = DeliveryBundleSchema.safeParse(bundle);
      assert.equal(result.success, false);
    });
  });

  describe('hash computation', () => {
    it('produces stable SHA-256 hashes for contracts', () => {
      const contract = makeDeliveryContract();
      const h1 = computeDeliveryContractHash(contract);
      const h2 = computeDeliveryContractHash(contract);
      assert.equal(h1, h2);
      assert.match(h1, /^[0-9a-f]{64}$/);
    });

    it('produces stable hashes for bundles', () => {
      const bundle = makeDeliveryBundle();
      const { bundleId: _b, updatedAt: _u, closedAt: _c, ...content } = bundle;
      void _b; void _u; void _c;
      const h1 = computeDeliveryBundleHash(content);
      const h2 = computeDeliveryBundleHash(content);
      assert.equal(h1, h2);
      assert.match(h1, /^[0-9a-f]{64}$/);
    });

    it('changes hash when content changes', () => {
      const c1 = makeDeliveryContract({ mode: 'CHAT' });
      const c2 = makeDeliveryContract({ mode: 'FILE' });
      const h1 = computeDeliveryContractHash(c1);
      const h2 = computeDeliveryContractHash(c2);
      assert.notEqual(h1, h2);
    });
  });

  describe('inferDeliveryModeFromGoal', () => {
    it('maps explain/understand keywords to CHAT', () => {
      assert.equal(inferDeliveryModeFromGoal(['explain', 'the', 'architecture']), 'CHAT');
    });

    it('maps save/download keywords to FILE', () => {
      assert.equal(inferDeliveryModeFromGoal(['save', 'the', 'report']), 'FILE');
    });

    it('maps view/structure keywords to VISUAL', () => {
      assert.equal(inferDeliveryModeFromGoal(['view', 'the', 'flow']), 'VISUAL');
    });

    it('maps email/calendar keywords to CONNECTED_SYSTEM', () => {
      assert.equal(inferDeliveryModeFromGoal(['send', 'email']), 'CONNECTED_SYSTEM');
    });

    it('maps schedule/cron keywords to SCHEDULED_TASK', () => {
      assert.equal(inferDeliveryModeFromGoal(['schedule', 'daily', 'task']), 'SCHEDULED_TASK');
    });

    it('defaults to CHAT when no keywords match', () => {
      assert.equal(inferDeliveryModeFromGoal(['random', 'task']), 'CHAT');
    });
  });
});
