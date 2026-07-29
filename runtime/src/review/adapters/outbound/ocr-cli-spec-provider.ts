import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  OCR_DELEGATE_SPEC_SCHEMA,
  OcrDelegateSpecSchema,
  REVIEW_SCOPE_SPEC_SCHEMA,
  ReviewScopeSpecSchema,
  type OcrDelegateSpec,
  type ReviewExcludeReason,
  type ReviewFile,
  type ReviewFileStatus,
  type ReviewScopeSpec,
} from '../../../contracts/public.js';
import { parseTrustedJson } from '../../../input/public.js';
import type { ReviewScopeRequest, ReviewSpecProviderPort } from '../../ports/outbound/review-spec-provider-port.js';

export interface OcrCommandResult {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitCode: number;
}

export interface OcrCommandRunner {
  run(file: string, args: readonly string[], options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly maxBufferBytes: number;
  }): Promise<OcrCommandResult>;
}

class ExecFileOcrCommandRunner implements OcrCommandRunner {
  run(file: string, args: readonly string[], options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly maxBufferBytes: number;
  }): Promise<OcrCommandResult> {
    return new Promise((resolvePromise, reject) => {
      execFile(file, [...args], {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes,
        encoding: 'buffer',
        windowsHide: true,
        shell: false,
      }, (error, stdout, stderr) => {
        if (error !== null && !('code' in error)) {
          reject(error);
          return;
        }
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolvePromise({
          stdout: Uint8Array.from(stdout),
          stderr: Uint8Array.from(stderr),
          exitCode: code,
        });
      });
    });
  }
}

export interface OcrCliSpecProviderOptions {
  readonly binaryPath: string;
  /** Engine-owned directory that must contain the OCR executable. */
  readonly allowedBinaryRoot: string;
  readonly expectedVersion?: string;
  readonly expectedBinarySha256?: string;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
  readonly runner?: OcrCommandRunner;
  readonly env?: NodeJS.ProcessEnv;
}

function safeProcessEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC',
    'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'LANG', 'LC_ALL',
  ];
  return Object.fromEntries(allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]));
}

function stripSha256(value: string): string {
  return value.slice('sha256:'.length);
}

function statusOf(value: OcrDelegateSpec['files'][number]['status']): ReviewFileStatus {
  switch (value) {
    case 'added': return 'ADDED';
    case 'modified': return 'MODIFIED';
    case 'deleted': return 'DELETED';
    case 'renamed': return 'RENAMED';
    case 'binary': return 'BINARY';
  }
}

function excludeReasonOf(value: OcrDelegateSpec['files'][number]['exclude_reason']): ReviewExcludeReason | undefined {
  switch (value) {
    case null: return undefined;
    case 'binary': return 'BINARY';
    case 'user_exclude': return 'USER_EXCLUDED';
    case 'unsupported_ext': return 'UNSUPPORTED';
    case 'default_path':
    case 'provider_default_path':
    case 'gitignore':
      return 'RULE_EXCLUDED';
    case 'deleted': return 'UNSUPPORTED';
  }
}

function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|tests?)(\/|\.)|\.(test|spec)\./i.test(path);
}

function mapFile(file: OcrDelegateSpec['files'][number]): ReviewFile {
  const policyForcesReview = file.status === 'deleted'
    || (isTestPath(file.path) && file.exclude_reason !== 'binary' && file.exclude_reason !== 'unsupported_ext');
  const willReview = policyForcesReview || file.will_review;
  return {
    path: file.path,
    ...(file.old_path === null ? {} : { oldPath: file.old_path }),
    status: statusOf(file.status),
    insertions: file.insertions,
    deletions: file.deletions,
    diffFingerprint: stripSha256(file.diff_fingerprint),
    willReview,
    ...(willReview ? {} : { excludeReason: excludeReasonOf(file.exclude_reason) ?? 'UNSUPPORTED' }),
    ruleGroupIds: [`ocr:${file.rule_group_id}`],
  };
}

function mapOcrSpec(spec: OcrDelegateSpec): ReviewScopeSpec {
  return ReviewScopeSpecSchema.parse({
    schema: REVIEW_SCOPE_SPEC_SCHEMA,
    provider: 'open-code-review',
    providerVersion: spec.ocr_version,
    repositoryRoot: resolve(spec.repository.root),
    baseRef: spec.target.from_oid,
    headRef: spec.target.to_oid,
    mergeBase: spec.target.merge_base_oid,
    diffFingerprint: stripSha256(spec.diff_fingerprint),
    files: spec.files.map(mapFile),
    ruleGroups: spec.rule_groups.map((group) => ({
      ruleGroupId: `ocr:${group.id}`,
      source: group.source,
      pattern: group.pattern,
      contentHash: stripSha256(group.content_hash),
      text: group.rule,
      files: group.files,
    })),
  });
}

