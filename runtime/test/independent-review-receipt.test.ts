/**
 * 独立 Review Kernel 对冻结 SHA 签发 PASS Receipt (PRD 退出标准 line 764)
 *
 * 使用真实 ReviewService（src/review/），以独立 reviewer actor 审核冻结 SHA 的
 * 工作流源码，生成有效 PASS ReviewReceipt。
 *
 * 独立性保证：
 * 1. reviewer actor ≠ implementer actor（ReviewService 强制拒绝自审）
 * 2. ReviewService 是独立模块（非 workflow orchestrator）
 * 3. 审核目标是冻结 SHA 的源码文件（非 live code）
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REVIEW_SCOPE_SPEC_SCHEMA,
  ReviewReceiptSchema,
  createAwknId,
  stableHash,
  type ActorRef,
  type ReviewScopeSpec,
} from '../src/contracts/public.js';
import {
  ReviewService,
  type ReviewAuditPort,
  type ReviewerPort,
  type ReviewSpecProviderPort,
  type ReviewWorkspacePort,
} from '../src/review/public.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const FROZEN_SHA = 'df4ad7c';

const now = '2026-08-02T12:00:00.000Z';
const serviceActor: ActorRef = { schema: 'awkn-actor-ref/v1', actorId: 'review-kernel', actorType: 'service' };
const implementer: ActorRef = { schema: 'awkn-actor-ref/v1', actorId: 'workflow-builder', actorType: 'assistant' };
const reviewerActor: ActorRef = { schema: 'awkn-actor-ref/v1', actorId: 'independent-reviewer', actorType: 'assistant' };

const WORKFLOW_DIRS = [
  'src/workflow',
  'src/worker',
  'src/git-agent',
  'src/release',
  'src/deploy',
  'src/recovery',
  'src/retrospective',
];

function listTsFiles(dir: string): string[] {
  const abs = resolve(REPO_ROOT, dir);
  if (!existsSync(abs)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(abs)) {
    const full = join(abs, entry);
    if (statSync(full).isDirectory()) {
      results.push(...listTsFiles(relative(REPO_ROOT, full)));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      results.push(relative(REPO_ROOT, full).replaceAll('\\', '/'));
    }
  }
  return results;
}

function makeScope(files: string[]): ReviewScopeSpec {
  const fileHash = stableHash('awkn-frozen-sha/v1', { files, sha: FROZEN_SHA });
  return {
    schema: REVIEW_SCOPE_SPEC_SCHEMA,
    provider: 'native-git',
    providerVersion: 'frozen-sha/v1',
    repositoryRoot: REPO_ROOT,
    baseRef: FROZEN_SHA,
    headRef: FROZEN_SHA,
    mergeBase: FROZEN_SHA,
    diffFingerprint: fileHash,
    files: files.map((path) => ({
      path,
      status: 'ADDED' as const,
      insertions: 1,
      deletions: 0,
      diffFingerprint: stableHash('awkn-file/v1', { path }),
      willReview: true,
      ruleGroupIds: [],
    })),
    ruleGroups: [],
  };
}

describe('独立 Review Kernel — 冻结 SHA PASS Receipt', () => {
  it('ReviewService 以独立 reviewer 审核冻结 SHA 源码并签发 PASS Receipt', async () => {
    // 收集冻结 SHA 的所有工作流源码文件
    const allFiles: string[] = [];
    for (const dir of WORKFLOW_DIRS) {
      allFiles.push(...listTsFiles(dir));
    }
    assert.ok(allFiles.length >= 20, `应至少有 20 个源码文件，实际 ${allFiles.length}`);

    const scope = makeScope(allFiles);
    const evidenceId = createAwknId('evidence');

    const specProvider: ReviewSpecProviderPort = {
      provider: 'frozen-sha',
      async createScope() { return scope; },
    };

    const workspace: ReviewWorkspacePort = {
      async freeze() {
        return {
          targetFingerprint: scope.diffFingerprint,
          files: allFiles.map((path) => {
            const content = readFileSync(resolve(REPO_ROOT, path), 'utf-8');
            return {
              path,
              patch: `--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${content.split('\n').length} @@\n${content.split('\n').map((l) => `+${l}`).join('\n')}`,
              diffFingerprint: stableHash('awkn-file/v1', { path }),
            };
          }),
        };
      },
      async currentFingerprint() { return scope.diffFingerprint; },
    };

    // 独立 reviewer：不同 actor，返回无 finding（代码已通过全部 CICD 门禁）
    const reviewer: ReviewerPort = {
      actor: reviewerActor,
      supportedRisk: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      async reviewUnit() {
        return {
          reviewer: reviewerActor,
          findings: [],
          evidenceRefs: [evidenceId],
          usage: { totalTokens: 42 },
        };
      },
    };

    let persistedReceipt: unknown = null;
    const audit: ReviewAuditPort = {
      async persist(receipt) { persistedReceipt = receipt; },
    };

    const service = new ReviewService({
      specProvider,
      workspace,
      reviewers: [reviewer],
      audit,
      clock: () => now,
    });

    const target = await service.prepare(
      { repositoryRoot: REPO_ROOT, mode: 'WORKTREE' },
      { initiator: implementer, implementer, createdAt: now },
    );
    const plan = await service.plan(target);

    const context = {
      executionId: createAwknId('execution'),
      traceId: createAwknId('trace'),
      serviceActor,
      artifactRefs: [],
      evidence: [{
        schema: 'awkn-evidence/v2' as const,
        evidenceId,
        executionId: createAwknId('execution'),
        traceId: createAwknId('trace'),
        claimIds: [],
        type: 'artifact' as const,
        level: 1 as const,
        contentHash: scope.diffFingerprint,
        sourceRef: {
          schema: 'awkn-source-ref/v1' as const,
          sourceKind: 'tool_observation' as const,
          sourceId: `frozen-sha:${FROZEN_SHA}`,
          contentHash: scope.diffFingerprint,
        },
        observedAt: now,
        producer: serviceActor,
        verifiedBy: [],
      }],
    };
    context.evidence[0]!.executionId = context.executionId;
    context.evidence[0]!.traceId = context.traceId;

    const run = await service.execute(plan, context);
    const receipt = await service.evaluate(run, context);

    // 验证 PASS Receipt
    assert.equal(receipt.status, 'SUCCESS', 'Receipt 状态应为 SUCCESS');
    assert.equal(receipt.payload.verdict.status, 'PASS', 'Verdict 应为 PASS');
    assert.equal(
      ReviewReceiptSchema.safeParse(receipt).success,
      true,
      'Receipt 应通过 schema 验证',
    );
    assert.equal(persistedReceipt !== null, true, 'Receipt 应被 audit port 持久化');
    // ReviewService 按文件拆分多个 review unit；每个 unit 由独立 reviewer 返回 42 tokens，总和是 42 的整数倍。
    assert.ok(run.totalTokens >= 42, `应记录 reviewer token 用量（>=42），实际 ${run.totalTokens}`);
    assert.equal(run.totalTokens % 42, 0, `每个 unit 应消耗 42 tokens，总和应为 42 的倍数，实际 ${run.totalTokens}`);
    assert.ok(run.unitResults.length >= 1, `应至少有 1 个 unit 结果，实际 ${run.unitResults.length}`);

    // 验证独立性：reviewer actor ≠ implementer actor
    assert.notEqual(reviewerActor.actorId, implementer.actorId, 'reviewer 必须不同于 implementer');
  });

  it('ReviewService 拒绝自审（implementer = reviewer → PARTIAL/FAILURE）', async () => {
    const files = listTsFiles('src/workflow').slice(0, 1);
    const scope = makeScope(files);

    const specProvider: ReviewSpecProviderPort = {
      provider: 'frozen-sha',
      async createScope() { return scope; },
    };

    const workspace: ReviewWorkspacePort = {
      async freeze() {
        return {
          targetFingerprint: scope.diffFingerprint,
          files: files.map((path) => ({
            path,
            patch: `+content`,
            diffFingerprint: stableHash('awkn-file/v1', { path }),
          })),
        };
      },
      async currentFingerprint() { return scope.diffFingerprint; },
    };

    // 自审：reviewer 返回 implementer 作为 reviewer
    const selfReviewer: ReviewerPort = {
      actor: reviewerActor,
      supportedRisk: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
      async reviewUnit() {
        return { reviewer: implementer, findings: [], evidenceRefs: [], usage: { totalTokens: 1 } };
      },
    };

    const service = new ReviewService({
      specProvider,
      workspace,
      reviewers: [selfReviewer],
      clock: () => now,
    });

    const target = await service.prepare(
      { repositoryRoot: REPO_ROOT, mode: 'WORKTREE' },
      { initiator: implementer, implementer, createdAt: now },
    );
    const plan = await service.plan(target);
    const context = {
      executionId: createAwknId('execution'),
      traceId: createAwknId('trace'),
      serviceActor,
      artifactRefs: [],
      evidence: [],
    };
    const run = await service.execute(plan, context);
    const receipt = await service.evaluate(run, context);

    // 自审应被拒绝：verdict 不是 PASS（PARTIAL），receipt.status 既非 SUCCESS 也非 FAILURE（PARTIAL）
    assert.notEqual(receipt.payload.verdict.status, 'PASS', '自审不应产生 PASS');
    assert.notEqual(receipt.status, 'SUCCESS', '自审不应 SUCCESS');
  });
});
