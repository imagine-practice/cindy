/**
 * 项目工作项执行后续：继续 / 批准 / 排队 / 换模型。
 *
 * 语义（承接入口 `entry.ts`，不新造授权）：
 *   1. 四个动作都作用在**同一个执行会话**（工作项自己的 `sessions` 行，也就是
 *      `bot_delegations.child_session_id`）上：继续/排队只向它追加一条输入，
 *      不新开任务；换模型只改它后续回合的路由；批准只解开它当前的待确认项。
 *   2. 每个动作一个独立幂等键：
 *      `project-workitem-followup:v1:<摘要>:<动作>:<round>`。摘要口径与入口同源，
 *      动作是独立分段；同一动作重试复用同一个键（同一个键最多一个回合），
 *      连点落回同一个键，因此只投递一次。round 只在上一轮后续已被目标会话真正
 *      消费（产出了 assistant/tool 等行）之后才前进。
 *   3. 状态、待确认项、繁忙、模型一律现读真实行：`bot_delegations`（含
 *      pending_interaction_json）、`bot_task_followup_requests.phase`、
 *      `messages`（自己的投递行）、`sessions`（模型/引擎/回合时间戳）。
 *      这里不写任何缓存，界面也不得缓存「已完成 / 已批准」。
 *   4. `unknown` 一律只对账：四个动作全部禁用，不投递、不改模型、不批准。
 *   5. 批准要留审计：谁批的、批的哪一条、当时执行状态，追加进该次委派已有的
 *      `permission_snapshot_json`（不新开表）；批准本身走既有 owner 确认通道。
 *   6. 换模型失败只报真实原因：不静默回退默认模型、不换账号、不重试。
 */

import type {
  ProjectWorkItemFollowupIntent,
  ProjectWorkItemFollowupResult,
  WorkItemExecutionState,
  WorkItemExecutionUnavailableReason,
  WorkItemFollowupAction,
  WorkItemFollowupApprovalAudit,
  WorkItemFollowupCapability,
  WorkItemFollowupErrorCode,
  WorkItemFollowupPending,
  WorkItemFollowupProjection,
  WorkItemFollowupUnavailableReason,
} from '../../shared/projectWorkItemExecutionRequest';
import {
  WORK_ITEM_EXECUTION_CLIENT_ID_PREFIX,
  WORK_ITEM_FOLLOWUP_CLIENT_ID_PREFIX,
  WORK_ITEM_FOLLOWUP_TEXT_MAX,
} from '../../shared/projectWorkItemExecutionRequest';
import { createHash } from 'node:crypto';
import type { CurrentDbClientSnapshot } from '../localDb/client/current';
import { throwIpcError } from '../utils/ipcValidate';
import { createLogger } from '../logger';
import {
  assertProjectMember,
  captureProjectExecutionAuthority,
  latestActionDelivery,
  latestExecutionDelivery,
  projectWorkItemExecutionState,
  readDelegations,
  readDeliveryRows,
  readFollowups,
  readWorkItemRows,
  workItemRequestKeyPrefixDigest,
  workItemUnavailableReason,
  type DelegationRow,
  type DeliveryRow,
  type WorkItemRow,
} from './context';
import { getOwnerTurnDispatch } from '../maker-ipc/ownerTurnDispatch';

const log = createLogger('project-workitem-followup');

/** 待确认项里可以「批准」的种类：提问需要回答，不是同意。 */
const APPROVABLE_KINDS = new Set(['permission', 'plan_review']);
/** 批准审计在快照里保留的条数上限（只增不改，旧条目先出）。 */
const MAX_APPROVAL_AUDIT_ROWS = 50;

const FOLLOWUP_ACTIONS: readonly WorkItemFollowupAction[] = ['continue', 'approve', 'queue', 'model'];

type Client = CurrentDbClientSnapshot['client'];

