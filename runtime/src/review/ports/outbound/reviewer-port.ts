import type {
  ActorRef,
  EvidenceRecord,
  ObjectRef,
  ReviewAxis,
  ReviewFindingCategory,
  ReviewPlan,
  ReviewRisk,
  ReviewSeverity,
  ReviewUnit,
} from '../../../contracts/public.js';
import type { ReviewArtifactBundle } from './review-workspace-port.js';

export interface ReviewFindingDraft {
  readonly axis: ReviewAxis;
  readonly category: ReviewFindingCategory;
  readonly severity: ReviewSeverity;
  readonly confidence: number;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly positionStatus: 'EXACT' | 'RELOCATED' | 'UNRESOLVED';
  readonly message: string;
  readonly impact: string;
  readonly suggestedFix: string;
  readonly rationaleSummary: string;
  readonly ruleRefs: readonly ObjectRef[];
  readonly specRefs: readonly ObjectRef[];
  readonly evidenceRefs: readonly string[];
  readonly verifiedBy?: readonly ActorRef[];
  readonly verificationKind?: 'INDEPENDENT_REVIEWER' | 'DETERMINISTIC_TOOL' | 'NONE';
}

export interface ReviewUnitResponse {
  readonly reviewer: ActorRef;
  readonly findings: readonly ReviewFindingDraft[];
  readonly evidenceRefs: readonly string[];
  readonly usage: { readonly totalTokens: number };
}

export interface ReviewUnitRequest {
  readonly unit: ReviewUnit;
  readonly plan: ReviewPlan;
  readonly artifacts: ReviewArtifactBundle;
  readonly evidence: readonly EvidenceRecord[];
}

export interface ReviewerPort {
  readonly actor: ActorRef;
  readonly supportedRisk: readonly ReviewRisk[];
  reviewUnit(request: ReviewUnitRequest): Promise<ReviewUnitResponse>;
}
