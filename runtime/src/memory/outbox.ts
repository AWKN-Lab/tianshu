import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface MemoryOutboxRecord {
  id: string;
  method: string;
  path: string;
  payload: Record<string, unknown> | null;
  idempotencyKey: string;
  checksum: string;
  createdAt: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function checksum(input: Omit<MemoryOutboxRecord, 'checksum'>): string {
  return createHash('sha256').update(stableJson(input)).digest('hex');
}

export class MemoryOutbox {
  readonly filePath: string;
  readonly quarantinePath: string;

  constructor(filePath = process.env.AWKN_MEMORY_OS_OUTBOX ?? resolve(process.cwd(), 'data', 'memory-os-outbox.jsonl')) {
    this.filePath = resolve(filePath);
    this.quarantinePath = `${this.filePath}.quarantine.jsonl`;
  }

  enqueue(input: {
    method: string;
    path: string;
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string;
  }): MemoryOutboxRecord {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const base: Omit<MemoryOutboxRecord, 'checksum'> = {
      id: randomUUID(),
      method: input.method.toUpperCase(),
      path: input.path,
      payload: input.payload ?? null,
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const record: MemoryOutboxRecord = { ...base, checksum: checksum(base) };
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf-8');
    return record;
  }

  readValid(): MemoryOutboxRecord[] {
    if (!existsSync(this.filePath)) return [];
    const valid: MemoryOutboxRecord[] = [];
    const quarantined: string[] = [];
    for (const line of readFileSync(this.filePath, 'utf-8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as MemoryOutboxRecord;
        const { checksum: digest, ...base } = record;
        if (!digest || checksum(base) !== digest) {
          quarantined.push(line);
          continue;
        }
        valid.push(record);
      } catch {
        quarantined.push(line);
      }
    }
    if (quarantined.length > 0) {
      mkdirSync(dirname(this.quarantinePath), { recursive: true });
      appendFileSync(this.quarantinePath, `${quarantined.join('\n')}\n`, 'utf-8');
    }
    return valid;
  }

  replace(records: MemoryOutboxRecord[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    const content = records.map((record) => JSON.stringify(record)).join('\n');
    writeFileSync(temporary, content ? `${content}\n` : '', 'utf-8');
    renameSync(temporary, this.filePath);
  }
}
