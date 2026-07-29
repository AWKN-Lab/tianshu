import type {
  ActorRef,
  EvidenceRecord,
  ObjectRef,
  ReviewPlan,
  ReviewReceipt,
  ReviewRun,
  ReviewTarget,
} from '../../../contracts/public.js';
import type { ReviewScopeRequest } from '../outbound/review-spec-provider-port.js';

export interface ReviewTargetMetadata {
  readonly prdRefs?: readonly ObjectRef[];
  readonly specRefs?: readonly ObjectRef[];
  readonly acceptanceCriteriaRefs?: readonly ObjectRef[];
  readonly includePatterns?: readonly string[];
  readonly excludePatterns?: readonly string[];
  readonly initiator: ActorRef;
  readonly implementer?: ActorRef;
  readonly createdAt: string;
}

export interface ReviewExecutionContext {
  readonly executionId: string;
  readonly traceId: string;
  readonly serviceActor: ActorRef;
  readonly artifactRefs: readonly ObjectRef[];
  readonly evidence: readonly EvidenceRecord[];
}

export interface ReviewServicePort {
  prepare(request: ReviewScopeRequest, metadata: ReviewTargetMetadata): Promise<ReviewTarget>;
  plan(target: ReviewTarget): Promise<ReviewPlan>;
  execute(plan: ReviewPlan, context: ReviewExecutionContext): Promise<ReviewRun>;
  evaluate(run: ReviewRun, context: ReviewExecutionContext): Promise<ReviewReceipt>;
}
