import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { runStructuredWorktreeReview, type WorktreeReviewResult } from '../../adapter/review-kernel-runner.js';
import { getLlmRouter, type LlmRouter } from '../../llm/router.js';
import type { LlmProvider } from '../../llm/types.js';
import { getDb } from '../../store/db.js';
import type Database from 'better-sqlite3';
import type { ExecutionContext, ToolHandler } from '../types.js';
import { ObjectRefSchema } from '../../contracts/public.js';

const PROVIDERS = new Set<LlmProvider>(['trae', 'codex', 'minimax', 'opencode']);
const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ENGINE_OCR_ROOT = resolve(ENGINE_ROOT, 'integrations/open-code-review');
const DEFAULT_OCR_BINARY = resolve(ENGINE_OCR_ROOT, 'bin', process.platform === 'win32' ? 'ocr.exe' : 'ocr');
const ContractArtifactsSchema = z.array(z.object({
  kind: z.enum(['PRD', 'SPEC', 'ACCEPTANCE_CRITERION']),
  ref: ObjectRefSchema,
  content: z.string().min(1),
}).strict());

export interface ReviewRepositoryDependencies {
  readonly router?: LlmRouter;
  readonly db?: Database.Database;
}

/**
 * Trusted composition boundary shared by the internal ToolRegistry and the
 * dedicated MCP adapter. Implementer identity is accepted only from the
 * runtime ExecutionContext, never from public tool arguments.
 */
export async function runReviewRepository(
  args: Record<string, unknown>,
  context: ExecutionContext | undefined,
  dependencies: ReviewRepositoryDependencies = {},
): Promise<WorktreeReviewResult> {
  const repositoryRoot = resolve(String(args.repositoryRoot ?? context?.workspaceRoot ?? process.cwd()));
  const mode = args.mode === undefined ? 'enforce' : String(args.mode);
  if (mode !== 'enforce') throw new Error('direct review_repository only supports enforce');
  const provider = String(args.reviewerProvider ?? 'codex') as LlmProvider;
  if (!PROVIDERS.has(provider)) throw new Error(`unsupported reviewerProvider: ${provider}`);
  if (context?.implementerActorId === undefined) {
    throw new Error('trusted implementer Actor is missing from execution context');
  }
  const contractArtifacts = ContractArtifactsSchema.parse(args.contractArtifacts ?? []);
  const baseRef = args.baseRef === undefined ? undefined : String(args.baseRef);
  const headRef = args.headRef === undefined ? undefined : String(args.headRef);
  if ((baseRef === undefined) !== (headRef === undefined)) throw new Error('baseRef and headRef must be provided together');
  const ocrBinary = process.env.AWKN_REVIEW_OCR_BINARY ?? DEFAULT_OCR_BINARY;
  const ocrVersion = process.env.AWKN_REVIEW_OCR_VERSION;
  const ocrSha256 = process.env.AWKN_REVIEW_OCR_SHA256;
  if (baseRef !== undefined && (ocrVersion === undefined || ocrSha256 === undefined)) {
    throw new Error('commit range review requires AWKN_REVIEW_OCR_VERSION and _SHA256 pins for the engine-local OCR binary');
  }
  return runStructuredWorktreeReview({
    repositoryRoot,
    mode,
    router: dependencies.router ?? getLlmRouter(),
    reviewerProvider: provider,
    implementer: {
      schema: 'awkn-actor-ref/v1',
      actorId: context.implementerActorId,
      actorType: 'assistant',
    },
    db: dependencies.db ?? getDb(),
    contractArtifacts,
    ...(baseRef === undefined ? {} : {
      baseRef,
      headRef: headRef!,
      ocr: {
        binaryPath: ocrBinary,
        allowedBinaryRoot: ENGINE_OCR_ROOT,
        expectedVersion: ocrVersion!,
        expectedBinarySha256: ocrSha256!,
      },
    }),
  });
}

export const reviewRepositoryTool: ToolHandler = {
  name: 'review_repository',
  description: '使用 AWKN Review Kernel 对 Git 工作树执行结构化独立审核，返回 Receipt、覆盖率和阻断项',
  source: 'builtin',
  isReadOnly: false,
  concurrentSafe: false,
  permissionLevel: 'confirm',
  priority: 'high',
  parameters: {
    type: 'object',
    properties: {
      repositoryRoot: { type: 'string', description: 'Git 仓库绝对路径，默认当前工作区' },
      mode: { type: 'string', enum: ['enforce'], description: '直接调用只允许 enforce；shadow 由 AgentLoop 双跑' },
      reviewerProvider: { type: 'string', enum: ['trae', 'codex', 'minimax'], description: '独立 Reviewer provider' },
      contractArtifacts: {
        type: 'array',
        description: '冻结的 PRD/Spec/验收标准内容与带 contentHash 的 ObjectRef',
        items: { type: 'object' },
      },
      baseRef: { type: 'string', description: '可选；与 headRef 同时提供时强制使用固定 OCR range provider' },
      headRef: { type: 'string', description: '可选；与 baseRef 同时提供时强制使用固定 OCR range provider' },
    },
    required: [],
  },
  async execute(args, context) {
    const result = await runReviewRepository(args, context);
    const payload = result.receipt.payload;
    const blockers = payload.findings.filter((finding) =>
      (finding.severity === 'CRITICAL' || finding.severity === 'HIGH')
      && finding.disposition === 'OPEN');
    const lines = [
      `VERDICT: ${payload.verdict.status}`,
      `Receipt: ${result.receipt.receiptId}`,
      `Target: ${payload.targetFingerprint}`,
      `Plan: ${payload.planHash}`,
      `Coverage: files ${(payload.coverage.fileCoverage * 100).toFixed(1)}%, risk ${(payload.coverage.riskCoverage * 100).toFixed(1)}%`,
      `Excluded: ${payload.coverage.excludedFiles.length}, Failed: ${payload.coverage.failedFiles.length}`,
      `Reviewer tokens: ${result.totalTokens}`,
    ];
    if (blockers.length > 0) {
      lines.push('', 'BLOCKERS:');
      for (const finding of blockers) {
        lines.push(`- [${finding.severity}] ${finding.path}:${finding.startLine} ${finding.message}`);
        lines.push(`  Impact: ${finding.impact}`);
        lines.push(`  Fix: ${finding.suggestedFix}`);
      }
    }
    if (payload.coverage.missing.length > 0) {
      lines.push('', 'COVERAGE_GAPS:');
      for (const gap of payload.coverage.missing) {
        lines.push(`- ${gap.path ?? gap.unitId}: ${gap.reason}`);
      }
    }
    return lines.join('\n');
  },
};
