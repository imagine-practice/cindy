import {
  isWorkItemStatus,
  summarizeWorkItems,
  toWorkItemStatus,
  type WorkItemSessionSignals,
  type WorkItemStatus,
} from '../../../../shared/workItemStatus';
import type { WorkItemProgressRecord } from '../../../../shared/workItemProgress';

export interface ProjectProgressItem {
  sessionId: string;
  projectId: string;
  title: string;
  sessionStatus: string;
  bindingRevision: number;
  progress: WorkItemProgressRecord | null;
  /** Current binding observations only; never infer them from an old progress record. */
  signals?: Omit<WorkItemSessionSignals, 'status' | 'explicitStatus'>;
  /**
   * 自动化来源（`schedules.project_id` 反查）；缺省 / null = 不是自动化创建的。
   * 可选：缺省与 null 同义，标记就不出现；只做展示标记，不参与状态推断。
   */
  automation?: { scheduleId: string; scheduleName: string } | null;
}

/** Already authorized by the host. This display filter is not an access-control boundary. */
export interface ProjectProgressHistoryEntry {
  eventId: number;
  projectId: string;
  sessionId: string;
  bindingRevision: number;
  from: WorkItemStatus | null;
  to: WorkItemStatus;
  actor: { kind: 'account' | 'bot'; id: string; displayName?: string | null };
  createdAt: number;
  reason: string | null;
  unblockCondition: string | null;
  resolution: string | null;
  completionNote: string | null;
}

/**
 * 投影工作项与历史。泛型只为了把调用方**自己的**附加字段（如处理人 `assignee`）
 * 原样带到结果里：投影只负责状态与阻塞原因，不替调用方掂别的字段。
 */
export function projectProgressView<T extends ProjectProgressItem>(
  projectId: string,
  items: readonly T[],
  history: readonly ProjectProgressHistoryEntry[],
) {
  const scoped = items.filter((item) => item.projectId === projectId);
  const ids = new Set<string>();
  for (const item of scoped) {
    if (
      !item.sessionId ||
      ids.has(item.sessionId) ||
      !Number.isSafeInteger(item.bindingRevision) ||
      item.bindingRevision < 0
    ) {
      throw new Error('INVALID_PROGRESS_PROJECTION');
    }
    ids.add(item.sessionId);
  }
  const projected = scoped
    .map((item) => {
      const record = item.progress;
      const matches =
        record?.projectId === projectId &&
        record.sessionId === item.sessionId &&
        record.bindingRevision === item.bindingRevision;
      // A matching but malformed completion is unknown, not an implicit confirmation.
      const invalid =
        matches &&
        ((record.status !== null && !isWorkItemStatus(record.status)) ||
          (record.status === 'done' &&
            (!Number.isSafeInteger(record.completionEventId) || record.completionEventId! <= 0)));
      const status = invalid
        ? null
        : toWorkItemStatus({
            ...item.signals,
            status: item.sessionStatus,
            explicitStatus: matches && record.status !== null ? record.status : undefined,
          });
      return {
        ...item,
        status,
        blockReason: status === 'blocked' && matches ? record.reason : null,
        unblockCondition: status === 'blocked' && matches ? record.unblockCondition : null,
      };
    })
    .filter((item) => item.sessionStatus !== 'deleted');
  const summary = summarizeWorkItems(projected);
  const eventIds = new Set<number>();
  const events = history
    .filter((event) => event.projectId === projectId)
    .map((event) => {
      if (
        !Number.isSafeInteger(event.eventId) ||
        event.eventId <= 0 ||
        eventIds.has(event.eventId) ||
        !Number.isFinite(new Date(event.createdAt).getTime()) ||
        !isWorkItemStatus(event.to) ||
        (event.from !== null && !isWorkItemStatus(event.from))
      )
        throw new Error('INVALID_PROGRESS_PROJECTION');
      eventIds.add(event.eventId);
      return {
        ...event,
        historicalBinding: !projected.some(
          (item) =>
            item.sessionId === event.sessionId && item.bindingRevision === event.bindingRevision,
        ),
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt || b.eventId - a.eventId);
  return { items: projected, summary, history: events };
}