/**
 * 后续动作的**意图摘要**：项目 + 工作项 + 执行伙伴 + 动作 + 规范化后的追加输入。
 *
 * 把动作与文本一起放进摘要，是「改了内容就是另一个意图」的结构性保证：
 * 同一个 round 里改过文本会得到不同的键，因此不会出现「按 clientId 去重把新内容
 * 静默吞掉、界面却显示已发送」。它也与入口的摘要（`workItemRequestKeyPrefixDigest`）
 * 分开：入口那两个键只看 (项目, 工作项, 伙伴)，执行状态的对账仍用那一个。
 */
export function workItemFollowupIntentDigest(input: {
  projectId: string;
  sessionId: string;
  botId: string;
  action: WorkItemFollowupAction;
  text: string | null;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.projectId,
        input.sessionId,
        input.botId,
        input.action,
        input.text ?? '',
      ]),
    )
    .digest('hex')
    .slice(0, 32);
}

/** 键形状：`project-workitem-followup:v1:<意图摘要>:<动作>:<round>`。 */
export function workItemFollowupKey(
  intentDigest: string,
  action: WorkItemFollowupAction,
  round: number,
): string {
  return `${WORK_ITEM_FOLLOWUP_CLIENT_ID_PREFIX}${intentDigest}:${action}:${round}`;
}

function denied(reason: WorkItemFollowupUnavailableReason): WorkItemFollowupCapability {
  return { allowed: false, reason };
}

const ALL_DENIED = (reason: WorkItemFollowupUnavailableReason) =>
  Object.fromEntries(FOLLOWUP_ACTIONS.map((action) => [action, denied(reason)])) as Record<
    WorkItemFollowupAction,
    WorkItemFollowupCapability
  >;

export function projectWorkItemFollowupCapabilities(input: {
  unavailableReason: WorkItemFollowupUnavailableReason | null;
  state: WorkItemExecutionState;
  pending: WorkItemFollowupPending | null;
  busy: boolean;
  hasModel: boolean;
}): Record<WorkItemFollowupAction, WorkItemFollowupCapability> {
  // 未知压过一切：结果不确定时四个动作全禁用，只允许对账。
  if (input.state === 'unknown') return ALL_DENIED('OUTCOME_UNKNOWN');
  if (input.unavailableReason !== null) return ALL_DENIED('EXECUTOR_UNAVAILABLE');
  const terminalOrPaused =
    input.state === 'completed' || input.state === 'failed' || input.pending !== null;
  const approve = ((): WorkItemFollowupCapability => {
    if (!input.pending) return denied('NO_PENDING_CONFIRMATION');
    return APPROVABLE_KINDS.has(input.pending.kind)
      ? { allowed: true, reason: null }
      : denied('CONFIRMATION_NOT_APPROVABLE');
  })();
  return {
    continue: terminalOrPaused ? { allowed: true, reason: null } : denied('NO_TERMINAL_EXECUTION'),
    approve,
    queue: input.busy ? { allowed: true, reason: null } : denied('NOT_BUSY'),
    model: input.hasModel ? { allowed: true, reason: null } : denied('MODEL_UNAVAILABLE'),
  };
}

function parseRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 待确认项只认 `status='waiting'` + 形状完整的持久化视图。 */
export function readPendingConfirmation(
  delegation: Pick<DelegationRow, 'status' | 'pendingInteractionJson'> | null,
): WorkItemFollowupPending | null {
  if (!delegation || delegation.status !== 'waiting') return null;
  const parsed = parseRecord(delegation.pendingInteractionJson);
  if (typeof parsed.requestId !== 'string' || !parsed.requestId) return null;
  if (parsed.kind !== 'permission' && parsed.kind !== 'ask_user_question' && parsed.kind !== 'plan_review')
    return null;
  if (typeof parsed.summary !== 'string' || typeof parsed.raisedAt !== 'number') return null;
  return {
    requestId: parsed.requestId,
    kind: parsed.kind,
    summary: parsed.summary.slice(0, 4_000),
    raisedAt: parsed.raisedAt,
  };
}

