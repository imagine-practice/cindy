/**
 * S integration: 真实迁移后的 SQLite + 生产 tx 分发器 + 生产 provider，经
 * `remoteResourceRegistry` 的 4 个既有入口读/写项目（契约
 * `documents/2026-11-11-手机端项目页接口契约.md`）。
 *
 * 为什么不是纯单测：权限矩阵的每一格都必须由**既有事务**（`projects.execute` /
 * `workItemProgress.execute` / `projectProgress.read`）真的拒绝或放行；mock 掉它们
 * 测出来的只是替身。这里只有三处接缝——device-link 广播（tracing 需要 electron）、
 * 本机窗口通知、以及关联群读（它自带 `projectGroupLinksIpc.test.ts` 的授权测试，
 * 与本次投影无关）。
 *
 * 覆盖：list 排序/limit/游标、get 五个 block 形状、禁止字段、负责人/成员/非成员 ×
 * 四个动作逐格、requestId 幂等与并发冲突、未注册集合的旧端行为与协议常量。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: undefined as import('better-sqlite3').Database | undefined,
  scopeCurrent: (): boolean => true,
  tap: vi.fn(),
  groupLinks: undefined as unknown,
}));

vi.mock('electron', () => ({
  app: {
    once: () => {},
    on: () => {},
    getPath: () => os.tmpdir(),
    getVersion: () => '0.0.0',
    isPackaged: false,
  },
  ipcMain: { handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: () => {},
  isTrustedAppRendererWindow: () => true,
}));
vi.mock('../../../device-link/broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: () => ({ generation: 1 }),
  isDataOwnerBroadcastScopeCurrent: () => h.scopeCurrent(),
  tapWindowBroadcast: (...args: unknown[]) => h.tap(...args),
  getSafeDataOwnerPushStamp: () => ({ dataOwnerId: 'owner' }),
}));
vi.mock('../../../logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock('../sessions', () => ({ broadcastSessionPatched: () => {} }));
vi.mock('../sessionOpening', () => ({ openSession: async () => ({ value: { ok: true } }) }));
vi.mock('../authorizedSessionPersistence', () => ({ buildAuthorizedSessionCreate: () => ({ insert: { sql: '', params: [] } }) }));
vi.mock('../sessionCreatedBroadcast', () => ({ emitSessionCreated: () => {} }));
vi.mock('../projectGroupLinks', () => ({
  readProjectGroupLinksByProject: async (raw: { projectId: string }) =>
    (h.groupLinks as (raw: { projectId: string }) => Promise<unknown>)(raw),
}));

import { REMOTE_RESOURCE_CHANNELS, REMOTE_RESOURCE_CHANGED_CHANNEL, REMOTE_RESOURCE_PROTOCOL_VERSION } from '@cindy/device-link';
import { RemoteResourceRegistry, remoteResourceRegistry } from '../../../device-link/remoteResourceRegistry';
import { createBetterSqliteDatabase } from '../../betterSqliteFactory';
import { runMigrationReplay } from '../../migrationRunner';
import { dispatch } from '../../worker/dispatcher';
import { clearCurrentDbClient, setCurrentDbClient } from '../../client/current';
import type { DbClient } from '../../client/DbClient';
import {
  PROJECT_REMOTE_COLLECTION_ID,
  PROJECT_REMOTE_RESOURCE_KIND,
  registerProjectRemoteResourceProvider,
  resetProjectRemoteReceipts,
} from '../projectRemoteResourceProvider';

const OWNER = 'owner-account';
const MEMBER = 'member-account';
const OUTSIDER = 'outsider-account';
const GROUP_ROOM = '8f14e45f-ceea-467a-9f0b-1a27b1a4c3de';
const PROJECT_DIR = 'C:\\Users\\someone\\work\\site';

const context = { controllerDeviceId: 'phone-1' };
const client = (primitives: string[] = []) => ({ protocolVersion: 1, primitives, locale: 'zh-CN' });
const ref = (id: string) => ({ collectionId: PROJECT_REMOTE_COLLECTION_ID, kind: PROJECT_REMOTE_RESOURCE_KIND, id });

let db: Database.Database;
let dir: string;
let dbClient: DbClient;

function sqlite<T>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/** 每个用例都从同一份项目夹具开始，权限矩阵的每一格互不残留。 */
function seed(): void {
  db.exec(`
    DELETE FROM work_item_progress;
    DELETE FROM work_item_progress_events;
    DELETE FROM project_group_links;
    DELETE FROM project_dirs;
    DELETE FROM project_members;
    DELETE FROM sessions;
    DELETE FROM projects;
    DELETE FROM bot_groups;
    DELETE FROM bot_profiles;

    INSERT INTO bot_profiles (id, display_name, created_at, updated_at) VALUES ('bot-1', '小助手', 1, 1);

    INSERT INTO projects (id, name, goal, owner_id, status, created_at, updated_at) VALUES
      ('p1', '官网改版', '把登录页做出来\n第二行不该出现在摘要里', '${OWNER}', 'active', 100, 300),
      ('p2', '旧项目', NULL, '${OWNER}', 'archived', 100, 100),
      ('p3', '内部工具', '批量导出', '${OWNER}', 'active', 100, 200),
      ('p4', '别人的项目', '不该出现', 'other-account', 'active', 100, 400);

    INSERT INTO project_members (project_id, subject_kind, subject_id, role, added_at) VALUES
      ('p1', 'account', '${OWNER}', 'owner', 1),
      ('p1', 'account', '${MEMBER}', 'member', 2),
      ('p1', 'bot', 'bot-1', 'member', 3),
      ('p2', 'account', '${OWNER}', 'owner', 1),
      ('p2', 'account', '${MEMBER}', 'member', 2),
      ('p3', 'account', '${OWNER}', 'owner', 1),
      ('p4', 'account', 'other-account', 'owner', 1);

    INSERT INTO sessions (id, title, task_objective, status, project_id, project_binding_revision, created_at, updated_at) VALUES
      ('s1', '登录页', '把登录页做出来', 'active', 'p1', 0, 100, 250),
      ('s2', '导出接口', '批量导出 CSV', 'active', 'p1', 0, 100, 240),
      ('s3', '别人的任务', '不该出现', 'active', 'p4', 0, 100, 230);

    INSERT INTO project_dirs (project_id, dir_key, dir_path, created_at) VALUES
      ('p1', 'local:${PROJECT_DIR}', '${PROJECT_DIR}', 1);
  `);
  h.groupLinks = async () => ({ ok: true, contractRevision: 1, truncated: false, links: [] });
}

