/**
 * Retrospective 公共 API — Spiral 4
 *
 * 对外仅暴露 coordinator 的公共函数与 schema；
 * candidate-normalizer 为内部实现细节，不从此处导出。
 */
export {
  runRetrospective,
  getRetrospectiveCandidates,
  getRetrospectiveCandidateById,
  updateRetrospectiveCandidateStatus,
  type RunRetrospectiveParams,
  type RunRetrospectiveResult,
} from './retrospective-coordinator.js';

export {
  RetrospectiveCandidateSchema,
  RetrospectiveReceiptPayloadSchema,
  RetrospectiveLayerSchema,
  RetrospectiveProposedActionSchema,
  RetrospectiveSeveritySchema,
  RetrospectiveEvolutionStatusSchema,
  type RetrospectiveCandidate,
  type RetrospectiveReceiptPayload,
  type RetrospectiveLayer,
  type RetrospectiveProposedAction,
  type RetrospectiveSeverity,
  type RetrospectiveEvolutionStatus,
  type RetrospectiveCandidateRow,
} from './contracts.js';