function agentKind(value: string | null): 'claude-code' | 'codex' | 'pi' | null {
  if (value === 'cc') return 'claude-code';
  if (value === 'codex') return 'codex';
  if (value === 'pi') return 'pi';
  return null;
}

/** 会话是否在跑回合：先取宿主实时边界，缺失时回落到真实时间戳列。 */
async function readBusy(client: Client, sessionId: string): Promise<boolean> {
  const live = getOwnerTurnDispatch();
  if (live) {
    const busy = live.readSessionBusy?.(sessionId);
    if (busy !== undefined) return busy;
  }
  const row = await client.queryOne<{ startedAt: number | null; endedAt: number | null }>(
    `SELECT active_turn_started_at AS startedAt, last_turn_ended_at AS endedAt
    FROM sessions WHERE id=?`,
    [sessionId],
  );
  if (!row || row.startedAt === null) return false;
  return row.endedAt === null || row.startedAt > row.endedAt;
}

export async function readFollowupProjection(input: {
  client: Client;
  row: WorkItemRow;
  state: WorkItemExecutionState;
  delegation: DelegationRow | null;
  /** 入口的不可用原因集合（无处理人等）；后续动作只区分「有原因 / 没原因」。 */
  unavailableReason: WorkItemExecutionUnavailableReason | null;
}): Promise<WorkItemFollowupProjection> {
  const pending = readPendingConfirmation(input.delegation);
  const busy = await readBusy(input.client, input.row.sessionId);
  const kind = agentKind(input.row.sessionAgentKind);
  const model = kind && input.row.sessionModel
    ? {
        current: input.row.sessionModel,
        providerId: input.row.sessionProviderId,
        agentKind: kind,
      }
    : null;
  return {
    busy,
    pending,
    model,
    actions: projectWorkItemFollowupCapabilities({
      // 显式映射：入口的任何不可用原因都让四个后续动作不可用，不把两个联合类型混用。
      unavailableReason: input.unavailableReason === null ? null : 'EXECUTOR_UNAVAILABLE',
      state: input.state,
      pending,
      busy,
      hasModel: model !== null,
    }),
  };
}

/** 后续动作的投递行：与入口共用同一个查询形状（`context.readDeliveryRows`）。 */
function readFollowupDeliveries(client: Client, sessionId: string): Promise<DeliveryRow[]> {
  return readDeliveryRows(client, sessionId, WORK_ITEM_FOLLOWUP_CLIENT_ID_PREFIX);
}

/**
 * 该投递之后目标会话是否已经产出内容（assistant / tool_use / thinking / ask_user /
 * plan_review，rewind 软删的不算）。「之后」用 (created_at, rowid) 双键严格大于，
 * 与 `localDb/sessionActiveTurn.ts` 的同名判定同口径。
 */
async function hasProgressAfter(client: Client, sessionId: string, clientId: string): Promise<boolean> {
  const found = await client.queryOne<{ found: number }>(
    `SELECT 1 AS found FROM messages m
    WHERE m.session_id=?
      AND m.role IN ('assistant','tool_use','thinking','ask_user','plan_review')
      AND m.rewind_at IS NULL
      AND EXISTS (
        SELECT 1 FROM messages u
        WHERE u.session_id=? AND u.client_id=? AND u.rewind_at IS NULL
          AND (m.created_at > u.created_at OR (m.created_at = u.created_at AND m.rowid > u.rowid))
      )
    LIMIT 1`,
    [sessionId, sessionId, clientId],
  );
  return Boolean(found);
}

/**
 * 该动作当前的 round 与已有键。
 *
 * - 没有投递行 → round 0（首次尝试，失败重试仍复用 0）。
 * - 有投递行但目标会话还没产出内容 → 沿用该 round 与**原键**：连点、重试、
 *   排队还没被消费，都只会有这一个回合。
 * - 上一轮已被消费 → round + 1，新的键，允许再追加一次输入。
 */
