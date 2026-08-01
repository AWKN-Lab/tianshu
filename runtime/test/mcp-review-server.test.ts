/** End-to-end contract test for the dedicated Review MCP. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ReviewReceiptSchema } from '../src/contracts/public.js';
import { createReviewMcpServer } from '../src/mcp/review-server.js';
import type { LlmRouter } from '../src/llm/router.js';
import { runAgentOsMigrations } from '../src/store/agent-os-migration-registry.js';
import { runReviewRepository } from '../src/tools/builtin/review-repository-tool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const approvedRoot = await mkdtemp(join(tmpdir(), 'awkn-review-approved-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'awkn-review-outside-'));
  const db = new Database(':memory:');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let reviewCalls = 0;
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: approvedRoot, encoding: 'utf8' });
    git('init');
    git('config', 'user.email', 'review-mcp-test@example.invalid');
    git('config', 'user.name', 'Review MCP Test');
    await writeFile(join(approvedRoot, 'a.ts'), 'export const value = 1;\n');
    git('add', '.');
    git('commit', '-m', 'base');
    await writeFile(join(approvedRoot, 'a.ts'), 'export const value = 2;\n');

    db.pragma('foreign_keys = ON');
    runAgentOsMigrations(db);
    const fakeRouter = {
      async chat() {
        return {
          content: '{"findings":[]}',
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
          provider: 'codex' as const,
          model: 'independent-review-model',
          finishReason: 'stop' as const,
        };
      },
    } as unknown as LlmRouter;

    assert.throws(
      () => createReviewMcpServer({ environment: { AWKN_REVIEW_ALLOWED_ROOTS: approvedRoot } }),
      /AWKN_REVIEW_IMPLEMENTER_ACTOR_ID/,
      'server must fail closed without trusted implementer identity',
    );

    const server = createReviewMcpServer({
      environment: {
        AWKN_REVIEW_IMPLEMENTER_ACTOR_ID: 'model:trae:implementation-model',
        AWKN_REVIEW_ALLOWED_ROOTS: [approvedRoot].join(delimiter),
      },
      async runReview(args, context) {
        reviewCalls++;
        assert.equal(context.implementerActorId, 'model:trae:implementation-model');
        return runReviewRepository(args, context, { router: fakeRouter, db });
      },
    });
    const client = new Client({ name: 'awkn-review-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['review_repository']);
    const schema = listed.tools[0]!.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    assert.equal(schema.required?.includes('repositoryRoot'), true);
    assert.equal('implementerActorId' in (schema.properties ?? {}), false);

    const reviewed = await client.callTool({
      name: 'review_repository',
      arguments: { repositoryRoot: approvedRoot, mode: 'enforce', reviewerProvider: 'codex' },
    });
    assert.equal(reviewed.isError, undefined);
    const structured = reviewed.structuredContent as { schema?: string; receipt?: unknown } | undefined;
    assert.equal(structured?.schema, 'awkn-review-mcp-result/v1');
    assert.equal(ReviewReceiptSchema.safeParse(structured?.receipt).success, true);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }).n, 1);
    assert.equal(reviewCalls, 1, 'legal enforce call must reach Review Kernel exactly once');

    const selfReview = await client.callTool({
      name: 'review_repository',
      arguments: { repositoryRoot: approvedRoot, mode: 'enforce', reviewerProvider: 'trae' },
    });
    assert.equal(selfReview.isError, true);
    assert.match((selfReview.content[0] as { text?: string }).text ?? '', /must differ/);
    assert.equal(reviewCalls, 1, 'same-provider self-review must fail before the Kernel');

    const spoofed = await client.callTool({
      name: 'review_repository',
      arguments: {
        repositoryRoot: approvedRoot,
        mode: 'enforce',
        implementerActorId: 'model:attacker:spoofed',
      },
    });
    assert.equal(spoofed.isError, undefined);
    assert.equal(
      reviewCalls,
      2,
      'unknown identity input may be stripped by the SDK, but the Kernel must still receive only trusted host identity',
    );

    const escaped = await client.callTool({
      name: 'review_repository',
      arguments: { repositoryRoot: outsideRoot, mode: 'enforce' },
    });
    assert.equal(escaped.isError, true);
    assert.match(
      (escaped.content[0] as { text?: string }).text ?? '',
      /outside AWKN_REVIEW_ALLOWED_ROOTS/,
    );
    assert.equal(reviewCalls, 2, 'out-of-scope repository must be rejected before the Kernel');

    const incompleteRange = await client.callTool({
      name: 'review_repository',
      arguments: { repositoryRoot: approvedRoot, mode: 'enforce', baseRef: 'HEAD~1' },
    });
    assert.equal(incompleteRange.isError, true);
    assert.equal(reviewCalls, 2);

    await client.close();
    await server.close();
    console.log(`PASS: Review MCP issued a complete Receipt and enforced trusted identity/path boundaries (${resolve(__dirname, '..')})`);
  } finally {
    db.close();
    await rm(approvedRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('FAIL:', error);
  process.exitCode = 1;
});
