import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  EvidenceRecordSchema,
  REVIEW_PLAN_SCHEMA,
  REVIEW_RUN_SCHEMA,
  REVIEW_TARGET_SCHEMA,
  ReviewPlanSchema,
  ReviewRunSchema,
  ReviewTargetSchema,
  computeReviewPlanHash,
  computeReviewRuleBundleHash,
  createAwknId,
  deterministicReviewId,
  type ActorRef,
  type ObjectRef,
  type ReviewPlan,
  type ReviewReceipt,
  type ReviewRun,
  type ReviewTarget,
} from '../contracts/public.js';
import type { LlmProvider } from '../llm/types.js';
import {
  NativeGitReviewAdapter,
  OcrCliSpecProvider,
  OcrRangeWorkspaceAdapter,
  ReviewCache,
  ReviewService,
  buildReviewReceipt,
  calculateReviewCoverage,
  calculateReviewVerdict,
  runPreflight,
  type OcrCliSpecProviderOptions,
} from '../review/public.js';
import type { ReviewExecutionContext } from '../review/ports/inbound/review-service-port.js';
import { LlmReviewerAdapter } from './llm-reviewer-adapter.js';
import { SqliteReviewAuditAdapter } from './sqlite-review-audit-adapter.js';
import type { LlmRouter } from '../llm/router.js';

export type ReviewRolloutMode = '0' | 'shadow' | 'enforce';

export interface ReviewContractInput {
  readonly kind: 'PRD' | 'SPEC' | 'ACCEPTANCE_CRITERION';
  readonly ref: ObjectRef;
  readonly content: string;
}

export function parseReviewRolloutMode(value: string | undefined): ReviewRolloutMode {
  if (value === undefined || value === '') return '0';
  if (value === '0' || value === 'shadow' || value === 'enforce') return value;
  throw new Error(`AWKN_REVIEW_OCR_V1 must be 0, shadow, or enforce; got ${value}`);
}

export interface WorktreeReviewInput {
  readonly repositoryRoot: string;
  readonly mode: Exclude<ReviewRolloutMode, '0'>;
  readonly router: LlmRouter;
  readonly reviewerProvider: LlmProvider;
  readonly implementer: ActorRef;
  readonly db: Database.Database;
  readonly createdAt?: string;
  readonly contractArtifacts?: readonly ReviewContractInput[];
  readonly baseRef?: string;
  readonly headRef?: string;
  readonly ocr?: OcrCliSpecProviderOptions;
  /** P1-4 指纹缓存开关（默认开启；测试可关闭） */
  readonly useCache?: boolean;
  /** P1-1 风险预算：review token 预算，用于计划预算分配 */
  readonly budgetTokens?: number;
  /** P1-5 执行预检开关（默认开启；测试可关闭） */
  readonly preflight?: boolean;
}

export interface WorktreeReviewResult {
  readonly receipt: ReviewReceipt;
  readonly totalTokens: number;
  readonly executionId: string;
  readonly traceId: string;
  readonly serviceActor: ActorRef;
}

interface FailureContext {
  readonly input: WorktreeReviewInput;
  readonly executionId: string;
  readonly traceId: string;
  readonly serviceActor: ActorRef;
  readonly now: string;
  readonly error: unknown;
  readonly target?: ReviewTarget;
}

function placeholderTargetFingerprint(input: WorktreeReviewInput, now: string): string {
  return createHash('sha256')
    .update(`${input.repositoryRoot}\0${input.baseRef ?? 'WORKTREE'}\0${input.headRef ?? 'WORKTREE'}\0${now}`)
    .digest('hex');
}

function buildFailureContext(
  executionId: string,
  traceId: string,
  serviceActor: ActorRef,
): ReviewExecutionContext {
  return {
    executionId,
    traceId,
    serviceActor,
    artifactRefs: [],
    evidence: [],
  };
}

/**
 * 通道失败隔离（P0-3）：任一通道（spec/plan 准备、reviewer 执行、审计持久化）
 * 失败都必须形成结构化覆盖缺口并产出 PARTIAL/FAIL receipt，
 * 禁止裸异常绕过审核结论。
 */