export async function resolveFollowupRound(
  client: Client,
  sessionId: string,
  digest: string,
  action: WorkItemFollowupAction,
): Promise<{ round: number; key: string | null }> {
  const rows = await readFollowupDeliveries(client, sessionId);
  const latest = latestActionDelivery(rows, WORK_ITEM_FOLLOWUP_CLIENT_ID_PREFIX, digest, action);
  if (!latest) return { round: 0, key: null };
  if (await hasProgressAfter(client, sessionId, latest.key))
    return { round: latest.round + 1, key: null };
  return { round: latest.round, key: latest.key };
}

function continuePrompt(input: {
  projectId: string;
  sessionId: string;
  ownerText: string | null;
  queued: boolean;
}): string {
  return [
    input.queued
      ? 'The project owner asked you — the assignee of this work item — to take an input for this same execution. This task is busy right now, so the input is queued on this task; run it here when this turn ends, not in a separate task.'
      : 'The project owner asked you — the assignee of this project work item — to continue this same execution.',
    `1. Read the real state with get_project_progress (project_id ${JSON.stringify(input.projectId)}) and take the item whose sessionId is ${JSON.stringify(input.sessionId)}.`,
    '2. Continue in this task from that real state; the history here is the execution history. Do not create a child task, do not open a new work item, and do not call execute_project_work_item again for this item.',
    '3. Report what is actually done, blocked or failed. Do not claim progress that the real rows do not show.',
    input.ownerText
      ? 'The owner\'s instruction for this follow-up, verbatim:'
      : 'No extra instruction was given: continue from the current real state and report the result.',
    ...(input.ownerText ? [input.ownerText] : []),
  ].join('\n');
}

/** 没有原话时落库/展示的那句话；也是幂等校验里比对的期望值。 */
const DEFAULT_CONTINUE_TEXT = 'Continue this work item from its current real state.';

/**
 * 读回某个键已落库的那条 user 消息文本。读不到（已被 rewind / 清空 / 还没落库）时
 * 返回 null —— 那是「没有可矛盾的东西」，不是冲突。
 */
async function readStoredDeliveryText(
  client: Client,
  sessionId: string,
  clientId: string,
): Promise<string | null> {
  const row = await client.queryOne<{ content: string }>(
    `SELECT content FROM messages WHERE session_id=? AND client_id=? AND rewind_at IS NULL
    ORDER BY created_at DESC LIMIT 1`,
    [sessionId, clientId],
  );
  if (!row) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.content);
  } catch {
    return row.content;
  }
  return parsed && typeof parsed === 'object' && typeof (parsed as { text?: unknown }).text === 'string'
    ? (parsed as { text: string }).text
    : row.content;
}

/** 追加批准审计：写在委派已有的快照 JSON 里（不新开表，不改任何已有字段）。 */
async function appendApprovalAudit(
  client: Client,
  delegation: Pick<DelegationRow, 'id' | 'permissionSnapshotJson'>,
  audit: WorkItemFollowupApprovalAudit,
): Promise<void> {
  const snapshot = parseRecord(delegation.permissionSnapshotJson);
  const previous = Array.isArray(snapshot.executionApprovals)
    ? snapshot.executionApprovals.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
      )
    : [];
  const next = JSON.stringify({
    ...snapshot,
    executionApprovals: [...previous, audit].slice(-MAX_APPROVAL_AUDIT_ROWS),
  });
  await client.exec('UPDATE bot_delegations SET permission_snapshot_json=? WHERE id=?', [
    next,
    delegation.id,
  ]);
}

