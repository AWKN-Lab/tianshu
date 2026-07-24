import { closeDb, getDb } from './store/db.js';
import { getMemoryService } from './memory/service.js';
import type { MemoryType } from './memory/types.js';

function args(): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 3; index < process.argv.length; index++) {
    const current = process.argv[index]!;
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const value = process.argv[index + 1] && !process.argv[index + 1]!.startsWith('--') ? process.argv[++index]! : '';
    output[key] = value;
  }
  return output;
}

function usage(): never {
  console.error('Usage: npm run memory -- put|search|context|versions|rollback|invalidate|compress|gc [--type TYPE --scope ID --key KEY --content TEXT --query TEXT --version N]');
  process.exit(1);
}

function type(value: string | undefined): MemoryType {
  const resolved = value as MemoryType;
  if (!['working', 'project_semantic', 'task_trajectory', 'engineering_experience'].includes(resolved)) usage();
  return resolved;
}

function main(): void {
  getDb();
  const service = getMemoryService();
  const command = process.argv[2];
  const options = args();
  try {
    if (command === 'put') {
      console.log(JSON.stringify(service.put({
        type: type(options.type),
        scopeId: options.scope ?? '',
        key: options.key ?? '',
        content: options.content ?? '',
        importance: options.importance ? Number(options.importance) : undefined,
        confidence: options.confidence ? Number(options.confidence) : undefined,
        expiresAt: options.expiresAt,
      }), null, 2));
      return;
    }
    if (command === 'search') {
      console.log(JSON.stringify(service.search({
        query: options.query ?? '',
        types: options.type ? [type(options.type)] : undefined,
        scopeIds: options.scope ? options.scope.split(',') : undefined,
        limit: options.limit ? Number(options.limit) : undefined,
      }), null, 2));
      return;
    }
    if (command === 'context') {
      console.log(service.buildContext({ query: options.query ?? '', projectId: options.project, sessionId: options.session }));
      return;
    }
    if (command === 'versions') {
      console.log(JSON.stringify(service.listVersions(type(options.type), options.scope ?? '', options.key ?? ''), null, 2));
      return;
    }
    if (command === 'rollback') {
      console.log(JSON.stringify(service.rollback(type(options.type), options.scope ?? '', options.key ?? '', Number(options.version)), null, 2));
      return;
    }
    if (command === 'invalidate') {
      console.log(JSON.stringify(service.invalidate(options.id ?? '', options.reason ?? 'manual invalidation'), null, 2));
      return;
    }
    if (command === 'compress') {
      console.log(JSON.stringify(service.compress({
        type: type(options.type),
        scopeId: options.scope ?? '',
        key: options.key,
        maxChars: options.maxChars ? Number(options.maxChars) : undefined,
      }), null, 2));
      return;
    }
    if (command === 'gc') {
      console.log(JSON.stringify({ expired: service.expireNow() }, null, 2));
      return;
    }
    usage();
  } finally {
    closeDb();
  }
}

main();
