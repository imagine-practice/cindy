/** Pure progress projection. Storage lifecycle never proves completion.
 * Unknown evidence returns null; callers must display it separately from todo.
 * No IO, persistence, acceptance authority, or publication decision lives here.
 */
export const WORK_ITEM_STATUSES = ['todo', 'doing', 'blocked', 'review', 'done'] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

/**
 * 映射输入：任务在某一刻可观察到的信号。
 *
 * 字段全部可缺省：main 只有 DB 列（时间戳是 unix ms），renderer 的 `Session` 带 ISO 字符串
 * 与运行态，两边都能直接传进来，不需要先各自转换。缺省 = 没有这个信号，不当成 true。
 */
export interface WorkItemSessionSignals {
  /** 任务存储状态（`sessions.status`）。无法识别的值走兜底分支。 */
  status: string;
  /** Recorded progress; done requires an existing authorized completion record.
   * Never synthesize this from archive/delete, execution exit, or agent self-report.
   */
  explicitStatus?: WorkItemStatus;
  /** 用户最近一次按下发送的时刻（unix ms 或 ISO 8601）；null = 从未发过。 */
  userSendAt?: number | string | null;
  /** 最近一次活动时刻（unix ms 或 ISO 8601）；null = 没有活动记录。 */
  lastActivityAt?: number | string | null;
  /** Agent 正有一轮在跑（renderer 运行态 / main runtime 快照）。 */
  running?: boolean;
  /** 阻塞标记：agent 正等用户回答问题或授权，或 /goal 续跑被标 blocked。 */
  blocked?: boolean;
  /** 本轮已完成、尚未被人工确认验收（完成未读 / 待验收）。 */
  completedAwaitingReview?: boolean;
}

function hasTimestamp(value: number | string | null | undefined): boolean {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // 空串与非法日期都等于「没有这个信号」；Date.parse 不读时钟，保持纯函数。
    return trimmed.length > 0 && Number.isFinite(Date.parse(trimmed));
  }
  return false;
}

export function isWorkItemStatus(value: unknown): value is WorkItemStatus {
  return typeof value === 'string' && (WORK_ITEM_STATUSES as readonly string[]).includes(value);
}

/** Explicit progress > blocked > awaiting review > activity > proven no start > unknown.
 * Archive preserves progress; deletion is excluded separately by summarizeWorkItems.
 * Execution stopping alone is neither independent review nor business acceptance.
 */
export function toWorkItemStatus(session: WorkItemSessionSignals): WorkItemStatus | null {
  if (isWorkItemStatus(session.explicitStatus)) return session.explicitStatus;
  if (session.blocked === true) return 'blocked';
  if (session.completedAwaitingReview === true) return 'review';
  if (!['active', 'archived', 'deleted'].includes(session.status)) return null;
  if (session.running === true) return 'doing';
  if (hasTimestamp(session.lastActivityAt) || hasTimestamp(session.userSendAt)) return 'doing';
  // Only explicit absence proves no start. Missing/invalid observations are unknown.
  if (session.running === false && session.userSendAt === null && session.lastActivityAt === null) {
    return 'todo';
  }
  return null;
}

