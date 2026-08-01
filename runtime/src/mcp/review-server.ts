/** Dedicated, fail-closed AWKN Review MCP Server. */
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, delimiter } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { WorktreeReviewResult } from '../adapter/review-kernel-runner.js';
import { loadRuntimeEnv } from '../config/runtime-env.js';
import { ObjectRefSchema, ReviewReceiptSchema } from '../contracts/public.js';
import { closeDb } from '../store/db.js';
import {
  reviewRepositoryTool,
  runReviewRepository,
} from '../tools/builtin/review-repository-tool.js';
import type { ExecutionContext } from '../tools/types.js';

const ContractArtifactSchema = z.object({
  kind: z.enum(['PRD', 'SPEC', 'ACCEPTANCE_CRITERION']),
  ref: ObjectRefSchema,
  content: z.string().min(1),
}).strict();

const ReviewInputShape = {
  repositoryRoot: z.string().min(1).refine(isAbsolute, 'repositoryRoot must be an absolute path'),
  mode: z.literal('enforce').optional().default('enforce'),
  reviewerProvider: z.enum(['trae', 'codex', 'minimax']).optional(),
  contractArtifacts: z.array(ContractArtifactSchema).optional(),
  baseRef: z.string().min(1).optional(),
  headRef: z.string().min(1).optional(),
};

const ReviewInputSchema = z.object(ReviewInputShape).strict().superRefine((value, context) => {
  if ((value.baseRef === undefined) !== (value.headRef === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: value.baseRef === undefined ? ['baseRef'] : ['headRef'],
      message: 'baseRef and headRef must be provided together',
    });
  }
});

const ReviewMcpResultSchema = z.object({
  schema: z.literal('awkn-review-mcp-result/v1'),
  receipt: ReviewReceiptSchema,
  totalTokens: z.number().int().nonnegative(),
  executionId: z.string().min(1),
  traceId: z.string().min(1),
}).strict();

interface ReviewMcpConfig {
  readonly implementerActorId: string;
  readonly implementerProvider: string;
  readonly approvedRoots: readonly string[];
}

export interface ReviewMcpServerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly runReview?: (
    args: Record<string, unknown>,
    context: ExecutionContext,
  ) => Promise<WorktreeReviewResult>;
}

function readConfig(environment: NodeJS.ProcessEnv): ReviewMcpConfig {
  const implementerActorId = environment.AWKN_REVIEW_IMPLEMENTER_ACTOR_ID?.trim();
  if (!implementerActorId || !/^model:[^:]+:.+$/u.test(implementerActorId)) {
    throw new Error(
      'AWKN_REVIEW_IMPLEMENTER_ACTOR_ID must be injected by the trusted MCP host as model:<provider>:<model>',
    );
  }
  const approvedRoots = (environment.AWKN_REVIEW_ALLOWED_ROOTS ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (approvedRoots.length === 0 || approvedRoots.some((entry) => !isAbsolute(entry))) {
    throw new Error('AWKN_REVIEW_ALLOWED_ROOTS must contain one or more absolute, host-approved roots');
  }
  return {
    implementerActorId,
    implementerProvider: implementerActorId.split(':')[1]!,
    approvedRoots,
  };
}

async function authorizeRepositoryRoot(
  requestedRoot: string,
  approvedRoots: readonly string[],
): Promise<string> {
  const canonicalRoot = await realpath(requestedRoot);
  const canonicalApprovedRoots = await Promise.all(approvedRoots.map((root) => realpath(root)));
  const approved = canonicalApprovedRoots.some((root) => {
    const child = relative(root, canonicalRoot);
    return child === '' || (!child.startsWith('..') && !isAbsolute(child));
  });
  if (!approved) throw new Error('repositoryRoot is outside AWKN_REVIEW_ALLOWED_ROOTS');
  return canonicalRoot;
}

function toError(error: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

export function createReviewMcpServer(options: ReviewMcpServerOptions = {}): McpServer {
  const environment = options.environment ?? process.env;
  const config = readConfig(environment);
  const executeReview = options.runReview ?? ((args, context) => runReviewRepository(args, context));
  const server = new McpServer(
    { name: 'awkn-review', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'AWKN Review Kernel. The MCP host supplies trusted implementer identity and approved repository roots. ' +
        'Only a complete, valid awkn-review-receipt/v1 PASS may satisfy a release review gate.',
    },
  );

  server.registerTool(
    'review_repository',
    {
      description: reviewRepositoryTool.description,
      inputSchema: ReviewInputShape,
      outputSchema: {
        schema: z.literal('awkn-review-mcp-result/v1'),
        receipt: z.record(z.unknown()),
        totalTokens: z.number().int().nonnegative(),
        executionId: z.string().min(1),
        traceId: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        // The outer object refinement enforces paired refs in addition to the
        // SDK's field-level validation generated from ReviewInputShape.
        const parsedArgs = ReviewInputSchema.parse(args);
        const reviewerProvider = parsedArgs.reviewerProvider ?? 'codex';
        if (reviewerProvider === config.implementerProvider) {
          throw new Error('reviewerProvider must differ from the trusted implementer provider');
        }
        const repositoryRoot = await authorizeRepositoryRoot(parsedArgs.repositoryRoot, config.approvedRoots);
        const result = await executeReview(
          { ...parsedArgs, repositoryRoot, reviewerProvider },
          {
            sessionId: `mcp-review-${Date.now()}`,
            userId: 'mcp-host',
            callSource: 'main_dialogue',
            workspaceRoot: repositoryRoot,
            implementerActorId: config.implementerActorId,
            approvedToolNames: ['review_repository'],
          },
        );
        const response = ReviewMcpResultSchema.parse({
          schema: 'awkn-review-mcp-result/v1',
          receipt: result.receipt,
          totalTokens: result.totalTokens,
          executionId: result.executionId,
          traceId: result.traceId,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
          structuredContent: response,
        };
      } catch (error) {
        return toError(error);
      }
    },
  );
  return server;
}

export async function main(): Promise<void> {
  // Existing host values win; .env supplies provider credentials without putting secrets in MCP config.
  loadRuntimeEnv();
  const server = createReviewMcpServer();
  // stdout belongs exclusively to JSON-RPC when using stdio transport.
  console.log = (...args: unknown[]) => console.error('[awkn-review-mcp]', ...args);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await server.close();
    closeDb();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
