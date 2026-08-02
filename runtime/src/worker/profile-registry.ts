/**
 * AgentProfileV2 注册与查询
 *
 * Spiral 2: Profile 注册表，基于 SQLite workflow_agent_profile 表（Migration v19）。
 * 数组字段（capabilities / inputTypes / outputTypes）序列化为 JSON；
 * sourceHash 写入 source_hash 列。
 *
 * 遵循模式: src/hierarchy/repository.ts
 * 对应契约: contracts/workflow-v2.ts — AgentProfileV2Schema
 */
import { queryAll, queryOne, queryRun } from '../store/db.js';
import type {
  AgentProfileV2,
  ProfileStatus,
  WorkflowStageType,
} from '../contracts/workflow-v2.js';
import type { AgentRole } from '../contracts/workflow.js';

// ─── Row 类型 ─────────────────────────────────────────────

interface ProfileRow {
  profile_id: string;
  version: string;
  role: string;
  specialty: string;
  capabilities_json: string;
  input_types_json: string;
  output_types_json: string;
  tool_policy_ref: string;
  independence_group: string;
  provider_policy: string;
  max_concurrent_assignments: number;
  max_attempts: number;
  timeout_ms: number;
  memory_policy: string;
  status: string;
  source_hash: string;
  created_at: string;
  updated_at: string;
}

// ─── 转换函数 ─────────────────────────────────────────────

function rowToProfile(row: ProfileRow): AgentProfileV2 {
  return {
    schema: 'awkn-agent-profile/v2',
    profileId: row.profile_id,
    version: row.version,
    role: row.role as AgentRole,
    specialty: row.specialty as WorkflowStageType,
    capabilities: JSON.parse(row.capabilities_json) as string[],
    inputTypes: JSON.parse(row.input_types_json) as string[],
    outputTypes: JSON.parse(row.output_types_json) as string[],
    toolPolicyRef: row.tool_policy_ref,
    independenceGroup: row.independence_group,
    providerPolicy: row.provider_policy as AgentProfileV2['providerPolicy'],
    maxConcurrentAssignments: row.max_concurrent_assignments,
    maxAttempts: row.max_attempts,
    timeoutMs: row.timeout_ms,
    memoryPolicy: row.memory_policy as AgentProfileV2['memoryPolicy'],
    status: row.status as ProfileStatus,
    sourceHash: row.source_hash,
  };
}

// ─── CRUD ─────────────────────────────────────────────────

/**
 * 注册（或覆盖）Profile。主键为 (profile_id, version)，
 * 使用 INSERT OR REPLACE 实现幂等 upsert。
 */
export function registerProfile(profile: AgentProfileV2): void {
  const now = new Date().toISOString();
  queryRun(
    `INSERT OR REPLACE INTO workflow_agent_profile
       (profile_id, version, role, specialty, capabilities_json, input_types_json,
        output_types_json, tool_policy_ref, independence_group, provider_policy,
        max_concurrent_assignments, max_attempts, timeout_ms, memory_policy, status,
        source_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      profile.profileId,
      profile.version,
      profile.role,
      profile.specialty,
      JSON.stringify(profile.capabilities),
      JSON.stringify(profile.inputTypes),
      JSON.stringify(profile.outputTypes),
      profile.toolPolicyRef,
      profile.independenceGroup,
      profile.providerPolicy,
      profile.maxConcurrentAssignments,
      profile.maxAttempts,
      profile.timeoutMs,
      profile.memoryPolicy,
      profile.status,
      profile.sourceHash,
      now,
      now,
    ],
  );
}

/**
 * 按 profileId 查询。未指定 version 时返回最新版本（按 updated_at 倒序）。
 */
export function getProfile(profileId: string, version?: string): AgentProfileV2 | undefined {
  if (version !== undefined) {
    const row = queryOne<ProfileRow>(
      'SELECT * FROM workflow_agent_profile WHERE profile_id = ? AND version = ?',
      [profileId, version],
    );
    return row ? rowToProfile(row) : undefined;
  }
  const row = queryOne<ProfileRow>(
    'SELECT * FROM workflow_agent_profile WHERE profile_id = ? ORDER BY updated_at DESC LIMIT 1',
    [profileId],
  );
  return row ? rowToProfile(row) : undefined;
}

export function getProfilesBySpecialty(specialty: WorkflowStageType): AgentProfileV2[] {
  return queryAll<ProfileRow>(
    'SELECT * FROM workflow_agent_profile WHERE specialty = ? ORDER BY created_at',
    [specialty],
  ).map(rowToProfile);
}

export function getProfilesByRole(role: string): AgentProfileV2[] {
  return queryAll<ProfileRow>(
    'SELECT * FROM workflow_agent_profile WHERE role = ? ORDER BY created_at',
    [role],
  ).map(rowToProfile);
}

/** 返回 status 为 ACTIVE 或 CANARY 的 Profile。 */
export function getActiveProfiles(): AgentProfileV2[] {
  return queryAll<ProfileRow>(
    "SELECT * FROM workflow_agent_profile WHERE status IN ('ACTIVE', 'CANARY') ORDER BY created_at",
  ).map(rowToProfile);
}

export function updateProfileStatus(
  profileId: string,
  version: string,
  status: ProfileStatus,
): void {
  const now = new Date().toISOString();
  queryRun(
    'UPDATE workflow_agent_profile SET status = ?, updated_at = ? WHERE profile_id = ? AND version = ?',
    [status, now, profileId, version],
  );
}
