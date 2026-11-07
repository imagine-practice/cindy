/** Integration tier: public MCP transport -> production Desktop adapter -> fixed
 * project services and named transaction dispatcher -> fully migrated SQLite.
 * Previous public tests controlled callbacks and could not detect owner/bot ACL
 * confusion or revocation between reads. Minimal failures: owner/bot share an ID,
 * or membership disappears after a read. Electron, live turn provenance and app
 * account lifecycle are controlled; this is not a real Host/remote/group acceptance.
 * One migration replay, transaction-isolated fixtures; no user DB, waits or models.
 * Standalone: pnpm exec vitest run src/main/mcp-integrations/__tests__/entityProjectManagement.test.ts
 * measured 4.10s (21 cases, test body 497ms) on 2026-11-05.
 */
import path from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createXdtHelperMcpServer } from '../../../../../../packages/lizi-mcps/src/lizi_xdtHelperMcpServer';
import type { LiziMcpSessionContext } from '@cindy/mcps';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBetterSqliteDatabase } from '../../localDb/betterSqliteFactory';
import { runMigrationReplay } from '../../localDb/migrationRunner';
import { createInprocDbClient, type DbClient } from '../../localDb/client/DbClient';
import { setCurrentDbClient, clearCurrentDbClient } from '../../localDb/client/current';
import { createTaskToolCallAuthorizer } from '../../maker-ipc/taskToolCallAuthorizer';
import { beginChannelToolScope } from '../../im/shared/channelToolScope';
import { registerGroupToolAuthority } from '../../maker-ipc/botGroupToolAuthorization';
import { createEntityProjectManagement } from '../entityProjectManagement';
import type { EntityProjectRuntime } from '../entityProjectAuthority';
import * as schema from '../../localDb/schema';

const host = vi.hoisted(() => ({ generation: 1, pending: false, db: undefined as Database.Database | undefined }));
vi.mock('../../localDb/index', () => ({
  getRawDb: () => host.db,
  getDrizzle: () => drizzle(host.db!, { schema }),
  getCurrentUserId: () => 'owner',
}));
vi.mock('../../appSessionState', () => ({
  getActiveAppSession: () => ({ mode: 'authenticated', dataOwnerId: 'owner', generation: host.generation }),
  activeOwnerScopeKey: () => `owner:${host.generation}`,
  isAppSessionBoundaryPending: () => host.pending,
}));
vi.mock('../../localDb/ipc/sessions', () => ({ broadcastSessionPatched: () => undefined }));
vi.mock('../../device-link/broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: () => host.generation,
  isDataOwnerBroadcastScopeCurrent: (generation: number) => host.generation === generation,
}));
vi.mock('../../i18n', () => ({ t: (key: string) => key }));
// Logging/profile storage is not under test and must not touch the owner's files.
vi.mock('../../logger', () => ({ createLogger: () => ({
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
}) }));
// This file explicitly uses the production in-process client/tx dispatcher. A
// worker process is outside this fixture; do not collect its inline worker bundle.
vi.mock('../../localDb/client/WorkerThreadTransport', () => ({ WorkerThreadTransport: class {
  constructor() { throw new Error('Worker transport is outside this in-process fixture'); }
} }));

