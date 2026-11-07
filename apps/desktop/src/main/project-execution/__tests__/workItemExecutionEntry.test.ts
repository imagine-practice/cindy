/**
 * S integration: real migrated SQLite + production IPC handlers + the production preload adapter.
 *
 * Bug/rule basis（本片要证明的规则）:
 *   - 执行者只能是工作项处理人（伙伴）；空处理人不得回退负责人或默认伙伴。
 *   - 同一工作项同一意图只投递一次：请求键随消息行落库，重试复用同一键、不开新回合。
 *   - 六档状态只来自真实行（bot_delegations / 0152 bot_task_followup_requests / 投递消息行），
 *     投递 ≠ 受理 ≠ 完成；未知只能对账，不得重发。
 *   - 投递失败可重试且复用同一键；终态后显式重新发起才生成新键。
 * Existing coverage gap: nothing reads the execution projection or the delivery key, so these
 * outcomes (no executor, duplicate turn, unknown resent, new key after failure) were unobservable.
 * Minimal failure input: no assignee / second click / phase=unknown / dispatch failure.
 * Tier S: real IPC seam + real SQLite; the model turn itself is a faithful dispatch double.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBetterSqliteDatabase } from '../../localDb/betterSqliteFactory';
import { runMigrationReplay } from '../../localDb/migrationRunner';
import { setCurrentDbClient, clearCurrentDbClient } from '../../localDb/client/current';
import type { DbClient } from '../../localDb/client/DbClient';
import {
  PROJECT_WORK_ITEM_EXECUTION_READ_CHANNEL,
  PROJECT_WORK_ITEM_EXECUTION_REQUEST_CHANNEL,
} from '../../../shared/projectWorkItemExecutionRequest';
import { registerProjectWorkItemExecutionIpc } from '../entry';
import { setOwnerTurnDispatch } from '../../maker-ipc/ownerTurnDispatch';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  trusted: true,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      h.handlers.set(channel, handler),
  },
}));
vi.mock('../../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: () => {
    if (!h.trusted) throw new Error('UNTRUSTED_RENDERER');
  },
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// Owner-scope seam only: epoch bookkeeping itself is covered by existing app-session tests.
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => 'local:owner:0',
  isAppSessionBoundaryPending: () => false,
  getActiveAppSession: () => ({ mode: 'local', dataOwnerId: 'owner', generation: 0 }),
}));

let db: Database.Database;
let dir: string;
let client: DbClient;
let dispatch: ReturnType<typeof vi.fn>;

const read = (request: unknown = { projectId: 'p' }) =>
  h.handlers.get(PROJECT_WORK_ITEM_EXECUTION_READ_CHANNEL)!({}, request);
const request = (intent: unknown = { projectId: 'p', sessionId: 'w1' }) =>
  h.handlers.get(PROJECT_WORK_ITEM_EXECUTION_REQUEST_CHANNEL)!({}, intent);
const item = async () => ((await read()) as { items: Array<Record<string, unknown>> }).items[0];

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-workitem-exec-S-'));
  db = createBetterSqliteDatabase(path.join(dir, 'fixture.db'));
  const desktop = path.resolve(__dirname, '../../../..');
  db.loadExtension(
    path.join(
      desktop,
      'native/sqlite-vec',
      `${process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib',
    ),
  );
  runMigrationReplay(db, { drizzleDir: path.join(desktop, 'drizzle') });
  registerProjectWorkItemExecutionIpc();
});

beforeEach(() => {
  vi.clearAllMocks();
  h.trusted = true;
  db.exec(`DELETE FROM messages; DELETE FROM bot_task_followup_requests; DELETE FROM bot_delegations;
    DELETE FROM bot_profiles; DELETE FROM project_members; DELETE FROM projects; DELETE FROM sessions;
    INSERT INTO projects(id,name,owner_id,status,created_at,updated_at) VALUES ('p','Fixture','owner','active',1,1);
    INSERT INTO project_members(project_id,subject_kind,subject_id,role,added_at) VALUES
      ('p','account','owner','owner',1), ('p','bot','bot1','member',1);
    INSERT INTO sessions(id,title,status,project_id,project_binding_revision,assignee_kind,assignee_id,created_at,updated_at)
      VALUES ('w1','Ship the parser','active','p',3,'bot','bot1',1,1);
    INSERT INTO sessions(id,title,status,source,created_at,updated_at) VALUES ('c1','Nova','active','bot',1,1);
    INSERT INTO bot_profiles(id,display_name,status,canonical_session_id,created_at,updated_at)
      VALUES ('bot1','Nova','active','c1',1,1);`);
  // Faithful dispatch double: one message row per client id, a duplicate key never opens a turn.
  dispatch = vi.fn(async (input: {
    targetSessionId: string;
    clientId: string;
    message: string;
    persistedContent: string;
    authorizationGuard?: { validate(): Promise<void>; assertCurrent(): void };
  }) => {
    await input.authorizationGuard?.validate();
    const existing = db
      .prepare('SELECT 1 AS ok FROM messages WHERE session_id=? AND client_id=?')
      .get(input.targetSessionId, input.clientId);
    if (existing) return { ok: true, targetSessionId: input.targetSessionId, wakeKind: 'already-active' };
    db.prepare(
      `INSERT INTO messages(id,client_id,session_id,role,content,created_at) VALUES (?,?,?,'user',?,?)`,
    ).run(`m-${input.clientId}`, input.clientId, input.targetSessionId,
      JSON.stringify({ text: input.persistedContent }), 1_700_000_000_000);
    return { ok: true, targetSessionId: input.targetSessionId, wakeKind: 'created' };
  });
  setOwnerTurnDispatch(dispatch as never);
  client = {
    query: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
    queryOne: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params),
  } as unknown as DbClient;
  setCurrentDbClient(client, 'owner');
});
afterEach(() => clearCurrentDbClient());
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('S project work-item execution entry', () => {
  it('disables the entry when the assignee is empty or not a teammate, without any turn', async () => {
    db.exec("UPDATE sessions SET assignee_kind=NULL, assignee_id=NULL WHERE id='w1'");
    expect(await item()).toMatchObject({
      sessionId: 'w1', executor: null, state: 'none',
      unavailableReason: 'UNASSIGNED', canRequest: false,
    });
    expect(await request()).toMatchObject({ ok: false, code: 'UNASSIGNED' });

    // The project owner is an account, never a fallback executor.
    db.exec("UPDATE sessions SET assignee_kind='account', assignee_id='owner' WHERE id='w1'");
    expect(await item()).toMatchObject({ executor: null, unavailableReason: 'ASSIGNEE_NOT_BOT' });
    expect(await request()).toMatchObject({ ok: false, code: 'ASSIGNEE_NOT_BOT' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('delivers exactly once: the stored key is reused and replayed without another turn', async () => {
    const first = await request();
    expect(first).toMatchObject({ ok: true, state: 'requested', replayed: false, requestRound: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const key = (first as { requestKey: string }).requestKey;
    expect(key).toMatch(/^project-workitem-execute:v1:[a-f0-9]{32}:0$/);
    // The prompt carries the locator and revision, and asks the teammate to read them itself.
    const sent = dispatch.mock.calls[0][0] as { message: string };
    expect(sent.message).toContain('"w1"');
    expect(sent.message).toContain('get_project_progress');
    expect(sent.message).toContain('execute_project_work_item');

    expect(await item()).toMatchObject({ state: 'requested', requestKey: key, canRequest: false });
    const second = await request();
    expect(second).toMatchObject({ ok: true, replayed: true, requestKey: key, requestRound: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE client_id=?").get(key) as { n: number }).n,
    ).toBe(1);
  });

  it('keeps delivered, accepted, running and completed apart, from real rows only', async () => {
    await request();
    expect(await item()).toMatchObject({ state: 'requested', delegationId: null });
    db.exec(`INSERT INTO bot_delegations(id,requesting_bot_id,target_bot_id,child_session_id,objective,status,accepted_at,created_at,updated_at)
      VALUES ('d1','bot1','bot1','w1','ship it','queued',2,1,1)`);
    db.exec(`INSERT INTO bot_task_followup_requests(task_id,requester_bot_id,key_digest,body_digest,input_id,admitted_run_sequence,child_session_id,phase,created_at,updated_at)
      VALUES ('d1','bot1','k','b','i1',1,'w1','admitted',1,1)`);
    expect(await item()).toMatchObject({ state: 'accepted', delegationId: 'd1' });
    db.exec("UPDATE bot_delegations SET status='running' WHERE id='d1'");
    expect(await item()).toMatchObject({ state: 'running' });
    db.exec("UPDATE bot_delegations SET status='completed' WHERE id='d1'");
    expect(await item()).toMatchObject({ state: 'completed', canRequest: true });
    db.exec("UPDATE bot_delegations SET status='failed' WHERE id='d1'");
    expect(await item()).toMatchObject({ state: 'failed', canRequest: true });
  });

  it('never resends an unknown outcome: reconcile only, key kept for the original request', async () => {
    const first = await request();
    const key = (first as { requestKey: string }).requestKey;
    db.exec(`INSERT INTO bot_delegations(id,requesting_bot_id,target_bot_id,child_session_id,objective,status,created_at,updated_at)
      VALUES ('d1','bot1','bot1','w1','ship it','queued',1,1)`);
    db.exec(`INSERT INTO bot_task_followup_requests(task_id,requester_bot_id,key_digest,body_digest,input_id,admitted_run_sequence,child_session_id,phase,created_at,updated_at)
      VALUES ('d1','bot1','k','b','i1',1,'w1','unknown',1,1)`);
    expect(await item()).toMatchObject({ state: 'unknown', canRequest: false, requestKey: key });
    expect(await request()).toMatchObject({ ok: false, code: 'OUTCOME_UNKNOWN', requestKey: key });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('retries a failed delivery with the same key, and only a fresh start after a terminal one', async () => {
    dispatch.mockImplementationOnce(async () => ({ ok: false, message: 'teammate is not ready' }));
    expect(await request()).toMatchObject({ ok: false, code: 'DISPATCH_FAILED', requestKey: null });
    expect(await item()).toMatchObject({ state: 'none', canRequest: true, requestKey: null });
    const retry = await request();
    expect(retry).toMatchObject({ ok: true, replayed: false, requestRound: 0 });
    const firstKey = (retry as { requestKey: string }).requestKey;
    expect(firstKey).toMatch(/^project-workitem-execute:v1:[a-f0-9]{32}:0$/);
    expect(dispatch).toHaveBeenCalledTimes(2);

    // Terminal failure + explicit new start = next round (new key, new turn).
    db.exec(`INSERT INTO bot_delegations(id,requesting_bot_id,target_bot_id,child_session_id,objective,status,created_at,updated_at)
      VALUES ('d1','bot1','bot1','w1','ship it','failed',1,1)`);
    expect(await item()).toMatchObject({ state: 'failed', canRequest: true });
    const restart = await request();
    expect(restart).toMatchObject({ ok: true, replayed: false, requestRound: 1 });
    expect((restart as { requestKey: string }).requestKey).not.toBe(firstKey);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it('rejects renderer-supplied identity and untrusted sources before any delivery', async () => {
    await expect(request({ projectId: 'p', sessionId: 'w1', targetBotId: 'bot1' }))
      .rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    db.exec("DELETE FROM project_members WHERE subject_kind='account' AND subject_id='owner'");
    await expect(read()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    h.trusted = false;
    await expect(request()).rejects.toThrow('UNTRUSTED_RENDERER');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
