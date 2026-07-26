import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const contractsRoot = resolve(here, '..', '..', 'src', 'contracts');

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const fullPath = join(directory, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) files.push(...listTypeScriptFiles(fullPath));
    else if (stat.isFile() && extname(entry) === '.ts') files.push(fullPath);
  }
  return files;
}

describe('Core Contracts architecture boundary', () => {
  it('has no runtime, database, environment or singleton dependencies', () => {
    const violations: string[] = [];
    const importPattern = /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g;

    for (const file of listTypeScriptFiles(contractsRoot)) {
      const source = readFileSync(file, 'utf8');
      const displayPath = relative(contractsRoot, file).replace(/\\/g, '/');

      if (/\bprocess\.env\b/.test(source)) violations.push(`${displayPath}: reads process.env`);
      if (/\blet\s+instance\s*(?::|=)/.test(source)) violations.push(`${displayPath}: mutable module singleton`);
      if (/(?:^|\/)store\/db(?:\.js)?/.test(source)) violations.push(`${displayPath}: imports store/db`);

      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1];
        if (!specifier.startsWith('.')) continue;
        const resolved = resolve(dirname(file), specifier);
        if (!resolved.startsWith(contractsRoot)) {
          violations.push(`${displayPath}: imports runtime implementation ${specifier}`);
        }
      }
    }

    assert.deepEqual(violations, []);
  });
});