export class OcrCliSpecProvider implements ReviewSpecProviderPort {
  readonly provider = 'open-code-review' as const;
  private readonly runner: OcrCommandRunner;

  constructor(private readonly options: OcrCliSpecProviderOptions) {
    this.runner = options.runner ?? new ExecFileOcrCommandRunner();
  }

  async createScope(request: ReviewScopeRequest): Promise<ReviewScopeSpec> {
    if (request.mode !== 'COMMIT_RANGE') throw new Error('ocr-delegate-spec/v1 supports COMMIT_RANGE only');
    if (request.baseRef === undefined || request.headRef === undefined) {
      throw new Error('OCR commit range requires baseRef and headRef');
    }
    if (!isAbsolute(request.repositoryRoot)) throw new Error('OCR repositoryRoot must be absolute');
    this.assertEngineLocalBinary();
    await this.verifyBinary();
    const result = await this.runner.run(this.options.binaryPath, [
      'delegate', 'spec', '--format', 'json', '--repo', request.repositoryRoot,
      '--from', request.baseRef, '--to', request.headRef,
    ], {
      cwd: request.repositoryRoot,
      env: this.options.env ?? safeProcessEnv(process.env),
      timeoutMs: this.options.timeoutMs ?? 30_000,
      maxBufferBytes: this.options.maxBufferBytes ?? 16 * 1024 * 1024,
    });
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder('utf-8', { fatal: false }).decode(result.stderr).slice(0, 2_000);
      throw new Error(`OCR delegate spec failed with exit ${result.exitCode}: ${stderr}`);
    }
    const parsedJson = parseTrustedJson(result.stdout, {
      limits: { maxInputBytes: this.options.maxBufferBytes ?? 16 * 1024 * 1024 },
    });
    if (!parsedJson.ok) {
      const diagnostics = parsedJson.receiptPayload.diagnostics.map((item) => item.code).join(', ');
      throw new Error(`OCR stdout is not trusted JSON: ${diagnostics}`);
    }
    const parsed = OcrDelegateSpecSchema.safeParse(parsedJson.document.value);
    if (!parsed.success) {
      throw new Error(`invalid ${OCR_DELEGATE_SPEC_SCHEMA}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
    }
    if (this.options.expectedVersion !== undefined && parsed.data.ocr_version !== this.options.expectedVersion) {
      throw new Error(`OCR version mismatch: expected ${this.options.expectedVersion}, got ${parsed.data.ocr_version}`);
    }
    if (resolve(parsed.data.repository.root) !== resolve(request.repositoryRoot)) {
      throw new Error('OCR repository root does not match request');
    }
    return mapOcrSpec(parsed.data);
  }

  private async verifyBinary(): Promise<void> {
    if (this.options.expectedBinarySha256 === undefined) return;
    if (!/^[0-9a-f]{64}$/.test(this.options.expectedBinarySha256)) {
      throw new Error('expectedBinarySha256 must be a lowercase SHA-256 hex string');
    }
    const [binaryPath, allowedRoot] = await Promise.all([
      realpath(this.options.binaryPath),
      realpath(this.options.allowedBinaryRoot),
    ]);
    this.assertContained(binaryPath, allowedRoot);
    const bytes = await readFile(binaryPath);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== this.options.expectedBinarySha256) {
      throw new Error(`OCR binary SHA-256 mismatch: expected ${this.options.expectedBinarySha256}, got ${actual}`);
    }
  }

  private assertEngineLocalBinary(): void {
    if (!isAbsolute(this.options.binaryPath) || !isAbsolute(this.options.allowedBinaryRoot)) {
      throw new Error('OCR binaryPath and allowedBinaryRoot must be absolute engine-local paths');
    }
    this.assertContained(resolve(this.options.binaryPath), resolve(this.options.allowedBinaryRoot));
  }

  private assertContained(binaryPath: string, allowedRoot: string): void {
    const relativePath = relative(allowedRoot, binaryPath);
    if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error('OCR binary must be inside the AWKN engine integrations/open-code-review directory');
    }
  }
}
