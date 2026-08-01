import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it, after } from 'node:test';
import Database from 'better-sqlite3';
import { runAgentOsMigrations } from '../src/store/agent-os-migration-registry.js';
import { closeDb, getDb } from '../src/store/db.js';
import { CorrectionsLedger } from '../src/evolve/corrections-ledger.js';
import { EventStore, EVENT_STREAM_SCHEMA } from '../src/workflow/event-store.js';
import { backoffDelayMs, isTransientError, shouldRetry } from '../src/core/retry-policy.js';
import { allocateRiskBudget } from '../src/review/application/review-planner.js';
import { ReviewCache } from '../src/review/application/review-cache.js';
import { runPreflight } from '../src/review/application/preflight.js';

before(() => {
  process.env.AWKN_DB_PATH = join(mkdtempSync(join(tmpdir(), 'absorb-p1-')), 'test.db');
  closeDb();
  getDb();
});

after(() => {
  delete process.env.AWKN_DB_PATH;
  closeDb();
});

function db(): Database.Database {
  const instance = new Database(':memory:');
  instance.pragma('foreign_keys = ON');
  runAgentOsMigrations(instance);
  return instance;
}

// ─── P1-1 风险预算分配 ─────────────────────────────────────────────

describe('P1-1 risk budget allocation', () => {
  const units = [
    { unitId: 'runit_a', risk: 'CRITICAL' as const },
    { unitId: 'runit_b', risk: 'HIGH' as const },
    { unitId: 'runit_c', risk: 'LOW' as const },
  ];

  it('按风险权重分配预算（4:2:0.5）', () => {
    const budget = allocateRiskBudget(units, 650);
    assert.equal(budget.runit_a, Math.floor(650 * 4 / 6.5));
    assert.equal(budget.runit_b, Math.floor(650 * 2 / 6.5));
    assert.ok(budget.runit_c < budget.runit_b);
    const total = Object.values(budget).reduce((sum, v) => sum + v, 0);
    assert.equal(total, 650);
  });

  it('空 units 或非正预算返回空映射', () => {
    assert.deepEqual(allocateRiskBudget([], 100), {});
    assert.deepEqual(allocateRiskBudget(units, 0), {});
  });

  it('总权重 0 时平均分配', () => {
    const allLow = units.map((unit) => ({ ...unit, risk: 'LOW' as const }));
    const budget = allocateRiskBudget(allLow, 300);
    assert.equal(budget.runit_a, 100);
    assert.equal(budget.runit_b, 100);
    assert.equal(budget.runit_c, 100);
  });
});

// ─── P1-2 事件流版本化 ─────────────────────────────────────────────

describe('P1-2 event stream versioning', () => {
  it('写入的事件 payload 内嵌 awkn-event-stream/v1', () => {
    const es = new EventStore();
    const run = es.createRun({ workflowName: 'wf', payload: { key: 'value' } });
    es.transitionRun(run.id, 'running');
    const row = getDb().prepare('SELECT payload_json FROM events WHERE event_type = ?')
      .get('run.created') as { payload_json: string };
    const payload = JSON.parse(row.payload_json);
    assert.equal(payload._eventSchema, EVENT_STREAM_SCHEMA);
    assert.equal(EventStore.eventSchemaVersion(payload), EVENT_STREAM_SCHEMA);
    assert.equal(EventStore.eventSchemaVersion({}), null);
  });
});

// ─── P1-3 瞬态错误重试 ─────────────────────────────────────────────