function assertFollowupIntent(value: unknown): {
  projectId: string;
  sessionId: string;
  action: WorkItemFollowupAction;
  text: string | null;
  model: string | null;
  providerId: string | null | undefined;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throwIpcError('INVALID_PARAMS', 'Invalid work-item follow-up request');
  const body = value as Record<string, unknown>;
  const allowed = new Set(['projectId', 'sessionId', 'action', 'text', 'model', 'providerId']);
  if (Object.keys(body).some((key) => !allowed.has(key)))
    throwIpcError('INVALID_PARAMS', 'Invalid work-item follow-up request');
  const text = (input: unknown) =>
    typeof input === 'string' && input.trim().length > 0 && input.length <= 200;
  if (!text(body.projectId) || !text(body.sessionId))
    throwIpcError('INVALID_PARAMS', 'Invalid work-item follow-up request');
  if (!FOLLOWUP_ACTIONS.includes(body.action as WorkItemFollowupAction))
    throwIpcError('INVALID_PARAMS', 'Unknown work-item follow-up action');
  const action = body.action as WorkItemFollowupAction;
  let instruction: string | null = null;
  if (body.text !== undefined) {
    if (action !== 'continue' && action !== 'queue')
      throwIpcError('INVALID_PARAMS', 'Only continue and queue accept text');
    if (typeof body.text !== 'string' || body.text.length > WORK_ITEM_FOLLOWUP_TEXT_MAX)
      throwIpcError('INVALID_PARAMS', 'Invalid follow-up text');
    instruction = body.text.trim() ? body.text.trim() : null;
  }
  let model: string | null = null;
  let providerId: string | null | undefined;
  if (action === 'model') {
    if (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 200)
      throwIpcError('INVALID_PARAMS', 'Invalid model id');
    model = body.model.trim();
    if (body.providerId !== undefined) {
      if (body.providerId !== null && (typeof body.providerId !== 'string' || body.providerId.length > 200))
        throwIpcError('INVALID_PARAMS', 'Invalid provider id');
      providerId = body.providerId as string | null;
    }
  } else if (body.model !== undefined || body.providerId !== undefined)
    throwIpcError('INVALID_PARAMS', 'Only the model action accepts a model');
  return {
    projectId: body.projectId as string,
    sessionId: body.sessionId as string,
    action,
    text: instruction,
    model,
    providerId,
  };
}