export async function failingReviewResult(
  service: ReviewService,
  failure: FailureContext,
): Promise<WorktreeReviewResult> {
  const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
  const target = failure.target ?? ReviewTargetSchema.parse({
    schema: REVIEW_TARGET_SCHEMA,
    targetId: deterministicReviewId('rtgt', placeholderTargetFingerprint(failure.input, failure.now)),
    mode: failure.input.baseRef !== undefined ? 'COMMIT_RANGE' : 'WORKTREE',
    repositoryRoot: failure.input.repositoryRoot,
    baseRef: failure.input.baseRef ?? 'PLANNING_FAILED',
    headRef: failure.input.headRef ?? 'PLANNING_FAILED',
    mergeBase: 'PLANNING_FAILED',
    diffFingerprint: placeholderTargetFingerprint(failure.input, failure.now),
    prdRefs: (failure.input.contractArtifacts ?? []).filter((artifact) => artifact.kind === 'PRD').map((artifact) => artifact.ref),
    specRefs: (failure.input.contractArtifacts ?? []).filter((artifact) => artifact.kind === 'SPEC').map((artifact) => artifact.ref),
    acceptanceCriteriaRefs: (failure.input.contractArtifacts ?? [])
      .filter((artifact) => artifact.kind === 'ACCEPTANCE_CRITERION').map((artifact) => artifact.ref),
    includePatterns: [],
    excludePatterns: [],
    initiator: failure.serviceActor,
    implementer: failure.input.implementer,
    createdAt: failure.now,
  });
  const base = {
    target,
    provider: 'native-git' as const,
    providerVersion: 'native-git/v1',
    ruleBundleHash: computeReviewRuleBundleHash([]),
    files: [],
    ruleGroups: [],
    units: [],
  };
  const planHash = computeReviewPlanHash(base);
  const plan = ReviewPlanSchema.parse({
    schema: REVIEW_PLAN_SCHEMA,
    planId: deterministicReviewId('rplan', planHash),
    ...base,
    planHash,
    createdAt: failure.now,
  });
  const run = ReviewRunSchema.parse({
    schema: REVIEW_RUN_SCHEMA,
    reviewRunId: createAwknId('reviewRun'),
    plan,
    providerStatus: 'INVALID',
    providerError: message,
    currentTargetFingerprint: target.diffFingerprint,
    unitResults: [],
    findings: [],
    validationErrors: [],
    totalTokens: 0,
    startedAt: failure.now,
    completedAt: failure.now,
  });
  const context = buildFailureContext(failure.executionId, failure.traceId, failure.serviceActor);
  try {
    const receipt = await service.evaluate(run, context);
    return { receipt, totalTokens: 0, executionId: context.executionId, traceId: context.traceId, serviceActor: context.serviceActor };
  } catch (persistError) {
    const coverage = calculateReviewCoverage(plan, run);
    const verdict = calculateReviewVerdict(run, coverage, failure.now);
    const receipt = buildReviewReceipt({
      executionId: context.executionId,
      traceId: context.traceId,
      producer: context.serviceActor,
      run,
      coverage,
      verdict,
      artifactRefs: [],
      createdAt: failure.now,
    });
    return { receipt, totalTokens: 0, executionId: context.executionId, traceId: context.traceId, serviceActor: context.serviceActor };
  }
}

