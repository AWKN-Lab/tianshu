import { closeDb, getDb } from './store/db.js';
import { getApprovalStore } from './workflow/approval-store.js';

function usage(): never {
  console.error('Usage: npm run approval -- list [pending|approved|denied] | show <id> | approve <id> [actor] | deny <id> [actor]');
  process.exit(1);
}

function main(): void {
  getDb();
  const [command, value, actor] = process.argv.slice(2);
  const store = getApprovalStore();
  try {
    if (command === 'list') {
      const status = value as 'pending' | 'approved' | 'denied' | undefined;
      console.log(JSON.stringify(store.list(status), null, 2));
      return;
    }
    if (command === 'show' && value) {
      console.log(JSON.stringify(store.read(value), null, 2));
      return;
    }
    if (command === 'approve' && value) {
      console.log(JSON.stringify(store.decide(value, 'approved', actor ?? 'user'), null, 2));
      return;
    }
    if (command === 'deny' && value) {
      console.log(JSON.stringify(store.decide(value, 'denied', actor ?? 'user'), null, 2));
      return;
    }
    usage();
  } finally {
    closeDb();
  }
}

main();