/** 阻塞原因的唯一口径：去首尾空白后为空即「没给原因」。 */
export function normalizeWorkItemBlockReason(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 允许的流转图。同一文件里既是校验依据，也是界面菜单的唯一来源（`allowedWorkItemTransitions`）。
 *
 * 刻意收紧的几条，避免用一次点击掩盖没处理完的事：
 * - `blocked` 只能回到 `todo` / `doing`：阻塞必须先被解除，才能宣称完成或进入验收。
 * - `done` 只能回到 `doing`：返工必须走过「在做」，不能直接退回未开始（那条信息会被吞掉）。
 * - `review` 不能直接回 `todo`：打回即返工，落 `doing`。
 * - 任何一档 → `blocked` 都需要原因；任何一档 → `done` 都允许（小事不必走验收）。
 */
const LEGAL_TRANSITIONS: Readonly<Record<WorkItemStatus, readonly WorkItemStatus[]>> = {
  todo: ['doing', 'blocked', 'done'],
  doing: ['todo', 'blocked', 'review', 'done'],
  blocked: ['todo', 'doing'],
  review: ['doing', 'blocked', 'done'],
  done: ['doing'],
};

/** 流转失败原因。命名对齐仓库既有的 UPPER_SNAKE 错误码风格（见 `ipc-errors.ts`）。 */
export type WorkItemStatusErrorCode =
  /** `from` / `to` 不是工作项状态（跨版本 payload、IPC 脏数据）。 */
  | 'UNKNOWN_STATUS'
  /** 流转图里没有这条边。 */
  | 'ILLEGAL_TRANSITION'
  /** 进入 `blocked` 却没给原因。 */
  | 'REASON_REQUIRED';

export type WorkItemStatusTransition = { ok: true } | { ok: false; code: WorkItemStatusErrorCode };

export interface WorkItemStatusTransitionInput {
  /** 进入 `blocked` 的原因；空白串按「没给」处理。 */
  reason?: string | null;
}

/** 该目标状态是否必须带原因（界面据此决定要不要先弹原因输入）。 */
export function workItemTransitionNeedsReason(to: WorkItemStatus): boolean {
  return to === 'blocked';
}

/** 从某状态出发的合法去向（不含自身），与 `nextWorkItemStatus` 用同一张图。 */
export function allowedWorkItemTransitions(from: WorkItemStatus): readonly WorkItemStatus[] {
  return LEGAL_TRANSITIONS[from] ?? [];
}

/** Validates the transition graph and block reason, including same-state requests.
 * This is not an authorization check: the caller must enforce acceptance authority.
 */
export function nextWorkItemStatus(
  from: WorkItemStatus,
  to: WorkItemStatus,
  input: WorkItemStatusTransitionInput = {},
): WorkItemStatusTransition {
  if (!isWorkItemStatus(from) || !isWorkItemStatus(to)) {
    return { ok: false, code: 'UNKNOWN_STATUS' };
  }
  if (from !== to && !LEGAL_TRANSITIONS[from].includes(to))
    return { ok: false, code: 'ILLEGAL_TRANSITION' };
  if (workItemTransitionNeedsReason(to) && normalizeWorkItemBlockReason(input.reason) === null) {
    return { ok: false, code: 'REASON_REQUIRED' };
  }
  return { ok: true };
}

/** 各档计数。空输入时每一项都是 0（调用方不必再判空）。 */
export interface WorkItemStatusCounts {
  todo: number;
  doing: number;
  blocked: number;
  review: number;
  done: number;
}

export interface WorkItemSummary<T> {
  /** Effective total includes unknown progress and excludes deleted items. */
  total: number;
  counts: WorkItemStatusCounts;
  /** Unknown progress stays in the denominator, avoiding inflated completion rates. */
  unknownCount: number;
  /** 阻塞项（保持输入顺序），供进度视图直接列出「卡在哪」。 */
  blockedItems: T[];
}

/** status is progress; sessionStatus is the separate storage lifecycle.
 * Deleted items are excluded from all effective statistics. Archived items remain.
 * total = sum(counts) + unknownCount. Unknown progress is never silently dropped.
 */
export function summarizeWorkItems<T extends { status: string | null; sessionStatus?: string }>(
  items: readonly T[],
): WorkItemSummary<T> {
  const counts: WorkItemStatusCounts = { todo: 0, doing: 0, blocked: 0, review: 0, done: 0 };
  const blockedItems: T[] = [];
  let total = 0;
  let unknownCount = 0;
  for (const item of items) {
    if (item.sessionStatus === 'deleted') continue;
    total += 1;
    if (!isWorkItemStatus(item.status)) {
      unknownCount += 1;
      continue;
    }
    counts[item.status] += 1;
    if (item.status === 'blocked') blockedItems.push(item);
  }
  return { total, counts, blockedItems, unknownCount };
}
