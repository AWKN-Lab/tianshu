import type { EvidenceRecord, ReviewReceipt } from '../../../contracts/public.js';

export interface ReviewAuditPort {
  persist(receipt: ReviewReceipt, evidence: readonly EvidenceRecord[]): Promise<void>;
}
