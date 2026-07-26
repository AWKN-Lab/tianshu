import { createHash } from 'node:crypto';
import {
  InputJsonReceiptPayloadSchema,
  TRUSTED_JSON_PARSER_VERSION,
  TrustedJsonDocumentSchema,
  TrustedJsonLimitsSchema,
  stableHash,
  type InputJsonReceiptPayload,
  type JsonValue,
  type TrustedJsonDiagnostic,
  type TrustedJsonDiagnosticCode,
  type TrustedJsonDocument,
  type TrustedJsonLimits,
} from '../../contracts/public.js';

export const DEFAULT_TRUSTED_JSON_LIMITS: TrustedJsonLimits = Object.freeze({
  maxInputBytes: 1_048_576,
  maxDepth: 64,
  maxNodes: 100_000,
  maxStringLength: 262_144,
});

export interface TrustedJsonParseOptions {
  limits?: Partial<TrustedJsonLimits>;
}

export type TrustedJsonParseResult =
  | {
      ok: true;
      document: TrustedJsonDocument;
      receiptPayload: InputJsonReceiptPayload;
    }
  | {
      ok: false;
      receiptPayload: InputJsonReceiptPayload;
    };

class ParserFailure extends Error {
  constructor(readonly diagnostic: TrustedJsonDiagnostic) {
    super(diagnostic.message);
    this.name = 'ParserFailure';
  }
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function pointerToken(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function childPath(parent: string, token: string | number): string {
  return `${parent}/${pointerToken(String(token))}`;
}

function resolveLimits(options?: TrustedJsonParseOptions): TrustedJsonLimits {
  return TrustedJsonLimitsSchema.parse({
    ...DEFAULT_TRUSTED_JSON_LIMITS,
    ...options?.limits,
  });
}

function decodeInput(input: string | Uint8Array): { bytes: Uint8Array; source?: string } {
  if (typeof input === 'string') {
    const bytes = Buffer.from(input, 'utf8');
    return { bytes, source: input };
  }

  const bytes = Uint8Array.from(input);
  try {
    return {
      bytes,
      source: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    };
  } catch {
    return { bytes };
  }
}

class TrustedJsonParser {
  private index = 0;
  private nodeCount = 0;

  constructor(
    private readonly source: string,
    private readonly limits: TrustedJsonLimits,
  ) {}

  parse(): JsonValue {
    this.skipWhitespace();
    if (this.index >= this.source.length) {
      this.fail('AOS_INPUT_JSON_EMPTY', 'JSON input is empty', '');
    }

    const value = this.parseValue('', 1);
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      this.fail('AOS_INPUT_JSON_TRAILING_CONTENT', 'unexpected content after the root JSON value', '');
    }
    return value;
  }

  private parseValue(path: string, depth: number): JsonValue {
    if (depth > this.limits.maxDepth) {
      this.fail('AOS_INPUT_JSON_DEPTH_LIMIT', `JSON depth exceeds ${this.limits.maxDepth}`, path);
    }

    this.nodeCount += 1;
    if (this.nodeCount > this.limits.maxNodes) {
      this.fail('AOS_INPUT_JSON_NODE_LIMIT', `JSON node count exceeds ${this.limits.maxNodes}`, path);
    }

    const character = this.source[this.index];
    if (character === '{') return this.parseObject(path, depth);
    if (character === '[') return this.parseArray(path, depth);
    if (character === '"') return this.parseString(path);
    if (character === '-' || (character !== undefined && character >= '0' && character <= '9')) {
      return this.parseNumber(path);
    }
    if (this.source.startsWith('true', this.index)) {
      this.index += 4;
      return true;
    }
    if (this.source.startsWith('false', this.index)) {
      this.index += 5;
      return false;
    }
    if (this.source.startsWith('null', this.index)) {
      this.index += 4;
      return null;
    }

    this.fail('AOS_INPUT_JSON_SYNTAX', 'expected a JSON value', path);
  }

  private parseObject(path: string, depth: number): JsonValue {
    this.index += 1;
    this.skipWhitespace();

    const result = Object.create(null) as Record<string, JsonValue>;
    const decodedKeys = new Set<string>();
    const normalizedKeys = new Set<string>();

    if (this.source[this.index] === '}') {
      this.index += 1;
      return result;
    }

    while (true) {
      if (this.source[this.index] !== '"') {
        this.fail('AOS_INPUT_JSON_SYNTAX', 'object key must be a JSON string', path);
      }

      const decodedKey = this.parseString(path);
      if (decodedKeys.has(decodedKey)) {
        this.fail('AOS_INPUT_JSON_DUPLICATE_KEY', `duplicate object key: ${decodedKey}`, childPath(path, decodedKey));
      }
      decodedKeys.add(decodedKey);

      const normalizedKey = decodedKey.normalize('NFC');
      if (normalizedKeys.has(normalizedKey)) {
        this.fail(
          'AOS_INPUT_JSON_NORMALIZED_KEY_COLLISION',
          `object keys collide after NFC normalization: ${normalizedKey}`,
          childPath(path, normalizedKey),
        );
      }
      normalizedKeys.add(normalizedKey);

      this.skipWhitespace();
      if (this.source[this.index] !== ':') {
        this.fail('AOS_INPUT_JSON_SYNTAX', 'expected colon after object key', childPath(path, normalizedKey));
      }
      this.index += 1;
      this.skipWhitespace();
      result[normalizedKey] = this.parseValue(childPath(path, normalizedKey), depth + 1);
      this.skipWhitespace();

      const delimiter = this.source[this.index];
      if (delimiter === '}') {
        this.index += 1;
        return result;
      }
      if (delimiter !== ',') {
        this.fail('AOS_INPUT_JSON_SYNTAX', 'expected comma or closing brace in object', path);
      }
      this.index += 1;
      this.skipWhitespace();
      if (this.source[this.index] === '}') {
        this.fail('AOS_INPUT_JSON_SYNTAX', 'trailing comma is not allowed in object', path);
      }
    }
  }

  private parseArray(path: string, depth: number): JsonValue {
    this.index += 1;
    this.skipWhitespace();

    const result: JsonValue[] = [];
    if (this.source[this.index] === ']') {
      this.index += 1;
      return result;
    }

    while (true) {
      result.push(this.parseValue(childPath(path, result.length), depth + 1));
      this.skipWhitespace();

      const delimiter = this.source[this.index];
      if (delimiter === ']') {
        this.index += 1;
        return result;
      }
      if (delimiter !== ',') {
        this.fail('AOS_INPUT_JSON_SYNTAX', 'expected comma or closing bracket in array', path);
      }
      this.index += 1;
      this.skipWhitespace();
      if (this.source[this.index] === ']') {
        this.fail('AOS_INPUT_JSON_SYNTAX', 'trailing comma is not allowed in array', path);
      }
    }
  }

  private parseString(path: string): string {
    this.index += 1;
    let result = '';
    let codePointLength = 0;

    const append = (value: string, points: number): void => {
      codePointLength += points;
      if (codePointLength > this.limits.maxStringLength) {
        this.fail(
          'AOS_INPUT_JSON_STRING_LIMIT',
          `JSON string length exceeds ${this.limits.maxStringLength}`,
          path,
        );
      }
      result += value;
    };

    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        return result;
      }

      if (character === '\\') {
        this.index += 1;
        const escaped = this.source[this.index];
        if (escaped === undefined) {
          this.fail('AOS_INPUT_JSON_SYNTAX', 'unterminated escape sequence', path);
        }
        this.index += 1;

        switch (escaped) {
          case '"': append('"', 1); break;
          case '\\': append('\\', 1); break;
          case '/': append('/', 1); break;
          case 'b': append('\b', 1); break;
          case 'f': append('\f', 1); break;
          case 'n': append('\n', 1); break;
          case 'r': append('\r', 1); break;
          case 't': append('\t', 1); break;
          case 'u': {
            const highOrValue = this.readHexCodeUnit(path);
            if (highOrValue >= 0xd800 && highOrValue <= 0xdbff) {
              if (this.source[this.index] !== '\\' || this.source[this.index + 1] !== 'u') {
                this.fail('AOS_INPUT_JSON_INVALID_UNICODE', 'high surrogate must be followed by a low surrogate', path);
              }
              this.index += 2;
              const low = this.readHexCodeUnit(path);
              if (low < 0xdc00 || low > 0xdfff) {
                this.fail('AOS_INPUT_JSON_INVALID_UNICODE', 'invalid low surrogate', path);
              }
              append(String.fromCodePoint(((highOrValue - 0xd800) * 0x400) + (low - 0xdc00) + 0x10000), 1);
            } else if (highOrValue >= 0xdc00 && highOrValue <= 0xdfff) {
              this.fail('AOS_INPUT_JSON_INVALID_UNICODE', 'unpaired low surrogate', path);
            } else {
              append(String.fromCharCode(highOrValue), 1);
            }
            break;
          }
          default:
            this.fail('AOS_INPUT_JSON_SYNTAX', `invalid escape sequence: \\${escaped}`, path);
        }
        continue;
      }

      const code = this.source.charCodeAt(this.index);
      if (code < 0x20) {
        this.fail('AOS_INPUT_JSON_SYNTAX', 'unescaped control character in string', path);
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = this.source.charCodeAt(this.index + 1);
        if (low < 0xdc00 || low > 0xdfff) {
          this.fail('AOS_INPUT_JSON_INVALID_UNICODE', 'unpaired high surrogate', path);
        }
        append(this.source.slice(this.index, this.index + 2), 1);
        this.index += 2;
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        this.fail('AOS_INPUT_JSON_INVALID_UNICODE', 'unpaired low surrogate', path);
      }

      append(character, 1);
      this.index += 1;
    }