function as(userId: string): void {
  resetProjectRemoteReceipts();
  setCurrentDbClient(dbClient, userId);
}

const list = (options: { limit?: number; cursor?: string } = {}) =>
  remoteResourceRegistry.list(context, { client: client(), collectionId: PROJECT_REMOTE_COLLECTION_ID, ...options });
const get = (id = 'p1') => remoteResourceRegistry.get(context, { client: client(), ref: ref(id) });
const invoke = (actionId: string, input: Record<string, unknown>, projectId = 'p1') =>
  remoteResourceRegistry.invoke(context, {
    client: client(),
    collectionId: PROJECT_REMOTE_COLLECTION_ID,
    actionId,
    resourceRef: ref(projectId),
    input,
  });

const progressEvents = () => sqlite<{ n: number }>('SELECT COUNT(*) AS n FROM work_item_progress_events')[0].n;
const projectRow = (id = 'p1') =>
  sqlite<{ status: string; updatedAt: number }>('SELECT status, updated_at AS updatedAt FROM projects WHERE id = ?', id)[0];

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-project-remote-'));
  db = createBetterSqliteDatabase(path.join(dir, 'fixture.db'));
  const desktop = path.resolve(__dirname, '../../../../..');
  db.loadExtension(path.join(desktop, 'native/sqlite-vec', `${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib'));
  runMigrationReplay(db, { drizzleDir: path.join(desktop, 'drizzle') });
  registerProjectRemoteResourceProvider();
  // 只替换传输层：SQL、权限判据、事务与结果映射都是生产代码。
  dbClient = {
    query: async (statement: string, params: unknown[] = []) => sqlite(statement, ...params),
    queryOne: async (statement: string, params: unknown[] = []) => sqlite(statement, ...params)[0],
    exec: async (statement: string, params: unknown[] = []) => {
      const result = db.prepare(statement).run(...params);
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    },
    tx: async (name: string, args: unknown) => dispatch('tx', { name, args }, db),
  } as unknown as DbClient;
});
beforeEach(() => {
  seed();
  h.scopeCurrent = () => true;
  h.tap.mockClear();
  as(OWNER);
});
afterAll(() => {
  clearCurrentDbClient();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('projects remote collection: read', () => {
  // Regression: absent progress is not explicit todo. Keep the legacy five-count
  // wire contract, but expose a complete read-only breakdown (including off-page
  // items). Real registry -> provider -> SQLite transactions; no synthetic writes.
  it.each([
    { statuses: ['todo', null, null], counts: { todo: 1, doing: 0, blocked: 0, review: 0, done: 0 }, missing: 2 },
    { statuses: [null, null], counts: { todo: 0, doing: 0, blocked: 0, review: 0, done: 0 }, missing: 2 },
    { statuses: ['todo', 'doing', 'blocked', 'review', 'done'], counts: { todo: 1, doing: 1, blocked: 1, review: 1, done: 1 }, missing: 0 },
    { statuses: [], counts: { todo: 0, doing: 0, blocked: 0, review: 0, done: 0 }, missing: 0 },
  ])('separates recorded progress from absence: $statuses', async ({ statuses, counts, missing }) => {
    db.exec("DELETE FROM sessions WHERE project_id='p1'");
    for (const [index, status] of statuses.entries()) {
      db.prepare('INSERT INTO sessions (id,title,status,project_id,created_at,updated_at) VALUES (?,?,\'active\',\'p1\',1,1)')
        .run(`stage-${index}`, `Task ${index}`);
      if (status) await invoke('project.recordProgress', {
        requestId: `stage-${index}`, sessionId: `stage-${index}`, to: status,
        ...(status === 'blocked' ? { reason: 'Needs input', unblockCondition: 'Input received' } : {}),
        ...(status === 'done' ? { completionNote: 'Owner checked' } : {}),
      });
    }
    const eventsBefore = progressEvents();
    const resource = await get();
    const progress = resource.blocks?.find((block) => block.id === 'progress')?.data as Record<string, unknown>;
    expect(progress).toMatchObject({ recordedCounts: counts, unrecordedCount: missing });
    // Old clients still see all tasks in their closed five-state contract.
    expect(progress.counts).toEqual({ ...counts, todo: counts.todo + missing });
    const items = (resource.blocks?.find((block) => block.id === 'work-items')?.data as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(statuses.length);
    for (const [index, status] of statuses.entries()) {
      expect(items.find((item) => item.sessionId === `stage-${index}`)).toMatchObject({
        status: status ?? 'todo', hasProgressRecord: status !== null, progressRevision: status ? 1 : 0,
      });
    }
    expect(progressEvents()).toBe(eventsBefore);
    expect(sqlite<{ n: number }>('SELECT COUNT(*) AS n FROM work_item_progress')[0].n).toBe(statuses.length - missing);
  });

  it('counts unrecorded tasks beyond the bounded work-item page without double counting', async () => {
    const insert = db.prepare("INSERT INTO sessions (id,title,status,project_id,created_at,updated_at) VALUES (?,?,'active','p1',1,1)");
    for (let index = 0; index < 199; index++) insert.run(`extra-${index}`, `Task ${index}`);
    const resource = await get();
    expect(resource.blocks?.find((block) => block.id === 'progress')?.data).toMatchObject({
      counts: { todo: 201, doing: 0, blocked: 0, review: 0, done: 0 },
      recordedCounts: { todo: 0, doing: 0, blocked: 0, review: 0, done: 0 }, unrecordedCount: 201,
    });
    expect((resource.blocks?.find((block) => block.id === 'work-items')?.data as { items: unknown[] }).items).toHaveLength(200);
    expect(progressEvents()).toBe(0);
  });

  it('lists only the caller\u2019s projects newest first, with the contract limit and an opaque cursor', async () => {
    const page = await list();
    expect(page.collectionId).toBe(PROJECT_REMOTE_COLLECTION_ID);
    // p4 是别人的项目：列表本身就是内容面，非成员不出现。
    expect(page.items.map((item) => item.ref.id)).toEqual(['p1', 'p3', 'p2']);
    expect(page.items[0]).toMatchObject({
      ref: { collectionId: 'projects', kind: 'project', id: 'p1' },
      revision: '300',
      display: {
        title: '官网改版',
        subtitle: '把登录页做出来',
        status: { tone: 'positive' },
        timestamp: 300,
      },
      links: [],
      actions: [],
    });
    expect(page.items[2].display.status).toMatchObject({ tone: 'neutral' });

    const first = await list({ limit: 2 });
    expect(first.items.map((item) => item.ref.id)).toEqual(['p1', 'p3']);
    expect(first.nextCursor).toBe('2');
    const second = await list({ limit: 2, cursor: '2' });
    expect(second.items.map((item) => item.ref.id)).toEqual(['p2']);
    expect(second.nextCursor).toBeUndefined();

    // 契约 §2 上限 50：控制端要 200 也只给 50。
    const many = Array.from({ length: 55 }, (_, index) =>
      `('bulk${index}','批量 ${index}',NULL,'${OWNER}','active',100,${500 + index})`).join(',');
    db.exec(`INSERT INTO projects (id,name,goal,owner_id,status,created_at,updated_at) VALUES ${many};
      INSERT INTO project_members (project_id,subject_kind,subject_id,role,added_at)
        SELECT id,'account','${OWNER}','owner',1 FROM projects WHERE id LIKE 'bulk%';`);
    const capped = await list({ limit: 200 });
    expect(capped.items).toHaveLength(50);
    expect(capped.nextCursor).toBe('50');
  });

  it('projects the five contract blocks with mobile-readable data and a bounded history', async () => {
    as(OWNER);
    await invoke('project.recordProgress', { requestId: 'seed-1', sessionId: 's1', to: 'blocked', reason: '等设计稿', unblockCondition: '设计确认' });
    const resource = await get('p1');
    expect(resource.blocks?.map((block) => ({ id: block.id, primitive: block.primitive }))).toEqual([
      { id: 'summary', primitive: 'project-summary' },
      { id: 'progress', primitive: 'project-progress' },
      { id: 'work-items', primitive: 'project-work-items' },
      { id: 'members', primitive: 'project-members' },
    ]);
    for (const block of resource.blocks ?? []) {
      expect(block.fallbackMarkdown.length).toBeGreaterThan(0);
      expect(block.title).toBeTruthy();
    }

    const summary = resource.blocks?.[0].data as Record<string, unknown>;
    expect(summary).toMatchObject({ projectId: 'p1', name: '官网改版', status: 'active', updatedAt: 300 });
    expect(summary.owner).toEqual({ kind: 'account', id: OWNER, name: '某位成员' });

    const progress = resource.blocks?.[1].data as { counts: Record<string, number>; events: Array<Record<string, unknown>> };
    // 未记录进度的任务按「未开始」计入：五档计数必须闭合。
    expect(progress.counts).toEqual({ todo: 1, doing: 0, blocked: 1, review: 0, done: 0 });
    expect(progress.events).toHaveLength(1);
    expect(progress.events[0]).toMatchObject({
      id: expect.any(String),
      sessionId: 's1',
      title: '登录页',
      from: null,
      to: 'blocked',
      at: expect.any(Number),
      actorName: '某位成员',
      note: '等设计稿',
    });

    const workItems = resource.blocks?.[2].data as { items: Array<Record<string, unknown>> };
    expect(workItems.items).toHaveLength(2);
    expect(workItems.items[0]).toMatchObject({
      sessionId: 's1',
      title: '登录页',
      taskObjective: '把登录页做出来',
      status: 'blocked',
      assignee: null,
      bindingRevision: 0,
      updatedAt: expect.any(Number),
      progressRevision: 1,
    });
    expect(workItems.items[1]).toMatchObject({ sessionId: 's2', status: 'todo', progressRevision: 0 });

    const members = resource.blocks?.[3].data as { members: Array<Record<string, unknown>> };
    expect(members.members).toEqual([
      { kind: 'account', id: OWNER, name: '某位成员', role: 'owner' },
      { kind: 'account', id: MEMBER, name: '某位成员', role: 'member' },
      { kind: 'bot', id: 'bot-1', name: '小助手', role: 'member' },
    ]);

    const actions = (resource.actions ?? []).map((action) => action.id);
    expect(actions).toEqual([
      'project.recordProgress',
      'project.setAssignee',
      'project.archive',
      'project.unarchive',
    ]);
    // 归档动作带二次确认；未归档时「恢复」只是展示提示。
    expect(resource.actions?.find((action) => action.id === 'project.archive')?.confirmation?.title).toBeTruthy();
    expect(resource.actions?.find((action) => action.id === 'project.unarchive')?.disabled).toBe(true);
  });

  it('surfaces the linked group by name only, and never leaks paths, room ids or endpoints', async () => {
    h.groupLinks = async () => ({ ok: true, contractRevision: 1, truncated: false, links: [{
      relationId: 'rel-1',
      group: { endpoint: 'https://chat.cindy.app/Case/API', roomId: GROUP_ROOM },
      target: { accountId: OWNER, deviceId: 'device-1', projectId: 'p1' },
      status: 'active',
      revision: 4,
      createdAt: '2026-11-11T00:00:00.000Z',
      updatedAt: '2026-11-11T00:00:00.000Z',
    }] });
    db.exec(`INSERT INTO bot_groups (id, name, created_at, updated_at) VALUES ('${GROUP_ROOM}', '官网介绍群', 1, 1)`);

    const resource = await get('p1');
    const group = resource.blocks?.at(-1);
    expect(group).toMatchObject({ id: 'group-link', primitive: 'project-group-link', data: { groupName: '官网介绍群', status: 'active', revision: 4 } });

    const payload = JSON.stringify({ list: (await list()).items, resource });
    for (const forbidden of ['account:', 'bot:', 'local-v1', 'chat.cindy.app', GROUP_ROOM, PROJECT_DIR, 'C:\\\\Users']) {
      expect(payload).not.toContain(forbidden);
    }

    // 没有关联就不返回这一块（契约 §3）。
    h.groupLinks = async () => ({ ok: true, contractRevision: 1, truncated: false, links: [] });
    expect((await get('p1')).blocks?.some((block) => block.id === 'group-link')).toBe(false);
  });
});

describe('projects remote collection: permission matrix', () => {
  const read = async (userId: string) => {
    as(userId);
    const outcome: Record<string, unknown> = {};
    outcome.list = (await list()).items.map((item) => item.ref.id);
    try {
      await get('p1');
      outcome.get = 'ok';
    } catch (error) {
      outcome.get = (error as { code?: string }).code;
    }
    return outcome;
  };

  it('lets owner and member read, and refuses a non-member', async () => {
    expect(await read(OWNER)).toEqual({ list: ['p1', 'p3', 'p2'], get: 'ok' });
    // 成员只多看到 p1（p3 只有负责人一人）。
    expect(await read(MEMBER)).toEqual({ list: ['p1', 'p2'], get: 'ok' });
    // 列表静默过滤（不返回别人的项目名），详情明确拒绝。
    expect(await read(OUTSIDER)).toEqual({ list: [], get: 'NOT_PROJECT_MEMBER' });
  });

  it('records a non-final stage for owner and member, refuses a non-member', async () => {
    for (const [userId, expected] of [[OWNER, 'ok'], [MEMBER, 'ok'], [OUTSIDER, 'NOT_PROJECT_MEMBER']] as const) {
      seed();
      as(userId);
      const outcome = await invoke('project.recordProgress', { requestId: `r-${userId}`, sessionId: 's1', to: 'doing' })
        .then((response) => (response.result as { ok?: boolean }).ok === true ? 'ok' : 'refused')
        .catch((error: { code?: string }) => error.code);
      expect([userId, outcome]).toEqual([userId, expected]);
      expect([userId, progressEvents()]).toEqual([userId, expected === 'ok' ? 1 : 0]);
    }
  });

  it('keeps confirmation of done owner-only', async () => {
    for (const [userId, expected] of [[OWNER, 'ok'], [MEMBER, 'NOT_PROJECT_OWNER'], [OUTSIDER, 'NOT_PROJECT_MEMBER']] as const) {
      seed();
      as(userId);
      const outcome = await invoke('project.recordProgress', {
        requestId: `done-${userId}`, sessionId: 's1', to: 'done', completionNote: '验收通过',
      }).then(() => 'ok').catch((error: { code?: string }) => error.code);
      expect([userId, outcome]).toEqual([userId, expected]);
      expect(progressEvents()).toBe(expected === 'ok' ? 1 : 0);
    }
  });

  it('lets owner and member set the assignee, refuses a non-member', async () => {
    for (const [userId, expected] of [[OWNER, 'ok'], [MEMBER, 'ok'], [OUTSIDER, 'NOT_PROJECT_MEMBER']] as const) {
      seed();
      as(userId);
      const outcome = await invoke('project.setAssignee', {
        requestId: `assign-${userId}`, sessionId: 's1', assignee: { kind: 'bot', id: 'bot-1' },
      }).then(() => 'ok').catch((error: { code?: string }) => error.code);
      expect([userId, outcome]).toEqual([userId, expected]);
      const assigned = sqlite<{ assignee_id: string | null }>('SELECT assignee_id FROM sessions WHERE id = ?', 's1')[0];
      expect(assigned.assignee_id).toBe(expected === 'ok' ? 'bot-1' : null);
    }
  });

  it('keeps archive and restore owner-only', async () => {
    for (const [userId, expected] of [[OWNER, 'ok'], [MEMBER, 'NOT_PROJECT_OWNER'], [OUTSIDER, 'NOT_PROJECT_OWNER']] as const) {
      seed();
      as(userId);
      const archived = await invoke('project.archive', { requestId: `archive-${userId}`, confirmation: true })
        .then(() => 'ok').catch((error: { code?: string }) => error.code);
      expect([userId, 'archive', archived]).toEqual([userId, 'archive', expected]);
      expect(projectRow('p1').status).toBe(expected === 'ok' ? 'archived' : 'active');

      seed();
      as(OWNER);
      await invoke('project.archive', { requestId: 'setup-archive', confirmation: true });
      as(userId);
      const restored = await invoke('project.unarchive', { requestId: `unarchive-${userId}` })
        .then(() => 'ok').catch((error: { code?: string }) => error.code);
      expect([userId, 'unarchive', restored]).toEqual([userId, 'unarchive', expected]);
      expect(projectRow('p1').status).toBe(expected === 'ok' ? 'active' : 'archived');
    }
  });
});

describe('projects remote collection: writes are idempotent and state-checked', () => {
  it('replays one requestId without a second progress event', async () => {
    as(OWNER);
    const input = { requestId: 'replay-1', sessionId: 's1', to: 'doing' };
    const first = await invoke('project.recordProgress', input);
    const second = await invoke('project.recordProgress', input);
    expect(first.result).toMatchObject({ ok: true, sessionId: 's1', revision: 1, replayed: false });
    expect(second).toEqual(first);
    expect(progressEvents()).toBe(1);
    // 换了内容的同一个 requestId 不是重放，是一次自相矛盾的请求。
    await expect(invoke('project.recordProgress', { ...input, to: 'review' }))
      .rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(progressEvents()).toBe(1);
  });

  it('does not duplicate state for assignee and archive replays', async () => {
    as(OWNER);
    const assign = { requestId: 'assign-replay', sessionId: 's1', assignee: { kind: 'bot', id: 'bot-1' } };
    const once = await invoke('project.setAssignee', assign);
    expect(await invoke('project.setAssignee', assign)).toEqual(once);
    expect(sqlite<{ assignee_id: string }>('SELECT assignee_id FROM sessions WHERE id = ?', 's1')[0].assignee_id).toBe('bot-1');

    const archive = { requestId: 'archive-replay', confirmation: true };
    const archived = await invoke('project.archive', archive);
    const stamp = projectRow('p1').updatedAt;
    expect(await invoke('project.archive', archive)).toEqual(archived);
    expect(projectRow('p1')).toEqual({ status: 'archived', updatedAt: stamp });
  });

  it('checks current state on every call: confirmation, staleness and cross-project ids', async () => {
    as(OWNER);
    await expect(invoke('project.archive', { requestId: 'no-confirm' }))
      .rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(projectRow('p1').status).toBe('active');

    // 控制端拿着旧版本提交：按事务的并发判据拒绝（W10）。
    await invoke('project.recordProgress', { requestId: 'advance', sessionId: 's1', to: 'doing' });
    await expect(invoke('project.recordProgress', {
      requestId: 'stale', sessionId: 's1', to: 'blocked', expectedRevision: 0, expectedBindingRevision: 0,
      reason: '旧视图', unblockCondition: '旧视图',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    // 打开项目 p1 的详情，不能顺手改到 p4 的任务。
    await expect(invoke('project.setAssignee', { requestId: 'cross', sessionId: 's3', assignee: null }, 'p1'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(sqlite<{ project_id: string }>('SELECT project_id FROM sessions WHERE id = ?', 's3')[0].project_id).toBe('p4');

    // 账号切换期间的一次写：先判 owner 代次，再判权限，不允许沿用上一个账号。
    as(MEMBER);
    await expect(invoke('project.archive', { requestId: 'stale-owner', confirmation: true }))
      .rejects.toMatchObject({ code: 'NOT_PROJECT_OWNER' });
    expect(projectRow('p1').status).toBe('active');
  });

  it('announces writes through the existing remote-resource change push only', async () => {
    as(OWNER);
    const response = await invoke('project.recordProgress', { requestId: 'notify', sessionId: 's1', to: 'doing' });
    expect(h.tap).toHaveBeenCalledWith(REMOTE_RESOURCE_CHANGED_CHANNEL, {
      collectionId: PROJECT_REMOTE_COLLECTION_ID,
      resourceRefs: [ref('p1')],
    }, { dataOwnerId: 'owner' });
    // 契约 §6 只选一种：刷新只由 changed 广播驱动，回包里既不给 refresh effect、
    // 也不内联刷新后的 resource（第二套机制会让刷新时序不可预测）。
    expect(response.effects).toEqual([]);
    expect(response).not.toHaveProperty('resource');

    // 幂等重放不会再写库，但仍发同一条广播，控制端因此收敛到最新状态。
    h.tap.mockClear();
    await invoke('project.recordProgress', { requestId: 'notify', sessionId: 's1', to: 'doing' });
    expect(h.tap).toHaveBeenCalledTimes(1);
    expect(progressEvents()).toBe(1);
  });
});

describe('projects remote collection: old-peer compatibility', () => {
  it('keeps the four channels and the protocol version unchanged', () => {
    expect(REMOTE_RESOURCE_PROTOCOL_VERSION).toBe(1);
    expect([...REMOTE_RESOURCE_CHANNELS]).toEqual([
      'maker:remote-resources:manifest',
      'maker:remote-resources:list',
      'maker:remote-resources:get',
      'maker:remote-resources:invoke',
    ]);
  });

  it('only appears in the manifest of a host that registered the provider', async () => {
    // 老被控端（没注册这个集合）：manifest 里没有，手机端按契约 §8 隐藏入口。
    const bare = new RemoteResourceRegistry();
    expect(bare.manifest(context, { client: client() }).collections).toEqual([]);
    await expect(bare.list(context, { client: client(), collectionId: PROJECT_REMOTE_COLLECTION_ID }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    const manifest = remoteResourceRegistry.manifest(context, { client: client() });
    expect(manifest.collections).toContainEqual({
      id: PROJECT_REMOTE_COLLECTION_ID,
      resourceKind: PROJECT_REMOTE_RESOURCE_KIND,
      title: expect.objectContaining({ fallback: 'Projects' }),
      placement: 'home-scope',
      icon: { name: 'folder', fallbackText: '项' },
    });
  });

  it('refuses writes when the account goes away mid-request instead of using the old owner', async () => {
    as(OWNER);
    h.scopeCurrent = () => false;
    await expect(list()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(invoke('project.recordProgress', { requestId: 'gone', sessionId: 's1', to: 'doing' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(progressEvents()).toBe(0);
  });
});
