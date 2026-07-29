import { basename, extname, relative, resolve, sep } from 'node:path';
import type { ExecutionContext, ToolHandler } from './types.js';
import { resolveToolDefaults } from './types.js';

export interface ToolPolicyDecision {
  allowed: boolean;
  reason: string;
  approvalRequired: boolean;
  resolvedPaths: string[];
}

export class ToolPolicyError extends Error {
  constructor(message: string, readonly decision: ToolPolicyDecision) {
    super(message);
    this.name = 'ToolPolicyError';
  }
}

const SENSITIVE_SEGMENTS = new Set([
  '.git', '.ssh', '.gnupg', '.aws', '.azure', '.config',
  'credentials.json', 'id_rsa', 'id_ed25519', '.env',
]);
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.secret']);
const DANGEROUS_COMMANDS: RegExp[] = [
  /(?:^|\s)rm\s+-rf\s+(?:\/|~|\$HOME)(?:\s|$)/i,
  /(?:^|\s)(?:shutdown|reboot|poweroff|halt)(?:\s|$)/i,
  /(?:^|\s)(?:mkfs|fdisk|diskpart|format)(?:\s|$)/i,
  /(?:curl|wget)[^|;&]*(?:\||&&|;)\s*(?:sh|bash|zsh|powershell|pwsh)/i,
  /powershell[^\n]*-(?:enc|encodedcommand)\b/i,
  /(?:^|\s)(?:sudo|runas)(?:\s|$)/i,
];
const GITHUB_ACTIONS_COMMANDS: RegExp[] = [
  /\bgh(?:\.exe)?\s+workflow\b/i,
  /\bgh(?:\.exe)?\s+run\b/i,
  /\bgh(?:\.exe)?\s+api\b[^\r\n]*(?:\/actions\/|actions\/workflows|actions\/runs)/i,
  /(?:api\.github\.com|github\.com\/api\/v3)[^\r\n]*(?:\/actions\/|actions\/workflows|actions\/runs)/i,
];

function approvedNames(ctx?: ExecutionContext): Set<string> {
  const envNames = (process.env.AWKN_APPROVED_TOOLS ?? '')
    .split(',').map((name) => name.trim()).filter(Boolean);
  return new Set([...(ctx?.approvedToolNames ?? []), ...envNames]);
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

function hasSensitiveSegment(target: string): boolean {
  const parts = target.split(/[\\/]+/).map((part) => part.toLowerCase());
  if (parts.some((part) => SENSITIVE_SEGMENTS.has(part))) return true;
  const file = basename(target).toLowerCase();
  return file.startsWith('.env') || SENSITIVE_EXTENSIONS.has(extname(file));
}

export class ToolPolicy {
  evaluate(tool: ToolHandler, args: Record<string, unknown>, ctx?: ExecutionContext): ToolPolicyDecision {
    const resolvedTool = resolveToolDefaults(tool);
    const workspaceRoot = resolve(ctx?.workspaceRoot ?? process.cwd());
    const resolvedPaths: string[] = [];

    if (resolvedTool.permissionLevel === 'deny') {
      return { allowed: false, reason: 'tool permissionLevel=deny', approvalRequired: false, resolvedPaths };
    }

    const approvals = approvedNames(ctx);
    const approvalRequired = resolvedTool.permissionLevel === 'confirm';
    const legacyMode = process.env.AWKN_TOOL_POLICY_MODE === 'legacy';
    if (approvalRequired && !legacyMode && !approvals.has('*') && !approvals.has(tool.name)) {
      return { allowed: false, reason: `tool ${tool.name} requires explicit approval`, approvalRequired: true, resolvedPaths };
    }

    for (const key of ['path', 'cwd']) {
      const value = args[key];
      if (typeof value !== 'string' || value.trim() === '') continue;
      const resolvedPath = resolve(workspaceRoot, value);
      resolvedPaths.push(resolvedPath);
      if (process.env.AWKN_ALLOW_OUTSIDE_WORKSPACE !== '1' && !isWithin(workspaceRoot, resolvedPath)) {
        return { allowed: false, reason: `${key} escapes workspace boundary: ${resolvedPath}`, approvalRequired, resolvedPaths };
      }
      if (hasSensitiveSegment(resolvedPath) && process.env.AWKN_ALLOW_SENSITIVE_PATHS !== '1') {
        return { allowed: false, reason: `${key} targets a sensitive path: ${resolvedPath}`, approvalRequired, resolvedPaths };
      }
    }

    if (tool.name === 'exec') {
      const command = String(args.command ?? '');
      if (process.env.AWKN_ALLOW_GITHUB_ACTIONS !== '1') {
        const githubActions = GITHUB_ACTIONS_COMMANDS.find((pattern) => pattern.test(command));
        if (githubActions) {
          return {
            allowed: false,
            reason: 'GitHub Actions denied: use local Windows CICD and Aliyun ReleaseBundle deployment',
            approvalRequired,
            resolvedPaths,
          };
        }
      }
      const denied = DANGEROUS_COMMANDS.find((pattern) => pattern.test(command));
      if (denied) {
        return { allowed: false, reason: `command denied by policy: ${denied.source}`, approvalRequired, resolvedPaths };
      }
    }

    return { allowed: true, reason: 'allowed', approvalRequired, resolvedPaths };
  }

  assertAllowed(tool: ToolHandler, args: Record<string, unknown>, ctx?: ExecutionContext): void {
    const decision = this.evaluate(tool, args, ctx);
    if (!decision.allowed) throw new ToolPolicyError(decision.reason, decision);
  }
}

export const toolPolicy = new ToolPolicy();
