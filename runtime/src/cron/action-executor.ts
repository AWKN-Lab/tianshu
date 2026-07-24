import { toolRegistry } from '../tools/registry.js';

export interface CronActionSnapshot {
  actionType: 'http' | 'tool' | 'script' | 'evolve';
  payload: Record<string, unknown>;
  workspaceRoot?: string;
}

export async function executeCronAction(snapshot: CronActionSnapshot, idempotencyKey: string): Promise<string> {
  const payload = snapshot.payload;
  const workspaceRoot = snapshot.workspaceRoot ?? String(payload.cwd ?? process.cwd());
  const approvedTools = Array.isArray(payload.approvedTools) ? payload.approvedTools.map(String) : [];

  if (snapshot.actionType === 'http') {
    const url = String(payload.url ?? '');
    if (!url) throw new Error('http action requires payload.url');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(payload.timeoutMs ?? 30_000));
    try {
      const headers = { ...(payload.headers as Record<string, string> | undefined), 'Idempotency-Key': idempotencyKey };
      const response = await fetch(url, {
        method: String(payload.method ?? 'GET'),
        headers,
        body: payload.body === undefined ? undefined : JSON.stringify(payload.body),
        signal: controller.signal,
      });
      const body = (await response.text()).slice(0, 20_000);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`);
      return `HTTP ${response.status}\n${body}`.trim();
    } finally {
      clearTimeout(timeout);
    }
  }

  if (snapshot.actionType === 'tool') {
    const toolName = String(payload.toolName ?? '');
    if (!toolName) throw new Error('tool action requires payload.toolName');
    const args = (payload.args && typeof payload.args === 'object' ? payload.args : {}) as Record<string, unknown>;
    return toolRegistry.execute(toolName, args, {
      sessionId: `cron:${idempotencyKey}`,
      userId: 'cron-worker',
      callSource: 'background_task',
      workspaceRoot,
      approvedToolNames: approvedTools,
    });
  }

  if (snapshot.actionType === 'script') {
    const command = String(payload.command ?? '');
    if (!command) throw new Error('script action requires payload.command');
    return toolRegistry.execute('exec', { command, cwd: String(payload.cwd ?? workspaceRoot) }, {
      sessionId: `cron:${idempotencyKey}`,
      userId: 'cron-worker',
      callSource: 'background_task',
      workspaceRoot,
      approvedToolNames: approvedTools,
    });
  }

  if (snapshot.actionType === 'evolve') {
    const { runEvolveOnce } = await import('../evolve/experience-writer.js');
    const result = await runEvolveOnce();
    return `evolve: detected ${result.patterns.length} patterns, wrote ${result.writes.length} files`;
  }

  throw new Error(`unsupported action type: ${snapshot.actionType}`);
}