export async function requestProjectWorkItemFollowup(
  rawIntent: ProjectWorkItemFollowupIntent | unknown,
): Promise<ProjectWorkItemFollowupResult> {
  const intent = assertFollowupIntent(rawIntent);
  const authority = captureProjectExecutionAuthority();
  const fail = (
    code: WorkItemFollowupErrorCode,
    reason: WorkItemFollowupUnavailableReason | null,
    message: string,
    requestKey: string | null = null,
  ): ProjectWorkItemFollowupResult => ({
    ok: false,
    sessionId: intent.sessionId,
    action: intent.action,
    code,
    reason,
    message,
    requestKey,
  });
  await assertProjectMember(authority.client, intent.projectId, authority.userId);
  const rows = await readWorkItemRows(authority.client, intent.projectId);
  authority.assertCurrent();
  const row = rows.find((value) => value.sessionId === intent.sessionId);
  if (!row) throwIpcError('NOT_FOUND', 'Project work item is not available for this account');
  const botId = row.assigneeId ?? '';
  const digest = workItemRequestKeyPrefixDigest(intent.projectId, row.sessionId, botId);
  const canonicalSessionId = row.canonicalSessionId ?? '';
  const [delegations, followups, executionDeliveries] = await Promise.all([
    readDelegations(authority.client, intent.projectId),
    readFollowups(authority.client, intent.projectId),
    canonicalSessionId
      ? readDeliveryRows(authority.client, canonicalSessionId, WORK_ITEM_EXECUTION_CLIENT_ID_PREFIX)
      : Promise.resolve([]),
  ]);
  authority.assertCurrent();
  const delegation = delegations.find((value) => value.childSessionId === row.sessionId) ?? null;
  const followupRow = followups.find((value) => value.childSessionId === row.sessionId) ?? null;
  // 状态与入口同源：正则是同一份摘要口径，只是键前缀不同。
  const executionDelivered = canonicalSessionId
    ? latestExecutionDelivery(executionDeliveries, WORK_ITEM_EXECUTION_CLIENT_ID_PREFIX, digest)
    : null;
  const state = projectWorkItemExecutionState({
    delivered: executionDelivered !== null,
    delegation,
    followup: followupRow,
  });
  const projection = await readFollowupProjection({
    client: authority.client,
    row,
    state,
    delegation,
    unavailableReason: workItemUnavailableReason(row),
  });
  authority.assertCurrent();
  const capability = projection.actions[intent.action];
  if (!capability.allowed)
    return fail(
      'FOLLOWUP_UNAVAILABLE',
      capability.reason,
      'This follow-up action is not available for the real current state',
    );

  if (intent.action === 'approve') {
    const pending = projection.pending;
    const host = getOwnerTurnDispatch();
    if (!pending || !delegation)
      return fail('FOLLOWUP_UNAVAILABLE', 'NO_PENDING_CONFIRMATION', 'There is no pending confirmation');
    if (!host?.approveInteraction)
      return fail('HOST_NOT_READY', null, 'The confirmation path is not ready yet');
    // 批准前重读一次：状态可能在这几毫秒里变了，过期就报真实原因，不硬批。
    const freshDelegations = await readDelegations(authority.client, intent.projectId);
    authority.assertCurrent();
    const fresh = freshDelegations.find((value) => value.childSessionId === row.sessionId) ?? null;
    const freshPending = readPendingConfirmation(fresh);
    if (!fresh || !freshPending || freshPending.requestId !== pending.requestId)
      return fail('CONFIRMATION_STALE', 'NO_PENDING_CONFIRMATION',
        'The pending confirmation was already handled or is gone');
    const approved = host.approveInteraction({
      sessionId: row.sessionId,
      requestId: pending.requestId,
      kind: pending.kind as 'permission' | 'plan_review',
    });
    if (!approved.accepted)
      return fail('CONFIRMATION_STALE', null,
        'The pending confirmation was already handled by someone else or expired');
    const audit: WorkItemFollowupApprovalAudit = {
      at: Date.now(),
      requestId: pending.requestId,
      kind: pending.kind,
      summary: pending.summary,
      action: 'approve',
      actorKind: 'account',
      actorId: authority.userId,
      executionState: state,
      projectId: intent.projectId,
      sessionId: row.sessionId,
    };
    try {
      await appendApprovalAudit(authority.client, {
        id: fresh.id,
        permissionSnapshotJson: fresh.permissionSnapshotJson,
      }, audit);
    } catch (error) {
      // 批准已经生效：审计写失败要如实说出来，但不能回滚一个已完成的批准。
      log.warn('work item approval audit write failed', {
        sessionId: row.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return fail('INTERNAL', null, 'The approval was applied but its audit record was not saved');
    }
    authority.assertCurrent();
    return {
      ok: true,
      sessionId: row.sessionId,
      action: 'approve',
      requestKey: null,
      requestRound: null,
      replayed: false,
      wakeKind: null,
      queuedPosition: null,
      approval: audit,
      model: null,
    };
  }

  if (intent.action === 'model') {
    const host = getOwnerTurnDispatch();
    if (!host?.setSessionModel)
      return fail('HOST_NOT_READY', null, 'The model selection path is not ready yet');
    const outcome = await host.setSessionModel({
      sessionId: row.sessionId,
      model: intent.model!,
      providerId: intent.providerId ?? undefined,
    });
    authority.assertCurrent();
    // 失败只回真实原因：不回落默认模型、不换账号、不自动重试。
    if (!outcome.ok)
      return fail('MODEL_CHANGE_FAILED', null, outcome.message || 'The model was not changed');
    return {
      ok: true,
      sessionId: row.sessionId,
      action: 'model',
      requestKey: null,
      requestRound: null,
      replayed: false,
      wakeKind: null,
      queuedPosition: null,
      approval: null,
      model: { status: outcome.status, model: outcome.model, providerId: outcome.providerId },
    };
  }

  const dispatch = getOwnerTurnDispatch();
  if (!dispatch)
    return fail('HOST_NOT_READY', null, 'The teammate input path is not ready yet');
  // 幂等键按「意图」算：动作 + 追加输入都进摘要，改了内容就是新键（不会按旧键被吞）。
  const intentDigest = workItemFollowupIntentDigest({
    projectId: intent.projectId,
    sessionId: row.sessionId,
    botId,
    action: intent.action,
    text: intent.text,
  });
  const { round, key: existingKey } = await resolveFollowupRound(
    authority.client,
    row.sessionId,
    intentDigest,
    intent.action,
  );
  authority.assertCurrent();
  const requestKey = existingKey ?? workItemFollowupKey(intentDigest, intent.action, round);
  const prompt = continuePrompt({
    projectId: intent.projectId,
    sessionId: row.sessionId,
    ownerText: intent.text,
    queued: intent.action === 'queue',
  });
  let result: Awaited<ReturnType<typeof dispatch>>;
  try {
    result = await dispatch({
      targetSessionId: row.sessionId,
      clientId: requestKey,
      message: prompt,
      // 任务里看到的是主人自己的话；没有原话时说明这是「继续」。
      persistedContent: intent.text ?? DEFAULT_CONTINUE_TEXT,
      resumeWithStoredPermissionMode: true,
      authorizationGuard: {
        validate: async () => authority.assertCurrent(),
        assertCurrent: authority.assertCurrent,
      },
    });
  } catch (error) {
    log.warn('work item follow-up dispatch failed', {
      sessionId: row.sessionId,
      action: intent.action,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail('DISPATCH_FAILED', null, 'The teammate did not accept the follow-up', requestKey);
  }
  authority.assertCurrent();
  if (!result.ok)
    return fail('DISPATCH_FAILED', null,
      result.message || 'The teammate did not accept the follow-up', requestKey);
  // 防御式校验：重放说明「这个键已经有行了」，那就必须确认那一行就是这次的意图。
  // 键里已经含动作与文本摘要，正常不可能不一致；真不一致（摘要碰撞 / 别的写入方
  // 复用了同一个键）时宁可靠错，也不能把 B 显示成已投递。
  if (result.wakeKind === 'already-active') {
    const stored = await readStoredDeliveryText(authority.client, row.sessionId, requestKey);
    authority.assertCurrent();
    const expected = intent.text ?? DEFAULT_CONTINUE_TEXT;
    if (stored !== null && stored !== expected) {
      log.warn('work item follow-up idempotency conflict', {
        sessionId: row.sessionId,
        action: intent.action,
      });
      return fail('IDEMPOTENCY_CONFLICT', null,
        'This key already holds a different instruction; nothing new was delivered', requestKey);
    }
  }
  // 排队位置读的是真实队列里的那条 id；重放（already-active）时仍能读回它还在队列里的位置。
  const queuedMessageId = result.wakeKind === 'queued' ? (result.queuedMessageId ?? requestKey) : null;
  const positionOf = (clientId: string | null) =>
    clientId ? (getOwnerTurnDispatch()?.readQueuedPosition?.(row.sessionId, clientId) ?? null) : null;
  const queuedPosition = result.wakeKind === 'queued'
    ? positionOf(queuedMessageId)
    : result.wakeKind === 'already-active'
      ? positionOf(requestKey)
      : null;
  return {
    ok: true,
    sessionId: row.sessionId,
    action: intent.action,
    requestKey,
    requestRound: round,
    // 同一个键已经落过一行 = 这次没有产生第二个回合。
    replayed: result.wakeKind === 'already-active',
    wakeKind: result.wakeKind,
    queuedPosition,
    approval: null,
    model: null,
  };
}
