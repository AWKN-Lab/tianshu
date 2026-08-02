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
  /**
   * 分析通道（P0-3 补完 · 双通道）：'code' 或 'test'。
   * 未标注（undefined）等价 'code'，保持单分析器场景向后兼容。
   * 执行时按 unit 特征路由：TEST_ABUSE / 实现-测试一致性 unit 只能由 'test' 通道执行，
   * 其余 unit 只能由 'code' 通道执行；两通道互斥分流。
   */
  readonly channel?: 'code' | 'test';
  reviewUnit(request: ReviewUnitRequest): Promise<ReviewUnitResponse>;
}