    this.fail('AOS_INPUT_JSON_SYNTAX', 'unterminated JSON string', path);
  }

  private readHexCodeUnit(path: string): number {
    const token = this.source.slice(this.index, this.index + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(token)) {
      this.fail('AOS_INPUT_JSON_SYNTAX', 'unicode escape requires four hexadecimal digits', path);
    }
    this.index += 4;
    return Number.parseInt(token, 16);
  }

  private parseNumber(path: string): number {
    const remaining = this.source.slice(this.index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(remaining);
    if (match === null) {
      this.fail('AOS_INPUT_JSON_SYNTAX', 'invalid JSON number', path);
    }

    const token = match[0];
    const next = remaining[token.length];
    if (next !== undefined && !/[\s,\]}]/.test(next)) {
      this.fail('AOS_INPUT_JSON_SYNTAX', 'invalid character after JSON number', path);
    }

    this.index += token.length;
    const value = Number(token);
    if (!Number.isFinite(value)) {
      this.fail('AOS_INPUT_JSON_SYNTAX', 'JSON number is not finite', path);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      this.fail(
        'AOS_INPUT_JSON_UNSAFE_INTEGER',
        'integer exceeds the JavaScript safe integer range; encode high-precision values as strings',
        path,
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length && /[\u0009\u000a\u000d\u0020]/.test(this.source[this.index])) {
      this.index += 1;
    }
  }

  private fail(code: TrustedJsonDiagnosticCode, message: string, path: string): never {
    let line = 1;
    let column = 1;
    for (const character of this.source.slice(0, this.index)) {
      if (character === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }

    throw new ParserFailure({
      code,
      message,
      byteOffset: Buffer.byteLength(this.source.slice(0, this.index), 'utf8'),
      line,
      column,
      path,
    });
  }
}

