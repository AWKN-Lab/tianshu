import { z } from 'zod';
import { parseTrustedJson } from '../input/public.js';
import type { ChatRequest, ChatResponse, LlmProvider } from '../llm/types.js';
import type {
  ReviewFindingDraft,
  ReviewerPort,
  ReviewUnitRequest,
  ReviewUnitResponse,
} from '../review/public.js';

const FindingOutputSchema = z.object({
  axis: z.enum(['CONTRACT', 'CODE', 'COVERAGE']),
  category: z.enum([
    'CORRECTNESS', 'CONTRACT', 'SECURITY', 'TEST_QUALITY',
    'MAINTAINABILITY', 'PERFORMANCE', 'COVERAGE', 'OTHER',
  ]),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']),
  confidence: z.number().min(0).max(1),
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  message: z.string().min(1),
  impact: z.string().min(1),
  suggestedFix: z.string().min(1),
  rationaleSummary: z.string().min(1),
}).strict();

const ReviewOutputSchema = z.object({
  findings: z.array(FindingOutputSchema),
}).strict();

export interface LlmReviewerAdapterOptions {
  readonly provider: LlmProvider;
  readonly model?: string;
  readonly traceId?: string;
  readonly chat: (request: ChatRequest) => Promise<ChatResponse>;
  readonly systemPrompt?: string;
}

export class LlmReviewerAdapter implements ReviewerPort {
  readonly actor;
  readonly supportedRisk = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

  constructor(private readonly options: LlmReviewerAdapterOptions) {
    this.actor = {
      schema: 'awkn-actor-ref/v1' as const,
      actorId: `review-route:${options.provider}:${options.model ?? 'default'}`,
      actorType: 'assistant' as const,
    };
  }

  async reviewUnit(request: ReviewUnitRequest): Promise<ReviewUnitResponse> {
    const artifactPaths = new Set(request.unit.paths);
    const artifacts = request.artifacts.files.filter((artifact) => artifactPaths.has(artifact.path));
    const rules = request.plan.ruleGroups.filter((group) => request.unit.ruleGroupIds.includes(group.ruleGroupId));
    const systemPrompt = this.options.systemPrompt ?? [
      'You are an independent repository reviewer operating on one frozen ReviewUnit.',
      'Return exactly one JSON object with shape {"findings": [...]}; no Markdown or prose outside JSON.',
      'Each finding requires axis, category, severity, confidence, path, startLine, endLine, message, impact, suggestedFix, rationaleSummary.',
      'Only report actionable defects supported by the supplied patch/evidence. Do not output private chain-of-thought.',
      'If no actionable defect exists, return {"findings":[]}.',
    ].join('\n');
    const response = await this.options.chat({
      provider: this.options.provider,
      model: this.options.model,
      fallbackPolicy: 'none',
      callSource: 'sub_agent',
      temperature: 0,
      traceId: this.options.traceId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify({
          unit: request.unit,
          target: {
            mode: request.plan.target.mode,
            baseRef: request.plan.target.baseRef,
            headRef: request.plan.target.headRef,
            diffFingerprint: request.plan.target.diffFingerprint,
          },
          rules,
          artifacts,
          contracts: request.artifacts.contracts ?? [],
          evidence: request.evidence,
        }) },
      ],
    });
    const trusted = parseTrustedJson(response.content);
    if (!trusted.ok) {
      throw new Error(`reviewer returned invalid JSON: ${trusted.receiptPayload.diagnostics.map((item) => item.code).join(', ')}`);
    }
    const parsed = ReviewOutputSchema.safeParse(trusted.document.value);
    if (!parsed.success) {
      throw new Error(`reviewer output schema invalid: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
    }
    const actualActor = {
      schema: 'awkn-actor-ref/v1' as const,
      actorId: `model:${response.provider}:${response.model}`,
      actorType: 'assistant' as const,
    };
    const evidenceRefs = request.evidence.map((record) => record.evidenceId);
    const ruleRefs = rules.map((rule) => ({
      schema: 'awkn-object-ref/v1' as const,
      objectType: 'review-rule',
      objectId: rule.ruleGroupId,
      schemaId: 'awkn-review-rule/v1',
      contentHash: rule.contentHash,
    }));
    const findings: ReviewFindingDraft[] = parsed.data.findings.map((finding) => ({
      ...finding,
      positionStatus: 'EXACT',
      ruleRefs,
      specRefs: request.unit.specRefs,
      evidenceRefs,
      verifiedBy: [actualActor],
      verificationKind: 'INDEPENDENT_REVIEWER',
    }));
    return {
      reviewer: actualActor,
      findings,
      evidenceRefs,
      usage: { totalTokens: response.usage.totalTokens },
    };
  }
}
