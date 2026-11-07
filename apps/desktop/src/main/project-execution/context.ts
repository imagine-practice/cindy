/**
 * 项目工作项执行：入口与后续动作共用的真实读取面。
 *
 * 只有两类东西在这里：
 *   1. 授权与身份守卫（数据 owner 快照 + 项目成员资格），两个入口都从这里拿；
 *   2. 幂等键的唯一生成口径，以及从真实行推导执行状态的分档函数。
 *
 * 这里不做任何写操作，也不缓存任何读取结果：每次调用都重新查库。
 */

import { createHash } from 'node:crypto';
import type {
  WorkItemExecutionState,
  WorkItemExecutionUnavailableReason,
} from '../../shared/projectWorkItemExecutionRequest';
import { WORK_ITEM_EXECUTION_CLIENT_ID_PREFIX } from '../../shared/projectWorkItemExecutionRequest';
import { getCurrentDbClientSnapshot, type CurrentDbClientSnapshot } from '../localDb/client/current';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState';
import { throwIpcError } from '../utils/ipcValidate';

/** 终态：允许用户显式重新发起（生成下一个 round 的新键）。 */
export const TERMINAL_DELEGATION_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

export interface WorkItemRow {
  sessionId: string;
  title: string;
  projectId: string;
  projectStatus: string;
  sessionStatus: string;
  bindingRevision: number;
  assigneeKind: string | null;
  assigneeId: string | null;
  executorName: string | null;
  executorStatus: string | null;
  canonicalSessionId: string | null;
  executorIsMember: number;
  /** 执行会话自己的运行时身份（换模型要用）。'cc' | 'codex' | 'pi'。 */
  sessionAgentKind: string | null;
  sessionModel: string | null;
  sessionProviderId: string | null;
}

export interface DelegationRow {
  id: string;
  childSessionId: string;
  status: string;
  acceptedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
  /** 真实的待确认项 JSON；只有 `status='waiting'` 时可信。 */
  pendingInteractionJson: string | null;
  /** 现有快照列：批准审计写在它下面（不新开表）。 */
  permissionSnapshotJson: string;
}

export interface FollowupRow {
  childSessionId: string;
  phase: string;
  nativeAcceptedAt: number | null;
  updatedAt: number;
}

export interface DeliveryRow {
  sessionId: string;
  clientId: string;
  createdAt: number;
}

/**
 * 幂等键前缀摘要：同一 (项目, 工作项, 执行伙伴) 的所有 round 共享同一个前缀，
 * 因此可以从真实消息行里重新数出 round，而不需要额外的表或前端缓存。
 *
 * 「请该伙伴执行」与四个后续动作共用这一个摘要口径；键前缀不同，互不串键。
 */
export function workItemRequestKeyPrefixDigest(
  projectId: string,
  sessionId: string,
  botId: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([projectId, sessionId, botId]))
    .digest('hex')
    .slice(0, 32);
}

export function projectWorkItemRequestKey(
  projectId: string,
  sessionId: string,
  botId: string,
  round: number,
): string {
  return `${WORK_ITEM_EXECUTION_CLIENT_ID_PREFIX}${workItemRequestKeyPrefixDigest(projectId, sessionId, botId)}:${round}`;
}

export interface Authority extends CurrentDbClientSnapshot {
  assertCurrent(): void;
}

export function captureProjectExecutionAuthority(): Authority {
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot || !snapshot.userId || isAppSessionBoundaryPending())
    throwIpcError('PRECONDITION_FAILED', 'Project execution owner unavailable');
  const scope = activeOwnerScopeKey();
  const assertCurrent = () => {
    const next = getCurrentDbClientSnapshot();
    if (
      !next ||
      next.client !== snapshot.client ||
      next.userId !== snapshot.userId ||
      next.clientEpoch !== snapshot.clientEpoch ||
      activeOwnerScopeKey() !== scope ||
      isAppSessionBoundaryPending()
    )
      throwIpcError('PRECONDITION_FAILED', 'Project execution owner changed');
  };
  assertCurrent();
  return { ...snapshot, assertCurrent };
}

