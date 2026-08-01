/**
 * awkn-engine — 日志脱敏（技能吸收 P0-1）
 *
 * CICD/Agent 输出在进入 EventStore、报告与日志前必须过滤秘密：
 * Token、密码、连接串、私钥块。Shell 输出原样进报告是泄露通道。
 *
 * 设计为纯函数 + 可注入扩展：调用方可按来源追加自定义模式
 * （如自定义云厂商 Token 前缀）。所有正则必须携带全局标志 `g`，
 * 否则只替换首个匹配。
 */

export interface RedactionPattern {
  /** 模式名，用于审计与替换占位 */
  readonly name: string;
  readonly regex: RegExp;
  /** 替换文案；缺省为 `[REDACTED:<name>]`，可含 `$1` 等反向引用 */
  readonly replacement?: string;
}

/** 标准脱敏模式集：Token、凭据赋值、URL 连接串、私钥块 */
export const DEFAULT_REDACTION_PATTERNS: readonly RedactionPattern[] = [
  {
    name: 'private-key',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
  },
  {
    name: 'url-credentials',
    regex: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:@/\s]+):([^@\s/]+)@/g,
    replacement: '$1$2:[REDACTED:url-credentials]@',
  },
  {
    name: 'github-token',
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  },
  {
    name: 'api-key',
    regex: /\b(?:sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g,
  },
  {
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    name: 'bearer-token',
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g,
  },
  {
    name: 'credential-assignment',
    regex: /(?<=^|[^A-Za-z0-9])(password|passwd|secret|api_?key|apikey|access_?key|client_?secret|token|auth_?token|authorization|bearer|connection_?string|conn_?string)\b\s*([:=])\s*(['"]?)(?:Bearer\s+)?[^\s'";,{}\[\]]+\3/gi,
    replacement: '$1$2$3[REDACTED:credential-assignment]$3',
  },
  {
    name: 'pwd-variable',
    regex: /\b([A-Za-z0-9_.]*pwd)\b\s*=\s*(['"]?)[^\s'";,{}\[\]]+\2/gi,
    replacement: '$1=$2[REDACTED:pwd-variable]$2',
  },
];

/** 对文本执行脱敏；extraPatterns 追加在默认模式之后 */
export function redactText(
  input: string,
  extraPatterns: readonly RedactionPattern[] = [],
): string {
  if (input.length === 0) return input;
  let output = input;
  for (const pattern of [...DEFAULT_REDACTION_PATTERNS, ...extraPatterns]) {
    if (!pattern.regex.global) continue;
    output = output.replace(pattern.regex, pattern.replacement ?? `[REDACTED:${pattern.name}]`);
  }
  return output;
}
