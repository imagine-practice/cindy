/**
 * W1 unit/integration: production dispatcher and actual inline worker RPC with real SQLite.
 * B1 TARGET SCHEMA FIXTURE only, not a production migration/replay claim.
 * Gap: pure transaction tests cannot detect missing dispatch cases, envelope flattening,
 * context defaults or broken toString embedding. Minimal input: named progress request.
 * Assert persisted records/events, replay and zero writes on rejected requests.
 * No real waits, user data, module resets or production file-worker bundle claim.
 */
import { describe, it, expect } from 'vitest';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { dispatch } from '../worker/dispatcher';
import { WorkerThreadTransport } from '../client/WorkerThreadTransport';
import type { DbTxArgsByName, DbTxResultByName } from '../client/tx/types';

const fixture = `
      CREATE TABLE projects (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE project_members (project_id TEXT, subject_kind TEXT, subject_id TEXT, role TEXT,
        PRIMARY KEY(project_id, subject_kind, subject_id));
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT, status TEXT NOT NULL, project_binding_revision INTEGER NOT NULL DEFAULT 0);
      INSERT INTO projects VALUES ('p','active'), ('q','active');
      INSERT INTO project_members VALUES ('p','account','same','owner'), ('p','bot','same','member'),
        ('q','account','same','owner');
      INSERT INTO sessions VALUES ('s','p','active',0);

      -- Target schema fixture only; the integration slice must generate a real migration.
      CREATE TABLE work_item_progress_events (
        event_id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
        binding_revision INTEGER NOT NULL,
        actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
        intent_json TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
        reason TEXT, unblock_condition TEXT, resolution TEXT, completion_note TEXT,
        created_at INTEGER NOT NULL, revision INTEGER NOT NULL,
        before_json TEXT NOT NULL, after_json TEXT NOT NULL,
        UNIQUE(project_id, session_id, actor_kind, actor_id, request_id, binding_revision));
      CREATE TABLE work_item_progress (
        session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, binding_revision INTEGER NOT NULL, status TEXT, revision INTEGER NOT NULL,
        reason TEXT, unblock_condition TEXT, completion_event_id INTEGER REFERENCES work_item_progress_events(event_id),
        updated_by_kind TEXT NOT NULL, updated_by_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `;
const intent = {
  projectId: 'p', sessionId: 's', expectedRevision: 0, expectedBindingRevision: 0,
  requestId: 'first', to: 'doing' as const,
};
const context = { actor: { kind: 'bot' as const, id: 'same' }, now: 1000 };
const envelope: DbTxArgsByName['workItemProgress.execute'] = { intent, context };
type Result = DbTxResultByName['workItemProgress.execute'];

describe('workItemProgress named dispatch (B1 target fixture)', () => {
  for (const mode of ['dispatcher', 'inline-worker'] as const) {
    it(`${mode}: persists, replays and rejects stale/forged/untrusted requests without writes`, async () => {
      const db = mode === 'dispatcher' ? createBetterSqliteDatabase(':memory:') : undefined;
      const worker = mode === 'inline-worker' ? new WorkerThreadTransport({
        useInlineWorker: true, dbPath: ':memory:', betterSqliteModulePath: require.resolve('better-sqlite3'),
      }) : undefined;
      const send = (op: string, args: unknown): Promise<unknown> =>
        worker ? worker.send(op, args) : dispatch(op, args, db!);
      const execute = (args: unknown) => send('tx', { name: 'workItemProgress.execute', args }) as Promise<Result>;
      const count = () => send('queryOne', { sql: 'SELECT COUNT(*) AS n FROM work_item_progress_events' });
      try {
        // Individual statements also exercise the actual worker exec transport.
        for (const sql of fixture.replace(/--[^\n]*/g, '').split(';').filter((part) => part.trim())) await send('exec', { sql });
        const first = await execute(envelope);
        expect(first).toMatchObject({ revision: 1, replayed: false, eventId: 1,
          record: { status: 'doing', bindingRevision: 0, updatedBy: context.actor, updatedAt: 1000 },
        });
        expect(await send('queryOne', { sql: "SELECT status, revision, binding_revision FROM work_item_progress WHERE session_id='s'" }))
          .toEqual({ status: 'doing', revision: 1, binding_revision: 0 });
        expect(await execute(envelope)).toEqual({ ...first, replayed: true });
        expect(await count()).toEqual({ n: 1 });
        for (const [args, code] of [
          [{ intent }, 'INVALID_PARAMS'],
          [{ intent: { ...intent, actor: { kind: 'account', id: 'same' } }, context }, 'INVALID_PARAMS'],
          [{ intent: { ...intent, expectedBindingRevision: 9 }, context }, 'BINDING_CONFLICT'],
          [{ intent: { ...intent, expectedBindingRevision: undefined }, context }, 'INVALID_PARAMS'],
          [{ intent, context: { ...context, actor: { kind: 'bot', id: 'outsider' } } }, 'FORBIDDEN'],
        ] as const) {
          await expect(execute(args)).rejects.toThrow(`[${code}]`);
          expect(await count()).toEqual({ n: 1 });
        }
        await send('exec', { sql: "DELETE FROM project_members WHERE project_id='p' AND subject_kind='bot'" });
        await expect(execute(envelope)).rejects.toThrow('[FORBIDDEN]');
        expect(await count()).toEqual({ n: 1 });
        expect(await send('queryOne', { sql: "SELECT revision FROM work_item_progress WHERE session_id='s'" })).toEqual({ revision: 1 });
      } finally {
        if (worker) await worker.close();
        if (db) db.close();
      }
    });
  }
});
