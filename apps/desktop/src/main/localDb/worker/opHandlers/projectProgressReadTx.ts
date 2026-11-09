import type Database from 'better-sqlite3';
import type {
  ProjectProgressReadContext,
  ProjectProgressReadResult,
  ProjectProgressApiHistoryEntry,
} from '../../../../shared/projectProgressApi';
import type { WorkItemProgressRecord } from '../../../../shared/workItemProgress';
import type { WorkItemStatus } from '../../../../shared/workItemStatus';

/** Self-contained for file/inline workers. One deferred read transaction supplies the
 * membership decision, complete items and a bounded history page from one snapshot.
 * This unregistered core consumes the target schema; it does not install migrations.
 */
export function readProjectProgressTransaction(
  db: Database.Database,
  raw: unknown,
  context: ProjectProgressReadContext,
): ProjectProgressReadResult {
  const fail = (code: string): never => {
    throw new Error(`[${code}] Project progress read rejected`);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('INVALID_PARAMS');
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'projectId' && key !== 'beforeEventId'))
    return fail('INVALID_PARAMS');
  if (typeof body.projectId !== 'string' || !body.projectId.trim() || body.projectId.length > 200)
    return fail('INVALID_PARAMS');
  const projectId = body.projectId;
  const cursor = body.beforeEventId;
  if (
    cursor !== undefined &&
    (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor <= 0)
  ) {
    return fail('INVALID_PARAMS');
  }
  const actor = context?.actor;
  if (
    !actor ||
    (actor.kind !== 'account' && actor.kind !== 'bot') ||
    typeof actor.id !== 'string' ||
    !actor.id.trim() ||
    actor.id.length > 200
  )
    return fail('FORBIDDEN');

  return db.transaction((): ProjectProgressReadResult => {
    const member = db
      .prepare(
        `SELECT m.role FROM project_members m JOIN projects p ON p.id=m.project_id
      WHERE p.id=? AND m.subject_kind=? AND m.subject_id=?`,
      )
      .get(projectId, actor.kind, actor.id) as { role: string } | undefined;
    if (!member) return fail('FORBIDDEN');
    const rows = db
      .prepare(
        `SELECT s.id AS sessionId, s.title, s.status AS sessionStatus,
      s.assignee_kind AS assigneeKind, s.assignee_id AS assigneeId,
      s.project_binding_revision AS bindingRevision, p.project_id AS progressProjectId,
      p.session_id AS progressSessionId, p.binding_revision AS progressBindingRevision,
      p.status AS progressStatus, p.revision, p.reason, p.unblock_condition AS unblockCondition,
      p.completion_event_id AS completionEventId, p.updated_by_kind AS updatedByKind,
      p.updated_by_id AS updatedById, p.updated_at AS updatedAt,
      e.event_id AS confirmedEventId
      FROM sessions s LEFT JOIN work_item_progress p ON p.session_id=s.id
        AND p.project_id=s.project_id AND p.binding_revision=s.project_binding_revision
      LEFT JOIN work_item_progress_events e ON e.event_id=p.completion_event_id
        AND e.session_id=s.id AND e.project_id=s.project_id AND e.binding_revision=s.project_binding_revision
        AND e.to_status='done' AND length(trim(e.completion_note))>0 AND e.revision=p.revision
        AND e.actor_kind=p.updated_by_kind AND e.actor_id=p.updated_by_id
      WHERE s.project_id=? AND s.status<>'deleted' ORDER BY s.id`,
      )
      .all(projectId) as Array<{
      sessionId: string;
      title: string;
      sessionStatus: string;
      assigneeKind: 'account' | 'bot' | null;
      assigneeId: string | null;
      bindingRevision: number;
      progressProjectId: string | null;
      progressSessionId: string | null;
      progressBindingRevision: number | null;
      progressStatus: WorkItemStatus | null;
      revision: number;
      reason: string | null;
      unblockCondition: string | null;
      completionEventId: number | null;
      confirmedEventId: number | null;
      updatedByKind: 'account' | 'bot';
      updatedById: string;
      updatedAt: number;
    }>;
    // 自动化来源**单独查**，并且在调度器 schema 不完整时降级为「没有来源」。
    //
    // 为什么不放进主查询做三连 JOIN：进度读取是项目内核的能力，不该被调度器表结构绑架。
    // 真实的旧库 / 部分库 / 受限环境只要缺这三张表（或缺 0153 才有的
    // `schedules.project_id`），JOIN 就会让整块进度读取抛错，而外层只能回一个
    // `[INTERNAL]`——用户看到的不是"少一个来源标记"，而是"进度读不出来"。
    const automationBySession = new Map<string, { scheduleId: string; scheduleName: string }>();
    const hasColumns = (table: string, columns: readonly string[]): boolean => {
      const existing = new Set(
        (db.prepare(`PRAGMA table_info('${table}')`).all() as { name: unknown }[]).map((column) =>
          String(column.name),
        ),
      );
      return existing.size > 0 && columns.every((column) => existing.has(column));
    };
    const canResolveAutomation =
      hasColumns('schedules', ['id', 'name', 'project_id'])
      && hasColumns('schedule_runs', ['id', 'schedule_id'])
      && hasColumns('schedule_session_latest_runs', ['session_id', 'run_id']);
    if (canResolveAutomation) {
      const automationRows = db
        .prepare(
          `SELECT lr.session_id AS sessionId, sch.id AS scheduleId, sch.name AS scheduleName
           FROM schedule_session_latest_runs lr
           JOIN schedule_runs sr ON sr.id=lr.run_id
           JOIN schedules sch ON sch.id=sr.schedule_id AND sch.project_id=?`,
        )
        .all(projectId) as Array<{ sessionId: string; scheduleId: string; scheduleName: string }>;
      for (const row of automationRows) {
        automationBySession.set(row.sessionId, { scheduleId: row.scheduleId, scheduleName: row.scheduleName });
      }
    }
    const items = rows.map((row) => {
      let progress: WorkItemProgressRecord | null = null;
      if (row.progressSessionId !== null) {
        const validStatus = ['todo', 'doing', 'blocked', 'review', 'done'].includes(
          row.progressStatus ?? '',
        );
        const invalidDone = row.progressStatus === 'done' && row.confirmedEventId === null;
        progress = {
          sessionId: row.sessionId,
          projectId,
          bindingRevision: row.bindingRevision,
          status: validStatus && !invalidDone ? row.progressStatus : null,
          revision: row.revision,
          reason: row.reason,
          unblockCondition: row.unblockCondition,
          completionEventId: !invalidDone ? row.completionEventId : null,
          updatedBy: { kind: row.updatedByKind, id: row.updatedById },
          updatedAt: row.updatedAt,
        };
      }
      return {
        sessionId: row.sessionId,
        projectId,
        title: row.title,
        sessionStatus: row.sessionStatus,
        bindingRevision: row.bindingRevision,
        progress,
        // 未分配就是 null；kind 只认 account/bot，坏值不当成某个人。
        assignee: (row.assigneeKind === 'account' || row.assigneeKind === 'bot') && row.assigneeId
          ? { kind: row.assigneeKind, id: row.assigneeId }
          : null,
        // 只有真的存在会话 + run + 仍绑在本项目的 automation 才给标记。
        automation: automationBySession.get(row.sessionId) ?? null,
      };
    });
    // No current-session JOIN here: a move/delete must not hide original-project history,
    // nor may it reveal a destination project's current title or content.
    const events = db
      .prepare(
        `SELECT event_id AS eventId, project_id AS projectId, session_id AS sessionId,
      binding_revision AS bindingRevision, from_status AS "from", to_status AS "to",
      actor_kind AS actorKind, actor_id AS actorId, created_at AS createdAt, reason,
      unblock_condition AS unblockCondition, resolution, completion_note AS completionNote
      FROM work_item_progress_events WHERE project_id=?${cursor === undefined ? '' : ' AND event_id<?'}
      ORDER BY event_id DESC LIMIT 101`,
      )
      .all(...(cursor === undefined ? [projectId] : [projectId, cursor])) as Array<
      Omit<ProjectProgressApiHistoryEntry, 'actor'> & {
        actorKind: 'account' | 'bot';
        actorId: string;
      }
    >;
    const hasMore = events.length > 100;
    const history = events.slice(0, 100).map((event) => ({
      eventId: event.eventId,
      projectId: event.projectId,
      sessionId: event.sessionId,
      bindingRevision: event.bindingRevision,
      from: event.from,
      to: event.to,
      actor: { kind: event.actorKind, id: event.actorId, displayName: null },
      createdAt: event.createdAt,
      reason: event.reason,
      unblockCondition: event.unblockCondition,
      resolution: event.resolution,
      completionNote: event.completionNote,
    }));
    return {
      projectId,
      items,
      history,
      // Frozen W1 permits records on archived projects; do not invent a different UI promise.
      capabilities: { canRecord: true, canConfirmDone: member.role === 'owner' },
      historyPage: {
        limit: 100,
        hasMore,
        nextBeforeEventId: hasMore ? history[history.length - 1].eventId : null,
      },
    };
  })();
}
