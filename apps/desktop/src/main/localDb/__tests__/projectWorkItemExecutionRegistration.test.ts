/** DB tier: real DbClient -> inproc/native file-worker -> formal 0152 SQLite.
 * Gap: adoption's controlled transact callback cannot detect a missing worker case.
 * Minimal input: admit an existing task, lose its ACK, reopen the client and inspect
 * the original request. Preserve the Session, reject stale binding/ACL and never
 * infer permission to dispatch from a durable pending/unknown receipt. No provider.
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createDbClient, createInprocDbClient, type DbClient } from '../client/DbClient';
import { buildDbWorkerBundle } from './dbWorkerTestUtils';
import { createJointFollowupDb, openJointFollowupDb } from '../ipc/__tests__/jointFollowupMigration.fixture';
import type { ProjectWorkItemExecutionRequest, ProjectWorkItemExecutionResult } from '../../../shared/projectWorkItemExecution';

const h = vi.hoisted(() => ({ db: undefined as Database.Database | undefined }));
vi.mock('../index', () => ({ getRawDb: () => h.db, getDrizzle: () => drizzle(h.db!), ensureReady: async () => ({ ready: true }) }));
vi.mock('../../logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));

const root = path.resolve(__dirname, '../../../..');
let dir: string, template: string, workerScriptPath: string;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
beforeAll(async () => {
  vi.stubEnv('XDT_DB_INPROC', 'false');
  dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-workitem-registration-'));
  template = path.join(dir, 'formal-0152.sqlite');
  createJointFollowupDb(dir, template).close();
  workerScriptPath = await buildDbWorkerBundle(path.join(dir, 'worker-build'));
});
afterAll(() => {
  vi.unstubAllEnvs();
  if (dir && path.dirname(dir) === os.tmpdir() && path.basename(dir).startsWith('cindy-workitem-registration-')) rmSync(dir, { recursive: true, force: true });
});

for (const mode of ['inproc', 'file-worker'] as const) {
  it(`${mode}: original-key recovery preserves the existing Session and rechecks ACL/binding`, async () => {
    const file = path.join(dir, `${mode}.sqlite`); copyFileSync(template, file);
    const db = openJointFollowupDb(file); h.db = db;
    db.exec(`INSERT INTO sessions(id,title,source,status,working_dir,permission_mode,created_at,updated_at)
      VALUES ('caller','Bot lane','bot','active','/fixture/caller','ask',1,1),('work','Original title','desktop','active','/fixture/work','ask',1,1);
      INSERT INTO bot_profiles(id,display_name,canonical_session_id,created_at,updated_at) VALUES ('executor','Executor','caller',1,1);
      INSERT INTO bot_session_links(id,bot_id,session_id,role,created_at) VALUES ('lane','executor','caller','canonical',1);
      INSERT INTO projects(id,name,owner_id,status,created_at,updated_at) VALUES ('p','Project','owner','active',1,1);
      INSERT INTO project_members VALUES ('p','account','owner','owner',1),('p','bot','executor','member',1);
      UPDATE sessions SET project_id='p',project_binding_revision=7 WHERE id='work';`);
    const connect = () => mode === 'inproc' ? createInprocDbClient() : createDbClient({ transport: 'worker-thread',
      dbPath: file, drizzleDir: path.join(root, 'drizzle'), workerScriptPath, useInlineWorker: false,
      betterSqliteModulePath: require.resolve('better-sqlite3'),
      sqliteVecExtPath: path.join(root, 'native/sqlite-vec', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib') });
    let client: DbClient = await connect();
    const request = { intent: 'start' as const, callerSessionId: 'caller', targetBotId: 'executor', projectId: 'p', sessionId: 'work',
      expectedBindingRevision: 7, requestId: 'original-key', objective: 'Explicit existing task execution', actor: { kind: 'account' as const, id: 'owner' } };
    const execute = (p: ProjectWorkItemExecutionRequest) => client.tx('bots.adoptProjectWorkItem', p);
    const requireView = (r: ProjectWorkItemExecutionResult) => { expect(r.ok).toBe(true); if (!r.ok) throw new Error(r.errorCode); return r.view; };
    const original = db.prepare('SELECT * FROM sessions ORDER BY id').all();
    try {
      expect(await client.queryOne("SELECT value FROM migration_meta WHERE key='schema_version'")).toEqual({ value: '152' });
      const first = requireView(await execute({ ...request, action: 'inspect' }));
      const plan = JSON.stringify({ permission: { mode: 'ask' }, targetBotId: null, taskInput: { inputId: first.inputId },
        projectWorkItemExecution: { version: 1, projectId: 'p', sessionId: 'work', bindingRevision: 7, targetBotId: 'executor', actor: request.actor } });
      const admit = { ...request, action: 'admit' as const, fingerprint: first.fingerprint, now: 10, maxActiveChildren: 3, permissionSnapshotJson: plan };
      await client.exec("CREATE TRIGGER fail_workitem_ledger BEFORE INSERT ON bot_task_followup_requests BEGIN SELECT RAISE(ABORT,'injected ledger failure'); END");
      await expect(execute(admit)).rejects.toThrow('injected ledger failure');
      expect(db.prepare('SELECT COUNT(*) n FROM bot_delegations').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) n FROM bot_task_followup_requests').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(original);
      await client.exec('DROP TRIGGER fail_workitem_ledger');
      await execute(admit); // Deliberately discard ACK; no dispatch or claim follows it.
      await client.dispose(); client = await connect();
      const recovered = requireView(await execute({ ...request, action: 'inspect' }));
      expect(recovered).toMatchObject({ inputId: first.inputId, delegationId: first.delegationId, phase: 'admitted', receipt: null, existing: true });
      requireView(await execute(admit));
      expect(await execute({ ...admit, requestId: 'new-key-after-lost-ack', requireSettledExisting: true })).toMatchObject({ ok: false, errorCode: 'FOLLOWUP_OUTCOME_UNKNOWN' });
      expect(db.prepare('SELECT COUNT(*) n FROM bot_delegations').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) n FROM bot_task_followup_requests').get()).toEqual({ n: 1 });
      expect(await execute({ ...admit, objective: 'Changed same-key intent' })).toMatchObject({ ok: false, errorCode: 'IDEMPOTENCY_CONFLICT' });
      // Merely admitted is not permission to consume. Claim is a distinct main-only CAS.
      expect(await execute({ ...request, action: 'verify', fingerprint: first.fingerprint })).toMatchObject({ ok: false, errorCode: 'EXECUTION_CHANGED' });
      expect(await client.tx('bots.followupRequest', { action: 'claim', taskId: first.delegationId, inputId: first.inputId, now: 11 })).toMatchObject({ kind: 'claimed' });
      requireView(await execute({ ...request, action: 'verify', fingerprint: first.fingerprint }));
      await client.tx('bots.followupRequest', { action: 'unknown', taskId: first.delegationId, inputId: first.inputId, now: 12 });
      await client.dispose(); client = await connect();
      expect(requireView(await execute({ ...request, action: 'inspect' }))).toMatchObject({ inputId: first.inputId, phase: 'unknown' });
      expect(await client.tx('bots.followupRequest', { action: 'claim', taskId: first.delegationId, inputId: first.inputId, now: 13 })).toMatchObject({ kind: 'request', request: { phase: 'unknown' } });
      expect(await execute({ ...request, action: 'verify', fingerprint: first.fingerprint })).toMatchObject({ ok: false, errorCode: 'EXECUTION_CHANGED' });
      // Same string, other principal kind does not acquire membership.
      expect(await execute({ ...request, actor: { kind: 'bot', id: 'owner' }, action: 'inspect' })).toMatchObject({ ok: false, errorCode: 'FORBIDDEN' });
      await client.exec("DELETE FROM project_members WHERE subject_kind='bot' AND subject_id='executor'");
      expect(await execute({ ...request, action: 'inspect' })).toMatchObject({ ok: false, errorCode: 'FORBIDDEN' });
      await client.exec("INSERT INTO project_members VALUES ('p','bot','executor','member',1)");
      await client.exec("UPDATE sessions SET project_binding_revision=9 WHERE id='work'");
      expect(await execute({ ...request, action: 'inspect' })).toMatchObject({ ok: false, errorCode: 'BINDING_CONFLICT' });
      await client.exec("UPDATE sessions SET project_binding_revision=7 WHERE id='work'");
      expect(db.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(original);
      expect(db.prepare('SELECT COUNT(*) n FROM messages').get()).toEqual({ n: 0 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(await client.tx('bots.followupRequest', { action: 'lookup', taskId: first.delegationId, requesterBotId: 'executor', keyDigest: digest(request.requestId) }))
        .toMatchObject({ kind: 'request', request: { phase: 'unknown', inputId: first.inputId, nativeAcceptedAt: null } });
    } finally { await client.dispose(); db.close(); h.db = undefined; }
  });
}
