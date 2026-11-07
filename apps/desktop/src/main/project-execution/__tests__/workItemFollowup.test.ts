/**
 * S integration: 执行后续（继续 / 批准 / 排队 / 换模型）跑真实迁移库 + 生产 IPC handler。
 *
 * Bug/规则依据（本片要证明的规则）:
 *   - 继续/排队只向**同一个执行会话**追加一条输入，历史保留、不新开任务；
 *   - 每个动作独立幂等键 `project-workitem-followup:v1:<摘要>:<动作>:<round>`，
 *     同动作重试与连点复用同一个键（只投递一次），动作不同键不同；
 *   - `unknown` 下四个动作全部禁用，只提示对账；
 *   - 批准只在真的有待确认项时可用，并把「谁批的 / 批的哪一条 / 当时执行状态」
 *     写进该次委派已有的快照（不新开表）；
 *   - 换模型只改后续回合，失败只报真实原因（不回退默认模型、不换账号）；
 *   - 可用性与待确认项每次都从真实行读，刷新即重读。
 * Existing coverage gap: 入口只覆盖一次性投递，后续四个动作与它们的幂等键、
 * 状态门槛、批准审计、换模型失败语义都没有任何可观察结果。
 * Minimal failure input: 连点同一动作 / phase=unknown / 繁忙时排队 / 有待确认项 /
 * 换模型被宿主拒绝 / 完成态再继续。
 * Tier S: 真实迁移 SQLite + 真实 IPC 面；模型回合本身是忠实的 dispatch 替身。
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
  PROJECT_WORK_ITEM_EXECUTION_FOLLOWUP_CHANNEL,
  PROJECT_WORK_ITEM_EXECUTION_READ_CHANNEL,
  WORK_ITEM_FOLLOWUP_CLIENT_ID_PREFIX,
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
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => 'local:owner:0',
  isAppSessionBoundaryPending: () => false,
  getActiveAppSession: () => ({ mode: 'local', dataOwnerId: 'owner', generation: 0 }),
}));

let db: Database.Database;
let dir: string;
let client: DbClient;
let dispatch: ReturnType<typeof vi.fn>;
let busy: Set<string>;
let queuedIds: Set<string>;
let approve: ReturnType<typeof vi.fn>;
let setSessionModel: ReturnType<typeof vi.fn>;

const read = (request: unknown = { projectId: 'p' }) =>
  h.handlers.get(PROJECT_WORK_ITEM_EXECUTION_READ_CHANNEL)!({}, request);
const followup = (intent: Record<string, unknown>) =>
  h.handlers.get(PROJECT_WORK_ITEM_EXECUTION_FOLLOWUP_CHANNEL)!({}, intent);
const item = async () =>
  ((await read()) as { items: Array<Record<string, unknown>> }).items[0] as {
    state: string;
    followup: {
      busy: boolean;
      pending: { requestId: string; kind: string; summary: string } | null;
      model: { current: string; providerId: string | null; agentKind: string } | null;
      actions: Record<string, { allowed: boolean; reason: string | null }>;
    };
  };

const messages = (sessionId: string) =>
  db.prepare('SELECT client_id, role, content FROM messages WHERE session_id=? ORDER BY rowid').all(sessionId) as Array<{
    client_id: string;
    role: string;
    content: string;
  }>;

const delegation = (status: string, pending: Record<string, unknown> | null = null) =>
  db
    .prepare(
      `INSERT INTO bot_delegations(id,requesting_bot_id,target_bot_id,child_session_id,objective,status,pending_interaction_json,permission_snapshot_json,created_at,updated_at)
       VALUES (?,?,NULL,'w1','ship it',?,?, '{}',1,1)`,
    )
    .run('d1', 'bot1', status, pending ? JSON.stringify(pending) : null);

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-workitem-followup-S-'));
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
  busy = new Set();
  queuedIds = new Set();
  db.exec(`DELETE FROM messages; DELETE FROM bot_task_followup_requests; DELETE FROM bot_delegations;
    DELETE FROM bot_profiles; DELETE FROM project_members; DELETE FROM projects; DELETE FROM sessions;
    INSERT INTO projects(id,name,owner_id,status,created_at,updated_at) VALUES ('p','Fixture','owner','active',1,1);
    INSERT INTO project_members(project_id,subject_kind,subject_id,role,added_at) VALUES
      ('p','account','owner','owner',1), ('p','bot','bot1','member',1);
    INSERT INTO sessions(id,title,status,project_id,project_binding_revision,assignee_kind,assignee_id,
      agent_kind,model,provider_id,created_at,updated_at)
      VALUES ('w1','Ship the parser','active','p',3,'bot','bot1','cc','model-a','p1',1,1);
    INSERT INTO sessions(id,title,status,source,created_at,updated_at) VALUES ('c1','Nova','active','bot',1,1);
    INSERT INTO bot_profiles(id,display_name,status,canonical_session_id,created_at,updated_at)
      VALUES ('bot1','Nova','active','c1',1,1);`);
  // 忠实替身：一个 client id 一行消息；同一个键第二次派发不再开回合。
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
    const queued = busy.has(input.targetSessionId);
    if (queued) {
      // 繁忙：同一个键只进队列一次（与真实协调器的 clientId 去重一致），不产生回合。
      if (queuedIds.has(input.clientId))
        return { ok: true, targetSessionId: input.targetSessionId, wakeKind: 'already-active' };
      queuedIds.add(input.clientId);
      return { ok: true, targetSessionId: input.targetSessionId, wakeKind: 'queued', queuedMessageId: input.clientId };
    }
    db.prepare(
      `INSERT INTO messages(id,client_id,session_id,role,content,created_at) VALUES (?,?,?,'user',?,?)`,
    ).run(`m-${input.clientId}`, input.clientId, input.targetSessionId,
      JSON.stringify({ text: input.persistedContent }), 1_700_000_000_000);
    return { ok: true, targetSessionId: input.targetSessionId, wakeKind: 'created' };
  });
  approve = vi.fn(({ sessionId, requestId }: { sessionId: string; requestId: string }) => {
    // 真实解析器成功后会由生命周期观察者把 waiting 行收敛；这里照同一结果。
    const found = db
      .prepare("SELECT 1 AS ok FROM bot_delegations WHERE child_session_id=? AND status='waiting' AND pending_interaction_json LIKE ?")
      .get(sessionId, `%${requestId}%`);
    if (!found) return { accepted: false };
    db.prepare("UPDATE bot_delegations SET status='running', pending_interaction_json=NULL WHERE child_session_id=?")
      .run(sessionId);
    return { accepted: true };
  });
  setSessionModel = vi.fn(async ({ sessionId, model }: { sessionId: string; model: string }) => {
    db.prepare('UPDATE sessions SET model=? WHERE id=?').run(model, sessionId);
    return { ok: true as const, status: 'applied' as const, model, providerId: 'p1' };
  });
  setOwnerTurnDispatch(
    Object.assign(dispatch as never, {
      readSessionBusy: (sessionId: string) => busy.has(sessionId),
      readQueuedPosition: (sessionId: string, clientId: string) => {
        void sessionId;
        // 宿主回执里的位置：只对真的排在本会话队列里的 id 给出位置。
        return queuedIds.has(clientId) ? 3 : null;
      },
      approveInteraction: approve,
      setSessionModel,
    }),
  );
  client = {
    query: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
    queryOne: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params),
    exec: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
  } as unknown as DbClient;
  setCurrentDbClient(client, 'owner');
});
afterEach(() => clearCurrentDbClient());
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('S work-item execution follow-ups', () => {
  it('F1 continues in the same execution session and keeps its history', async () => {
    delegation('completed');
    db.prepare(`INSERT INTO messages(id,client_id,session_id,role,content,created_at)
      VALUES ('old','old-turn','w1','assistant','{"text":"done"}',1)`).run();
    expect((await item()).followup.actions.continue).toEqual({ allowed: true, reason: null });

    const result = (await followup({ projectId: 'p', sessionId: 'w1', action: 'continue', text: 'Handle the retry path.' })) as {
      ok: boolean;
      requestKey: string;
      requestRound: number;
      wakeKind: string;
    };
    expect(result).toMatchObject({ ok: true, requestRound: 0, wakeKind: 'created' });
    expect(result.requestKey).toMatch(
      new RegExp(`^${WORK_ITEM_FOLLOWUP_CLIENT_ID_PREFIX}[a-f0-9]{32}:continue:0$`),
    );
    // 同一个会话追加一条输入：不新开任务，旧历史仍在。
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0][0] as { targetSessionId: string }).targetSessionId).toBe('w1');
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE project_id='p' AND id<>'w1' AND id<>'c1'").get() as { n: number }).n,
    ).toBe(0);
    expect(messages('w1').map((row) => row.client_id)).toEqual(['old-turn', result.requestKey]);
    expect((dispatch.mock.calls[0][0] as { message: string }).message).toContain('Handle the retry path.');
  });

  it('F2 disables all four actions on an unknown outcome and never sends or changes anything', async () => {
    delegation('queued', null);
    db.exec(`INSERT INTO bot_task_followup_requests(task_id,requester_bot_id,key_digest,body_digest,input_id,admitted_run_sequence,child_session_id,phase,created_at,updated_at)
      VALUES ('d1','bot1','k','b','i1',1,'w1','unknown',1,1)`);
    busy.add('w1');
    const entry = await item();
    expect(entry.state).toBe('unknown');
    for (const action of ['continue', 'approve', 'queue', 'model'] as const)
      expect(entry.followup.actions[action]).toEqual({ allowed: false, reason: 'OUTCOME_UNKNOWN' });
    for (const intent of [
      { projectId: 'p', sessionId: 'w1', action: 'continue' },
      { projectId: 'p', sessionId: 'w1', action: 'approve' },
      { projectId: 'p', sessionId: 'w1', action: 'queue' },
      { projectId: 'p', sessionId: 'w1', action: 'model', model: 'model-b', providerId: 'p1' },
    ])
      expect(await followup(intent)).toMatchObject({
        ok: false,
        code: 'FOLLOWUP_UNAVAILABLE',
        reason: 'OUTCOME_UNKNOWN',
      });
    expect(dispatch).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    expect(setSessionModel).not.toHaveBeenCalled();
  });

  it('F3 queues into the busy task and reports the real queue position', async () => {
    delegation('running', null);
    busy.add('w1');
    expect((await item()).followup.actions.queue).toEqual({ allowed: true, reason: null });
    const first = (await followup({ projectId: 'p', sessionId: 'w1', action: 'queue' })) as {
      ok: boolean;
      wakeKind: string;
      queuedPosition: number | null;
      requestKey: string;
      replayed: boolean;
    };
    expect(first).toMatchObject({ ok: true, wakeKind: 'queued', queuedPosition: 3, replayed: false });
    expect(first.requestKey).toMatch(
      new RegExp(`^${WORK_ITEM_FOLLOWUP_CLIENT_ID_PREFIX}[a-f0-9]{32}:queue:0$`),
    );
    // 同一动作再点一次：同一个键，宿主按 clientId 去重，队列里只有一条。
    const again = (await followup({ projectId: 'p', sessionId: 'w1', action: 'queue' })) as {
      requestKey: string;
      replayed: boolean;
      queuedPosition: number | null;
    };
    expect(again.requestKey).toBe(first.requestKey);
    expect(again.replayed).toBe(true);
    expect(again.queuedPosition).toBe(3);
    expect(queuedIds.size).toBe(1);
    // 排队不是新回合：会话里没有多出来的消息行。
    expect(messages('w1')).toEqual([]);
  });

  it('F4 approves the real pending item and records who approved what, in which state', async () => {
    const pending = {
      requestId: 'r-perm-1',
      kind: 'permission',
      summary: 'Allow npm install',
      raisedAt: 1_700_000_000_000,
    };
    delegation('waiting', pending);
    const entry = await item();
    expect(entry.state).toBe('running');
    expect(entry.followup.pending).toMatchObject({ requestId: 'r-perm-1', kind: 'permission' });
    expect(entry.followup.actions.approve).toEqual({ allowed: true, reason: null });

    const result = (await followup({ projectId: 'p', sessionId: 'w1', action: 'approve' })) as {
      ok: boolean;
      approval: Record<string, unknown>;
    };
    expect(result).toMatchObject({
      ok: true,
      approval: {
        requestId: 'r-perm-1',
        kind: 'permission',
        summary: 'Allow npm install',
        action: 'approve',
        actorKind: 'account',
        actorId: 'owner',
        executionState: 'running',
        projectId: 'p',
        sessionId: 'w1',
      },
    });
    expect(approve).toHaveBeenCalledWith({ sessionId: 'w1', requestId: 'r-perm-1', kind: 'permission' });
    // 审计写进该次委派已有的快照，没有新表。
    const snapshot = JSON.parse(
      (db.prepare("SELECT permission_snapshot_json AS json FROM bot_delegations WHERE id='d1'").get() as { json: string }).json,
    ) as { executionApprovals: Array<Record<string, unknown>> };
    expect(snapshot.executionApprovals).toHaveLength(1);
    expect(snapshot.executionApprovals[0]).toMatchObject({
      requestId: 'r-perm-1',
      actorId: 'owner',
      executionState: 'running',
    });
  });

  it('F4c approves only the confirmation of this work item, never a sibling execution', async () => {
    db.exec(`INSERT INTO sessions(id,title,status,project_id,project_binding_revision,assignee_kind,assignee_id,
      agent_kind,model,provider_id,created_at,updated_at)
      VALUES ('w2','Second item','active','p',3,'bot','bot1','cc','model-a','p1',1,1);
      INSERT INTO bot_delegations(id,requesting_bot_id,target_bot_id,child_session_id,objective,status,created_at,updated_at)
        VALUES ('d1','bot1',NULL,'w1','ship it','waiting',1,1),
               ('d2','bot1',NULL,'w2','ship the other','waiting',1,1);`);
    db.prepare("UPDATE bot_delegations SET pending_interaction_json=? WHERE id='d1'").run(
      JSON.stringify({ requestId: 'r1', kind: 'permission', summary: 'Allow w1', raisedAt: 1 }),
    );
    db.prepare("UPDATE bot_delegations SET pending_interaction_json=? WHERE id='d2'").run(
      JSON.stringify({ requestId: 'r2', kind: 'permission', summary: 'Allow w2', raisedAt: 1 }),
    );
    expect(await followup({ projectId: 'p', sessionId: 'w1', action: 'approve' })).toMatchObject({
      ok: true,
      approval: { requestId: 'r1', sessionId: 'w1' },
    });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0][0]).toMatchObject({ sessionId: 'w1', requestId: 'r1' });
    // 兄弟工作项自己的确认仍然挂着，没有被这次批准连带处理。
    expect(
      (db.prepare("SELECT status FROM bot_delegations WHERE id='d2'").get() as { status: string }).status,
    ).toBe('waiting');
  });

  it('F4b refuses to approve a question, and refuses when the confirmation disappeared', async () => {
    delegation('waiting', { requestId: 'r-ask', kind: 'ask_user_question', summary: 'Which env?', raisedAt: 1 });
    const entry = await item();
    expect(entry.followup.actions.approve).toEqual({
      allowed: false,
      reason: 'CONFIRMATION_NOT_APPROVABLE',
    });
    expect(await followup({ projectId: 'p', sessionId: 'w1', action: 'approve' })).toMatchObject({
      ok: false,
      reason: 'CONFIRMATION_NOT_APPROVABLE',
    });
    expect(approve).not.toHaveBeenCalled();

    db.exec("UPDATE bot_delegations SET pending_interaction_json=NULL WHERE id='d1'");
    expect((await item()).followup.actions.approve).toEqual({
      allowed: false,
      reason: 'NO_PENDING_CONFIRMATION',
    });
  });

  it('F5 changes only the following turns model, and leaves history untouched', async () => {
    delegation('completed');
    db.prepare(`INSERT INTO messages(id,client_id,session_id,role,content,created_at,agent_meta)
      VALUES ('old','old-turn','w1','assistant','{"text":"done"}',1,'{"model":"model-a"}')`).run();
    const before = messages('w1');
    const result = (await followup({
      projectId: 'p',
      sessionId: 'w1',
      action: 'model',
      model: 'model-b',
      providerId: 'p1',
    })) as { ok: boolean; model: { status: string; model: string } };
    expect(result).toMatchObject({ ok: true, model: { status: 'applied', model: 'model-b' } });
    expect(setSessionModel).toHaveBeenCalledTimes(1);
    expect(setSessionModel).toHaveBeenCalledWith({ sessionId: 'w1', model: 'model-b', providerId: 'p1' });
    // 历史消息与它们的模型记录都没有被改写。
    expect(messages('w1')).toEqual(before);
    expect((await item()).followup.model).toMatchObject({ current: 'model-b', providerId: 'p1' });
  });

  it('F6 reports the real model failure without falling back to a default model', async () => {
    delegation('completed');
    setSessionModel.mockImplementationOnce(async () => ({
      ok: false as const,
      message: 'the agent is still working; change the model after this turn',
    }));
    const result = (await followup({
      projectId: 'p',
      sessionId: 'w1',
      action: 'model',
      model: 'model-b',
      providerId: 'p1',
    })) as { ok: false; code: string; message: string };
    expect(result).toMatchObject({
      ok: false,
      code: 'MODEL_CHANGE_FAILED',
      message: 'the agent is still working; change the model after this turn',
    });
    // 只试了用户点的那一个模型：没有回退、没有换账号、没有重试。
    expect(setSessionModel).toHaveBeenCalledTimes(1);
    expect((db.prepare("SELECT model FROM sessions WHERE id='w1'").get() as { model: string }).model).toBe('model-a');
  });

  it('F7 double-clicking the same action keeps one key and one delivery, then advances after a real reply', async () => {
    delegation('completed');
    const first = (await followup({ projectId: 'p', sessionId: 'w1', action: 'continue' })) as {
      requestKey: string;
      replayed: boolean;
    };
    const second = (await followup({ projectId: 'p', sessionId: 'w1', action: 'continue' })) as {
      requestKey: string;
      replayed: boolean;
    };
    expect(second.requestKey).toBe(first.requestKey);
    expect(second.replayed).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE client_id=?').get(first.requestKey) as { n: number }).n,
    ).toBe(1);
    // 动作不同则键不同：批准/换模型不是同一件事。
    const different = ((await followup({ projectId: 'p', sessionId: 'w1', action: 'queue' })) as {
      requestKey: string;
    }).requestKey;
    expect(different).not.toBe(first.requestKey);

    // 目标会话已经产出内容 = 上一轮被消费，下一次「继续」才是新的一轮。
    db.prepare(`INSERT INTO messages(id,client_id,session_id,role,content,created_at)
      VALUES ('reply','reply-1','w1','assistant','{"text":"ok"}',1700000000001)`).run();
    const third = (await followup({ projectId: 'p', sessionId: 'w1', action: 'continue' })) as {
      requestKey: string;
      requestRound: number;
    };
    expect(third.requestRound).toBe(1);
    expect(third.requestKey).not.toBe(first.requestKey);
  });

  it('F7b changing the instruction in the same round creates a new intent key, never a silent no-op', async () => {
    delegation('completed');
    const first = (await followup({
      projectId: 'p',
      sessionId: 'w1',
      action: 'continue',
      text: 'Handle the retry path.',
    })) as { ok: true; requestKey: string; requestRound: number; replayed: boolean };
    expect(first).toMatchObject({ ok: true, requestRound: 0, replayed: false });

    // 同一动作、同一 round，但内容是 B：必须是新意图、新键、真的再投一次。
    const changed = (await followup({
      projectId: 'p',
      sessionId: 'w1',
      action: 'continue',
      text: 'Handle the cancellation path.',
    })) as { ok: true; requestKey: string; requestRound: number; replayed: boolean };
    expect(changed).toMatchObject({ ok: true, requestRound: 0, replayed: false });
    expect(changed.requestKey).not.toBe(first.requestKey);
    expect(dispatch).toHaveBeenCalledTimes(2);
    const delivered = messages('w1').map((row) => JSON.parse(row.content).text);
    expect(delivered).toEqual(['Handle the retry path.', 'Handle the cancellation path.']);

    // 原样再点 B：同一个键，不再多投一次。
    const again = (await followup({
      projectId: 'p',
      sessionId: 'w1',
      action: 'continue',
      text: 'Handle the cancellation path.',
    })) as { requestKey: string; replayed: boolean };
    expect(again.requestKey).toBe(changed.requestKey);
    expect(again.replayed).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(messages('w1')).toHaveLength(2);
  });

  it('F7c refuses to report a different stored instruction as delivered under the same key', async () => {
    delegation('completed');
    // 先正常投递一次，拿到真实键。
    const first = (await followup({ projectId: 'p', sessionId: 'w1', action: 'continue' })) as {
      requestKey: string;
    };
    // 把那一行的内容换成别的东西（模拟摘要碰撞或别的写入方复用同键），再原样点一次：
    // 宿主的 clientId 去重会回 already-active，此处必须报冲突而不是「已投递」。
    db.prepare("UPDATE messages SET content=? WHERE client_id=?")
      .run(JSON.stringify({ text: 'A different instruction' }), first.requestKey);
    const conflict = (await followup({ projectId: 'p', sessionId: 'w1', action: 'continue' })) as {
      ok: false;
      code: string;
      requestKey: string;
      message: string;
    };
    expect(conflict).toMatchObject({ ok: false, code: 'IDEMPOTENCY_CONFLICT', requestKey: first.requestKey });
    expect(conflict.message).toContain('different instruction');
    // 没有因为这次调用多出任何一行。
    expect(messages('w1')).toHaveLength(1);
  });

  it('F8 every read is a fresh read: availability follows the real rows', async () => {
    delegation('completed', null);
    expect((await item()).followup.actions.continue.allowed).toBe(true);
    // 伙伴自己又跑了起来 → 继续不再可用，排队可用。
    db.exec("UPDATE bot_delegations SET status='running' WHERE id='d1'");
    busy.add('w1');
    const running = await item();
    expect(running.followup.actions.continue).toEqual({ allowed: false, reason: 'NO_TERMINAL_EXECUTION' });
    expect(running.followup.actions.queue.allowed).toBe(true);
    // 执行会话消失（工作项被删）→ 条目不再出现，而不是留着「已完成」。
    db.exec("UPDATE sessions SET status='deleted' WHERE id='w1'");
    expect(((await read()) as { items: unknown[] }).items).toHaveLength(0);
  });

  it('rejects renderer-supplied identity, keys and model overrides on the model action', async () => {
    delegation('completed');
    await expect(
      followup({ projectId: 'p', sessionId: 'w1', action: 'continue', requestKey: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      followup({ projectId: 'p', sessionId: 'w1', action: 'continue', model: 'model-b' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      followup({ projectId: 'p', sessionId: 'w1', action: 'approve', text: 'yes' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    h.trusted = false;
    await expect(followup({ projectId: 'p', sessionId: 'w1', action: 'continue' })).rejects.toThrow(
      'UNTRUSTED_RENDERER',
    );
    expect(dispatch).not.toHaveBeenCalled();
  });
});
