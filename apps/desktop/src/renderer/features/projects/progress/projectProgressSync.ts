/**
 * 「项目进展同步到群」的纯逻辑：把**已授权读到的**项目进展变成一段可以贴进群里的文字，
 * 并给每一次发送一枚新的发送标识。
 *
 * 四条底线（`docs/plans/2026-11-06-project-progress-to-group.md`）：
 * 1. 只写真实读到的数据。没有记录就写「暂无记录」，不写 0%，不推测百分比。
 * 2. 摘要只含项目名、按状态计数、每个工作项的标题/状态/处理人、阻塞原因与解除条件、
 *    最近进展时间；不含材料正文、成员名单、凭证、群成员或任何账号信息。
 * 3. 兜底走「文字」这一条消息通道：不用卡片协议、不改群发送协议。
 * 4. **同一段内容可以再次发送**（用户决定）：`clientId` = hash(项目 + 文本 + sendId)，
 *    sendId 由每次确认发送时生成；失败/未知重试复用同一枚（不会出现第二条），
 *    成功后作废，下次点击换新的一枚。
 *
 * 发送以**当前账号**身份进行（`authorKind: 'user'` 由 main 决定），这里不冒充伙伴。
 */
import type { TFunction } from 'i18next';
import type { BotGroupSendResult } from '../../../../shared/botGroupChat';
import type { ProjectProgressApiHistoryEntry, ProjectProgressApiItem } from '../../../../shared/projectProgressApi';
import type { WorkItemStatus } from '../../../../shared/workItemStatus';
import { botGroupApi } from '@/features/bots/botGroupStore';
import { botGroupErrorKey } from '@/features/bots/botGroupPresentation';
import { projectProgressView } from './progressProjection';

/** 一次摘要在确认框里看到什么，群里就是什么。 */
export interface ProjectProgressSummary {
  projectId: string;
  text: string;
}

/** 处理人只带 kind/id：名字由界面按自己已知的主体解析，main 没有账号昵称的权威来源。 */
export type ProjectProgressSubjectRef = { kind: 'account' | 'bot'; id: string };

export interface ProjectProgressSummaryInput {
  projectId: string;
  projectName: string;
  items: readonly ProjectProgressApiItem[];
  history: readonly ProjectProgressApiHistoryEntry[];
  t: TFunction;
  /** 处理人展示名；解析不到时必须返回 id，不猜名字。 */
  subjectLabel: (ref: ProjectProgressSubjectRef) => string;
  /** 时间戳渲染；测试可注入固定实现，界面与发送两侧必须用同一个。 */
  formatTimestamp?: (value: number) => string;
}

/** 最多列这么多行工作项，其余只报数量，避免一段摘要撑爆群消息上限。 */
const MAX_LISTED_ITEMS = 20;
/** 标题/原因/解除条件的长度上限：来自真实数据，但不能让一条摘要无限长。 */
const MAX_FIELD_CHARS = 200;
/** 计数展示顺序：先看正在推进与卡住的事，再看已完成。 */
const COUNT_ORDER: readonly WorkItemStatus[] = ['doing', 'blocked', 'review', 'todo', 'done'];
/** 工作项列表顺序：卡住的排最前，状态未知的排最后（它们不是「没进展」，是「没记录」）。 */
const ITEM_ORDER: readonly (WorkItemStatus | null)[] = ['blocked', 'doing', 'review', 'todo', 'done', null];
const SEPARATOR = ' · ';

function clip(value: string): string {
  const chars = Array.from(value.trim());
  return chars.length <= MAX_FIELD_CHARS ? chars.join('') : `${chars.slice(0, MAX_FIELD_CHARS).join('')}…`;
}

/** 53 位字符串散列（两种 FNV-1a 变体拼接），用于发送标识；不需要密码学强度。 */
function contentHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

/**
 * 每一次「确认发送」都生成一枚新的发送标识。
 *
 * 它只承担一件事：让同一段内容的下一次发送是一个新的 `clientId`。失败/未知时重试
 * 复用同一枚，因此 main 的 (group, clientId) 唯一约束仍然保证「一次点击最多一条」。
 */
