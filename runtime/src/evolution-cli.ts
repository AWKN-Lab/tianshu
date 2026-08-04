import type { LlmProvider } from './llm/types.js';
import { loadRuntimeEnv } from './config/runtime-env.js';
import { closeDb, getDb } from './store/db.js';
import { EvolutionLifecycle, type EvolutionStatus } from './evolve/lifecycle.js';
import { EvolutionOrchestrator } from './evolve/operational-evolution.js';

loadRuntimeEnv();

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  console.error(`Usage:
  npm run evolution -- list [STATUS]
  npm run evolution -- create --experience ID --path FILE [--fingerprint HASH]
  npm run evolution -- import-runs [--limit N]
  npm run evolution -- evaluate CANDIDATE_ID [--provider trae|codex|minimax] [--cwd PATH] [--maxTurns N]
  npm run evolution -- promote CANDIDATE_ID [--provider trae|codex|minimax] [--cwd PATH] [--maxTurns N]
  npm run evolution -- activate CANDIDATE_ID
  npm run evolution -- quarantine CANDIDATE_ID [reason]
  npm run evolution -- retire CANDIDATE_ID
  npm run evolution -- rollback EXPERIENCE_ID`);
  process.exit(1);
}

async function main(): Promise<void> {
  getDb();
  const lifecycle = new EvolutionLifecycle();
  const orchestrator = new EvolutionOrchestrator();
  const [command, value, reason] = process.argv.slice(2);
  try {
    if (command === 'list') {
      console.log(JSON.stringify(lifecycle.list(value as EvolutionStatus | undefined), null, 2));
      return;
    }
    if (command === 'create') {
      const experienceId = arg('experience');
      const contentPath = arg('path');
      if (!experienceId || !contentPath) usage();
      console.log(JSON.stringify(lifecycle.createCandidate({
        experienceId,
        contentPath,
        sourceFingerprint: arg('fingerprint'),
      }), null, 2));
      return;
    }
    if (command === 'import-runs') {
      console.log(JSON.stringify(orchestrator.importHistoricalRuns(Number(arg('limit') ?? 20)), null, 2));
      return;
    }
    if ((command === 'evaluate' || command === 'promote') && value) {
      const input = {
        candidateId: value,
        provider: arg('provider') as LlmProvider | undefined,
        cwd: arg('cwd') ?? process.cwd(),
        maxTurns: Number(arg('maxTurns') ?? 6),
        importLimit: Number(arg('limit') ?? 20),
      };
      const result = command === 'promote'
        ? await orchestrator.promote(input)
        : await orchestrator.evaluateCandidate(input);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (command === 'activate' && value) {
      console.log(JSON.stringify(await orchestrator.activateApprovedCandidate(value), null, 2));
      return;
    }
    if (command === 'quarantine' && value) {
      console.log(JSON.stringify(await orchestrator.quarantineCandidate(value, reason), null, 2));
      return;
    }
    if (command === 'retire' && value) {
      console.log(JSON.stringify(lifecycle.transition(value, 'RETIRED'), null, 2));
      return;
    }
    if (command === 'rollback' && value) {
      console.log(JSON.stringify(await orchestrator.rollback(value), null, 2));
      return;
    }
    usage();
  } finally {
    closeDb();
  }
}

void main();