export function parseTrustedJson(
  input: string | Uint8Array,
  options?: TrustedJsonParseOptions,
): TrustedJsonParseResult {
  const limits = resolveLimits(options);
  const decoded = decodeInput(input);
  const sourceHash = sha256Bytes(decoded.bytes);
  const byteLength = decoded.bytes.byteLength;

  if (byteLength > limits.maxInputBytes) {
    const receiptPayload = InputJsonReceiptPayloadSchema.parse({
      schema: 'awkn-input-json-receipt/v1',
      parserVersion: TRUSTED_JSON_PARSER_VERSION,
      status: 'REJECTED',
      sourceHash,
      byteLength,
      limits,
      diagnostics: [{
        code: 'AOS_INPUT_JSON_INPUT_LIMIT',
        message: `input byte length exceeds ${limits.maxInputBytes}`,
        byteOffset: 0,
        line: 1,
        column: 1,
        path: '',
      }],
    });
    return { ok: false, receiptPayload };
  }

  if (decoded.source === undefined) {
    const receiptPayload = InputJsonReceiptPayloadSchema.parse({
      schema: 'awkn-input-json-receipt/v1',
      parserVersion: TRUSTED_JSON_PARSER_VERSION,
      status: 'REJECTED',
      sourceHash,
      byteLength,
      limits,
      diagnostics: [{
        code: 'AOS_INPUT_JSON_INVALID_UTF8',
        message: 'input is not valid UTF-8',
        byteOffset: 0,
        line: 1,
        column: 1,
        path: '',
      }],
    });
    return { ok: false, receiptPayload };
  }

  try {
    const value = new TrustedJsonParser(decoded.source, limits).parse();
    const valueHash = stableHash('awkn-trusted-json-value/v1', value);
    const document = TrustedJsonDocumentSchema.parse({
      schema: 'awkn-trusted-json-document/v1',
      parserVersion: TRUSTED_JSON_PARSER_VERSION,
      sourceHash,
      valueHash,
      byteLength,
      value,
    });
    const receiptPayload = InputJsonReceiptPayloadSchema.parse({
      schema: 'awkn-input-json-receipt/v1',
      parserVersion: TRUSTED_JSON_PARSER_VERSION,
      status: 'ACCEPTED',
      sourceHash,
      valueHash,
      byteLength,
      limits,
      diagnostics: [],
    });
    return { ok: true, document, receiptPayload };
  } catch (error) {
    if (!(error instanceof ParserFailure)) throw error;
    const receiptPayload = InputJsonReceiptPayloadSchema.parse({
      schema: 'awkn-input-json-receipt/v1',
      parserVersion: TRUSTED_JSON_PARSER_VERSION,
      status: 'REJECTED',
      sourceHash,
      byteLength,
      limits,
      diagnostics: [error.diagnostic],
    });
    return { ok: false, receiptPayload };
  }
}