export function createProjectProgressSendId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `pps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 发送幂等键：项目 + 文本 + 这一次点击的 sendId；内容不变但 sendId 变，就是一次新发送。 */
export function projectProgressClientId(projectId: string, text: string, sendId: string): string {
  return `project-progress-sync-${contentHash(`${projectId}\u0000${text}\u0000${sendId}`)}`;
}

/**
 * 生成摘要。`projectProgressView` 已经校验过项目范围与状态合法性；这里再兜一层，
 * 任何不一致都抛出，让调用方显示「读不到」而不是发一段猜出来的文字。
 */
export function buildProjectProgressSummary(input: ProjectProgressSummaryInput): ProjectProgressSummary {
  const { t } = input;
  const formatTimestamp = input.formatTimestamp ?? ((value: number) => new Date(value).toLocaleString());
  const view = projectProgressView(input.projectId, input.items, input.history);
  const lines: string[] = [t('projectProgressToGroup.summary.heading', { name: input.projectName })];

  if (view.summary.total === 0) {
    // 没有工作项就是没有记录：不写 0，也不写百分比。
    lines.push(t('projectProgressToGroup.summary.empty'));
  } else {
    const parts: string[] = [];
    for (const status of COUNT_ORDER) {
      const count = view.summary.counts[status];
      if (count > 0) {
        parts.push(t('projectProgressToGroup.summary.count', {
          status: t(`ccAgent.projectCore.progress.${status}`), count,
        }));
      }
    }
    if (view.summary.unknownCount > 0) {
      parts.push(t('projectProgressToGroup.summary.unknown', { count: view.summary.unknownCount }));
    }
    // total > 0 时 parts 不可能为空（未知状态也算一项），这里不做「0%」式兜底。
    if (parts.length > 0) lines.push(parts.join(SEPARATOR));

    // 每个工作项一行：状态 + 标题 + 处理人。处理人来自真实绑定，未分配就明说未分配。
    const ordered = [...view.items].sort((left, right) => rank(left.status) - rank(right.status));
    const listed = ordered.slice(0, MAX_LISTED_ITEMS);
    const notRecorded = t('ccAgent.projectCore.progress.notRecorded');
    lines.push('');
    for (const item of listed) {
      const status = item.status === null
        ? t('projectProgressToGroup.summary.statusUnknown')
        : t(`ccAgent.projectCore.progress.${item.status}`);
      const assignee = t('projectProgressToGroup.summary.assignee', {
        name: item.assignee === null
          ? t('projectProgressToGroup.summary.unassigned')
          : (input.subjectLabel(item.assignee) || item.assignee.id),
      });
      lines.push([
        t('projectProgressToGroup.summary.item', {
          status, title: clip(item.title || t('ccAgent.projectCore.progress.untitled')),
        }),
        assignee,
      ].join(SEPARATOR));
      // 阻塞项附原因与解除条件：这是「跟进状态」里最需要别人知道的部分。
      if (item.status === 'blocked') {
        lines.push(`  ${t('projectProgressToGroup.summary.blockedReason', {
          reason: item.blockReason ? clip(item.blockReason) : notRecorded,
        })}`);
        lines.push(`  ${t('projectProgressToGroup.summary.blockedUnblock', {
          condition: item.unblockCondition ? clip(item.unblockCondition) : notRecorded,
        })}`);
      }
    }
    const omitted = ordered.length - listed.length;
    if (omitted > 0) lines.push(t('projectProgressToGroup.summary.itemOmitted', { count: omitted }));
  }

  const latest = latestTimestamp(view.items, view.history);
  // 空行把「每个工作项」与「最近一次进展」分成两段，不会读成同一块。
  lines.push('');
  lines.push(latest === null
    ? t('projectProgressToGroup.summary.latestNone')
    : t('projectProgressToGroup.summary.latest', { time: formatTimestamp(latest) }));

  return { projectId: input.projectId, text: lines.join('\n') };
}

/** 列表排序：状态优先级 → 同状态内标题。 */
function rank(status: WorkItemStatus | null): number {
  const index = ITEM_ORDER.indexOf(status);
  return index === -1 ? ITEM_ORDER.length : index;
}

/** 最近一次进展：进度记录的更新时间与状态事件里最新的那个；都没有就是没有。 */
function latestTimestamp(
  items: ReturnType<typeof projectProgressView>['items'],
  history: ReturnType<typeof projectProgressView>['history'],
): number | null {
  let latest = 0;
  for (const event of history) if (Number.isFinite(event.createdAt) && event.createdAt > latest) latest = event.createdAt;
  for (const item of items) {
    const updatedAt = item.progress?.updatedAt;
    if (typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt > latest) latest = updatedAt;
  }
  return latest > 0 ? latest : null;
}

export type ProjectProgressSyncOutcome =
  | { kind: 'sent'; messageId: string }
  /** main 按同一枚 `clientId` 认出了同一条：这一枚已经入库，没有再发第二条。 */
  | { kind: 'alreadySent'; messageId: string }
  | { kind: 'failed'; reasonKey: string; retryable: boolean };

/** 内容被拒或没有权限时重试也没用；其余（含结果未知）都可以用同一枚标识重试。 */
const NON_RETRYABLE = new Set<string>([
  'INVALID_PARAMS', 'ALL_BOTS_MENTION_DISABLED', 'NOT_FOUND', 'PERMISSION_DENIED',
  'GROUP_ARCHIVED', 'GROUP_DISSOLVED',
]);

const RECEIPT_KEY = 'cindy.projectProgressSync.receipts.v2';
const RECEIPT_LIMIT = 50;

/** 本机已知的「这一枚发送标识已发成哪条消息」，用于把重试后的重放说成「已发送过」。 */
function readReceipts(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(RECEIPT_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const receipts: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 0) receipts[key] = value;
    }
    return receipts;
  } catch {
    return {};
  }
}

function receiptKey(groupId: string, clientId: string): string {
  return `${groupId}\u0000${clientId}`;
}

function writeReceipt(key: string, messageId: string): void {
  try {
    const receipts = readReceipts();
    receipts[key] = messageId;
    const keys = Object.keys(receipts);
    for (const stale of keys.slice(0, Math.max(0, keys.length - RECEIPT_LIMIT))) delete receipts[stale];
    globalThis.localStorage?.setItem(RECEIPT_KEY, JSON.stringify(receipts));
  } catch { /* 隐私模式或配额满：只是少认一次「已发送过」，不影响幂等发送。 */ }
}

/** 仅测试：清掉本机回执。 */
export function resetProjectProgressSyncReceipts(): void {
  try { globalThis.localStorage?.removeItem(RECEIPT_KEY); } catch { /* 没有 storage 就没有残留。 */ }
}

/**
 * 把摘要作为**当前账号**的一条普通群消息发出。
 *
 * `sendId` 是这次点击的发送标识：同一枚重试由 main 的 (group, clientId) 唯一约束兜底，
 * 不会产生第二条；换一枚（用户再次确认发送）就是一条新消息，同内容也可以再发。
 */
export async function sendProjectProgressSummary(input: {
  groupId: string;
  summary: ProjectProgressSummary;
  sendId: string;
}): Promise<ProjectProgressSyncOutcome> {
  const api = botGroupApi();
  if (!api?.sendBotGroupMessage) {
    return { kind: 'failed', reasonKey: 'projectProgressToGroup.hostNotReady', retryable: true };
  }
  const clientId = projectProgressClientId(input.summary.projectId, input.summary.text, input.sendId);
  const key = receiptKey(input.groupId, clientId);
  const known = readReceipts()[key];
  let result: BotGroupSendResult;
  try {
    result = await api.sendBotGroupMessage({
      groupId: input.groupId,
      clientId,
      text: input.summary.text,
      mentions: { all: false, botIds: [] },
    });
  } catch {
    // 发出去了没拿到回执：内容未知但可能已入库；同一枚标识重试是安全的。
    return { kind: 'failed', reasonKey: 'projectProgressToGroup.unknownOutcome', retryable: true };
  }
  if (!result || result.ok !== true) {
    const code = result && result.ok === false ? result.errorCode : null;
    return {
      kind: 'failed',
      reasonKey: botGroupErrorKey(code, 'projectProgressToGroup.sendFailed'),
      retryable: !NON_RETRYABLE.has(code ?? ''),
    };
  }
  writeReceipt(key, result.messageId);
  return known === result.messageId
    ? { kind: 'alreadySent', messageId: result.messageId }
    : { kind: 'sent', messageId: result.messageId };
}
