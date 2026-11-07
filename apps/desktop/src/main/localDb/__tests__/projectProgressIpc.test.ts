/**
 * S integration: real IPC adapters -> production dispatcher/inline RPC -> real migrated SQLite.
 * Existing R fixtures cannot detect identity injection, owner publication races or missing registration.
 * Minimal failure: member removed before read/replay, or missing client binding revision.
 * Migrations run once; no real model/account DB, module reset or real waits.
 */
import ts from 'typescript';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runMigrationReplay } from '../migrationRunner';
import { dispatch } from '../worker/dispatcher';
import { WorkerThreadTransport } from '../client/WorkerThreadTransport';
import { setCurrentDbClient, clearCurrentDbClient } from '../client/current';
import type { DbClient } from '../client/DbClient';
import { registerProjectProgressIpc } from '../ipc/projectProgress';
import { isIpcErrorCode } from '../../../shared/ipc-errors';

const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  trusted: true, generation: 0, tap: vi.fn(), send: vi.fn(), closed: false }));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => h.handlers.set(channel, handler) },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: (...args: unknown[]) => {
    if (h.closed) throw new Error('closed'); h.send(...args);
  } } }] },
}));
vi.mock('../../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: () => { if (!h.trusted) throw new Error('UNTRUSTED_RENDERER'); },
  isTrustedAppRendererWindow: () => true,
}));
vi.mock('../../device-link/broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: () => ({ generation: h.generation, ownerStamp: { dataOwnerId: 'fixture' } }),
  isDataOwnerBroadcastScopeCurrent: (scope: { generation: number }) => scope.generation === h.generation,
  tapWindowBroadcast: h.tap,
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

let db: Database.Database;
let dir: string;
let file: string;
let client: DbClient;
let bridge: ReturnType<typeof vi.fn>;
// Execute the production preload adapter, not a test reimplementation of its channel mapping.
const preload = readFileSync(path.resolve(__dirname, '../../../preload/preload.ts'), 'utf8');
const start = preload.indexOf('    projectProgress: {');
const end = preload.indexOf('    materials: {', start);
if (start < 0 || end <= start) throw new Error('Project progress preload adapter missing');
const compiled = ts.transpileModule(`const bridge = {${preload.slice(start, end)}};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const adapter = new Function('ipcRenderer', `${compiled}; return bridge.projectProgress;`)({
  invoke: (channel: string, request: unknown) => h.handlers.get(channel)!({}, request),
}) as { read(request: unknown): Promise<unknown>; update(intent: unknown): Promise<unknown> };
const read = (request: unknown = { projectId: 'p' }) => adapter.read(request);
const update = (intent: unknown = baseIntent()) => adapter.update(intent);
const baseIntent = () => ({ projectId: 'p', sessionId: 's', expectedRevision: 0, expectedBindingRevision: 0,
  requestId: 'request-1', to: 'blocked', reason: 'private progress note', unblockCondition: 'fixture unblock' });
const events = () => (db.prepare('SELECT COUNT(*) AS n FROM work_item_progress_events').get() as { n: number }).n;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-progress-S-')); file = path.join(dir, 'fixture.db');
  db = createBetterSqliteDatabase(file);
  const desktop = path.resolve(__dirname, '../../../..');
  db.loadExtension(path.join(desktop, 'native/sqlite-vec', `${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib'));
  runMigrationReplay(db, { drizzleDir: path.join(desktop, 'drizzle') });
  registerProjectProgressIpc();
});
beforeEach(() => {
  vi.clearAllMocks(); h.trusted = true; h.closed = false;
  db.exec(`DELETE FROM work_item_progress; DELETE FROM work_item_progress_events;
    DELETE FROM project_members; DELETE FROM projects; DELETE FROM sessions;
    INSERT INTO projects(id,name,owner_id,status,created_at,updated_at) VALUES ('p','Fixture','owner','active',1,1);
    INSERT INTO project_members VALUES ('p','account','owner','owner',1), ('p','account','member','member',1), ('p','bot','member','member',1);
    INSERT INTO sessions(id,title,status,project_id,created_at,updated_at) VALUES ('s','Task','active','p',1,1);`);
  bridge = vi.fn(async (name: string, args: unknown) => dispatch('tx', { name, args }, db));
  // Transport seam only; all authorization, SQL, persistence and result mapping are production code.
  client = { tx: bridge } as unknown as DbClient;
  setCurrentDbClient(client, 'member');
});
afterEach(() => clearCurrentDbClient());
afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('S official progress IPC', () => {
  it('round-trips migrated progress, preserves replay identity and broadcasts only invalidation', async () => {
    const initial = await read();
    expect(initial).toMatchObject({ items: [{ sessionId: 's', bindingRevision: 0, progress: null }], capabilities: { canRecord: true, canConfirmDone: false } });
    const first = await update(); const replay = await update();
    expect(first).toMatchObject({ revision: 1, replayed: false });
    expect(replay).toEqual({ ...(first as object), replayed: true }); expect(events()).toBe(1);
    expect(await read()).toMatchObject({ items: [{ progress: { revision: 1, status: 'blocked' } }], history: [{ reason: 'private progress note' }] });
    expect(h.send).toHaveBeenCalledWith('local-db:projects:changed', {}, expect.anything());
    expect(h.tap).toHaveBeenCalledWith('local-db:projects:changed', {}, expect.anything());
    expect(JSON.stringify(h.send.mock.calls)).not.toContain('private progress note');
    expect(bridge).toHaveBeenCalledWith('workItemProgress.execute', expect.objectContaining({
      intent: baseIntent(), context: { actor: { kind: 'account', id: 'member' }, now: expect.any(Number) },
    }));
  });
  it('rejects renderer identity fields and missing or stale revisions without writes or success broadcasts', async () => {
    await expect(read({ projectId: 'p', actor: { kind: 'account', id: 'owner' } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    for (const intent of [
      { ...baseIntent(), actor: { kind: 'account', id: 'owner' } }, { ...baseIntent(), role: 'owner' },
      { ...baseIntent(), now: 1 }, { ...baseIntent(), expectedBindingRevision: undefined },
      { ...baseIntent(), expectedRevision: undefined },
    ]) await expect(update(intent)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(update({ ...baseIntent(), expectedBindingRevision: 9 })).rejects.toMatchObject({ code: 'BINDING_CONFLICT' });
    await expect(update({ ...baseIntent(), to: 'done', completionNote: 'forged owner' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(events()).toBe(0); expect(h.send).not.toHaveBeenCalled(); expect(h.tap).not.toHaveBeenCalled();
    expect(isIpcErrorCode('BINDING_CONFLICT')).toBe(true);
  });
  it('rechecks membership on both read and idempotent replay, without borrowing same-id bot authority', async () => {
    await update(); h.send.mockClear(); h.tap.mockClear();
    db.exec("DELETE FROM project_members WHERE subject_kind='account' AND subject_id='member'");
    await expect(read()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(update()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(events()).toBe(1); expect(h.send).not.toHaveBeenCalled(); expect(h.tap).not.toHaveBeenCalled();
  });
  it.each(['read', 'update'])('discards %s response after owner epoch changes on the same client', async operation => {
    bridge.mockImplementationOnce(async (name, args) => {
      const result = await dispatch('tx', { name, args }, db);
      setCurrentDbClient(client, 'member'); // Same object/id, new owner epoch.
      return result;
    });
    await expect(operation === 'read' ? read() : update()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(events()).toBe(operation === 'read' ? 0 : 1); // Never claim committed writes rolled back.
    expect(h.send).not.toHaveBeenCalled(); expect(h.tap).not.toHaveBeenCalled();
  });
  it('preserves unknown transport outcome and replays the same requestId without a second event', async () => {
    bridge.mockImplementationOnce(async (name, args) => {
      await dispatch('tx', { name, args }, db);
      throw Object.assign(new Error('response lost'), { code: 'DB_TRANSPORT_OUTCOME_UNKNOWN' });
    });
    await expect(update()).rejects.toMatchObject({ code: 'DB_TRANSPORT_OUTCOME_UNKNOWN' });
    expect(events()).toBe(1); expect(h.send).not.toHaveBeenCalled(); expect(h.tap).not.toHaveBeenCalled();
    expect(await update()).toMatchObject({ revision: 1, replayed: true }); expect(events()).toBe(1);
  });
  it('keeps committed success when a window or relay closes', async () => {
    h.closed = true; h.tap.mockImplementationOnce(() => { throw new Error('closed relay'); });
    expect(await update()).toMatchObject({ revision: 1 }); expect(events()).toBe(1);
  });
  it('checks renderer source before touching the database', async () => {
    h.trusted = false; await expect(read()).rejects.toThrow('UNTRUSTED_RENDERER');
    await expect(update()).rejects.toThrow('UNTRUSTED_RENDERER'); expect(bridge).not.toHaveBeenCalled();
  });
  it('uses actual inline RPC for named read and write against the migrated database', async () => {
    const worker = new WorkerThreadTransport({ useInlineWorker: true, dbPath: file, drizzleDir: path.resolve(__dirname, '../../../../drizzle'),
      betterSqliteModulePath: require.resolve('better-sqlite3') });
    try {
      bridge.mockImplementation((name, args) => worker.send('tx', { name, args }));
      expect(await read()).toMatchObject({ items: [{ progress: null, bindingRevision: 0 }] });
      expect(await update()).toMatchObject({ revision: 1 });
      expect(await read()).toMatchObject({ items: [{ progress: { status: 'blocked' } }] });
      db.exec("DELETE FROM project_members WHERE subject_kind='account' AND subject_id='member'");
      await expect(read()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(update()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(events()).toBe(1);
    } finally { await worker.close(); }
  });
});
