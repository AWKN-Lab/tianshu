/**
 * Hook 生命周期类型定义 — 从 awkn-agent 抽取（零依赖纯类型）
 *
 * 来源：awkn-agent/src/core/hook-types.ts
 * 改动：无（直接复用）
 *
 * 6 个生命周期钩子点（与 Codex hooks.json 兼容）：
 * session_start / user_prompt_submit / pre_tool_use / post_tool_use / pre_compact / session_stop
 */

/** 生命周期钩子点（6 个会话/工具点 + 2 个 LLM 调用点） */
export type HookPoint =
  | 'session_start'
  | 'user_prompt_submit'
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'pre_compact'
  | 'session_stop'
  | 'pre_llm_call'
  | 'post_llm_call';

/** 钩子类型 */
export type HookType = 'command' | 'function';

/** 钩子定义 */
export interface Hook {
  /** 唯一 ID */
  id: string;
  /** 钩子点 */
  point: HookPoint;
  /** 钩子类型：command=外部脚本, function=内部函数 */
  type: HookType;
  /** 外部脚本命令（type=command 时） */
  command?: string;
  /** 内部函数（type=function 时） */
  fn?: (payload: HookPayload) => Promise<HookResult>;
  /** 工具名匹配（仅 pre/post_tool_use） */
  matcher?: string;
  /** 状态消息（执行时展示） */
  statusMessage?: string;
  /** 超时（ms），默认 5000 */
  timeout: number;
  /**
   * 失败模式（opt-in，2026-07-23 M3 进阶-5 新增）：
   * - false/undefined（默认）：fail-open — command 输出非 JSON 时默认 success:true（向后兼容 informational hooks）
   * - true：fail-closed — command 输出非 JSON 或缺 success 字段时：
   *   - success:false
   *   - block:true（仅 pre_tool_use，阻断工具执行）
   *   - blockReason 含诊断信息
   *
   * 设计原因：与 M3 进阶-4 trae stub 同类 bug — "无信号"被当作"成功"。
   * 安全钩子（如阻断 rm -rf 的 pre_tool_use）必须显式 opt-in failClosed:true，
   * 否则 broken hook 会静默放行危险工具。
   */
  failClosed?: boolean;
}

/** 钩子载荷 */
export interface HookPayload {
  /** 钩子点 */
  point: HookPoint;
  /** 工具名（pre/post_tool_use） */
  toolName?: string;
  /** 用户 prompt（user_prompt_submit） */
  prompt?: string;
  /** 会话 ID */
  sessionId?: string;
  /** 工具输入（pre_tool_use） */
  toolInput?: Record<string, unknown>;
  /** 工具输出（post_tool_use） */
  toolOutput?: string;
  /** 额外上下文 */
  context?: Record<string, unknown>;
  /** LLM 请求载荷（pre_llm_call 用，trae provider 桥接到宿主 LLM） */
  llmRequest?: {
    messages: Array<{ role: string; content: string }>;
    model?: string;
    provider?: string;
  };
}

/** 钩子执行结果 */
export interface HookResult {
  /** 是否成功 */
  success: boolean;
  /** 输出文本 */
  output?: string;
  /** 错误信息 */
  error?: string;
  /** 修改后的 payload（钩子可修改） */
  modifiedPayload?: HookPayload;
  /** 是否阻断主流程（仅 pre_tool_use 有效） */
  block?: boolean;
  /** 阻断原因 */
  blockReason?: string;
  /** LLM 响应（pre_llm_call hook 回填，trae provider 优先用此响应） */
  llmResponse?: {
    content: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  };
}

/** hooks.json 配置格式（与 Codex 兼容） */
export interface HooksConfig {
  hooks?: Record<
    string,
    Array<{
      matcher?: string;
      hooks: Array<{
        type: 'command';
        command: string;
      }>;
    }>
  >;
}