describe('P1-3 transient-error retry policy', () => {
  it('识别 HTTP 429/5xx 为瞬态', () => {
    assert.equal(isTransientError(Object.assign(new Error('upstream'), { status: 429 })), true);
    assert.equal(isTransientError(Object.assign(new Error('boom'), { status: 503 })), true);
    assert.equal(isTransientError(Object.assign(new Error('bad request'), { status: 400 })), false);
    assert.equal(isTransientError(Object.assign(new Error('unauthorized'), { status: 401 })), false);
  });

  it('识别网络 errno/rate-limit 文案为瞬态', () => {
    assert.equal(isTransientError(Object.assign(new Error('connect'), { errno: 'ECONNRESET' })), true);
    assert.equal(isTransientError(Object.assign(new Error('connect'), { code: 'ETIMEDOUT' })), true);
    assert.equal(isTransientError(new Error('rate limit exceeded, try again later')), true);
    assert.equal(isTransientError(new Error('syntax error: unexpected token')), false);
  });

  it('shouldRetry 受次数上限约束', () => {
    const transient = Object.assign(new Error('x'), { status: 503 });
    assert.equal(shouldRetry(transient, 1, 3), true);
    assert.equal(shouldRetry(transient, 3, 3), false);
    assert.equal(shouldRetry(new Error('permanent'), 1, 3), false);
  });

  it('backoff 指数增长且不超上限', () => {
    assert.ok(backoffDelayMs(1) >= 1);
    assert.ok(backoffDelayMs(3, 1000, 5000) <= 5000);
    assert.ok(backoffDelayMs(4, 1000, 60_000) <= 60_000);
  });
});

// ─── P1-4 指纹缓存 ─────────────────────────────────────────────────

describe('P1-4 review cache by fingerprint + rule bundle', () => {
  const fp = 'a'.repeat(64);
  const bundle = 'b'.repeat(64);

  function receipt(status: 'PASS' | 'FAIL'): any {
    const payload = {
      schema: 'awkn-review-receipt/v1',
      reviewRunId: `rr_${randomUUID()}`,
      targetFingerprint: fp,
      planHash: 'p'.repeat(64),
      ruleBundleHash: bundle,
      reviewerActors: [],
      findings: [],
      coverage: { schema: 'awkn-review-coverage/v1', files: [], units: [] },
      verdict: {
        schema: 'awkn-review-verdict/v1',
        status,
        reasonCodes: status === 'PASS' ? ['OK'] : ['BLOCKING_FINDING'],
        blockerFindingIds: [],
        coverage: { files: [], units: [] },
        evaluatedAt: new Date().toISOString(),
      },
      evidenceRefs: [],
    };
    return {
      schema: 'awkn-receipt-envelope/v1',
      receiptId: `rcpt_${randomUUID()}`,
      payloadSchema: 'awkn-review-receipt/v1',
      executionId: `ex_${randomUUID()}`,
      traceId: `tr_${randomUUID()}`,
      aggregateType: 'review',
      aggregateId: 'agg',
      producer: { schema: 'awkn-actor-ref/v1', actorId: 'service:test', actorType: 'service' },
      status: status === 'PASS' ? 'SUCCESS' : 'FAILURE',
      payload,
      payloadHash: 'f'.repeat(64),
      artifactRefs: [],
      createdAt: new Date().toISOString(),
    };
  }

  it('同指纹同规则包命中并自增 hit_count', () => {
    const instance = db();
    const cache = new ReviewCache(instance);
    assert.equal(cache.lookup(fp, bundle), null);
    cache.store(fp, bundle, receipt('PASS'));
    const hit = cache.lookup(fp, bundle);
    assert.ok(hit !== null);
    assert.equal(hit.receipt.payload.verdict.status, 'PASS');
    assert.equal(cache.lookup(fp, bundle)!.entry.hit_count, 2);
  });

  it('指纹或规则包任一变化即失配', () => {
    const instance = db();
    const cache = new ReviewCache(instance);
    cache.store(fp, bundle, receipt('PASS'));
    assert.equal(cache.lookup('c'.repeat(64), bundle), null);
    assert.equal(cache.lookup(fp, 'd'.repeat(64)), null);
  });

  it('仅缓存 PASS（FAIL 结果不入缓存）', () => {
    const instance = db();
    const cache = new ReviewCache(instance);
    cache.store(fp, bundle, receipt('FAIL'));
    assert.equal(cache.lookup(fp, bundle), null);
  });

  it('stats 统计条目与命中', () => {
    const instance = db();
    const cache = new ReviewCache(instance);
    cache.store(fp, bundle, receipt('PASS'));
    cache.lookup(fp, bundle);
    assert.deepEqual(cache.stats(), { entries: 1, hits: 1 });
  });
});

