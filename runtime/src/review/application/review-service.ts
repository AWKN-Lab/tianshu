import {
  REVIEW_RUN_SCHEMA,
  ReviewRunSchema,
  createAwknId,
  type ReviewPlan,
  type ReviewReceipt,
  type ReviewRun,
  type ReviewTarget,
  type ReviewUnitResult,
} from '../../contracts/public.js';
import type {
  ReviewExecutionContext,
  ReviewServicePort,
  ReviewTargetMetadata,
} from '../ports/inbound/review-service-port.js';
import type { ReviewAuditPort } from '../ports/outbound/review-audit-port.js';
import type { ReviewScopeRequest, ReviewSpecProviderPort } from '../ports/outbound/review-spec-provider-port.js';
import type { ReviewerPort } from '../ports/outbound/reviewer-port.js';
import type { ReviewWorkspacePort } from '../ports/outbound/review-workspace-port.js';
import { calculateReviewCoverage } from './coverage-calculator.js';
import { validateFindingDrafts } from './finding-validator.js';
import { buildReviewPlan, createReviewTarget } from './review-planner.js';
import { buildReviewReceipt } from './review-receipt.js';
import { calculateReviewVerdict } from './verdict-calculator.js';
import type { ReviewUnit } from '../../contracts/public.js';

export interface ReviewServiceDependencies {
  readonly specProvider: ReviewSpecProviderPort;
  readonly workspace: ReviewWorkspacePort;
  readonly reviewers: readonly ReviewerPort[];
  readonly audit?: ReviewAuditPort;
  readonly clock?: () => string;
  readonly maxReviewerAttempts?: number;
}

/** 测试路径判定：与 review-planner 的 TEST_ABUSE 识别保持同口径 */
export function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|tests?)(\/|\.)|\.(test|spec)\./i.test(path);
}

/**
 * unit 归属通道（P0-3 补完 · 双通道）：
 * TEST_ABUSE 与"实现-测试一致性"（CROSS_FILE 且含测试路径）→ test 通道；
 * 其余（FILE / CROSS_FILE / SPEC）→ code 通道。
 */
export function unitChannel(unit: ReviewUnit): 'code' | 'test' {
  if (unit.type === 'TEST_ABUSE') return 'test';
  if (unit.type === 'CROSS_FILE' && unit.paths.some((path) => isTestPath(path))) return 'test';
  return 'code';
}

export class ReviewService implements ReviewServicePort {
  private readonly clock: () => string;
  private readonly maxReviewerAttempts: number;

  constructor(private readonly dependencies: ReviewServiceDependencies) {
    this.clock = dependencies.clock ?? (() => new Date().toISOString());
    this.maxReviewerAttempts = dependencies.maxReviewerAttempts ?? 2;
    if (this.maxReviewerAttempts < 1) throw new Error('maxReviewerAttempts must be >= 1');
  }

  async prepare(request: ReviewScopeRequest, metadata: ReviewTargetMetadata): Promise<ReviewTarget> {
    const scope = await this.dependencies.specProvider.createScope(request);
    return createReviewTarget(scope, { ...metadata, mode: request.mode });
  }

  async plan(target: ReviewTarget): Promise<ReviewPlan> {
    const scope = await this.dependencies.specProvider.createScope({
      repositoryRoot: target.repositoryRoot,
      mode: target.mode,
      baseRef: target.baseRef,
      headRef: target.headRef,
      includePatterns: target.includePatterns,
      excludePatterns: target.excludePatterns,
    });
    return buildReviewPlan(target, scope, this.clock());
  }