/** Viewer 必须是项目成员；成员资格单独查，空工作项也照常返回空投影。 */
export async function assertProjectMember(
  client: CurrentDbClientSnapshot['client'],
  projectId: string,
  userId: string,
): Promise<void> {
  const member = await client.queryOne<{ role: string }>(
    `SELECT m.role AS role FROM project_members m JOIN projects p ON p.id=m.project_id
    WHERE p.id=? AND m.subject_kind='account' AND m.subject_id=?`,
    [projectId, userId],
  );
  if (!member) throwIpcError('FORBIDDEN', 'Project execution is not available for this account');
}

export async function readWorkItemRows(
  client: CurrentDbClientSnapshot['client'],
  projectId: string,
): Promise<WorkItemRow[]> {
  return client.query<WorkItemRow>(
    `SELECT s.id AS sessionId, s.title AS title, s.project_id AS projectId,
      pr.status AS projectStatus, s.status AS sessionStatus,
      s.project_binding_revision AS bindingRevision,
      s.assignee_kind AS assigneeKind, s.assignee_id AS assigneeId,
      b.display_name AS executorName, b.status AS executorStatus,
      b.canonical_session_id AS canonicalSessionId,
      s.agent_kind AS sessionAgentKind, s.model AS sessionModel,
      s.provider_id AS sessionProviderId,
      CASE WHEN s.assignee_kind='bot' AND EXISTS (
        SELECT 1 FROM project_members m WHERE m.project_id=s.project_id
          AND m.subject_kind='bot' AND m.subject_id=s.assignee_id) THEN 1 ELSE 0 END AS executorIsMember
    FROM sessions s
    JOIN projects pr ON pr.id=s.project_id
    LEFT JOIN bot_profiles b ON b.id=s.assignee_id AND s.assignee_kind='bot'
    WHERE s.project_id=? AND s.status<>'deleted'
    ORDER BY s.id`,
    [projectId],
  );
}

export async function readDelegations(
  client: CurrentDbClientSnapshot['client'],
  projectId: string,
): Promise<DelegationRow[]> {
  return client.query<DelegationRow>(
    `SELECT d.id AS id, d.child_session_id AS childSessionId, d.status AS status,
      d.accepted_at AS acceptedAt, d.completed_at AS completedAt, d.updated_at AS updatedAt,
      d.pending_interaction_json AS pendingInteractionJson,
      d.permission_snapshot_json AS permissionSnapshotJson
    FROM bot_delegations d JOIN sessions s ON s.id=d.child_session_id
    WHERE s.project_id=? AND s.status<>'deleted'
    ORDER BY d.created_at DESC`,
    [projectId],
  );
}

export async function readFollowups(
  client: CurrentDbClientSnapshot['client'],
  projectId: string,
): Promise<FollowupRow[]> {
  return client.query<FollowupRow>(
    `SELECT f.child_session_id AS childSessionId, f.phase AS phase,
      f.native_accepted_at AS nativeAcceptedAt, f.updated_at AS updatedAt
    FROM bot_task_followup_requests f JOIN sessions s ON s.id=f.child_session_id
    WHERE s.project_id=? AND s.status<>'deleted'
    ORDER BY f.updated_at DESC`,
    [projectId],
  );
}

/** 状态分档：真实行 → 六档（+ completed）。顺序即优先级。 */
export function projectWorkItemExecutionState(input: {
  delivered: boolean;
  delegation: Pick<DelegationRow, 'status'> | null;
  followup: Pick<FollowupRow, 'phase'> | null;
}): WorkItemExecutionState {
  const status = input.delegation?.status ?? null;
  if (status === 'completed') return 'completed';
  if (status !== null && TERMINAL_DELEGATION_STATUSES.has(status)) return 'failed';
  // 未知压过「已受理 / 执行中」：不确定的结果不能被显示成还在跑。
  if (input.followup?.phase === 'unknown') return 'unknown';
  if (status === 'running' || status === 'waiting') return 'running';
  if (input.delegation) return 'accepted';
  if (input.delivered) return 'requested';
  return 'none';
}

