/**
 * SQLite 表结构定义
 *
 * 4 张表：
 * - goals: L2 目标（goal-state 持久化）
 * - cron_jobs: L3 定时任务
 * - loop_state: 循环状态快照
 * - usage: token 用量
 */

export const SCHEMA_SQL = `
-- L2 目标表
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  owner TEXT NOT NULL DEFAULT 'user',
  hao TEXT NOT NULL DEFAULT '[]',
  kan TEXT,
  buzuo TEXT,
  budget TEXT,
  history TEXT NOT NULL DEFAULT '[]',
  milestones TEXT,
  target_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- L3 定时任务表
CREATE TABLE IF NOT EXISTS cron_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron_expr TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_payload TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- L3 任务执行日志
CREATE TABLE IF NOT EXISTS cron_run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  result_text TEXT,
  error_text TEXT,
  FOREIGN KEY (job_id) REFERENCES cron_jobs(id)
);

-- 循环状态快照表（断点恢复用）
CREATE TABLE IF NOT EXISTS loop_state (
  id TEXT PRIMARY KEY,
  goal_id TEXT,
  turn INTEGER NOT NULL DEFAULT 0,
  step TEXT NOT NULL,
  react_state TEXT NOT NULL,
  observations TEXT NOT NULL DEFAULT '[]',
  reflections TEXT NOT NULL DEFAULT '[]',
  total_observations INTEGER NOT NULL DEFAULT 0,
  total_errors INTEGER NOT NULL DEFAULT 0,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (goal_id) REFERENCES goals(id)
);

-- token 用量表（budgetGate 用）
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  call_source TEXT,
  ts TEXT NOT NULL,
  FOREIGN KEY (goal_id) REFERENCES goals(id)
);

-- 错误台账表（M3 自进化：记录每次循环失败/异常，供 pattern-detector 检测重复模式）
CREATE TABLE IF NOT EXISTS corrections_ledger (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  goal_id TEXT,
  -- 错误来源：gate 名（typecheckGate/testGate/...）/ loop_monitor / manual
  source TEXT NOT NULL,
  -- 严重度：info / warn / error / fatal
  severity TEXT NOT NULL DEFAULT 'error',
  -- 错误文本（gate details 或异常 message）
  error_text TEXT NOT NULL,
  -- 归一化指纹（用于重复检测，normalized hash of source+error_text）
  fingerprint TEXT NOT NULL,
  -- 额外上下文 JSON（gate suggestion / loop state / tool name 等）
  context_json TEXT NOT NULL DEFAULT '{}',
  -- 状态：open / resolved / ignored
  status TEXT NOT NULL DEFAULT 'open',
  -- 解决方案（人工填或 pattern-detector 自动建议）
  resolution TEXT,
  -- 关联的经验文件 ID（如 EXP-DRV-20260723-001）
  experience_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
  -- 注：goal_id 不加 FOREIGN KEY，允许记录无关联 goal 的 manual 条目（如 loop_monitor 异常）
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_goals_state ON goals(state);
CREATE INDEX IF NOT EXISTS idx_goals_owner ON goals(owner);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(next_run_at);
CREATE INDEX IF NOT EXISTS idx_cron_run_log_job_id ON cron_run_log(job_id);
CREATE INDEX IF NOT EXISTS idx_loop_state_goal_id ON loop_state(goal_id);
CREATE INDEX IF NOT EXISTS idx_usage_goal_id ON usage(goal_id);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
CREATE INDEX IF NOT EXISTS idx_corrections_ts ON corrections_ledger(ts);
CREATE INDEX IF NOT EXISTS idx_corrections_source ON corrections_ledger(source);
CREATE INDEX IF NOT EXISTS idx_corrections_fingerprint ON corrections_ledger(fingerprint);
CREATE INDEX IF NOT EXISTS idx_corrections_status ON corrections_ledger(status);
`;

export interface GoalRow {
  id: string;
  title: string;
  description: string;
  state: string;
  owner: string;
  hao: string; // JSON
  kan: string | null;
  buzuo: string | null;
  budget: string | null; // JSON
  history: string; // JSON
  milestones: string | null; // JSON
  target_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface CronJobRow {
  id: string;
  name: string;
  cron_expr: string;
  action_type: string;
  action_payload: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  run_count: number;
  failed_count: number;
  last_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CronRunLogRow {
  id: number;
  job_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  result_text: string | null;
  error_text: string | null;
}

export interface LoopStateRow {
  id: string;
  goal_id: string | null;
  turn: number;
  step: string;
  react_state: string;
  observations: string;
  reflections: string;
  total_observations: number;
  total_errors: number;
  consecutive_errors: number;
  created_at: string;
  updated_at: string;
}

export interface UsageRow {
  id: number;
  goal_id: string | null;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  call_source: string | null;
  ts: string;
}

export interface CorrectionRow {
  id: string;
  ts: string;
  goal_id: string | null;
  source: string;
  severity: string;
  error_text: string;
  fingerprint: string;
  context_json: string;
  status: string;
  resolution: string | null;
  experience_id: string | null;
  created_at: string;
  updated_at: string;
}