describe('Desktop entity project host read closure', () => {
  let db: Database.Database;
  let client: DbClient;
  let context: LiziMcpSessionContext | undefined;
  let ownerInput: boolean;
  let inputKey: string;
  let live: ReturnType<EntityProjectRuntime['getSession']>;
  let mcp: Client;
  let server: ReturnType<typeof createXdtHelperMcpServer>;
  let unregister: (() => void) | undefined;
  let afterQuery: ((sql: string) => void) | undefined;
  let afterTx: (() => void) | undefined;
  const runtime: EntityProjectRuntime = {
    input: () => ({ key: inputKey, boundary: 'instance:1', ownerInput }),
    getSession: () => live,
  };
  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
  async function call(name = 'list_project_entities', args: object = {}) {
    const result = await mcp.callTool({ name: 'call_tool', arguments: { name, args } });
    const text = result.content;
    if (!Array.isArray(text) || !text[0] || text[0].type !== 'text') throw new Error('Missing MCP text result');
    return JSON.parse(text[0].text);
  }
  function bot(role = 'canonical') {
    run("UPDATE sessions SET source='bot' WHERE id='caller'");
    run("INSERT INTO bot_profiles(id,display_name,canonical_session_id,created_at,updated_at) VALUES ('owner','Same name','caller',1,1)");
    run('INSERT INTO bot_session_links(id,bot_id,session_id,role,created_at) VALUES (?,?,?,?,1)', 'link', 'owner', 'caller', role);
  }
  function noBody(result: unknown, code?: string) {
    expect(result).toMatchObject({ ok: false, ...(code ? { errorCode: code } : {}) });
    expect(result).not.toHaveProperty('projects');
    expect(result).not.toHaveProperty('project');
    expect(result).not.toHaveProperty('items');
    expect(JSON.stringify(result)).not.toContain('private-goal');
  }
  beforeAll(() => {
    db = createBetterSqliteDatabase(':memory:'); host.db = db;
    const root = path.resolve(__dirname, '../../../..');
    db.loadExtension(path.join(root, 'native/sqlite-vec', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib'));
    runMigrationReplay(db, { drizzleDir: path.join(root, 'drizzle') });
  });
  beforeEach(async () => {
    db.exec('BEGIN');
    host.generation = 1; host.pending = false;
    context = { agentKind: 'pi', workingDir: '/fixture', sessionId: 'caller' };
    ownerInput = true; inputKey = 'accepted-owner-input';
    live = { instanceId: 'instance', getCurrentTurnOrigin: () => null };
    afterQuery = undefined; afterTx = undefined;
    run("INSERT INTO sessions(id,created_at,updated_at) VALUES ('caller',1,1)");
    run("INSERT INTO projects(id,name,goal,owner_id,status,created_at,updated_at) VALUES ('p','Same name','private-goal','owner','active',1,1),('q','Same name',NULL,'other','active',1,1)");
    run("INSERT INTO project_members(project_id,subject_kind,subject_id,role,added_at) VALUES ('p','account','owner','owner',1),('q','account','other','owner',1),('q','bot','owner','member',1)");
    client = await createInprocDbClient();
    const query = client.query.bind(client);
    const queryOne = client.queryOne.bind(client);
    const tx = client.tx.bind(client);
    client.query = async <T>(sql: string, params?: unknown[]) => { const result = await query<T>(sql, params); afterQuery?.(sql); return result; };
    client.queryOne = async <T>(sql: string, params?: unknown[]) => { const result = await queryOne<T>(sql, params); afterQuery?.(sql); return result; };
    client.tx = async <T>(name: string, args: unknown) => { const result = await tx<T>(name, args); afterTx?.(); return result; };
    setCurrentDbClient(client, 'owner');
    server = createXdtHelperMcpServer({
      entityProjects: createEntityProjectManagement(runtime),
      authorizeCall: createTaskToolCallAuthorizer({ getDb: () => client, isScopeCurrent: candidate => candidate === client }),
      projectManagement: {
        list: async () => ({ ok: true, projects: [{ workingDir: '/fixture', directoryName: 'fixture', alias: null, hidden: false, exists: true, lastUsedAt: '2026-11-05T00:00:00Z' }], total: 1, nextOffset: null, projectsRoot: { path: '/projects', source: 'setting', exists: true } }),
        rename: async () => ({ ok: true, workingDir: '/fixture', alias: null }),
        remove: async () => ({ ok: true, workingDir: '/fixture', removed: true }),
      },
    }, { agentKind: 'pi', workingDir: '/fixture', getSessionContext: () => context });
    mcp = new Client({ name: 'desktop-entity-host-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(a), server.connect(b)]);
  });
  afterEach(async () => { unregister?.(); unregister = undefined; clearCurrentDbClient(); await mcp.close(); await server.close(); db.exec('ROLLBACK'); });
  afterAll(() => { db.close(); host.db = undefined; });

  it('discovers both project meanings and reads actual account detail without exposing directory/storage state', async () => {
    const discovered = await mcp.callTool({ name: 'list_tools', arguments: { category: 'control' } });
    expect(JSON.stringify(discovered)).toContain('get_project_entity');
    const result = await call();
    expect(result.projects.map((p: { id: string }) => p.id)).toEqual(['p']);
    const detail = await call('get_project_entity', { project_id: 'p' });
    expect(detail).toMatchObject({ ok: true, project: { id: 'p', name: 'Same name', goal: 'private-goal' }, workItems: [] });
    expect(await call('list_projects')).toMatchObject({ ok: true, projects: [{ project_path: '/fixture', working_dir: '/fixture' }] });
    expect(result).not.toHaveProperty('storageRef');
  });
  it('retains normal plugin task account access', async () => {
    run("UPDATE sessions SET source='plugin' WHERE id='caller'");
    expect(await call()).toMatchObject({ ok: true, projects: [{ id: 'p' }] });
  });
  it('keeps same-ID bot/account memberships distinct, and honors verified owner agency', async () => {
    bot(); ownerInput = false;
    expect(await call()).toMatchObject({ ok: true, projects: [{ id: 'q', name: 'Same name' }] });
    noBody(await call('get_project_entity', { project_id: 'p' }), 'NOT_PROJECT_MEMBER');
    ownerInput = true;
    expect(await call()).toMatchObject({ ok: true, projects: [{ id: 'p' }] });
  });
  it.each(['missing', 'deleted', 'unknown', 'remote', 'no-runtime', 'shared'])('rejects %s callers instead of defaulting to owner', async mode => {
    if (mode === 'missing') context = undefined;
    if (mode === 'deleted') run("DELETE FROM sessions WHERE id='caller'");
    if (mode === 'unknown') run("UPDATE sessions SET source='new-unknown-scope' WHERE id='caller'");
    if (mode === 'remote') run("UPDATE sessions SET remote_host_id='remote' WHERE id='caller'");
    if (mode === 'no-runtime') live = undefined;
    if (mode === 'shared') run("UPDATE sessions SET source='shared' WHERE id='caller'");
    noBody(await call());
  });
  it('rejects forged actor and remote public contexts without a local fallback', async () => {
    noBody(await call('get_project_entity', { project_id: 'p', actor: { kind: 'account', id: 'owner' } }));
    context = { ...context!, remoteHostId: 'remote' };
    noBody(await call(), 'UNSUPPORTED_CAPABILITY');
  });
  it.each(['prepare', 'return'])('discards all project data when membership is revoked during %s', async phase => {
    let callerReads = 0;
    afterQuery = sql => {
      if (sql.includes('entity-project-caller')) {
        callerReads++;
        if (phase === 'prepare' && callerReads === 1) run("DELETE FROM project_members WHERE project_id='p' AND subject_kind='account' AND subject_id='owner'");
      }
      if (phase === 'return' && sql.includes('FROM bot_profiles')) run("DELETE FROM project_members WHERE project_id='p' AND subject_kind='account' AND subject_id='owner'");
    };
    noBody(await call('get_project_entity', { project_id: 'p' }), 'NOT_PROJECT_MEMBER');
  });
  it.each(['owner-epoch', 'db-epoch', 'caller-deleted', 'input-changed'])('invalidates data after %s changes even with the same DB object', async mode => {
    afterTx = () => {
      if (mode === 'owner-epoch') host.generation++;
      if (mode === 'db-epoch') setCurrentDbClient(client, 'owner');
      if (mode === 'caller-deleted') run("DELETE FROM sessions WHERE id='caller'");
      if (mode === 'input-changed') inputKey = 'different-turn';
    };
    noBody(await call('get_project_progress', { project_id: 'p' }));
  });
  it('requires the actual group owner lease; read-self modes and route keys cannot supply it', async () => {
    bot('group'); ownerInput = true;
    run("UPDATE bot_session_links SET route_key='group:owner' WHERE id='link'");
    noBody(await call(), 'GROUP_AUTHORIZATION_REQUIRED');
    unregister = registerGroupToolAuthority('caller', { botId: 'owner', mode: 'tools', validate: async () => undefined, isCurrent: () => true });
    noBody(await call(), 'GROUP_AUTHORIZATION_REQUIRED');
    unregister();
    let current = true;
    unregister = registerGroupToolAuthority('caller', { botId: 'owner', mode: 'owner', validate: async () => undefined, isCurrent: () => current });
    expect(await call()).toMatchObject({ ok: true, projects: [{ id: 'p' }] });
    afterTx = () => { current = false; };
    noBody(await call('get_project_progress', { project_id: 'p' }), 'GROUP_AUTHORIZATION_REQUIRED');
  });
  it('returns complete current items alongside 100-event cursor pages and ignores stale completions', async () => {
    const insert = db.prepare("INSERT INTO sessions(id,title,project_id,created_at,updated_at) VALUES (?,?,'p',1,1)");
    for (let i = 0; i < 120; i++) insert.run(`s${i}`, 'Same task');
    for (let i = 0; i < 102; i++) await client.tx('workItemProgress.execute', {
      intent: { projectId: 'p', sessionId: 's0', requestId: `r${i}`, expectedRevision: i, expectedBindingRevision: 0, to: i % 2 ? 'review' : 'doing' },
      context: { actor: { kind: 'account', id: 'owner' }, now: i + 1 },
    });
    const page = await call('get_project_progress', { project_id: 'p' });
    expect(page).toMatchObject({ ok: true, historyPage: { limit: 100, hasMore: true } });
    expect(page.items).toHaveLength(120); expect(page.history).toHaveLength(100);
    const second = await call('get_project_progress', { project_id: 'p', before_event_id: page.historyPage.nextBeforeEventId });
    expect(second.items).toEqual(page.items); expect(second.history).toHaveLength(2);
    expect(second.historyPage.hasMore).toBe(false);
    await client.tx('workItemProgress.execute', {
      intent: { projectId: 'p', sessionId: 's0', requestId: 'confirmed', expectedRevision: 102, expectedBindingRevision: 0, to: 'done', completionNote: 'Owner progress confirmation, not business acceptance' },
      context: { actor: { kind: 'account', id: 'owner' }, now: 103 },
    });
    const confirmed = await call('get_project_progress', { project_id: 'p' });
    expect(confirmed.items.find((item: { sessionId: string }) => item.sessionId === 's0').progress.status).toBe('done');
    run("INSERT INTO work_item_progress(session_id,project_id,binding_revision,status,revision,updated_by_kind,updated_by_id,updated_at) VALUES ('s1','p',0,'done',1,'account','owner',1)");
    run("UPDATE sessions SET project_binding_revision=1 WHERE id='s0'");
    const moved = await call('get_project_progress', { project_id: 'p' });
    expect(moved.items.find((item: { sessionId: string }) => item.sessionId === 's0').progress).toBeNull();
    expect(moved.items.find((item: { sessionId: string }) => item.sessionId === 's1').progress.status).toBeNull();
  });
  it('does not release a stale list or a suspended bot read', async () => {
    // Revoke in the window between the service's own terminal membership read and the
    // adapter's final authority snapshot. The service already drops in-flight content
    // (`projectAccess.test.ts`); this asserts the adapter guard still refuses to release a
    // project id whose membership disappeared after that read.
    afterQuery = sql => {
      if (sql.includes('FROM project_members WHERE subject_kind')) run("DELETE FROM project_members WHERE project_id='p' AND subject_kind='account' AND subject_id='owner'");
    };
    noBody(await call(), 'NOT_PROJECT_MEMBER');
    afterQuery = undefined; bot(); ownerInput = false;
    afterTx = () => { run("UPDATE bot_profiles SET status='paused' WHERE id='owner'"); };
    noBody(await call('get_project_progress', { project_id: 'q' }), 'TASK_ACTION_AUTHORIZATION_EXPIRED');
  });
  it('does not turn a verified nonowner channel speaker into an account or bot project grant', async () => {
    bot('channel');
    unregister = beginChannelToolScope({ sessionId: 'caller', sessionInstanceId: 'instance', scope: {
      channel: 'discord', botId: 'owner', laneUserId: 'guest', chatId: 'group', chatKind: 'group', requesterIsOwner: false, companion: true,
    } });
    noBody(await call(), 'TASK_ACTION_SOURCE_UNAUTHORIZED');
  });
  it('sanitizes storage exceptions and does not write via read tools', async () => {
    const before = db.prepare('SELECT total_changes()').pluck().get();
    expect(await call()).toMatchObject({ ok: true });
    expect(await call('get_project_entity', { project_id: 'p' })).toMatchObject({ ok: true });
    expect(await call('get_project_progress', { project_id: 'p' })).toMatchObject({ ok: true });
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(before);
    afterQuery = () => { throw new Error('secret SQL private-goal storageRef /private/path'); };
    const failed = await call(); noBody(failed, 'INTERNAL');
    expect(JSON.stringify(failed)).not.toMatch(/secret|storageRef|private\/path/);
  });
});