export async function runStructuredWorktreeReview(input: WorktreeReviewInput): Promise<WorktreeReviewResult> {
  const now = input.createdAt ?? new Date().toISOString();
  const executionId = createAwknId('execution');
  const traceId = createAwknId('trace');
  const serviceActor: ActorRef = {
    schema: 'awkn-actor-ref/v1',
    actorId: 'service:awkn-review-kernel/v1',
    actorType: 'service',
  };
  const git = new NativeGitReviewAdapter();
  const isRange = input.baseRef !== undefined || input.headRef !== undefined;
  if (isRange && (input.baseRef === undefined || input.headRef === undefined)) {
    throw new Error('baseRef and headRef must be provided together');
  }
  if (isRange && input.ocr === undefined) throw new Error('COMMIT_RANGE enforce requires pinned OCR configuration');
  const specProvider = isRange ? new OcrCliSpecProvider(input.ocr!) : git;
  const baseWorkspace = isRange ? new OcrRangeWorkspaceAdapter(specProvider, git) : git;
  const contractArtifacts = input.contractArtifacts ?? [];
  for (const artifact of contractArtifacts) {
    if (artifact.ref.contentHash === undefined) throw new Error(`contract ${artifact.ref.objectId} requires contentHash`);
    const actual = createHash('sha256').update(artifact.content).digest('hex');
    if (actual !== artifact.ref.contentHash) throw new Error(`contract content hash mismatch: ${artifact.ref.objectId}`);
  }
  const workspace = {
    async freeze(target: Parameters<NativeGitReviewAdapter['freeze']>[0]) {
      const frozen = await baseWorkspace.freeze(target);
      return { ...frozen, contracts: contractArtifacts.map(({ ref, content }) => ({ ref, content })) };
    },
    currentFingerprint: (plan: Parameters<NativeGitReviewAdapter['currentFingerprint']>[0]) =>
      baseWorkspace.currentFingerprint(plan),
  };
  const audit = new SqliteReviewAuditAdapter(input.db);
  audit.ensureExecution({
    executionId,
    traceId,
    actor: serviceActor,
    repositoryRoot: input.repositoryRoot,
    rolloutMode: input.mode,
    createdAt: now,
  });
  const reviewer = new LlmReviewerAdapter({
    provider: input.reviewerProvider,
    traceId: traceId.slice('tr_'.length),
    chat: (request) => input.router.chat(request),
  });
  const service = new ReviewService({
    specProvider,
    workspace,
    reviewers: [reviewer],
    audit,
  });
  let target: ReviewTarget;
  try {
    target = await service.prepare({
      repositoryRoot: input.repositoryRoot,
      mode: isRange ? 'COMMIT_RANGE' : 'WORKTREE',
      ...(isRange ? { baseRef: input.baseRef!, headRef: input.headRef! } : {}),
    }, {
      initiator: serviceActor,
      implementer: input.implementer,
      prdRefs: contractArtifacts.filter((artifact) => artifact.kind === 'PRD').map((artifact) => artifact.ref),
      specRefs: contractArtifacts.filter((artifact) => artifact.kind === 'SPEC').map((artifact) => artifact.ref),
      acceptanceCriteriaRefs: contractArtifacts
        .filter((artifact) => artifact.kind === 'ACCEPTANCE_CRITERION').map((artifact) => artifact.ref),
      createdAt: now,
    });
  } catch (error) {
    return failingReviewResult(service, { input, executionId, traceId, serviceActor, now, error });
  }
  let plan: ReviewPlan;
  try {
    plan = await service.plan(target);
  } catch (error) {
    return failingReviewResult(service, { input, executionId, traceId, serviceActor, now, error, target });
  }

  // P1-5 执行预检：规模/敏感/生成物/二进制；BLOCK → 拒绝进入 LLM review
  if (input.preflight !== false) {
    const preflightReport = runPreflight(plan.files);
    if (preflightReport.verdict === 'BLOCK') {
      return failingReviewResult(service, {
        input,
        executionId,
        traceId,
        serviceActor,
        now,
        error: new Error(
          `preflight BLOCKED review: ${preflightReport.issues
            .filter((issue) => issue.severity === 'BLOCK')
            .map((issue) => issue.message)
            .join('; ')}`,
        ),
        target,
      });
    }
  }

  // P1-4 指纹缓存：同一 diff + 同一规则包直接复用历史 PASS receipt
  const reviewCache = new ReviewCache(input.db);
  if (input.useCache !== false) {
    const cached = reviewCache.lookup(target.diffFingerprint, plan.ruleBundleHash);
    if (cached !== null && cached.receipt.payload.verdict.status === 'PASS') {
      return { receipt: cached.receipt, totalTokens: 0, executionId, traceId, serviceActor };
    }
  }
  const evidence = EvidenceRecordSchema.parse({
    schema: 'awkn-evidence/v2',
    evidenceId: createAwknId('evidence'),
    executionId,
    traceId,
    claimIds: [],
    type: 'artifact',
    level: 1,
    contentHash: target.diffFingerprint,
    sourceRef: {
      schema: 'awkn-source-ref/v1',
      sourceKind: 'tool_observation',
      sourceId: 'native-git-review-snapshot',
      contentHash: target.diffFingerprint,
      observedAt: now,
    },
    observedAt: now,
    producer: serviceActor,
    verifiedBy: [],
  });
  const contractEvidence = contractArtifacts.map((artifact) => EvidenceRecordSchema.parse({
    schema: 'awkn-evidence/v2',
    evidenceId: createAwknId('evidence'),
    executionId,
    traceId,
    claimIds: [],
    type: 'artifact',
    level: 1,
    contentHash: artifact.ref.contentHash,
    sourceRef: {
      schema: 'awkn-source-ref/v1',
      sourceKind: 'tianshu_repository_file',
      sourceId: artifact.ref.objectId,
      ...(artifact.ref.externalRef === undefined ? {} : { uri: artifact.ref.externalRef }),
      contentHash: artifact.ref.contentHash,
      observedAt: now,
    },
    observedAt: now,
    producer: serviceActor,
    verifiedBy: [],
  }));
  const context = {
    executionId,
    traceId,
    serviceActor,
    artifactRefs: [{
      schema: 'awkn-object-ref/v1' as const,
      objectType: 'git-diff',
      objectId: target.targetId,
      schemaId: 'awkn-review-artifact/v1',
      contentHash: target.diffFingerprint,
    }],
    evidence: [evidence, ...contractEvidence],
    contractEvidenceRefs: contractEvidence.map((record) => record.evidenceId),
  };
  let run: ReviewRun;
  try {
    run = await service.execute(plan, context);
  } catch (error) {
    return failingReviewResult(service, { input, executionId, traceId, serviceActor, now, error, target });
  }
  let receipt: ReviewReceipt;
  try {
    receipt = await service.evaluate(run, context);
  } catch (error) {
    return failingReviewResult(service, { input, executionId, traceId, serviceActor, now, error, target });
  }
  if (receipt.payload.verdict.status === 'PASS') {
    try {
      reviewCache.store(target.diffFingerprint, plan.ruleBundleHash, receipt);
    } catch {
      // 缓存失败不影响审核结论（fail-open）
    }
  }
  return { receipt, totalTokens: run.totalTokens, executionId, traceId, serviceActor };
}
