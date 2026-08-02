/**
 * Worker Lease 管理测试 — 创建、查询、续约、释放、回收
 *
 * 覆盖: createLease, getLease, getActiveLeaseByStageRun, renewLease,
 *       releaseLease, isLeaseValid, reclaimExpiredLeases
 *
 * 对应源码: src/worker/lease-manager.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { closeDb, getDb } from '../src/store/db.js';
import {
  createLease,
  getLease,
  getActiveLeaseByStageRun,
  renewLease,
  releaseLease,
  isLeaseValid,
  reclaimExpiredLeases,
} from '../src/worker/lease-manager.js';

// ─── 测试 DB 隔离 ─────────────────────────────────────────

let tempDir: string | undefined;

async function setupIsolatedDb(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'wf-lease-'));
  process.env.AWKN_DB_PATH = join(tempDir, `${randomUUID()}.db`);
  closeDb();
  getDb();
}

async function cleanupIsolatedDb(): Promise<void> {
  closeDb();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('Worker lease management', () => {
  before(async () => {
    await setupIsolatedDb();
  });

  after(async () => {
    await cleanupIsolatedDb();
  });

  it('createLease returns LeaseInfo with active state', () => {
    const lease = createLease('srun_lease_1', 'actor_1', 'prun_1', 60_000);
    assert.equal(lease.state, 'active');
    assert.equal(lease.stageRunId, 'srun_lease_1');
    assert.equal(lease.actorId, 'actor_1');
    assert.equal(lease.providerRunId, 'prun_1');
    assert.ok(lease.leaseId);
    assert.ok(lease.expiresAt);
  });

  it('getLease returns created lease', () => {
    const lease = createLease('srun_lease_2', 'actor_2', 'prun_2', 60_000);
    const fetched = getLease(lease.leaseId);
    assert.ok(fetched);
    assert.equal(fetched!.leaseId, lease.leaseId);
    assert.equal(fetched!.stageRunId, 'srun_lease_2');
    assert.equal(fetched!.actorId, 'actor_2');
  });

  it('getActiveLeaseByStageRun returns active lease', () => {
    const lease = createLease('srun_lease_3', 'actor_3', 'prun_3', 60_000);
    const active = getActiveLeaseByStageRun('srun_lease_3');
    assert.ok(active);
    assert.equal(active!.leaseId, lease.leaseId);
    assert.equal(active!.state, 'active');
  });

  it('renewLease extends expiry', () => {
    const lease = createLease('srun_lease_4', 'actor_4', 'prun_4', 1_000);
    const originalExpiry = lease.expiresAt;
    const renewed = renewLease(lease.leaseId, 60_000);
    assert.ok(renewed);
    assert.equal(renewed!.state, 'active');
    assert.ok(
      new Date(renewed!.expiresAt).getTime() >= new Date(originalExpiry).getTime(),
    );
  });

  it('releaseLease sets state to released', () => {
    const lease = createLease('srun_lease_5', 'actor_5', 'prun_5', 60_000);
    const result = releaseLease(lease.leaseId);
    assert.equal(result, true);
    const fetched = getLease(lease.leaseId);
    assert.ok(fetched);
    assert.equal(fetched!.state, 'released');
  });

  it('isLeaseValid returns true for active, false for released', () => {
    const activeLease = createLease('srun_lease_6', 'actor_6', 'prun_6', 60_000);
    assert.equal(isLeaseValid(activeLease.leaseId), true);

    const releasedLease = createLease('srun_lease_7', 'actor_7', 'prun_7', 60_000);
    releaseLease(releasedLease.leaseId);
    assert.equal(isLeaseValid(releasedLease.leaseId), false);
  });

  it('reclaimExpiredLeases reclaims expired leases', async () => {
    const lease = createLease('srun_lease_8', 'actor_8', 'prun_8', 1);
    // Wait for lease to expire
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reclaimed = reclaimExpiredLeases();
    assert.ok(reclaimed.includes(lease.leaseId));
    const fetched = getLease(lease.leaseId);
    assert.ok(fetched);
    assert.equal(fetched!.state, 'reclaimed');
  });

  it('createLease generates unique leaseId', () => {
    const lease1 = createLease('srun_lease_9', 'actor_9', 'prun_9', 60_000);
    const lease2 = createLease('srun_lease_10', 'actor_10', 'prun_10', 60_000);
    assert.notEqual(lease1.leaseId, lease2.leaseId);
  });
});
