import { existsSync, readFileSync } from 'node:fs';
import { guardMemoryPayload } from './dlp.js';

export interface GovernCandidateInput {
  projectId: string;
  candidateId: string;
  experienceKey: string;
  content: string;
  evaluation: Record<string, unknown>;
  autoActivate?: boolean;
}

export interface GovernCandidateResult {
  experienceId: string;
  ruleId: string;
  status: 'PROPOSED' | 'ACTIVE';
  activationId?: string;
}

function tokenFromEnvironment(): string | undefined {
  const direct = process.env.AWKN_MEMORY_OS_TOKEN ?? process.env.AWKN_SESSION_TOKEN;
  if (direct?.trim()) return direct.trim();
  const path = process.env.AWKN_MEMORY_OS_TOKEN_PATH;
  if (path && existsSync(path)) {
    const value = readFileSync(path, 'utf-8').trim();
    if (value) return value;
  }
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstLine(content: string): string {
  const line = content.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean) ?? 'Replay-verified engineering rule';
  return line.replace(/^#+\s*/, '').slice(0, 500);
}

export class AwknMemoryAuthorityClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;

  constructor(input: { baseUrl?: string; token?: string; timeoutMs?: number } = {}) {
    this.baseUrl = (input.baseUrl ?? process.env.AWKN_MEMORY_OS_URL ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
    this.token = input.token ?? tokenFromEnvironment();
    this.timeoutMs = input.timeoutMs ?? Number(process.env.AWKN_MEMORY_OS_TIMEOUT_MS ?? 2500);
  }

  async governCandidate(input: GovernCandidateInput): Promise<GovernCandidateResult> {
    await this.assertProtocol();
    const experience = await this.request('POST', '/api/v1/experiences', {
      project_id: input.projectId,
      evidence_ids: [],
      scope: 'PROJECT',
      source_type: 'STATED',
      summary_text: firstLine(input.content),
      body: {
        local_candidate_id: input.candidateId,
        local_experience_key: input.experienceKey,
        rule_content: input.content,
        replay_evaluation: input.evaluation,
        source: 'tianshu-replay-verification',
      },
      confidence: 0.95,
    });
    const experienceId = String(experience.experience_id ?? '');
    if (!experienceId) throw new Error('AWKN Memory OS did not return experience_id');
    await this.request('POST', `/api/v1/experiences/${encodeURIComponent(experienceId)}/promote`);
    await this.request('POST', `/api/v1/experiences/${encodeURIComponent(experienceId)}/confirm`, {
      reason: 'tianshu_replay_verified',
    });

    const rule = await this.request('POST', '/api/v1/rules/propose', {
      project_id: input.projectId,
      experience_ids: [experienceId],
      scope: 'PROJECT',
      rule_type: 'GUIDANCE',
      summary_text: firstLine(input.content),
      body: {
        local_candidate_id: input.candidateId,
        local_experience_key: input.experienceKey,
        content: input.content,
        replay_evaluation: input.evaluation,
      },
      authority_level: Number(process.env.AWKN_MEMORY_OS_RULE_AUTHORITY ?? 7),
      priority: Number(process.env.AWKN_MEMORY_OS_RULE_PRIORITY ?? 8),
      specificity: Number(process.env.AWKN_MEMORY_OS_RULE_SPECIFICITY ?? 7),
      conflict_group: input.experienceKey,
    });
    const ruleId = String(rule.rule_id ?? '');
    if (!ruleId) throw new Error('AWKN Memory OS did not return rule_id');

    if (!input.autoActivate) return { experienceId, ruleId, status: 'PROPOSED' };
    const activation = await this.reviewApproveActivateRule(ruleId);
    return {
      experienceId,
      ruleId,
      status: 'ACTIVE',
      activationId: typeof activation.activation_id === 'string' ? activation.activation_id : undefined,
    };
  }

  async reviewApproveActivateRule(ruleId: string): Promise<Record<string, unknown>> {
    await this.request('POST', `/api/v1/rules/${encodeURIComponent(ruleId)}/review`);
    await this.request('POST', `/api/v1/rules/${encodeURIComponent(ruleId)}/approve`);
    return this.request('POST', `/api/v1/rules/${encodeURIComponent(ruleId)}/activate`);
  }

  async activateRule(ruleId: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/api/v1/rules/${encodeURIComponent(ruleId)}/activate`);
  }

  async pauseRule(ruleId: string, reason: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/api/v1/rules/${encodeURIComponent(ruleId)}/pause?reason=${encodeURIComponent(reason)}`);
  }

  async revokeRule(ruleId: string, reason: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/api/v1/rules/${encodeURIComponent(ruleId)}/revoke?reason=${encodeURIComponent(reason)}`);
  }

  private async assertProtocol(): Promise<void> {
    const protocol = await this.request('GET', '/api/v1/protocol');
    if (Number(protocol.major) !== 1) throw new Error(`unsupported AWKN Memory OS protocol major: ${String(protocol.major)}`);
  }

  private async request(method: string, path: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const clean = payload === undefined ? undefined : guardMemoryPayload(payload).value;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          ...(clean ? { 'content-type': 'application/json' } : {}),
          ...(this.token ? { 'x-awkn-session-token': this.token } : {}),
        },
        body: clean ? JSON.stringify(clean) : undefined,
      });
      const text = await response.text();
      let body: Record<string, unknown> = {};
      if (text) {
        try { body = objectValue(JSON.parse(text)); } catch { body = { raw: text }; }
      }
      if (!response.ok) throw new Error(`AWKN Memory OS authority ${method} ${path} failed: ${response.status} ${text.slice(0, 500)}`);
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }
}
