/**
 * Release 契约 — Release Bundle / Artifact / Receipt 载荷
 *
 * Spiral 3: Release Agent 产出的制品包契约。Release Agent 将通过门禁的
 * 源码 SHA、制品摘要、SBOM 摘要绑定到 ReleaseBundle，不修改源代码。
 *
 * 对应契约: contracts/receipts.ts — ReceiptType 'RELEASE'
 * 对应工程文档: AWKN-ENG-WFA-002 Spiral 3
 */
import { z } from 'zod';
import { awknIdSchema } from '../contracts/ids.js';
import { SafeNonNegativeIntegerSchema } from '../contracts/numbers.js';
import { UtcTimestampSchema } from '../contracts/time.js';

// ─── Release Bundle 状态 ─────────────────────────────────

export const ReleaseBundleStatusSchema = z.enum([
  'DRAFT',
  'VERIFIED',
  'SIGNED',
  'PUBLISHED',
  'REJECTED',
]);
export type ReleaseBundleStatus = z.infer<typeof ReleaseBundleStatusSchema>;

// ─── Release Bundle ───────────────────────────────────────

export const ReleaseBundleSchema = z.object({
  schema: z.literal('awkn-release-bundle/v1'),
  releaseBundleId: awknIdSchema('rb'),
  missionId: awknIdSchema('goal'),
  workItemId: z.string().min(1),
  frozenSourceSha: z.string().min(1),
  artifactDigest: z.string().min(1),
  sbomDigest: z.string().min(1),
  buildReceiptId: z.string().min(1).optional(),
  testReceiptId: z.string().min(1).optional(),
  reviewReceiptId: z.string().min(1).optional(),
  securityReceiptId: z.string().min(1).optional(),
  issuedActorId: z.string().min(1),
  authorizationEnvelopeId: awknIdSchema('env'),
  status: ReleaseBundleStatusSchema,
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
}).strict();
export type ReleaseBundle = z.infer<typeof ReleaseBundleSchema>;

// ─── Release Artifact ─────────────────────────────────────

export const ReleaseArtifactSchema = z.object({
  schema: z.literal('awkn-release-artifact/v1'),
  artifactId: z.string().min(1),
  releaseBundleId: awknIdSchema('rb'),
  artifactType: z.string().min(1),
  artifactPath: z.string().min(1),
  artifactDigest: z.string().min(1),
  artifactSizeBytes: SafeNonNegativeIntegerSchema,
  createdAt: UtcTimestampSchema,
}).strict();
export type ReleaseArtifact = z.infer<typeof ReleaseArtifactSchema>;

// ─── Release Receipt 载荷 ─────────────────────────────────

export const ReleaseReceiptPayloadSchema = z.object({
  missionId: awknIdSchema('goal'),
  workItemId: z.string().min(1),
  envelopeId: awknIdSchema('env'),
  releaseBundleId: awknIdSchema('rb'),
  frozenSourceSha: z.string().min(1),
  artifactDigest: z.string().min(1),
  sbomDigest: z.string().min(1),
  verdict: z.enum(['PASS', 'FAIL', 'BLOCKED']),
}).strict();
export type ReleaseReceiptPayload = z.infer<typeof ReleaseReceiptPayloadSchema>;

export const RELEASE_RECEIPT_PAYLOAD_SCHEMA = 'awkn-release-receipt/v1';
