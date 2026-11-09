import type Database from 'better-sqlite3';
import type {
  WorkItemProgressContext,
  WorkItemProgressRecord,
  WorkItemProgressResult,
  WorkItemProgressErrorCode,
} from '../../../../shared/workItemProgress';
import type { WorkItemStatus } from '../../../../shared/workItemStatus';

/**
 * Self-contained for file worker and legacy inline embedding via toString().
 * Tables are a target contract only: migration and worker registration are a later slice.
 * Never call with renderer-supplied context. Membership/role/binding are re-read under
 * the write lock; even an idempotent replay requires current access.
 * Consumes sessions.project_binding_revision maintained by the binding entry.
 * This slice does not implement/register that producer or its production migration.
 */
export function runWorkItemProgressTransaction(
  db: Database.Database,
  raw: unknown,
  context: WorkItemProgressContext,
): WorkItemProgressResult {
  const fail = (code: WorkItemProgressErrorCode): never => {
    // No project text, notes or historical payload in errors.
    throw new Error(`[${code}] Work item progress request rejected`);
  };
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_PARAMS');
    return value as Record<string, unknown>;
  };
  const text = (value: unknown, max: number, required = false): string | null => {
    if (value === undefined || value === null) {
      if (required) return fail('INVALID_PARAMS');
      return null;
    }
    if (typeof value !== 'string') return fail('INVALID_PARAMS');
    const result = value.trim();
    if (result.length > max || (required && !result)) return fail('INVALID_PARAMS');
    return result || null;
  };
  const body = object(raw);
  const fields = [
    'projectId',
    'sessionId',
    'expectedRevision',
    'expectedBindingRevision',
    'requestId',
    'to',
    'reason',
    'unblockCondition',
    'resolution',
    'completionNote',
  ];
  if (Object.keys(body).some((key) => !fields.includes(key))) return fail('INVALID_PARAMS');
  const projectId = text(body.projectId, 200, true)!;
  const sessionId = text(body.sessionId, 200, true)!;
  const requestId = text(body.requestId, 200, true)!;
  const expectedRevision = body.expectedRevision;
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    return fail('INVALID_PARAMS');
  }
  const expectedBindingRevision = body.expectedBindingRevision;
  if (
    typeof expectedBindingRevision !== 'number' ||
    !Number.isSafeInteger(expectedBindingRevision) ||
    expectedBindingRevision < 0
  ) {
    return fail('INVALID_PARAMS');
  }
  const statuses = ['todo', 'doing', 'blocked', 'review', 'done'];
  if (typeof body.to !== 'string' || !statuses.includes(body.to)) return fail('INVALID_PARAMS');
  const to = body.to as WorkItemStatus;
  const reason = text(body.reason, 4000);
  const unblockCondition = text(body.unblockCondition, 4000);
  const resolution = text(body.resolution, 4000);
  const completionNote = text(body.completionNote, 4000);
  const trusted = object(context);
  const actor = object(trusted.actor);
  if (actor.kind !== 'account' && actor.kind !== 'bot') return fail('INVALID_PARAMS');
  const kind = actor.kind;
  const actorId = text(actor.id, 200, true)!;
  const now = trusted.now;
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0)
    return fail('INVALID_PARAMS');
  // Fixed order, whitespace normalized, no context in the client intent fingerprint.
  const intentJson = JSON.stringify({
    projectId,
    sessionId,
    requestId,
    expectedRevision,
    expectedBindingRevision,
    to,
    reason,
    unblockCondition,
    resolution,
    completionNote,
  });

  return db
    .transaction((): WorkItemProgressResult => {
      const member = db
        .prepare(
          `SELECT m.role FROM project_members m
      JOIN projects p ON p.id = m.project_id
      WHERE m.project_id = ? AND m.subject_kind = ? AND m.subject_id = ?`,
        )
        .get(projectId, kind, actorId) as { role: string } | undefined;
      if (!member) return fail('FORBIDDEN');
      const session = db
        .prepare(
          'SELECT project_id AS projectId, status, project_binding_revision AS bindingRevision FROM sessions WHERE id = ?',
        )
        .get(sessionId) as
        { projectId: string | null; status: string; bindingRevision: number } | undefined;
      if (!session) return fail('NOT_FOUND');
      if (session.projectId !== projectId) return fail('PROJECT_MISMATCH');
      if (session.status === 'deleted') return fail('SESSION_DELETED');
      // Role is scoped by kind AND id. An owner bot is a progress confirmer too.
      if (to === 'done' && member.role !== 'owner') return fail('FORBIDDEN');
      // Check the current epoch before consulting any historical receipt.
      if (session.bindingRevision !== expectedBindingRevision) return fail('BINDING_CONFLICT');

      const replay = db
        .prepare(
          `SELECT event_id AS eventId, intent_json AS intentJson,
      after_json AS afterJson FROM work_item_progress_events
      WHERE project_id = ? AND session_id = ? AND actor_kind = ? AND actor_id = ? AND request_id = ? AND binding_revision = ?`,
        )
        .get(projectId, sessionId, kind, actorId, requestId, expectedBindingRevision) as
        { eventId: number; intentJson: string; afterJson: string } | undefined;
      if (replay) {
        if (replay.intentJson !== intentJson) return fail('REQUEST_CONFLICT');
        const record = JSON.parse(replay.afterJson) as WorkItemProgressRecord;
        return { record, eventId: replay.eventId, revision: record.revision, replayed: true };
      }

      const row = db
        .prepare(
          `SELECT project_id AS projectId, binding_revision AS bindingRevision, status, revision, reason,
      unblock_condition AS unblockCondition, completion_event_id AS completionEventId,
      updated_by_kind AS updatedByKind, updated_by_id AS updatedById, updated_at AS updatedAt
      FROM work_item_progress WHERE session_id = ?`,
        )
        .get(sessionId) as
        | {
            projectId: string;
            bindingRevision: number;
            status: WorkItemStatus | null;
            revision: number;
            reason: string | null;
            unblockCondition: string | null;
            completionEventId: number | null;
            updatedByKind: 'account' | 'bot';
            updatedById: string;
            updatedAt: number;
          }
        | undefined;
      // A project move starts unknown at revision 0. The previous project's history stays scoped there.
      const previous =
        row?.projectId === projectId && row.bindingRevision === expectedBindingRevision
          ? row
          : undefined;
      if (expectedRevision !== (previous?.revision ?? 0)) return fail('REVISION_CONFLICT');
      const from = previous?.status ?? null;
      // Same frozen graph as workItemStatus.ts, local because inline workers embed this function.
      const graph: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
        todo: ['doing', 'blocked', 'done'],
        doing: ['todo', 'blocked', 'review', 'done'],
        blocked: ['todo', 'doing'],
        review: ['doing', 'blocked', 'done'],
        done: ['doing'],
      };
      if (from !== null && from !== to && !graph[from]?.includes(to))
        return fail('ILLEGAL_TRANSITION');
      if (to === 'blocked' && !reason) return fail('REASON_REQUIRED');
      if (to === 'blocked' && !unblockCondition) return fail('UNBLOCK_CONDITION_REQUIRED');
      if (from === 'blocked' && to !== 'blocked' && !resolution) return fail('RESOLUTION_REQUIRED');
      if (to === 'done' && !completionNote) return fail('COMPLETION_NOTE_REQUIRED');
      if (to !== 'blocked' && (reason || unblockCondition)) return fail('INVALID_PARAMS');
      if (!(from === 'blocked' && to !== 'blocked') && resolution) return fail('INVALID_PARAMS');
      if (to !== 'done' && completionNote) return fail('INVALID_PARAMS');

      const before: WorkItemProgressRecord | null = previous
        ? {
            sessionId,
            projectId,
            status: previous.status,
            revision: previous.revision,
            bindingRevision: previous.bindingRevision,
            reason: previous.reason,
            unblockCondition: previous.unblockCondition,
            completionEventId: previous.completionEventId,
            updatedBy: { kind: previous.updatedByKind, id: previous.updatedById },
            updatedAt: previous.updatedAt,
          }
        : null;
      const record: WorkItemProgressRecord = {
        sessionId,
        projectId,
        status: to,
        revision: expectedRevision + 1,
        bindingRevision: expectedBindingRevision,
        reason: to === 'blocked' ? reason : null,
        unblockCondition: to === 'blocked' ? unblockCondition : null,
        completionEventId: null,
        updatedBy: { kind, id: actorId },
        updatedAt: now,
      };
      // Allocate an ID under the write lock so completion evidence and its snapshot can be
      // inserted once, without subsequently rewriting an append-only event.
      const eventId = (
        db
          .prepare('SELECT COALESCE(MAX(event_id), 0) + 1 AS id FROM work_item_progress_events')
          .get() as { id: number }
      ).id;
      if (to === 'done') record.completionEventId = eventId;
      db.prepare(
        `INSERT INTO work_item_progress_events
      (event_id, project_id, session_id, binding_revision, actor_kind, actor_id, request_id, intent_json,
       from_status, to_status, reason, unblock_condition, resolution, completion_note,
       created_at, revision, before_json, after_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        eventId,
        projectId,
        sessionId,
        expectedBindingRevision,
        kind,
        actorId,
        requestId,
        intentJson,
        from,
        to,
        reason ?? previous?.reason ?? null,
        unblockCondition ?? previous?.unblockCondition ?? null,
        resolution,
        completionNote,
        now,
        record.revision,
        JSON.stringify(before),
        JSON.stringify(record),
      );
      db.prepare(
        `INSERT INTO work_item_progress
      (session_id, project_id, binding_revision, status, revision, reason, unblock_condition, completion_event_id,
       updated_by_kind, updated_by_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET project_id=excluded.project_id,
       binding_revision=excluded.binding_revision, status=excluded.status,
       revision=excluded.revision, reason=excluded.reason, unblock_condition=excluded.unblock_condition,
       completion_event_id=excluded.completion_event_id, updated_by_kind=excluded.updated_by_kind,
       updated_by_id=excluded.updated_by_id, updated_at=excluded.updated_at`,
      ).run(
        sessionId,
        projectId,
        expectedBindingRevision,
        to,
        record.revision,
        record.reason,
        record.unblockCondition,
        record.completionEventId,
        kind,
        actorId,
        now,
      );
      return { record, eventId, revision: record.revision, replayed: false };
    })
    .immediate();
}
