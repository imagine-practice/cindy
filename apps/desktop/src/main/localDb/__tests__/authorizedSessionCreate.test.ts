import { dispatch as workerDispatch } from '../worker/dispatcher';
import { WorkerThreadTransport } from '../client/WorkerThreadTransport';
/**
 * Unit regression: membership revoked between preparation and the final sessions INSERT.
 * Production main compiler + real proxy toSQL + SQLite transaction entry. Existing
 * sessionsUpdate coverage does not close this create TOCTOU. Minimal failure: compile
 * a project row, remove the member, then persist it. No IPC/worker registration claim.
 * Fixture sessions columns derive from the actual Drizzle schema (not a migration).
 * No user DB, model/network, module resets or real waits. Integration must separately
 * replay the real sessions:create/openSession counterexample and provisional cleanup.
 */
import type Database from 'better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessions } from '../schema';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { createDrizzleProxy } from '../client/drizzleProxy';
import type { DbTransport } from '../client/DbTransport';
import type { DbClient } from '../client/DbClient';
import {
  buildAuthorizedSessionCreate,
  persistAuthorizedSession,
  type SessionCreateActor,
} from '../authorizedSessionPersistence';
import { runAuthorizedSessionCreateTransaction } from '../worker/opHandlers/authorizedSessionCreateTx';

