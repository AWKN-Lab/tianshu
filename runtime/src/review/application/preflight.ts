/**
 * awkn-engine — Review 执行预检（技能吸收 P1-5）
 *
 * 在启动 LLM review 前对变更集做静态预检：
 * - scale：改动规模超限（文件数 / 预估行数）→ BLOCK；
 * - sensitive：敏感目录（密钥、凭证、数据文件）→ 标记 WARN；
 * - generated：生成物（构建产物、依赖锁、覆盖率）→ 建议排除 WARN；
 * - binary：二进制文件 → WARN（不可文本审核）。
 */

import type { ReviewFile } from '../../contracts/public.js';

export type PreflightSeverity = 'WARN' | 'BLOCK';

export interface PreflightIssue {
  readonly code: 'SCALE_TOO_LARGE' | 'SENSITIVE_PATH' | 'GENERATED_PATH' | 'BINARY_PATH';
  readonly severity: PreflightSeverity;
  readonly path?: string;
  readonly message: string;
}

export interface PreflightOptions {
  /** 最大变更文件数（超过 → BLOCK，默认 300） */
  readonly maxFiles?: number;
  /** 最大预估变更行数（超过 → BLOCK，默认 20000） */
  readonly maxLines?: number;
  /** 敏感路径正则（附加） */
  readonly extraSensitivePatterns?: readonly RegExp[];
  /** 生成物路径正则（附加） */
  readonly extraGeneratedPatterns?: readonly RegExp[];
}

export interface PreflightReport {
  readonly verdict: 'PASS' | 'WARN' | 'BLOCK';
  readonly issues: readonly PreflightIssue[];
  readonly summary: {
    readonly totalFiles: number;
    readonly reviewableFiles: number;
    readonly estimatedLines: number;
  };
}

const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /(^|\/)(\.env.*|.*\.pem|.*\.key|.*\.p12|.*\.pfx|credentials?.*|secrets?.*|tokens?.*)(\/|$|\.)/i,
  /(^|\/)data\/.*\.(db|sqlite|sqlite3)$/i,
  /(^|\/)(\.aws|\.ssh|\.npmrc|\.pypirc|kubeconfig|\.git-credentials)(\/|$)/i,
];

const GENERATED_PATTERNS: readonly RegExp[] = [
  /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|node_modules|vendor)(\/|$)/i,
  /\.(min|bundle)\.(js|css)$/i,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)(go\.sum|go\.mod)$/,
];

const BINARY_PATTERNS: readonly RegExp[] = [
  /\.(png|jpe?g|gif|webp|ico|bmp|pdf|exe|dll|so|dylib|bin|class|jar|wasm|zip|gz|tgz|7z|rar|mp4|mov|avi|mp3|wav)$/i,
];

function estimatedLines(file: ReviewFile): number {
  return Math.max(0, file.insertions + file.deletions);
}

export function runPreflight(files: readonly ReviewFile[], options?: PreflightOptions): PreflightReport {
  const maxFiles = options?.maxFiles ?? 300;
  const maxLines = options?.maxLines ?? 20_000;
  const issues: PreflightIssue[] = [];
  const reviewable = files.filter((file) => file.willReview);
  const totalLines = reviewable.reduce((sum, file) => sum + estimatedLines(file), 0);

  if (files.length > maxFiles) {
    issues.push({
      code: 'SCALE_TOO_LARGE',
      severity: 'BLOCK',
      message: `changeset exceeds max files (${files.length} > ${maxFiles}); refusing full review`,
    });
  }
  if (totalLines > maxLines) {
    issues.push({
      code: 'SCALE_TOO_LARGE',
      severity: 'BLOCK',
      message: `changeset exceeds max estimated lines (${totalLines} > ${maxLines}); refusing full review`,
    });
  }

  const sensitive = [...SENSITIVE_PATTERNS, ...(options?.extraSensitivePatterns ?? [])];
  const generated = [...GENERATED_PATTERNS, ...(options?.extraGeneratedPatterns ?? [])];

  for (const file of files) {
    if (sensitive.some((pattern) => pattern.test(file.path))) {
      issues.push({
        code: 'SENSITIVE_PATH',
        severity: 'WARN',
        path: file.path,
        message: `sensitive path in changeset; treat output as restricted`,
      });
    } else if (generated.some((pattern) => pattern.test(file.path))) {
      issues.push({
        code: 'GENERATED_PATH',
        severity: 'WARN',
        path: file.path,
        message: `generated artifact in changeset; consider excluding from review scope`,
      });
    } else if (BINARY_PATTERNS.some((pattern) => pattern.test(file.path))) {
      issues.push({
        code: 'BINARY_PATH',
        severity: 'WARN',
        path: file.path,
        message: `binary file in changeset; not text-reviewable`,
      });
    }
  }

  const verdict: PreflightReport['verdict'] = issues.some((issue) => issue.severity === 'BLOCK')
    ? 'BLOCK'
    : issues.length > 0
      ? 'WARN'
      : 'PASS';
  return {
    verdict,
    issues,
    summary: {
      totalFiles: files.length,
      reviewableFiles: reviewable.length,
      estimatedLines: totalLines,
    },
  };
}
