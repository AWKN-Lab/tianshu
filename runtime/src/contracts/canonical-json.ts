import { createHash } from 'node:crypto';
import type { JsonValue } from './json-value.js';

const HASH_DOMAIN = 'awkn-canonical-json/v1\n';

export interface CanonicalizeOptions {
  /** JSON Pointer paths whose string values are declared text fields. */
  textPaths?: ReadonlySet<string>;
}

export class CanonicalJsonError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} at ${path || '/'}`);
    this.name = 'CanonicalJsonError';
  }
}

function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function childPath(parent: string, token: string | number): string {
  return `${parent}/${escapePointerToken(String(token))}`;
}

function assertValidUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalJsonError('unpaired high surrogate', path);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalJsonError('unpaired low surrogate', path);
    }
  }
}

function normalizeString(value: string, path: string, textPaths?: ReadonlySet<string>): string {
  assertValidUnicode(value, path);
  const textNormalized = textPaths?.has(path) ? value.replace(/\r\n?/g, '\n') : value;
  return textNormalized.normalize('NFC');
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serialize(value: unknown, path: string, options: CanonicalizeOptions): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError('non-finite number', path);
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'string':
      return JSON.stringify(normalizeString(value, path, options.textPaths));
    case 'undefined':
      throw new CanonicalJsonError('undefined is not a JSON value', path);
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new CanonicalJsonError(`${typeof value} is not a JSON value`, path);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError('unsupported JSON value', path);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item, index) => serialize(item, childPath(path, index), options)).join(',')}]`;
  }

  if (!isPlainRecord(value)) {
    throw new CanonicalJsonError('only plain objects are supported', path);
  }

  const normalizedEntries = new Map<string, unknown>();
  for (const [rawKey, item] of Object.entries(value)) {
    const normalizedKey = normalizeString(rawKey, childPath(path, rawKey), undefined);
    if (normalizedEntries.has(normalizedKey)) {
      throw new CanonicalJsonError(`duplicate key after NFC normalization: ${normalizedKey}`, path);
    }
    if (item === undefined) {
      throw new CanonicalJsonError('undefined object field', childPath(path, normalizedKey));
    }
    normalizedEntries.set(normalizedKey, item);
  }

  const keys = [...normalizedEntries.keys()].sort(compareUnicodeCodePoints);
  const fields = keys.map((key) => {
    const itemPath = childPath(path, key);
    return `${JSON.stringify(key)}:${serialize(normalizedEntries.get(key), itemPath, options)}`;
  });
  return `{${fields.join(',')}}`;
}

export function canonicalizeJson(value: JsonValue | unknown, options: CanonicalizeOptions = {}): string {
  return serialize(value, '', options);
}

export function canonicalJsonBytes(value: JsonValue | unknown, options: CanonicalizeOptions = {}): Buffer {
  return Buffer.from(canonicalizeJson(value, options), 'utf8');
}

export function stableHash(
  schemaId: string,
  value: JsonValue | unknown,
  options: CanonicalizeOptions = {},
): string {
  if (!schemaId.trim()) throw new CanonicalJsonError('schemaId is required', '/schemaId');
  const hash = createHash('sha256');
  hash.update(HASH_DOMAIN, 'utf8');
  hash.update(schemaId.normalize('NFC'), 'utf8');
  hash.update('\n', 'utf8');
  hash.update(canonicalJsonBytes(value, options));
  return hash.digest('hex');
}
