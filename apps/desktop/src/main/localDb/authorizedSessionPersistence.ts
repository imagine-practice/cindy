import type { DbClient } from './client/DbClient';
import { sessions } from './schema';

export type SessionCreateActor = { kind: 'account' | 'bot'; id: string };

/** Main-to-worker envelope only. Never accept this SQL or actor from IPC input. */
export interface AuthorizedSessionCreateRequest {
  sessionId: string;
  projectId: string | null;
  actor: SessionCreateActor | null;
  insert: { sql: string; params: unknown[] };
}

export interface AuthorizedSessionCreateResult {
  sessionId: string;
  projectId: string | null;
}

/**
 * Compile the prepared row using the actual schema, including defaults and encoders.
 * No duplicate sessions column list. The actor comes from main's captured authority.
 * Works with the existing Drizzle proxy: toSQL() does not dispatch a raw SQL write.
 */
export function buildAuthorizedSessionCreate(
  client: Pick<DbClient, 'drizzle'>,
  prepared: typeof sessions.$inferInsert,
  actor: SessionCreateActor | null,
): AuthorizedSessionCreateRequest {
  const insert = client.drizzle.insert(sessions).values(prepared).toSQL();
  return {
    sessionId: prepared.id,
    projectId: prepared.projectId ?? null,
    actor: actor ? { kind: actor.kind, id: actor.id } : null,
    insert: { sql: insert.sql, params: insert.params },
  };
}

/**
 * Use the SAME client/actor captured before async preparation. Register the named tx
 * in file/inline/inproc transports in the integration slice; no registration here.
 * The synchronous owner check and immediate dispatch preserve openSession's guard.
 * A post-dispatch owner change still has the existing ambiguous-outcome boundary;
 * do not retry it on a different account/client or emit a success broadcast.
 */
export async function persistAuthorizedSession(
  client: Pick<DbClient, 'drizzle' | 'tx'>,
  prepared: typeof sessions.$inferInsert,
  authority: { actor: SessionCreateActor | null; assertCurrent: () => void },
): Promise<AuthorizedSessionCreateResult> {
  authority.assertCurrent();
  const request = buildAuthorizedSessionCreate(client, prepared, authority.actor);
  authority.assertCurrent();
  const result = await client.tx<AuthorizedSessionCreateResult>(
    'sessions.createAuthorized',
    request,
  );
  authority.assertCurrent();
  return result;
}
