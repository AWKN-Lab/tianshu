import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  EvidenceRecordSchema,
  createAwknId,
  type ActorRef,
  type ObjectRef,
  type ReviewReceipt,
} from '../contracts/public.js';
import type { LlmProvider } from '../llm/types.js';
import {
  NativeGitReviewAdapter,
  OcrCliSpecProvider,
  OcrRangeWorkspaceAdapter,
  ReviewService,
  type OcrCliSpecProviderOptions,
} from '../review/public.js';
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
}

export interface WorktreeReviewResult {
  readonly receipt: ReviewReceipt;
  readonly totalTokens: number;
  readonly executionId: string;
  readonly traceId: string;
  readonly serviceActor: ActorRef;
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
  const target = await service.prepare({
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
  const plan = await service.plan(target);
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
  const run = await service.execute(plan, context);
  const receipt = await service.evaluate(run, context);
  return { receipt, totalTokens: run.totalTokens, executionId, traceId, serviceActor };
}
