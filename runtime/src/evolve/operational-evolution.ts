import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { LlmProvider } from '../llm/types.js';
import type { GovernCandidateInput, GovernCandidateResult } from '../memory/authority.js';
import { getMemoryBackendRouter } from '../memory/router.js';
import { getDb } from '../store/db.js';
import { EvolutionLifecycle, type EvolutionCandidate } from './lifecycle.js';
import {
  ReplayEvaluator,
  type EvaluationThresholds,
  type ReplayCase,
  type ReplayMetrics,
} from './replay-evaluator.js';

export interface AgentReplayResult {
  finalText: string;
  totalTurns: number;
  totalTokens: number;
  terminated: boolean;
  terminationReason?: string;
  observations?: Array<{ isError?: boolean; errorMessage?: string }>;
}

export type AgentReplayExecutor = (input: {
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  provider?: LlmProvider;
  maxTurns: number;
}) => Promise<AgentReplayResult>;

export interface EvolutionAuthorityGateway {
  isRemoteAuthorityEnabled(): boolean;
  governCandidate(input: GovernCandidateInput): Promise<GovernCandidateResult | null>;
  activateAuthorityRule(ruleId: string): Promise<Record<string, unknown>>;
  pauseAuthorityRule(ruleId: string, reason: string): Promise<Record<string, unknown>>;
}

interface AuthorityProjection {
  authority_experience_id: string | null;
  authority_rule_id: string | null;
  authority_status: string | null;
}

function parseObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function promptFrom(input: Record<string, unknown>): string {
  for (const key of ['prompt', 'userInput', 'task', 'goal', 'description']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function expectedSuccess(expected: Record<string, unknown>): boolean | undefined {
  return typeof expected.success === 'boolean' ? expected.success : undefined;
}

function projectId(): string {
  return process.env.AWKN_PROJECT_ID ?? process.env.npm_package_name ?? 'default-project';
}

function autoGovern(): boolean {
  return process.env.AWKN_MEMORY_OS_AUTO_GOVERNANCE === '1';
}

export function metricsFromReplay(result: AgentReplayResult, expected: Record<string, unknown> = {}): ReplayMetrics {
  const errorMessages = (result.observations ?? [])
    .filter((observation) => observation.isError)
    .map((observation) => observation.errorMessage ?? '')
    .filter(Boolean);
  const combined = `${result.terminationReason ?? ''}\n${errorMessages.join('\n')}`;
  const expectedContains = typeof expected.contains === 'string' ? expected.contains : undefined;
  const textMatches = expectedContains ? result.finalText.includes(expectedContains) : true;
  const shouldSucceed = expectedSuccess(expected);
  const runtimeSuccess = !result.terminated && textMatches;
  const success = shouldSucceed === undefined
    ? runtimeSuccess
    : shouldSucceed === runtimeSuccess;
  const approval = /approval required|waiting_approval|human takeover/i.test(combined);
  const security = /policy.block|policy blocked|workspace boundary|sensitive path|command denied|security violation/i.test(combined);
  return {
    successRate: success ? 1 : 0,
    avgCycles: Math.max(1, result.totalTurns),
    tokenCount: Math.max(0, result.totalTokens),
    errorRate: result.terminated || errorMessages.length > 0 ? 1 : 0,
    humanTakeoverRate: approval ? 1 : 0,
    securityViolationRate: security ? 1 : 0,
  };
}

export class HistoricalReplayManager {
  constructor(private readonly db: Database.Database = getDb()) {}

  importTerminalRuns(limit = 20): { imported: number; skipped: number } {
    const rows = this.db.prepare(
      `SELECT id, workflow_name, status, input_json, output_json, started_at
       FROM runs WHERE status IN ('succeeded', 'failed', 'budget_exceeded', 'policy_blocked')
       ORDER BY started_at DESC LIMIT ?`,
    ).all(limit) as Array<{
      id: string;
      workflow_name: string;
      status: string;
      input_json: string;
      output_json: string | null;
      started_at: string;
    }>;
    let imported = 0;
    let skipped = 0;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO evolution_replay_cases
       (id, name, input_json, expected_json, tags_json, enabled, source_run_id, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    const run = this.db.transaction(() => {
      for (const row of rows) {
        const input = parseObject(row.input_json);
        const prompt = promptFrom(input);
        if (!prompt) {
          skipped++;
          continue;
        }
        const result = insert.run(
          randomUUID(),
          `historical:${row.workflow_name}:${row.id.slice(0, 8)}`,
          JSON.stringify({ prompt, sourceRunId: row.id, workflowName: row.workflow_name }),
          JSON.stringify({ success: row.status === 'succeeded', previousOutput: parseObject(row.output_json) }),
          JSON.stringify(['historical', row.workflow_name, row.status]),
          row.id,
          new Date().toISOString(),
        );
        if (result.changes === 1) imported++;
        else skipped++;
      }
    });
    run();
    return { imported, skipped };
  }
}

export class AgentReplayRunner {
  constructor(
    private readonly db: Database.Database = getDb(),
    private readonly options: {
      cwd?: string;
      provider?: LlmProvider;
      maxTurns?: number;
      executor?: AgentReplayExecutor;
    } = {},
  ) {}

  async run(testCase: ReplayCase, candidate: EvolutionCandidate | null): Promise<ReplayMetrics> {
    const prompt = promptFrom(testCase.input);
    if (!prompt) throw new Error(`replay case ${testCase.id} has no prompt`);
    const baselinePrompt = typeof testCase.input.systemPrompt === 'string'
      ? testCase.input.systemPrompt
      : undefined;
    const candidateRule = candidate ? readFileSync(candidate.content_path, 'utf-8') : '';
    const systemPrompt = candidateRule
      ? `${baselinePrompt ?? ''}\n\nCANDIDATE_ENGINEERING_RULE\n${candidateRule}\nEND_CANDIDATE_ENGINEERING_RULE`.trim()
      : baselinePrompt;
    const executor = this.options.executor ?? this.defaultExecutor.bind(this);
    const startedAt = Date.now();
    let metrics: ReplayMetrics;
    let errorText: string | null = null;
    try {
      const result = await executor({
        prompt,
        systemPrompt,
        cwd: this.options.cwd ?? process.cwd(),
        provider: this.options.provider,
        maxTurns: this.options.maxTurns ?? 6,
      });
      metrics = metricsFromReplay(result, testCase.expected ?? {});
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
      metrics = {
        successRate: 0,
        avgCycles: 1,
        tokenCount: 0,
        errorRate: 1,
        humanTakeoverRate: /approval required/i.test(errorText) ? 1 : 0,
        securityViolationRate: /policy|workspace boundary|sensitive path|command denied/i.test(errorText) ? 1 : 0,
      };
    }
    this.db.prepare(
      `INSERT INTO evolution_replay_runs
       (id, candidate_id, replay_case_id, mode, metrics_json, error_text, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      candidate?.id ?? null,
      testCase.id,
      candidate ? 'candidate' : 'baseline',
      JSON.stringify(metrics),
      errorText,
      Date.now() - startedAt,
      new Date().toISOString(),
    );
    return metrics;
  }

  private async defaultExecutor(input: {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    provider?: LlmProvider;
    maxTurns: number;
  }): Promise<AgentReplayResult> {
    const { AgentLoop } = await import('../core/agent-loop.js');
    const loop = new AgentLoop({
      cwd: input.cwd,
      enableL2: false,
      callSource: 'sub_agent',
      provider: input.provider,
      maxTurns: input.maxTurns,
      systemPrompt: input.systemPrompt,
      approvedTools: [],
    });
    const result = await loop.runL1(input.prompt);
    return {
      finalText: result.finalText,
      totalTurns: result.totalTurns,
      totalTokens: result.totalTokens,
      terminated: result.terminated,
      terminationReason: result.terminationReason,
      observations: result.reactState.observations.map((observation) => ({
        isError: observation.isError,
        errorMessage: observation.errorMessage,
      })),
    };
  }
}

export class EvolutionOrchestrator {
  private readonly evaluator: ReplayEvaluator;
  private readonly historical: HistoricalReplayManager;
  private readonly lifecycle: EvolutionLifecycle;

  constructor(
    private readonly db: Database.Database = getDb(),
    private readonly authority: EvolutionAuthorityGateway = getMemoryBackendRouter(),
  ) {
    this.evaluator = new ReplayEvaluator(db);
    this.historical = new HistoricalReplayManager(db);
    this.lifecycle = new EvolutionLifecycle(db);
  }

  importHistoricalRuns(limit = 20): { imported: number; skipped: number } {
    return this.historical.importTerminalRuns(limit);
  }

  async evaluateCandidate(input: {
    candidateId: string;
    cwd?: string;
    provider?: LlmProvider;
    maxTurns?: number;
    importLimit?: number;
    thresholds?: Partial<EvaluationThresholds>;
    executor?: AgentReplayExecutor;
  }) {
    if (this.evaluator.listCases().length === 0) this.importHistoricalRuns(input.importLimit ?? 20);
    const runner = new AgentReplayRunner(this.db, {
      cwd: input.cwd,
      provider: input.provider,
      maxTurns: input.maxTurns,
      executor: input.executor,
    });
    return this.evaluator.evaluate(
      input.candidateId,
      (testCase, candidate) => runner.run(testCase, candidate),
      input.thresholds,
    );
  }

  async promote(input: {
    candidateId: string;
    cwd?: string;
    provider?: LlmProvider;
    maxTurns?: number;
    importLimit?: number;
    thresholds?: Partial<EvaluationThresholds>;
    executor?: AgentReplayExecutor;
  }) {
    const evaluation = await this.evaluateCandidate(input);
    if (evaluation.verdict !== 'PASS') {
      return { evaluation, candidate: this.lifecycle.read(input.candidateId), authority: null };
    }

    const candidate = this.requireCandidate(input.candidateId);
    if (!this.authority.isRemoteAuthorityEnabled()) {
      return { evaluation, candidate: this.lifecycle.activate(input.candidateId), authority: null };
    }

    try {
      const authority = await this.authority.governCandidate({
        projectId: projectId(),
        candidateId: candidate.id,
        experienceKey: candidate.experience_id,
        content: readFileSync(candidate.content_path, 'utf-8'),
        evaluation: {
          verdict: evaluation.verdict,
          reasons: evaluation.reasons,
          baseline: evaluation.baseline,
          candidate: evaluation.candidate,
        },
        autoActivate: autoGovern(),
      });
      if (!authority) throw new Error('remote authority returned no governance result');
      this.saveAuthority(candidate.id, authority);
      const activated = authority.status === 'ACTIVE'
        ? this.lifecycle.activate(candidate.id)
        : this.lifecycle.read(candidate.id);
      return { evaluation, candidate: activated, authority };
    } catch (error) {
      this.saveAuthorityError(candidate.id, error);
      throw error;
    }
  }

  async activateApprovedCandidate(candidateId: string): Promise<{
    candidate: EvolutionCandidate;
    authority: GovernCandidateResult | null;
  }> {
    const candidate = this.requireCandidate(candidateId);
    if (candidate.status !== 'APPROVED') throw new Error(`candidate ${candidateId} must be APPROVED before activation`);
    if (!this.authority.isRemoteAuthorityEnabled()) {
      return { candidate: this.lifecycle.activate(candidateId), authority: null };
    }

    const projection = this.readAuthority(candidateId);
    try {
      let authority: GovernCandidateResult;
      if (projection.authority_rule_id) {
        const activation = await this.authority.activateAuthorityRule(projection.authority_rule_id);
        authority = {
          experienceId: projection.authority_experience_id ?? '',
          ruleId: projection.authority_rule_id,
          status: 'ACTIVE',
          activationId: typeof activation.activation_id === 'string' ? activation.activation_id : undefined,
        };
      } else {
        const result = await this.authority.governCandidate({
          projectId: projectId(),
          candidateId: candidate.id,
          experienceKey: candidate.experience_id,
          content: readFileSync(candidate.content_path, 'utf-8'),
          evaluation: parseObject(candidate.evaluation_json),
          autoActivate: true,
        });
        if (!result) throw new Error('remote authority returned no governance result');
        authority = result;
      }
      if (authority.status !== 'ACTIVE') throw new Error(`authority rule ${authority.ruleId} is not ACTIVE`);
      this.saveAuthority(candidate.id, authority);
      return { candidate: this.lifecycle.activate(candidate.id), authority };
    } catch (error) {
      this.saveAuthorityError(candidate.id, error);
      throw error;
    }
  }

  async quarantineCandidate(candidateId: string, reason = 'evaluation failed'): Promise<EvolutionCandidate> {
    this.requireCandidate(candidateId);
    const projection = this.readAuthority(candidateId);
    if (projection.authority_rule_id && projection.authority_status === 'ACTIVE') {
      await this.authority.pauseAuthorityRule(projection.authority_rule_id, reason);
      this.db.prepare(
        `UPDATE evolution_candidates SET authority_status = 'PAUSED', authority_synced_at = ?, authority_error = NULL WHERE id = ?`,
      ).run(new Date().toISOString(), candidateId);
    }
    return this.lifecycle.transition(candidateId, 'QUARANTINED', reason);
  }

  async rollback(experienceId: string): Promise<EvolutionCandidate> {
    const current = this.db.prepare(
      `SELECT * FROM evolution_candidates WHERE experience_id = ? AND status = 'ACTIVE' LIMIT 1`,
    ).get(experienceId) as EvolutionCandidate | undefined;
    if (!current) throw new Error(`no ACTIVE candidate for ${experienceId}`);
    const history = this.db.prepare(
      `SELECT from_candidate_id FROM evolution_activation_history
       WHERE experience_id = ? AND to_candidate_id = ? AND from_candidate_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    ).get(experienceId, current.id) as { from_candidate_id: string } | undefined;
    if (!history) throw new Error(`no rollback target for ${experienceId}`);
    const previousProjection = this.readAuthority(history.from_candidate_id);
    const currentProjection = this.readAuthority(current.id);

    if (this.authority.isRemoteAuthorityEnabled()) {
      if (currentProjection.authority_rule_id && currentProjection.authority_status === 'ACTIVE') {
        await this.authority.pauseAuthorityRule(currentProjection.authority_rule_id, 'tianshu rollback');
      }
      if (previousProjection.authority_rule_id) {
        await this.authority.activateAuthorityRule(previousProjection.authority_rule_id);
      }
    }

    const restored = this.lifecycle.rollback(experienceId);
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE evolution_candidates SET authority_status = 'PAUSED', authority_synced_at = ? WHERE id = ?`,
    ).run(now, current.id);
    if (previousProjection.authority_rule_id) {
      this.db.prepare(
        `UPDATE evolution_candidates SET authority_status = 'ACTIVE', authority_synced_at = ?, authority_error = NULL WHERE id = ?`,
      ).run(now, restored.id);
    }
    return restored;
  }

  private requireCandidate(candidateId: string): EvolutionCandidate {
    const candidate = this.lifecycle.read(candidateId);
    if (!candidate) throw new Error(`candidate ${candidateId} not found`);
    return candidate;
  }

  private readAuthority(candidateId: string): AuthorityProjection {
    return this.db.prepare(
      `SELECT authority_experience_id, authority_rule_id, authority_status
       FROM evolution_candidates WHERE id = ?`,
    ).get(candidateId) as AuthorityProjection;
  }

  private saveAuthority(candidateId: string, authority: GovernCandidateResult): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE evolution_candidates
       SET authority_experience_id = ?, authority_rule_id = ?, authority_status = ?,
           authority_synced_at = ?, authority_error = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(
      authority.experienceId,
      authority.ruleId,
      authority.status,
      now,
      now,
      candidateId,
    );
  }

  private saveAuthorityError(candidateId: string, error: unknown): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE evolution_candidates SET authority_error = ?, authority_synced_at = ?, updated_at = ? WHERE id = ?`,
    ).run(
      error instanceof Error ? error.message : String(error),
      now,
      now,
      candidateId,
    );
  }
}