export function workItemUnavailableReason(
  row: WorkItemRow,
): WorkItemExecutionUnavailableReason | null {
  // 处理人为空 = 未分配；绝不回退负责人或默认伙伴。
  if (!row.assigneeKind || !row.assigneeId) return 'UNASSIGNED';
  if (row.assigneeKind !== 'bot') return 'ASSIGNEE_NOT_BOT';
  if (!row.executorName || row.executorStatus !== 'active' || !row.canonicalSessionId)
    return 'EXECUTOR_INACTIVE';
  // 执行工具自己的准入要求「Bot-kind executor membership」，提前在这里就说清楚。
  if (!row.executorIsMember) return 'EXECUTOR_NOT_MEMBER';
  if (row.projectStatus !== 'active') return 'PROJECT_ARCHIVED';
  return null;
}

/** 同一键被宿主重派时可能带 `:retry:<rowId>` 后缀，仍属于同一个 round。 */
export function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 只查这个入口自己投递过的消息行：键前缀是固定的，别的入口不会命中。
 * 已 rewind / 已清空的行不算“已投递”：宿主那边同样会重新派发新回合。
 */
export async function readDeliveryRows(
  client: CurrentDbClientSnapshot['client'],
  sessionId: string,
  prefix: string,
): Promise<DeliveryRow[]> {
  return client.query<DeliveryRow>(
    `SELECT m.session_id AS sessionId, m.client_id AS clientId, m.created_at AS createdAt
    FROM messages m JOIN sessions s ON s.id=m.session_id
    WHERE m.session_id=? AND m.client_id LIKE ? AND m.rewind_at IS NULL
      AND (s.cleared_at IS NULL OR m.created_at > s.cleared_at)`,
    [sessionId, `${prefix}%`],
  );
}

/** 「请该伙伴执行」的投递行：同一 round 取最后一行（`:retry:` 后缀也算同一 round）。 */
export function latestExecutionDelivery(
  rows: readonly DeliveryRow[],
  prefix: string,
  digest: string,
): { round: number; key: string; createdAt: number } | null {
  const pattern = new RegExp(`^${escapeForRegExp(prefix)}${digest}:(\\d+)(:retry:.+)?$`);
  let latest: { round: number; key: string; createdAt: number } | null = null;
  for (const row of rows) {
    const match = pattern.exec(row.clientId);
    if (!match) continue;
    const round = Number(match[1]);
    if (!Number.isSafeInteger(round) || round < 0) continue;
    if (!latest || round > latest.round || (round === latest.round && row.createdAt >= latest.createdAt))
      latest = { round, key: row.clientId, createdAt: row.createdAt };
  }
  return latest;
}

/** 后续动作的投递行：只看指定动作的键。 */
export function latestActionDelivery(
  rows: readonly DeliveryRow[],
  prefix: string,
  digest: string,
  action: string,
): { round: number; key: string; createdAt: number } | null {
  const pattern = new RegExp(`^${escapeForRegExp(prefix)}${digest}:${action}:(\\d+)(:retry:.+)?$`);
  let latest: { round: number; key: string; createdAt: number } | null = null;
  for (const row of rows) {
    const match = pattern.exec(row.clientId);
    if (!match) continue;
    const round = Number(match[1]);
    if (!Number.isSafeInteger(round) || round < 0) continue;
    if (!latest || round > latest.round || (round === latest.round && row.createdAt >= latest.createdAt))
      latest = { round, key: row.clientId, createdAt: row.createdAt };
  }
  return latest;
}
