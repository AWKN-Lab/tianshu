import { closeDb, getDb } from './store/db.js';
import { EvolutionLifecycle, type EvolutionStatus } from './evolve/lifecycle.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  console.error('Usage: npm run evolution -- list [STATUS] | create --experience ID --path FILE | activate ID | quarantine ID [reason] | retire ID | rollback EXPERIENCE_ID');
  process.exit(1);
}

function main(): void {
  getDb();
  const lifecycle = new EvolutionLifecycle();
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
      console.log(JSON.stringify(lifecycle.createCandidate({ experienceId, contentPath }), null, 2));
      return;
    }
    if (command === 'activate' && value) {
      console.log(JSON.stringify(lifecycle.activate(value), null, 2));
      return;
    }
    if (command === 'quarantine' && value) {
      console.log(JSON.stringify(lifecycle.transition(value, 'QUARANTINED', reason), null, 2));
      return;
    }
    if (command === 'retire' && value) {
      console.log(JSON.stringify(lifecycle.transition(value, 'RETIRED'), null, 2));
      return;
    }
    if (command === 'rollback' && value) {
      console.log(JSON.stringify(lifecycle.rollback(value), null, 2));
      return;
    }
    usage();
  } finally {
    closeDb();
  }
}

main();