describe('authorized session creation core', () => {
  let sqlite: Database.Database;
  let client: Pick<DbClient, 'drizzle' | 'tx'>;
  const actor: SessionCreateActor = { kind: 'account', id: 'same' };
  const send = vi.fn();
  const dispatch = vi.fn();
  const row = (
    patch: Partial<typeof sessions.$inferInsert> = {},
  ): typeof sessions.$inferInsert => ({
    id: 's',
    projectId: 'p',
    title: "Owner's task'); DROP TABLE projects; --",
    model: 'model-fixture',
    createdAt: 1000,
    updatedAt: 1000,
    ...patch,
  });
  const request = (
    patch: Partial<typeof sessions.$inferInsert> = {},
    identity: SessionCreateActor | null = actor,
  ) => buildAuthorizedSessionCreate(client, row(patch), identity);
  const count = () =>
    (sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;

  beforeEach(() => {
    sqlite = createBetterSqliteDatabase(':memory:');
    const config = getTableConfig(sessions);
    // Schema-derived fixture only; no hand-maintained second sessions field table.
    sqlite.exec(`CREATE TABLE sessions (${config.columns
      .map(
        (column) =>
          `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${column.name === 'project_binding_revision' ? ' NOT NULL DEFAULT 0' : ''}`,
      )
      .join(', ')})`);
    sqlite.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE project_members (project_id TEXT, subject_kind TEXT, subject_id TEXT, role TEXT,
        PRIMARY KEY(project_id,subject_kind,subject_id));
      INSERT INTO projects VALUES ('p','active');
      INSERT INTO project_members VALUES ('p','account','same','member'), ('p','bot','same','owner');`);
    send.mockReset();
    dispatch.mockReset();
    dispatch.mockImplementation(async (name, args) => {
      expect(name).toBe('sessions.createAuthorized');
      return runAuthorizedSessionCreateTransaction(sqlite, args);
    });
    client = {
      drizzle: createDrizzleProxy({ send } as unknown as DbTransport),
      tx: dispatch as DbClient['tx'],
    };
  });
  afterEach(() => sqlite.close());

  it('uses parameterized schema-generated INSERT and preserves ordinary prepared fields/defaults', async () => {
    const result = await persistAuthorizedSession(
      client,
      row({
        hiddenAt: 1000,
        remoteHostId: 'remote',
        permissionMode: 'plan',
        fastMode: 'ultrafast',
      }),
      { actor, assertCurrent: () => {} },
    );
    expect(result).toEqual({ sessionId: 's', projectId: 'p' });
    expect(
      sqlite
        .prepare(
          'SELECT title,project_id,project_binding_revision,hidden_at,remote_host_id,permission_mode,status FROM sessions',
        )
        .get(),
    ).toEqual({
      title: row().title,
      project_id: 'p',
      project_binding_revision: 0,
      hidden_at: 1000,
      remote_host_id: 'remote',
      permission_mode: 'plan',
      status: 'active',
    });
    expect(send).not.toHaveBeenCalled(); // toSQL did not send an unguarded raw INSERT.
    const envelope = dispatch.mock.calls[0][1];
    expect(envelope.insert.sql).not.toContain(row().title);
    expect(envelope.insert.params).toContain(row().title);
  });

  it.each(['remove-member', 'archive-project', 'delete-project'])(
    'rejects %s after preparation with zero session writes',
    (change) => {
      const prepared = request();
      if (change === 'remove-member')
        sqlite.exec("DELETE FROM project_members WHERE subject_kind='account'");
      if (change === 'archive-project') sqlite.exec("UPDATE projects SET status='archived'");
      if (change === 'delete-project') sqlite.exec('DELETE FROM projects');
      const before = (sqlite.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
      expect(() => runAuthorizedSessionCreateTransaction(sqlite, prepared)).toThrow(
        change === 'archive-project' ? '[PRECONDITION_FAILED]' : '[FORBIDDEN]',
      );
      expect(count()).toBe(0);
      expect((sqlite.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(before);
    },
  );

  it('does not borrow the same-id bot membership after account membership is revoked', () => {
    sqlite.exec("DELETE FROM project_members WHERE subject_kind='account'");
    expect(() => runAuthorizedSessionCreateTransaction(sqlite, request())).toThrow('[FORBIDDEN]');
    expect(
      runAuthorizedSessionCreateTransaction(sqlite, request({}, { kind: 'bot', id: 'same' })),
    ).toEqual({ sessionId: 's', projectId: 'p' });
  });

  it('requires trusted identity for a project-bound task', () => {
    expect(() => runAuthorizedSessionCreateTransaction(sqlite, request({}, null))).toThrow(
      '[FORBIDDEN]',
    );
    expect(count()).toBe(0);
  });

  it('retains unbound creation without requiring a project membership or signed-in actor', async () => {
    sqlite.exec('DELETE FROM projects; DELETE FROM project_members');
    await persistAuthorizedSession(client, row({ projectId: null }), {
      actor: null,
      assertCurrent: () => {},
    });
    expect(
      sqlite.prepare('SELECT project_id,project_binding_revision FROM sessions').get(),
    ).toEqual({ project_id: null, project_binding_revision: 0 });
  });

  it('rejects account switch during preparation before dispatch and never signals success', async () => {
    const assertCurrent = () => {
      throw new Error('fixture owner changed');
    };
    const success = vi.fn();
    await expect(
      persistAuthorizedSession(client, row(), { actor, assertCurrent }).then(success),
    ).rejects.toThrow('fixture owner changed');
    expect(dispatch).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(count()).toBe(0);
  });

  it('does not resolve a failed database write as success', async () => {
    sqlite.exec("DELETE FROM project_members WHERE subject_kind='account'");
    const success = vi.fn();
    await expect(
      persistAuthorizedSession(client, row(), { actor, assertCurrent: () => {} }).then(success),
    ).rejects.toThrow('[FORBIDDEN]');
    expect(success).not.toHaveBeenCalled();
    expect(count()).toBe(0);
  });

  it('rejects duplicate IDs without replacing the original session', () => {
    runAuthorizedSessionCreateTransaction(sqlite, request());
    expect(() =>
      runAuthorizedSessionCreateTransaction(sqlite, request({ title: 'replacement' })),
    ).toThrow('[ALREADY_EXISTS]');
    expect(count()).toBe(1);
    expect(sqlite.prepare('SELECT title FROM sessions').get()).toEqual({ title: row().title });
  });

  it('rolls back a malformed internal binding envelope instead of silently creating unbound', () => {
    const envelope = request();
    envelope.insert = request({ projectId: null }).insert;
    expect(() => runAuthorizedSessionCreateTransaction(sqlite, envelope)).toThrow(
      '[PRECONDITION_FAILED]',
    );
    expect(count()).toBe(0);
  });

  it('requires initial binding revision zero when the column exists', () => {
    sqlite.exec(`CREATE TRIGGER bad_binding AFTER INSERT ON sessions
      BEGIN UPDATE sessions SET project_binding_revision=4 WHERE id=NEW.id; END;`);
    expect(() => runAuthorizedSessionCreateTransaction(sqlite, request())).toThrow(
      '[PRECONDITION_FAILED]',
    );
    expect(count()).toBe(0);
  });

  it('supports the current schema without the future binding-revision column', () => {
    sqlite.exec('ALTER TABLE sessions DROP COLUMN project_binding_revision');
    // Legacy main compiled against the old schema; the current compiler includes the new column.
    const legacy = request();
    legacy.insert = { sql: 'insert into "sessions" ("id", "project_id") values (?, ?)', params: ['s', 'p'] };
    runAuthorizedSessionCreateTransaction(sqlite, legacy);
    expect(count()).toBe(1);
  });

  it('runs in legacy inline embedding without imported runtime helpers', () => {
    const embedded = new Function(
      `return (${runAuthorizedSessionCreateTransaction.toString()})`,
    )() as typeof runAuthorizedSessionCreateTransaction;
    expect(embedded(sqlite, request())).toEqual({ sessionId: 's', projectId: 'p' });
  });
  it.each(['dispatcher', 'inline-worker'] as const)('%s executes the named transaction and refuses a revoked actor', async mode => {
    const worker = mode === 'inline-worker' ? new WorkerThreadTransport({ useInlineWorker: true,
      dbPath: ':memory:', betterSqliteModulePath: require.resolve('better-sqlite3') }) : undefined;
    try {
      if (worker) {
        const tables = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL").all() as { sql: string }[];
        for (const table of tables) await worker.send('exec', { sql: table.sql });
        await worker.send('exec', { sql: "INSERT INTO projects VALUES ('p','active')" });
        await worker.send('exec', { sql: "INSERT INTO project_members VALUES ('p','account','same','member')" });
      }
      const sendTx = (args: unknown) => worker
        ? worker.send('tx', { name: 'sessions.createAuthorized', args })
        : workerDispatch('tx', { name: 'sessions.createAuthorized', args }, sqlite);
      expect(await sendTx(request())).toEqual({ sessionId: 's', projectId: 'p' });
      const sql = "DELETE FROM project_members WHERE subject_kind='account'";
      if (worker) await worker.send('exec', { sql }); else sqlite.exec(sql);
      await expect(sendTx(request({ id: 'denied' }))).rejects.toThrow('[FORBIDDEN]');
      const count = worker ? await worker.send('queryOne', { sql: 'SELECT COUNT(*) AS n FROM sessions' })
        : sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get();
      expect(count).toEqual({ n: 1 });
    } finally { if (worker) await worker.close(); }
  });

});
