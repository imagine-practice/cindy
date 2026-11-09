import type Database from 'better-sqlite3';
import type { AuthorizedSessionCreateResult } from '../../authorizedSessionPersistence';

/**
 * Internal named transaction; no renderer-facing SQL API. Self-contained for legacy
 * inline embedding. Membership and INSERT share an IMMEDIATE SQLite transaction.
 * The envelope must be compiled by main from the prepared row, never from IPC SQL.
 */
export function runAuthorizedSessionCreateTransaction(
  db: Database.Database,
  raw: unknown,
): AuthorizedSessionCreateResult {
  const fail = (code: string): never => {
    throw new Error(`[${code}] Session creation rejected`);
  };
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_PARAMS');
    return value as Record<string, unknown>;
  };
  const body = object(raw);
  const sessionId = body.sessionId;
  const projectId = body.projectId;
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200)
    return fail('INVALID_PARAMS');
  if (
    projectId !== null &&
    (typeof projectId !== 'string' || !projectId || projectId.length > 200)
  ) {
    return fail('INVALID_PARAMS');
  }
  let actor: { kind: 'account' | 'bot'; id: string } | null = null;
  if (body.actor !== null && body.actor !== undefined) {
    const supplied = object(body.actor);
    if (
      (supplied.kind !== 'account' && supplied.kind !== 'bot') ||
      typeof supplied.id !== 'string' ||
      !supplied.id.trim() ||
      supplied.id.length > 200
    )
      return fail('INVALID_PARAMS');
    actor = { kind: supplied.kind, id: supplied.id };
  }
  const insert = object(body.insert);
  if (
    typeof insert.sql !== 'string' ||
    !insert.sql.startsWith('insert into "sessions" (') ||
    !Array.isArray(insert.params)
  )
    return fail('INVALID_PARAMS');
  const statement = insert.sql;
  const params = insert.params;

  return db
    .transaction((): AuthorizedSessionCreateResult => {
      if (projectId !== null) {
        if (!actor) return fail('FORBIDDEN');
        // Kind and id are both required; an account must not borrow a same-id bot's role.
        const member = db
          .prepare(
            `SELECT p.status FROM project_members m
        JOIN projects p ON p.id=m.project_id
        WHERE m.project_id=? AND m.subject_kind=? AND m.subject_id=?`,
          )
          .get(projectId, actor.kind, actor.id) as { status: string } | undefined;
        if (!member) return fail('FORBIDDEN');
        if (member.status !== 'active') return fail('PRECONDITION_FAILED');
      }
      if (db.prepare('SELECT 1 FROM sessions WHERE id=?').get(sessionId))
        return fail('ALREADY_EXISTS');
      const saved = db.prepare(statement).run(...params);
      if (saved.changes !== 1) return fail('PRECONDITION_FAILED');
      const stored = db
        .prepare('SELECT project_id AS projectId FROM sessions WHERE id=?')
        .get(sessionId) as { projectId: string | null } | undefined;
      if (!stored || stored.projectId !== projectId) return fail('PRECONDITION_FAILED');
      // Old schemas lack the column. New schemas must give a fresh binding its default 0.
      const hasBindingRevision = (
        db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
      ).some((column) => column.name === 'project_binding_revision');
      if (hasBindingRevision) {
        const epoch = db
          .prepare('SELECT project_binding_revision AS revision FROM sessions WHERE id=?')
          .get(sessionId) as { revision: number };
        if (epoch.revision !== 0) return fail('PRECONDITION_FAILED');
      }
      return { sessionId, projectId };
    })
    .immediate();
}