// ─── P1-5 执行预检 ─────────────────────────────────────────────────

describe('P1-5 preflight checks', () => {
  const file = (path: string, extra: Partial<{ insertions: number; deletions: number; willReview: boolean }> = {}) => ({
    path,
    status: 'MODIFIED',
    insertions: extra.insertions ?? 1,
    deletions: extra.deletions ?? 0,
    willReview: extra.willReview ?? true,
    ruleGroupIds: [],
  });

  it('规模超限 BLOCK', () => {
    const many = Array.from({ length: 301 }, (_, index) => file(`src/f${index}.ts`));
    assert.equal(runPreflight(many).verdict, 'BLOCK');
    const big = [file('src/big.ts', { insertions: 20_001 })];
    assert.equal(runPreflight(big).verdict, 'BLOCK');
  });

  it('敏感/生成物/二进制标记 WARN', () => {
    const files = [
      file('.env.local'),
      file('data/secret.db'),
      file('dist/bundle.min.js'),
      file('assets/icon.png'),
    ];
    const report = runPreflight(files);
    assert.equal(report.verdict, 'WARN');
    const codes = report.issues.map((issue) => issue.code);
    assert.ok(codes.includes('SENSITIVE_PATH'));
    assert.ok(codes.includes('GENERATED_PATH'));
    assert.ok(codes.includes('BINARY_PATH'));
  });

  it('正常变更 PASS', () => {
    const report = runPreflight([file('src/app.ts')]);
    assert.equal(report.verdict, 'PASS');
    assert.equal(report.issues.length, 0);
    assert.equal(report.summary.reviewableFiles, 1);
  });

  it('非 reviewable 文件不计入规模', () => {
    const files = [file('docs/readme.md', { willReview: false, insertions: 5000 })];
    const report = runPreflight(files);
    assert.equal(report.summary.reviewableFiles, 0);
    assert.equal(report.verdict, 'PASS');
  });

  it('附加敏感模式生效', () => {
    const report = runPreflight([file('internal/vault.txt')], {
      extraSensitivePatterns: [/(^|\/)vault/i],
    });
    assert.equal(report.verdict, 'WARN');
    assert.equal(report.issues[0]!.code, 'SENSITIVE_PATH');
  });
});

// ─── P1-6 指纹整改闭环 ─────────────────────────────────────────────

describe('P1-6 fingerprint-driven remediation', () => {
  it('verifyByFingerprint 将 open/resolved 升级为 verified', () => {
    const ledger = new CorrectionsLedger();
    const first = ledger.record({ source: 'reviewGate', errorText: 'missing null check' });
    const second = ledger.record({ source: 'reviewGate', errorText: 'missing null check' });
    assert.equal(ledger.fingerprintHealth(first.fingerprint).open, 2);
    ledger.resolve(first.id, 'fixed in commit abc');
    const updated = ledger.verifyByFingerprint(first.fingerprint, 'review rr_1');
    assert.equal(updated, 2);
    const health = ledger.fingerprintHealth(first.fingerprint);
    assert.equal(health.verified, 2);
    assert.equal(health.open, 0);
    assert.equal(health.resolved, 0);
    assert.equal(ledger.read(second.id)!.status, 'verified');
  });

  it('fingerprintHealth 未知指纹返回零视图', () => {
    const health = new CorrectionsLedger().fingerprintHealth('f'.repeat(16));
    assert.equal(health.total, 0);
    assert.equal(health.verified, 0);
  });
});
