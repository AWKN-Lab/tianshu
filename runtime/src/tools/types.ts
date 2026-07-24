export type PermissionLevel = 'none' | 'confirm' | 'deny';
export type ToolPriority = 'critical' | 'high' | 'medium' | 'normal' | 'low';
export type CallSource =
  | 'main_dialogue'
  | 'memory_extract'
  | 'compression'
  | 'classifier'
  | 'sub_agent'
  | 'background_task'
  | 'skill_tool';

export interface ExecutionContext {
  sessionId: string;
  userId: string;
  callSource: CallSource;
  parentToolCallId?: string;
  workspaceRoot?: string;
  approvedToolNames?: string[];
  approvalId?: string;
}

export interface ToolResult {
  content: string;
  truncated: boolean;
  diskPath?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolHandler {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx?: ExecutionContext) => Promise<string | ToolResult>;
  source: 'builtin' | 'mcp' | 'plugin' | 'integration';
  isReadOnly?: boolean;
  concurrentSafe?: boolean;
  permissionLevel?: PermissionLevel;
  maxResultSize?: number;
  priority?: ToolPriority;
  disabled?: boolean;
}

export const TOOL_DEFAULTS = {
  isReadOnly: false,
  concurrentSafe: false,
  permissionLevel: 'confirm' as PermissionLevel,
  maxResultSize: 50000,
  disabled: false,
  priority: 'normal' as ToolPriority,
};

export function resolveToolDefaults(tool: ToolHandler): Required<Pick<ToolHandler,
  | 'name' | 'description' | 'parameters' | 'execute' | 'source'
  | 'isReadOnly' | 'concurrentSafe' | 'permissionLevel'
  | 'maxResultSize' | 'disabled' | 'priority'>> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: tool.execute,
    source: tool.source,
    isReadOnly: tool.isReadOnly ?? TOOL_DEFAULTS.isReadOnly,
    concurrentSafe: tool.concurrentSafe ?? TOOL_DEFAULTS.concurrentSafe,
    permissionLevel: tool.permissionLevel ?? TOOL_DEFAULTS.permissionLevel,
    maxResultSize: tool.maxResultSize ?? TOOL_DEFAULTS.maxResultSize,
    disabled: tool.disabled ?? TOOL_DEFAULTS.disabled,
    priority: tool.priority ?? TOOL_DEFAULTS.priority,
  };
}