  async execute(plan: ReviewPlan, context: ReviewExecutionContext): Promise<ReviewRun> {
    const startedAt = this.clock();
    let artifacts;
    try {
      artifacts = await this.dependencies.workspace.freeze(plan.target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return ReviewRunSchema.parse({
        schema: REVIEW_RUN_SCHEMA,
        reviewRunId: createAwknId('reviewRun'),
        plan,
        providerStatus: 'INVALID',
        providerError: message,
        currentTargetFingerprint: plan.target.diffFingerprint,
        unitResults: plan.units.map((unit): ReviewUnitResult => ({
          unitId: unit.unitId,
          status: 'FAILED',
          reviewer: context.serviceActor,
          findingIds: [],
          evidenceRefs: [],
          error: `workspace provider failed: ${message}`,
          totalTokens: 0,
          completedAt: this.clock(),
        })),
        findings: [],
        validationErrors: [],
        totalTokens: 0,
        startedAt,
        completedAt: this.clock(),
      });
    }

    if (artifacts.targetFingerprint !== plan.target.diffFingerprint) {
      return ReviewRunSchema.parse({
        schema: REVIEW_RUN_SCHEMA,
        reviewRunId: createAwknId('reviewRun'),
        plan,
        providerStatus: 'VALID',
        currentTargetFingerprint: artifacts.targetFingerprint,
        unitResults: plan.units.map((unit): ReviewUnitResult => ({
          unitId: unit.unitId,
          status: 'SKIPPED',
          reviewer: context.serviceActor,
          findingIds: [],
          evidenceRefs: [],
          error: 'target changed before review execution',
          totalTokens: 0,
          completedAt: this.clock(),
        })),
        findings: [],
        validationErrors: [],
        totalTokens: 0,
        startedAt,
        completedAt: this.clock(),
      });
    }

    const unitResults: ReviewUnitResult[] = [];
    const findings = [];
    const validationErrors: string[] = [];
    const allowedEvidenceRefs = new Set(context.evidence.map((record) => record.evidenceId));
    const contractEvidenceRefs = new Set(context.contractEvidenceRefs ?? []);
    let totalTokens = 0;
    for (const unit of plan.units) {
      let completed = false;
      let lastError = 'no independent reviewer available';
      const attemptedActors = new Set<string>();
      const channel = unitChannel(unit);
      for (const reviewer of this.dependencies.reviewers) {
        if (attemptedActors.size >= this.maxReviewerAttempts) break;
        if (attemptedActors.has(reviewer.actor.actorId)) continue;
        if ((reviewer.channel ?? 'code') !== channel) continue;
        if (!reviewer.supportedRisk.includes(unit.risk)) continue;
        if (plan.target.implementer?.actorId === reviewer.actor.actorId) continue;
        attemptedActors.add(reviewer.actor.actorId);
        try {
          const response = await reviewer.reviewUnit({ unit, plan, artifacts, evidence: context.evidence });
          if (plan.target.implementer?.actorId === response.reviewer.actorId) {
            throw new Error('actual reviewer actor matches implementer actor');
          }
          if (!Number.isSafeInteger(response.usage.totalTokens) || response.usage.totalTokens < 0) {
            throw new Error('reviewer returned invalid token usage');
          }
          if (response.evidenceRefs.some((evidenceRef) => !allowedEvidenceRefs.has(evidenceRef))) {
            throw new Error('reviewer returned evidence outside the frozen execution');
          }
          if (unit.type === 'SPEC'
            && (response.evidenceRefs.length === 0
              || !response.evidenceRefs.some((evidenceRef) => contractEvidenceRefs.has(evidenceRef)))) {
            throw new Error('SPEC review unit requires frozen contract evidence');
          }
          totalTokens += response.usage.totalTokens;
          const validated = validateFindingDrafts(
            plan,
            unit,
            response.reviewer,
            response.findings,
            artifacts,
            allowedEvidenceRefs,
          );
          findings.push(...validated.findings);
          validationErrors.push(...validated.errors.map((error) => `${unit.unitId}: ${error}`));
          unitResults.push({
            unitId: unit.unitId,
            status: 'COMPLETED',
            reviewer: response.reviewer,
            findingIds: validated.findings.map((finding) => finding.findingId),
            evidenceRefs: [...response.evidenceRefs],
            totalTokens: response.usage.totalTokens,
            completedAt: this.clock(),
          });
          completed = true;
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      if (!completed) {
        unitResults.push({
          unitId: unit.unitId,
          status: 'FAILED',
          reviewer: context.serviceActor,
          findingIds: [],
          evidenceRefs: [],
          error: lastError,
          totalTokens: 0,
          completedAt: this.clock(),
        });
      }
    }

    let currentTargetFingerprint: string;
    try {
      currentTargetFingerprint = await this.dependencies.workspace.currentFingerprint(plan);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return ReviewRunSchema.parse({
        schema: REVIEW_RUN_SCHEMA,
        reviewRunId: createAwknId('reviewRun'),
        plan,
        providerStatus: 'INVALID',
        providerError: `target freshness check failed: ${message}`,
        currentTargetFingerprint: plan.target.diffFingerprint,
        unitResults,
        findings,
        validationErrors,
        totalTokens,
        startedAt,
        completedAt: this.clock(),
      });
    }
    return ReviewRunSchema.parse({
      schema: REVIEW_RUN_SCHEMA,
      reviewRunId: createAwknId('reviewRun'),
      plan,
      providerStatus: 'VALID',
      currentTargetFingerprint,
      unitResults,
      findings,
      validationErrors,
      totalTokens,
      startedAt,
      completedAt: this.clock(),
    });
  }

  async evaluate(run: ReviewRun, context: ReviewExecutionContext): Promise<ReviewReceipt> {
    const evaluatedAt = this.clock();
    const coverage = calculateReviewCoverage(run.plan, run);
    const verdict = calculateReviewVerdict(run, coverage, evaluatedAt);
    const receipt = buildReviewReceipt({
      executionId: context.executionId,
      traceId: context.traceId,
      producer: context.serviceActor,
      run,
      coverage,
      verdict,
      artifactRefs: context.artifactRefs,
      createdAt: evaluatedAt,
    });
    if (this.dependencies.audit !== undefined) {
      await this.dependencies.audit.persist(receipt, context.evidence);
    }
    return receipt;
  }
}
