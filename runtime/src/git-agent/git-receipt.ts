/**
 * Git Receipt 契约 — GIT 集成回执载荷
 *
 * Spiral 3: Git Agent 产出的回执载荷 Schema 与构造器。
 * Git Agent 仅执行 git 操作（commit/push），不修改源代码。
 *
 * 对应契约: contracts/receipts.ts — ReceiptType 'GIT'
 * 对应工程文档: AWKN-ENG-WFA-002 Spiral 3
 */
import { z } from 'zod';
import { awknIdSchema } from '../contracts/ids.js';

/** Git 集成回执载荷 Schema。 */
export const GitReceiptPayloadSchema = z.object({
  missionId: awknIdSchema('goal'),
  workPackageId: awknIdSchema('wp'),
  envelopeId: awknIdSchema('env'),
  frozenSourceSha: z.string().min(1),
  commitSha: z.string().min(1),
  commitVerified: z.boolean(),
  filesChanged: z.array(z.string().min(1)),
  verdict: z.enum(['PASS', 'FAIL', 'BLOCKED']),
}).strict();

export type GitReceiptPayload = z.infer<typeof GitReceiptPayloadSchema>;

export const GIT_RECEIPT_PAYLOAD_SCHEMA = 'awkn-git-receipt/v1';

/**
 * 构造 Git 集成回执载荷并校验。
 *
 * 返回经过 Zod 严格校验的载荷对象，调用方负责计算 payloadHash 并持久化回执。
 */
export function buildGitReceiptPayload(input: {
  missionId: string;
  workPackageId: string;
  envelopeId: string;
  frozenSourceSha: string;
  commitSha: string;
  commitVerified: boolean;
  filesChanged: readonly string[];
  verdict: 'PASS' | 'FAIL' | 'BLOCKED';
}): GitReceiptPayload {
  return GitReceiptPayloadSchema.parse({
    missionId: input.missionId,
    workPackageId: input.workPackageId,
    envelopeId: input.envelopeId,
    frozenSourceSha: input.frozenSourceSha,
    commitSha: input.commitSha,
    commitVerified: input.commitVerified,
    filesChanged: [...input.filesChanged],
    verdict: input.verdict,
  });
}
