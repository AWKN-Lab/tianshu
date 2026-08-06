import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { redactText } from '../core/redaction.js';
import { EvolutionLifecycle, type EvolutionStatus } from './lifecycle.js';

export interface ExperienceCandidateDraft {
  experienceId: string;
  contentPath: string;
  title: string;
  sourceFingerprint?: string;
  sourceKind?: string;
  sourceEvidence?: string[];
  correctionIds?: string[];
}

export interface ExperienceCandidateManifest {
  schema: 'awkn-experience-candidate-manifest/v1';
  candidates: ExperienceCandidateDraft[];
}

export interface CandidateIngestOptions {
  workspaceRoot: string;
  db?: Database.Database;
  dryRun?: boolean;
}

export interface CandidateIngestResult {
  experienceId: string;
  contentPath: string;
  contentHash: string;
  sourceFingerprint: string;
  candidateId: string | null;
  status: EvolutionStatus | 'VALIDATED';
  linkedCorrections: number;
  reusedCandidate: boolean;
}

interface DraftMetadata {
  schema: string;
  experienceId: string;
  status: string;
}

function resolveInsideWorkspace(workspaceRoot: string, contentPath: string): string {
  const root = resolve(workspaceRoot);
  const absolute = resolve(root, contentPath);
  const rel = relative(root, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`candidate contentPath escapes workspace: ${contentPath}`);
  }
  return absolute;
}

function parseFrontmatter(content: string): DraftMetadata {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('candidate file requires YAML frontmatter');
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = line.match(/^([a-zA-Z0-9_]+):\s*(.*?)\s*$/);
    if (field) fields.set(field[1]!, field[2]!.replace(/^['"]|['"]$/g, ''));
  }
  return {
    schema: fields.get('schema') ?? '',
    experienceId: fields.get('experience_id') ?? '',
    status: fields.get('status') ?? '',
  };
}

function assertSafeContent(content: string): void {
  if (redactText(content) !== content) {
    throw new Error('candidate contains credential-like content; sanitize before ingest');
  }
  const forbidden = [
    /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
    /\b(?:postgres(?:ql)?|mysql|mariadb):\/\/[^\s:@/]+:[^\s@/]+@/i,
  ];
  if (forbidden.some((pattern) => pattern.test(content))) {
    throw new Error('candidate contains forbidden secret material');
  }
}

function normalizeFingerprint(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(trimmed)) return trimmed;
  return createHash('sha256').update(trimmed).digest('hex');
}

export function computeCandidateFingerprint(
  draft: ExperienceCandidateDraft,
  content: string,
): string {
  if (draft.sourceFingerprint) return normalizeFingerprint(draft.sourceFingerprint);
  return createHash('sha256')
    .update(JSON.stringify({
      experienceId: draft.experienceId,
      title: draft.title,
      sourceKind: draft.sourceKind ?? 'manual_draft',
      content,
    }))
    .digest('hex');
}

export function validateCandidateDraft(
  draft: ExperienceCandidateDraft,
  workspaceRoot: string,
): Omit<CandidateIngestResult, 'candidateId' | 'status' | 'linkedCorrections' | 'reusedCandidate'> {
  if (!/^EXP-(?:DRV|FIX)-\d{8}-\d{3}$/.test(draft.experienceId)) {
    throw new Error(`invalid experienceId: ${draft.experienceId}`);
  }
  if (!draft.title.trim()) throw new Error(`candidate ${draft.experienceId} requires title`);
  const absolutePath = resolveInsideWorkspace(workspaceRoot, draft.contentPath);
  if (!existsSync(absolutePath)) throw new Error(`candidate file not found: ${draft.contentPath}`);
  const content = readFileSync(absolutePath, 'utf-8');
  assertSafeContent(content);
  const metadata = parseFrontmatter(content);
  if (metadata.schema !== 'awkn-experience/v1') {
    throw new Error(`candidate ${draft.experienceId} has unsupported schema: ${metadata.schema || '(missing)'}`);
  }
  if (metadata.experienceId !== draft.experienceId) {
    throw new Error(`candidate ID mismatch: manifest=${draft.experienceId}, file=${metadata.experienceId}`);
  }
  if (metadata.status !== 'DRAFT') {
    throw new Error(`candidate ${draft.experienceId} must be DRAFT before ingest`);
  }
  return {
    experienceId: draft.experienceId,
    contentPath: absolutePath,
    contentHash: createHash('sha256').update(content).digest('hex'),
    sourceFingerprint: computeCandidateFingerprint(draft, content),
  };
}

export function ingestCandidateDraft(
  draft: ExperienceCandidateDraft,
  options: CandidateIngestOptions,
): CandidateIngestResult {
  const validated = validateCandidateDraft(draft, options.workspaceRoot);
  if (options.dryRun) {
    return {
      ...validated,
      candidateId: null,
      status: 'VALIDATED',
      linkedCorrections: 0,
      reusedCandidate: false,
    };
  }
  if (!options.db) throw new Error('db is required when dryRun is false');
  const lifecycle = new EvolutionLifecycle(options.db);
  const existing = lifecycle.findInFlightByFingerprint(validated.sourceFingerprint);
  const candidate = lifecycle.createCandidate({
    experienceId: draft.experienceId,
    contentPath: validated.contentPath,
    contentHash: validated.contentHash,
    sourcePattern: {
      kind: draft.sourceKind ?? 'manual_draft',
      title: draft.title,
      evidence: draft.sourceEvidence ?? [],
    },
    sourceFingerprint: validated.sourceFingerprint,
    correctionIds: draft.correctionIds ?? [],
  });
  return {
    ...validated,
    candidateId: candidate.id,
    status: candidate.status,
    linkedCorrections: lifecycle.listCorrectionIds(candidate.id).length,
    reusedCandidate: existing?.id === candidate.id,
  };
}

export function ingestCandidateManifest(
  manifest: ExperienceCandidateManifest,
  options: CandidateIngestOptions,
): CandidateIngestResult[] {
  if (manifest.schema !== 'awkn-experience-candidate-manifest/v1') {
    throw new Error(`unsupported manifest schema: ${manifest.schema}`);
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const draft of manifest.candidates) {
    if (ids.has(draft.experienceId)) throw new Error(`duplicate experienceId: ${draft.experienceId}`);
    if (paths.has(draft.contentPath)) throw new Error(`duplicate contentPath: ${draft.contentPath}`);
    ids.add(draft.experienceId);
    paths.add(draft.contentPath);
  }
  return manifest.candidates.map((draft) => ingestCandidateDraft(draft, options));
}
