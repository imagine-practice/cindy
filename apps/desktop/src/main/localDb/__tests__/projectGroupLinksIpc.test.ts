/** Integration: actual registered sender guard/C/A -> named dispatcher/B/full0150 SQLite,
 *  including the read-only by-project read (`project-group-links:list-project`).
 * Gap: C mocks tx and cannot detect missing registration or identity forgery.
 * Controlled HTTP/Electron/owner, no real accounts/group/model. Modules and migrations load once.
 * Standalone measurement: 10 cases, 3.4s wall / 1.0s tests (2026-11-06, Windows).
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeAll, beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runMigrationReplay } from '../migrationRunner';
import { createInprocDbClient, type DbClient } from '../client/DbClient';
import { setCurrentDbClient, clearCurrentDbClient } from '../client/current';
import { WorkerThreadTransport } from '../client/WorkerThreadTransport';
import { dispatch } from '../worker/dispatcher';
import { createChatGroupAuthority } from '../../maker-ipc/chatGroupAuthority';
import { markAppContentWindow } from '../../windowFocusClassifier';
import { configureProjectGroupLinksHost, registerProjectGroupLinksIpc } from '../ipc/projectGroupLinks';
import { createDbTransportError, DB_TRANSPORT_OUTCOME_UNKNOWN } from '../client/DbTransport';
import type { ProjectGroupLinksResponse } from '../../../shared/projectGroupLinks';
import * as schema from '../schema';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<ProjectGroupLinksResponse>>(),
  windows: new Map<unknown, unknown>(), user: 'owner', epoch: 1, db: undefined as Database.Database | undefined,
}));
vi.mock('electron', () => ({ ipcMain: { handle: (n: string, f: (event: unknown, raw: unknown) => Promise<ProjectGroupLinksResponse>) => h.handlers.set(n, f) },
  BrowserWindow: { fromWebContents: (sender: unknown) => h.windows.get(sender) } }));
vi.mock('../index', () => ({ getRawDb: () => h.db, getDrizzle: () => drizzle(h.db!, { schema }), getCurrentUserId: () => h.user }));
vi.mock('../../appSessionState', () => ({ getActiveAppSession: () => ({ dataOwnerId: h.user, generation: h.epoch }), activeOwnerScopeKey: () => `${h.user}:${h.epoch}`, isAppSessionBoundaryPending: () => false }));
vi.mock('../../logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock('../../i18n', () => ({ t: (key: string) => key }));

const group = { endpoint: 'https://chat.example/Case/API', roomId: 'aaaaaaaa-1111-4111-8111-111111111111' };
const self = 'bbbbbbbb-1111-4111-8111-111111111111';
const target = { accountId: 'owner', deviceId: 'device', projectId: 'p' };
const link = (id = 'r1', revision = 0) => ({ action: 'link', requestId: id, group, target, expectedRevision: revision });
let db: Database.Database, dir: string, file: string, client: DbClient;
let beforeTx: (() => void) | undefined, afterTx: (() => void) | undefined, loseAck = false;
let role = 'owner', joined = true, onHttp: (() => void) | undefined;
const frame = { url: 'http://localhost:5173/index.html', parent: null };
const sender = { mainFrame: frame, isDestroyed: () => false };
const event = { sender, senderFrame: frame };
const request = (raw: unknown = link(), source: unknown = event, action = 'link') => h.handlers.get(`local-db:project-group-links:${action}`)!(source, raw);
const counts = () => db.prepare('SELECT (SELECT COUNT(*) FROM project_group_links) AS links,(SELECT COUNT(*) FROM project_group_link_requests) AS receipts').get();
const envelope = () => ({ intent: link(), context: { actor: { kind: 'account', id: 'owner' }, accountId: 'owner', deviceId: 'device', group, now: 1 }, newRelationId: 'transport-relation' });

beforeAll(() => {
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173');
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
  dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-group-link-wire-')); file = path.join(dir, 'fixture.db');
  db = createBetterSqliteDatabase(file); h.db = db;
  const root = path.resolve(__dirname, '../../../..');
  db.loadExtension(path.join(root, 'native/sqlite-vec', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib'));
  runMigrationReplay(db, { drizzleDir: path.join(root, 'drizzle') });
  const win = { isDestroyed: () => false };
  markAppContentWindow(win as Parameters<typeof markAppContentWindow>[0]); h.windows.set(sender, win);
  registerProjectGroupLinksIpc();
});
beforeEach(async () => {
  h.user = 'owner'; h.epoch = 1; role = 'owner'; joined = true; frame.url = 'http://localhost:5173/index.html';
  beforeTx = undefined; afterTx = undefined; loseAck = false; onHttp = undefined;
  db.exec(`DELETE FROM project_group_link_requests; DELETE FROM project_group_links; DELETE FROM project_members; DELETE FROM projects;
    INSERT INTO projects(id,name,owner_id,status,created_at,updated_at) VALUES ('p','private-project','owner','active',1,1);
    INSERT INTO project_members VALUES ('p','account','owner','owner',1);`);
  client = await createInprocDbClient();
  const execute = client.tx.bind(client);
  client.tx = async <T>(name: string, args: unknown): Promise<T> => {
    beforeTx?.();
    const result = await execute<T>(name, args);
    const hook = afterTx; afterTx = undefined; hook?.();
    if (loseAck) throw createDbTransportError(DB_TRANSPORT_OUTCOME_UNKNOWN, 'ACK unavailable');
    return result;
  };
  setCurrentDbClient(client, 'owner');
  const groupAuthority = createChatGroupAuthority({ captureBoundary: () => {
    const epoch = h.epoch;
    return { ownerId: 'owner', endpoint: group.endpoint, assertCurrent: () => { if (epoch !== h.epoch) throw Error('OWNER_SCOPE_CHANGED'); },
      resolveRoom: room => room, read: async route => {
        onHttp?.();
        if (route === '/me') return { actor: { id: self, kind: 'human', externalId: 'owner' } };
        if (route === '/actors') return [];
        // 群房间按请求的 roomId 回答：这个 fixture 要能同时服务多个群。
        const roomId = /^\/conversations\/([^/]+)\/snapshot$/.exec(route)?.[1] ?? group.roomId;
        return { room: { id: roomId, kind: 'group', revision: 1, archived: false }, members: [
          { id: self, kind: 'human', ownerActorId: self, state: joined ? 'joined' : 'left', role, accessRevision: 1 }] };
      } };
  } });
  const service = { groupAuthority };
  configureProjectGroupLinksHost({ groupService: () => service, currentDeviceId: () => 'device' });
});
afterEach(() => clearCurrentDbClient());
afterAll(() => {
  h.db = undefined; db.close();
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('cindy-group-link-wire-')) throw Error('Unexpected fixture root');
  rmSync(resolved, { recursive: true, force: true }); vi.unstubAllGlobals();
});

it('actual preload and registered channels round-trip named link/list/unlink/replay', async () => {
  const source = readFileSync(path.resolve(__dirname, '../../../preload/preload.ts'), 'utf8');
  const start = source.indexOf('    projectGroupLinks: {'), end = source.indexOf('    projectProgress: {', start);
  const compiled = ts.transpileModule(`const b={${source.slice(start,end)}};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const api = new Function('ipcRenderer', `${compiled};return b.projectGroupLinks;`)({ invoke: (channel: string, raw: unknown) => h.handlers.get(channel)!(event, raw) }) as {
    link(raw: unknown): Promise<ProjectGroupLinksResponse>; list(raw: unknown): Promise<ProjectGroupLinksResponse>; unlink(raw: unknown): Promise<ProjectGroupLinksResponse>;
    listProject(raw: unknown): Promise<ProjectGroupLinksResponse>;
  };
  const first = await api.link(link()); expect(first).toMatchObject({ ok: true, current: { revision: 1, status: 'active' } });
  if (!first.ok || !('current' in first)) throw Error('fixture');
  expect(await api.list({ action: 'list', group })).toMatchObject({ ok: true, links: [{ relationId: first.current.relationId }] });
  // 同一份关系按项目也能读到：只读通道不需要 requestId，也不写账本。
  expect(await api.listProject({ action: 'list-project', projectId: 'p' }))
    .toMatchObject({ ok: true, contractRevision: 1, truncated: false, links: [{ relationId: first.current.relationId, status: 'active' }] });
  expect(await api.unlink({ action: 'unlink', requestId: 'r2', group, target, relationId: first.current.relationId, expectedRevision: 1 })).toMatchObject({ ok: true, current: { revision: 2, status: 'removed' } });
  expect(await api.link(link())).toMatchObject({ ok: true, replayed: true, commit: { revision: 1, statusAtCommit: 'active' }, current: { revision: 2, status: 'removed' } });
  expect(counts()).toEqual({ links: 1, receipts: 2 });
});
it('real sender guard denies foreign/subframe/unregistered senders and public identity fields', async () => {
  await expect(request(link(), { sender, senderFrame: { ...frame, parent: frame } })).rejects.toThrow();
  await expect(request(link(), { sender: { ...sender }, senderFrame: frame })).rejects.toThrow();
  frame.url = 'https://evil.example'; await expect(request()).rejects.toThrow(); frame.url = 'http://localhost:5173';
  for (const extra of [{ actor: { kind: 'account', id: 'owner' } }, { canManage: true }, { context: envelope().context }, { callerSessionId: 'forged' }])
    expect(await request({ ...link(), ...extra })).toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS', commitState: 'not-committed' });
  expect(await request({ ...link(), action: 'list' })).toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
  expect(counts()).toEqual({ links: 0, receipts: 0 });
});
it('transaction rechecks project owner after main/group prechecks', async () => {
  beforeTx = () => db.exec("UPDATE project_members SET role='member' WHERE project_id='p'");
  expect(await request()).toMatchObject({ ok: false, errorCode: 'NOT_PROJECT_OWNER', commitState: 'not-committed' });
  expect(counts()).toEqual({ links: 0, receipts: 0 });
});
it('revoked group, navigated sender and switched owner cannot cross HTTP awaits', async () => {
  joined = false; expect(await request()).toMatchObject({ ok: false, errorCode: 'GROUP_ACCESS_DENIED' });
  joined = true; onHttp = () => { frame.url = 'https://evil.example'; };
  expect(await request()).toMatchObject({ ok: false }); expect(counts()).toEqual({ links: 0, receipts: 0 });
  frame.url = 'http://localhost:5173'; onHttp = () => { h.epoch++; };
  expect(await request()).toMatchObject({ ok: false, errorCode: 'OWNER_SCOPE_CHANGED' });
});
it('postcommit revoke preserves committed; concurrent current unlink does not rewrite old commit', async () => {
  afterTx = () => db.exec('DELETE FROM project_members');
  expect(await request()).toMatchObject({ ok: false, commitState: 'committed' }); expect(counts()).toEqual({ links: 1, receipts: 1 });
  db.exec("INSERT INTO project_members VALUES ('p','account','owner','owner',1)");
  afterTx = () => { const row = db.prepare('SELECT id FROM project_group_links').get() as { id: string };
    void dispatch('tx', { name: 'projectGroupLinks.execute', args: { intent: { action: 'unlink', requestId: 'r2', group, target, relationId: row.id, expectedRevision: 1 }, context: envelope().context } }, db); };
  expect(await request()).toMatchObject({ ok: true, replayed: true, commit: { revision: 1, statusAtCommit: 'active' }, current: { revision: 2, status: 'removed' } });
});
it('unknown ACK then denied reconciliation preserves original fact and same-id replay never duplicates', async () => {
  loseAck = true; expect(await request()).toMatchObject({ ok: false, commitState: 'unknown' }); expect(counts()).toEqual({ links: 1, receipts: 1 });
  loseAck = false; db.exec('DELETE FROM project_members');
  expect(await request()).toMatchObject({ ok: false, commitState: 'not-committed' }); expect(counts()).toEqual({ links: 1, receipts: 1 });
  db.exec("INSERT INTO project_members VALUES ('p','account','owner','owner',1)");
  expect(await request()).toMatchObject({ ok: true, replayed: true, commit: { revision: 1 } }); expect(counts()).toEqual({ links: 1, receipts: 1 });
});

it("by-project read returns only this project's active links of this account and device", async () => {
  db.exec(`INSERT INTO projects(id,name,owner_id,status,created_at,updated_at) VALUES ('q','other-project','owner','active',1,1);
    INSERT INTO project_members VALUES ('q','account','owner','owner',1);`);
  const roomRemoved = 'cccccccc-1111-4111-8111-111111111111';
  const roomOtherProject = 'dddddddd-1111-4111-8111-111111111111';
  const roomOtherDevice = 'eeeeeeee-1111-4111-8111-111111111111';
  expect(await request(link('r1'))).toMatchObject({ ok: true });
  // 另一个项目的关联
  expect(await request({ action: 'link', requestId: 'r2', group: { endpoint: group.endpoint, roomId: roomOtherProject },
    target: { ...target, projectId: 'q' }, expectedRevision: 0 })).toMatchObject({ ok: true });
  // 已解除的关联（同项目同群先关联再解除）
  expect(await request({ action: 'link', requestId: 'r3', group: { endpoint: group.endpoint, roomId: roomRemoved },
    target, expectedRevision: 0 })).toMatchObject({ ok: true });
  const removed = db.prepare('SELECT id FROM project_group_links WHERE group_room_id=?').get(roomRemoved) as { id: string };
  expect(await request({ action: 'unlink', requestId: 'r4', group: { endpoint: group.endpoint, roomId: roomRemoved },
    target, relationId: removed.id, expectedRevision: 1 }, event, 'unlink')).toMatchObject({ ok: true });
  // 另一台设备上的关联（同一账号）：本机看不到，也不冒充没有关联。
  await dispatch('tx', { name: 'projectGroupLinks.execute', args: { intent: {
    action: 'link', requestId: 'r5', group: { endpoint: group.endpoint, roomId: roomOtherDevice },
    target: { accountId: 'owner', deviceId: 'other-device', projectId: 'p' }, expectedRevision: 0,
  }, context: { actor: { kind: 'account', id: 'owner' }, accountId: 'owner', deviceId: 'other-device',
    group: { endpoint: group.endpoint, roomId: roomOtherDevice }, now: 1 }, newRelationId: 'other-device-relation' } }, db);

  // 读之前记下账本：这次查询必须一行都不新增。
  const settled = counts();
  const listed = await request({ action: 'list-project', projectId: 'p' }, event, 'list-project');
  expect(listed).toMatchObject({ ok: true, contractRevision: 1, truncated: false });
  if (!listed.ok || !('links' in listed)) throw Error('fixture');
  expect(listed.links).toEqual([{
    relationId: (db.prepare('SELECT id FROM project_group_links WHERE group_room_id=?').get(group.roomId) as { id: string }).id,
    group, target, status: 'active', revision: 1, createdAt: expect.any(String), updatedAt: expect.any(String),
  }]);
  // 只读：不写动作账本，也不改 revision。
  expect(counts()).toEqual(settled);
  expect(settled).toEqual({ links: 4, receipts: 5 });
});

it('by-project read refuses non-members and forged identity fields without leaking rows', async () => {
  expect(await request(link('r1'))).toMatchObject({ ok: true });
  for (const extra of [{ actor: { kind: 'account', id: 'owner' } }, { accountId: 'owner' }, { deviceId: 'device' },
    { context: envelope().context }, { group }, { requestId: 'forged' }, { includeRemoved: true }])
    expect(await request({ action: 'list-project', projectId: 'p', ...extra }, event, 'list-project'))
      .toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS', commitState: 'not-committed' });
  expect(await request({ action: 'list-project', projectId: 'p' }, event, 'list'))
    .toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
  db.exec("DELETE FROM project_members WHERE project_id='p'");
  expect(await request({ action: 'list-project', projectId: 'p' }, event, 'list-project'))
    .toMatchObject({ ok: false, errorCode: 'NOT_PROJECT_MEMBER', commitState: 'not-committed' });
});

for (const mode of ['inline', 'file-worker'] as const) it(`${mode}: named tx executes generated schema and rejects revoked replay`, async () => {
  let workerScriptPath: string | undefined;
  if (mode === 'file-worker') {
    workerScriptPath = path.join(dir, 'dbWorker.mjs');
    await build({ entryPoints: [path.resolve(__dirname, '../worker/dbWorker.ts')], outfile: workerScriptPath, platform: 'node', format: 'esm', bundle: true,
      plugins: [{ name: 'native-sqlite', setup(b) { b.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: require.resolve('better-sqlite3'), external: true })); } }] });
  }
  const worker = new WorkerThreadTransport({ dbPath: file, drizzleDir: path.resolve(__dirname, '../../../../drizzle'),
    useInlineWorker: mode === 'inline', workerScriptPath, betterSqliteModulePath: require.resolve('better-sqlite3') });
  try {
    const transported: DbClient = { ...client,
      queryOne: <T>(sql: string, params?: unknown[]) => worker.send('queryOne', { sql, params }) as Promise<T | undefined>,
      tx: <T>(name: string, args: unknown) => worker.send('tx', { name, args }) as Promise<T>,
    };
    setCurrentDbClient(transported, 'owner');
    expect(await request()).toMatchObject({ ok: true, current: { revision: 1 }, replayed: false });
    // 同一份 worker 也要能回答按项目查询（inline 脚本里嵌的函数源码必须能独立运行）。
    expect(await request({ action: 'list-project', projectId: 'p' }, event, 'list-project'))
      .toMatchObject({ ok: true, truncated: false, links: [{ status: 'active', target: { projectId: 'p' } }] });
    expect(await request()).toMatchObject({ ok: true, replayed: true });
    await worker.send('exec', { sql: 'DELETE FROM project_members' });
    expect(await request()).toMatchObject({ ok: false, errorCode: 'NOT_PROJECT_OWNER', commitState: 'not-committed' });
    expect(counts()).toEqual({ links: 1, receipts: 1 });
  } finally { await worker.close(); }
});
