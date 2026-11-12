/**
 * DB tier: real public MCP -> adapter -> project service -> named dispatcher ->
 * SQLite with the target official migration replay through 0151, once per file.
 * Protects project-core C1-C5 and source/owner lifecycle at the final dispatch
 * boundary. Existing read tests / controlled public callbacks cannot catch writes
 * escaping after async prechecks. Minimal input: update while its precheck changes
 * the owner epoch. Controlled Electron, live runtime and group lease; no real user
 * DB, network, group or model. Fixtures use transactions and rollback.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createSourceFile, forEachChild, isPropertyAssignment, isObjectLiteralExpression, ScriptTarget, transpileModule, type Node, type ObjectLiteralExpression } from 'typescript';
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
import { createDesktopTaskActionAuthorizer } from '../../maker-ipc/taskActionHost';
import { createTaskToolCallAuthorizer } from '../../maker-ipc/taskToolCallAuthorizer';
import { beginChannelToolScope } from '../../im/shared/channelToolScope';
import { registerGroupToolAuthority } from '../../maker-ipc/botGroupToolAuthorization';
import { createEntityProjectManagement } from '../../mcp-integrations/entityProjectManagement';
import type { EntityProjectRuntime } from '../../mcp-integrations/entityProjectAuthority';
import { createEntityProjectMutation } from '../../mcp-integrations/entityProjectMutation';
import { setSessionOpeningModelAdmission } from '../../localDb/sessionOpening';
import * as schema from '../../localDb/schema';

const host = vi.hoisted(() => ({ generation: 1, pending: false, failNotice: false, db: undefined as Database.Database | undefined }));
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
vi.mock('../../localDb/ipc/sessions', () => ({ broadcastSessionPatched: () => { if (host.failNotice) throw new Error('private-path-secret'); } }));
// Workspace directory and git bootstrap are host filesystem side effects, covered by their own
// tests; keeping them real here would drag the whole session-opening graph into a DB-tier file.
vi.mock('../../localDb/dialogueWorkspace', () => ({ ensureDialogueWorkspaceDir: async () => '/fixture/dialogue' }));
vi.mock('../../git-snapshot/projectGitBootstrap', () => ({ ensureProjectGitInitialized: async () => undefined }));
vi.mock('../../device-link/broadcast-tap', () => ({
  tapWindowBroadcast: () => { if (host.failNotice) throw new Error('private-path-secret'); },
  captureDataOwnerBroadcastScope: () => host.generation,
  isDataOwnerBroadcastScopeCurrent: (generation: number) => host.generation === generation,
}));
vi.mock('../../i18n.desktop', () => ({ t: (key: string) => key }));
// Logging/profile storage is not under test and must not touch the owner's files.
vi.mock('../../logger', () => ({ createLogger: () => ({
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
}) }));
// This file explicitly uses the production in-process client/tx dispatcher. A
// worker process is outside this fixture; do not collect its inline worker bundle.
vi.mock('../../localDb/client/WorkerThreadTransport', () => ({ WorkerThreadTransport: class {
  constructor() { throw new Error('Worker transport is outside this in-process fixture'); }
} }));

// Execute the real xdtHelper provider property expressions, including its existing
// authorizer; keep unrelated provider bootstrap/services outside this fixture.
const providerFile = createSourceFile('mcp-providers.ts', readFileSync(path.resolve(__dirname, '../../mcp-integrations/mcp-providers.ts'), 'utf8'), ScriptTarget.ES2022, true);
let helperObject: ObjectLiteralExpression | undefined;
function findHelper(node: Node): void {
  if (isPropertyAssignment(node) && node.name.getText(providerFile) === 'xdtHelper' && isObjectLiteralExpression(node.initializer)) helperObject = node.initializer;
  forEachChild(node, findHelper);
}
findHelper(providerFile);
const fields = ['entityProjectMutation', 'entityProjects', 'authorizeCall'].map(name => {
  const prop = helperObject?.properties.find(node => isPropertyAssignment(node) && node.name.getText(providerFile) === name);
  if (!prop) throw new Error(`Missing real provider property: ${name}`);
  return prop.getText(providerFile);
});
const providerCode = transpileModule(`return ({${fields.join(',')}});`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
function wiredCallbacks(runtime: EntityProjectRuntime, authorizeTaskToolCall: ReturnType<typeof createTaskToolCallAuthorizer>) {
  const callbacks: Pick<Parameters<typeof createXdtHelperMcpServer>[0], 'entityProjectMutation' | 'entityProjects' | 'authorizeCall'> =
    new Function('createEntityProjectMutation', 'createEntityProjectManagement', 'getTaskActionInputState', 'getTaskActionSession', 'authorizeTaskToolCall', providerCode)(
      createEntityProjectMutation, createEntityProjectManagement, runtime.input, runtime.getSession, authorizeTaskToolCall);
  if (callbacks.authorizeCall !== authorizeTaskToolCall || typeof callbacks.entityProjectMutation !== 'function') throw new Error('Provider lost its real authorizer or mutation callback');
  return callbacks;
}

describe('Desktop entity project mutation DB closure', () => {
  let db: Database.Database;
  let client: DbClient;
  let context: LiziMcpSessionContext | undefined;
  let ownerInput: boolean;
  let inputKey: string;
  let live: ReturnType<Parameters<typeof createDesktopTaskActionAuthorizer>[0]['getSession']>;
  let permissionCurrent = true;
  let plan = false;
  let mcp: Client;
  let server: ReturnType<typeof createXdtHelperMcpServer>;
  let unregister: (() => void) | undefined;
  let afterQuery: ((sql: string) => void) | undefined;
  let dispatchCount = 0;
  let beforeTx: (() => void) | undefined;
  let afterTx: (() => void) | undefined;
  const runtime: EntityProjectRuntime = {
    input: () => ({ key: inputKey, boundary: 'instance:1', ownerInput, permission: { permissionMode: 'bypassPermissions', planModeEnabled: plan, isCurrent: () => permissionCurrent } }),
    getSession: () => live,
  };
  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
  async function call(name = 'mutate_project_entity', args: object = {}) {
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
  beforeAll(() => {
    db = createBetterSqliteDatabase(':memory:'); host.db = db;
    const root = path.resolve(__dirname, '../../../..');
    db.loadExtension(path.join(root, 'native/sqlite-vec', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib'));
    runMigrationReplay(db, { drizzleDir: path.join(root, 'drizzle') });
  });
  beforeEach(async () => {
    db.exec('BEGIN');
    host.generation = 1; host.pending = false; host.failNotice = false; dispatchCount = 0; beforeTx = undefined;
    context = { agentKind: 'pi', workingDir: '/fixture', sessionId: 'caller' };
    permissionCurrent = true; plan = false;
    ownerInput = true; inputKey = 'accepted-owner-input';
    live = { instanceId: 'instance', getCurrentTurnOrigin: () => null, stablePermissionModeState: { mode: 'bypassPermissions', generation: 1 }, stablePlanModeState: { enabled: false, generation: 1 }, reviewHostPermissionAction: async () => ({ verdict: 'allow' }) };
    afterQuery = undefined; afterTx = undefined;
    // The host installs its model catalog once; this fixture admits the prepared body unchanged
    // so the createWorkItem host path (openSession -> insert -> emit) can run at the DB tier.
    setSessionOpeningModelAdmission(async body => body);
    run("INSERT INTO sessions(id,created_at,updated_at) VALUES ('caller',1,1),('target',1,1)");
    run("INSERT INTO projects(id,name,goal,owner_id,status,created_at,updated_at) VALUES ('p','Same name','private-goal','owner','active',1,1),('q','Same name',NULL,'other','active',1,1)");
    run("INSERT INTO project_members(project_id,subject_kind,subject_id,role,added_at) VALUES ('p','account','owner','owner',1),('q','account','other','owner',1),('q','bot','owner','member',1)");
    client = await createInprocDbClient();
    const query = client.query.bind(client);
    const queryOne = client.queryOne.bind(client);
    const tx = client.tx.bind(client);
    client.query = async <T>(sql: string, params?: unknown[]) => { const result = await query<T>(sql, params); afterQuery?.(sql); return result; };
    client.queryOne = async <T>(sql: string, params?: unknown[]) => { const result = await queryOne<T>(sql, params); afterQuery?.(sql); return result; };
    client.tx = async <T>(name: string, args: unknown) => { if (name === 'projects.execute' || name === 'workItemProgress.execute') { dispatchCount++; beforeTx?.(); } const result = await tx<T>(name, args); afterTx?.(); return result; };
    setCurrentDbClient(client, 'owner');
    const authorizeTaskToolCall = createTaskToolCallAuthorizer({ getDb: () => client, isScopeCurrent: candidate => candidate === client,
      authorizeAction: createDesktopTaskActionAuthorizer({
        input: runtime.input, getSession: () => live, confirm: async () => false,
      }),
    });
    server = createXdtHelperMcpServer({
      ...wiredCallbacks(runtime, authorizeTaskToolCall),
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

  const mutate = (intent: object) => call('mutate_project_entity', { intent });
  const account = { kind: 'account', id: 'owner' };
  const member = { kind: 'bot', id: 'member' };
  const query = (sql: string) => db.prepare(sql).all();

  // A conversation/group tool must use the same progress ledger as the UI, not a
  // second status store. Verify actual event receipts and same-request replay.
  it('records explicit progress on the original task and replays the same request once through public MCP', async () => {
    run("UPDATE sessions SET project_id='p' WHERE id='target'");
    const intent = { action: 'recordProgress', projectId: 'p', sessionId: 'target',
      expectedRevision: 0, expectedBindingRevision: 0, requestId: 'explicit-progress', to: 'doing' };
    const first = await mutate(intent);
    expect(first).toMatchObject({ ok: true, projectId: 'p', sessionId: 'target', progressReceipt: { revision: 1, replayed: false } });
    expect(await mutate(intent)).toMatchObject({ ok: true, progressReceipt: { revision: 1, replayed: true } });
    expect(query("SELECT count(*) AS n FROM work_item_progress_events WHERE session_id='target'")).toEqual([{ n: 1 }]);
  });

  it('returns a real owner completion receipt only with the required completion note', async () => {
    run("UPDATE sessions SET project_id='p' WHERE id='target'");
    const base = { action: 'recordProgress', projectId: 'p', sessionId: 'target', expectedBindingRevision: 0 };
    expect(await mutate({ ...base, requestId: 'owner-review', expectedRevision: 0, to: 'review' })).toMatchObject({ ok: true });
    expect(await mutate({ ...base, requestId: 'missing-note', expectedRevision: 1, to: 'done' })).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
    expect(query("SELECT status,revision FROM work_item_progress WHERE session_id='target'")).toEqual([{ status: 'review', revision: 1 }]);
    expect(await mutate({ ...base, requestId: 'owner-confirmed-done', expectedRevision: 1, to: 'done', completionNote: 'Explicit owner confirmation' }))
      .toMatchObject({ ok: true, progressReceipt: { revision: 2, replayed: false } });
    expect(query("SELECT status,revision FROM work_item_progress WHERE session_id='target'")).toEqual([{ status: 'done', revision: 2 }]);
  });

  it('does not let an ordinary member confirm completion via the conversation tool', async () => {
    bot(); ownerInput = false;
    run("UPDATE sessions SET project_id='q' WHERE id='target'");
    const base = { action: 'recordProgress', projectId: 'q', sessionId: 'target', expectedBindingRevision: 0 };
    expect(await mutate({ ...base, expectedRevision: 0, requestId: 'member-review', to: 'review' })).toMatchObject({ ok: true });
    expect(await mutate({ ...base, expectedRevision: 1, requestId: 'member-done', to: 'done', completionNote: 'Not owner' })).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(query("SELECT status FROM work_item_progress WHERE session_id='target'")).toEqual([{ status: 'review' }]);
  });

  it('reconciles lost progress acknowledgement with the original requestId and refuses replay after membership revocation', async () => {
    run("UPDATE sessions SET project_id='p' WHERE id='target'");
    const intent = { action: 'recordProgress', projectId: 'p', sessionId: 'target',
      expectedRevision: 0, expectedBindingRevision: 0, requestId: 'lost-progress', to: 'doing' };
    afterTx = () => { throw new Error('ACK lost'); };
    expect(await mutate(intent)).toMatchObject({ ok: false, data: { writeOutcome: 'unknown' } });
    afterTx = undefined;
    expect(await mutate(intent)).toMatchObject({ ok: true, progressReceipt: { revision: 1, replayed: true } });
    beforeTx = () => run("DELETE FROM project_members WHERE project_id='p' AND subject_kind='account' AND subject_id='owner'");
    expect(await mutate(intent)).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(query("SELECT count(*) AS n FROM work_item_progress_events WHERE session_id='target'")).toEqual([{ n: 1 }]);
  });

  it('requires the real group owner-action lease before applying explicit feedback to the existing task', async () => {
    bot('group');
    run("UPDATE sessions SET project_id='p' WHERE id='target'");
    const intent = { action: 'recordProgress', projectId: 'p', sessionId: 'target',
      expectedRevision: 0, expectedBindingRevision: 0, requestId: 'group-feedback', to: 'doing' };
    expect(await mutate(intent)).toMatchObject({ ok: false });
    expect(query("SELECT count(*) AS n FROM work_item_progress_events WHERE session_id='target'")).toEqual([{ n: 0 }]);
    let current = true;
    unregister = registerGroupToolAuthority('caller', { botId: 'owner', mode: 'owner', validate: async () => undefined, isCurrent: () => current });
    expect(await mutate(intent)).toMatchObject({ ok: true, progressReceipt: { revision: 1 } });
    current = false;
    expect(await mutate({ ...intent, requestId: 'revoked-group', expectedRevision: 1, to: 'review' })).toMatchObject({ ok: false });
    expect(query("SELECT count(*) AS n FROM work_item_progress_events WHERE session_id='target'")).toEqual([{ n: 1 }]);
  });

  // Public MCP -> actual authority/service/worker: supplement the original Session,
  // retaining progress/binding and rejecting stale edits, revocation and archive.
  // Existing create/assignee tests did not cover title/objective persistence (DB tier).
  it('leaves no session row when task creation is refused before the insert', async () => {
    // The conflict branch was covered; this covers "nothing was written at all": an archived
    // project must not leave a half-created session behind (rollback, not just an error code).
    // `writeOutcome` deliberately stays `unknown` for this action: a post-commit NOT_FOUND from the
    // caller-side owner check is indistinguishable here, and only ALREADY_EXISTS is provably pre-insert.
    run("UPDATE projects SET status='archived' WHERE id='p'");
    expect(await mutate({ action: 'createWorkItem', projectId: 'p', sessionId: 'never-created',
      title: 'Rejected task', taskObjective: 'Never stored', assignee: null }))
      .toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED', data: { writeOutcome: 'unknown' } });
    expect(query("SELECT id FROM sessions WHERE id='never-created'")).toEqual([]);
  });
  it('supplements one existing task with an observed timestamp and never creates or dispatches another session', async () => {
    run("UPDATE sessions SET project_id='p',title='Original',task_objective='Initial',updated_at=100 WHERE id='caller'");
    const intent = { action: 'updateWorkItem', projectId: 'p', sessionId: 'caller',
      expectedBindingRevision: 0, expectedUpdatedAt: new Date(100).toISOString(), title: 'Refined', taskObjective: 'Clarified objective' };
    expect(await mutate(intent)).toMatchObject({ ok: true, projectId: 'p', sessionId: 'caller' });
    const detail = await call('get_project_entity', { project_id: 'p' });
    expect(JSON.stringify(detail)).toContain('Clarified objective');
    expect(query("SELECT title,task_objective FROM sessions WHERE id='caller'")).toEqual([{ title: 'Refined', task_objective: 'Clarified objective' }]);
    expect(await mutate({ ...intent, title: 'Stale overwrite' })).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
    expect(query("SELECT title FROM sessions WHERE id='caller'")).toEqual([{ title: 'Refined' }]);
  });

  it.each(['revoked', 'archived', 'task-archived', 'other-project', 'rebound'])('rejects %s task supplementation under the transaction lock', async mode => {
    run("UPDATE sessions SET project_id='p',title='Original',updated_at=100 WHERE id='caller'");
    beforeTx = () => {
      if (mode === 'revoked') run("DELETE FROM project_members WHERE project_id='p' AND subject_kind='account' AND subject_id='owner'");
      if (mode === 'archived') run("UPDATE projects SET status='archived' WHERE id='p'");
      if (mode === 'task-archived') run("UPDATE sessions SET status='archived' WHERE id='caller'");
      if (mode === 'other-project') run("UPDATE sessions SET project_id='q' WHERE id='caller'");
      if (mode === 'rebound') run("UPDATE sessions SET project_binding_revision=2 WHERE id='caller'");
    };
    expect(await mutate({ action: 'updateWorkItem', projectId: 'p', sessionId: 'caller',
      expectedBindingRevision: 0, expectedUpdatedAt: new Date(100).toISOString(), taskObjective: 'Must not save' })).toMatchObject({ ok: false });
    expect(query("SELECT title,task_objective FROM sessions WHERE id='caller'")).toEqual([{ title: 'Original', task_objective: null }]);
  });

  it('allows a genuine member to supplement a task without granting project-owner operations', async () => {
    bot(); ownerInput = false;
    run("UPDATE sessions SET project_id='q',title='Original',updated_at=100 WHERE id='target'");
    expect(await mutate({ action: 'updateWorkItem', projectId: 'q', sessionId: 'target',
      expectedBindingRevision: 0, expectedUpdatedAt: new Date(100).toISOString(), taskObjective: 'Member clarification' })).toMatchObject({ ok: true });
    expect(await mutate({ action: 'update', projectId: 'q', status: 'archived' })).toMatchObject({ ok: false, errorCode: 'NOT_PROJECT_OWNER' });
    expect(query("SELECT task_objective FROM sessions WHERE id='target'")).toEqual([{ task_objective: 'Member clarification' }]);
    expect(query("SELECT status FROM projects WHERE id='q'")).toEqual([{ status: 'active' }]);
  });

  it('recovers a supplement after a lost commit acknowledgement by reading the same task and rejects stale replay', async () => {
    run("UPDATE sessions SET project_id='p',title='Original',updated_at=100 WHERE id='caller'");
    const intent = { action: 'updateWorkItem', projectId: 'p', sessionId: 'caller',
      expectedBindingRevision: 0, expectedUpdatedAt: new Date(100).toISOString(), taskObjective: 'Saved once' };
    afterTx = () => { throw new Error('Lost acknowledgement'); };
    expect(await mutate(intent)).toMatchObject({ ok: false, errorCode: 'INTERNAL', data: { writeOutcome: 'unknown' } });
    afterTx = undefined;
    expect(JSON.stringify(await call('get_project_entity', { project_id: 'p' }))).toContain('Saved once');
    expect(await mutate(intent)).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
    expect(query("SELECT count(*) AS n FROM sessions WHERE id='caller' AND task_objective='Saved once'")).toEqual([{ n: 1 }]);
  });

  it('executes all seven actions, preserves same-ID kinds, deduplicates members and clears nullable values', async () => {
    const created = await mutate({ action: 'create', input: { name: ' New ', goal: ' Goal ', owner: { kind: 'bot', id: 'owner' },
      members: [account, member, member, { kind: 'bot', id: 'other-same-name' }] } });
    expect(created.ok).toBe(true);
    expect(Object.keys(created).sort()).toEqual(['ok', 'projectId', 'sessionId']);
    const p = created.projectId;
    expect(db.prepare('SELECT name,goal FROM projects WHERE id=?').get(p)).toEqual({ name: 'New', goal: 'Goal' });
    expect(db.prepare('SELECT subject_kind,subject_id,role FROM project_members WHERE project_id=? ORDER BY subject_kind,subject_id').all(p))
      .toEqual([{ subject_kind: 'account', subject_id: 'owner', role: 'member' },
        { subject_kind: 'bot', subject_id: 'member', role: 'member' },
        { subject_kind: 'bot', subject_id: 'other-same-name', role: 'member' },
        { subject_kind: 'bot', subject_id: 'owner', role: 'owner' }]);
    // The explicit business owner did not become the account caller.
    expect(await mutate({ action: 'update', projectId: p, name: 'Denied' })).toMatchObject({ errorCode: 'NOT_PROJECT_OWNER', data: { writeOutcome: 'not-applied' } });
    expect(await mutate({ action: 'update', projectId: 'p', name: 'Changed', goal: null, status: 'archived' })).toMatchObject({ ok: true });
    expect(query("SELECT name,goal,status FROM projects WHERE id='p'")).toEqual([{ name: 'Changed', goal: null, status: 'archived' }]);
    expect(await mutate({ action: 'update', projectId: 'p', status: 'active' })).toMatchObject({ ok: true });
    expect(await mutate({ action: 'addMember', projectId: 'p', subject: member })).toMatchObject({ ok: true });
    expect(await mutate({ action: 'bindSession', sessionId: 'target', projectId: 'p' })).toEqual({ ok: true, projectId: 'p', sessionId: 'target' });
    expect(await mutate({ action: 'setAssignee', sessionId: 'target', assignee: member })).toMatchObject({ ok: true });
    expect(query("SELECT project_id,assignee_kind,assignee_id FROM sessions WHERE id='target'"))
      .toEqual([{ project_id: 'p', assignee_kind: 'bot', assignee_id: 'member' }]);
    expect(await mutate({ action: 'setAssignee', sessionId: 'target', assignee: null })).toMatchObject({ ok: true });
    expect(query("SELECT assignee_id FROM sessions WHERE id='target'")).toEqual([{ assignee_id: null }]);
    expect(await mutate({ action: 'bindSession', sessionId: 'target', projectId: null })).toEqual({ ok: true, projectId: null, sessionId: 'target' });
    expect(await mutate({ action: 'removeMember', projectId: 'p', subject: member })).toMatchObject({ ok: true });
    expect(await mutate({ action: 'addMember', projectId: 'p', subject: { kind: 'bot', id: 'owner' } })).toMatchObject({ ok: true });
    expect(await mutate({ action: 'transferOwner', projectId: 'p', subject: { kind: 'bot', id: 'owner' } })).toMatchObject({ ok: true });
    expect(query("SELECT subject_kind,role FROM project_members WHERE project_id='p' ORDER BY subject_kind"))
      .toEqual([{ subject_kind: 'account', role: 'member' }, { subject_kind: 'bot', role: 'owner' }]);
    expect(dispatchCount).toBe(11);
    expect(await call('list_projects')).toMatchObject({ ok: true, projects: [{ project_path: '/fixture' }] });
    expect(await call('get_project_entity', { project_id: 'p' })).toMatchObject({ ok: true, project: { id: 'p' } });
  });
  it('defaults business owner in the real service and rejects injected identity before any dispatch', async () => {
    const result = await mutate({ action: 'create', input: { name: 'Default' } });
    expect(result.ok).toBe(true);
    expect(db.prepare('SELECT owner_id FROM projects WHERE id=?').get(result.projectId)).toEqual({ owner_id: 'owner' });
    for (const key of ['actor', 'role', 'now', 'newId', 'callerSessionId', 'grant']) {
      expect(await mutate({ action: 'create', input: { name: 'Forged' }, [key]: 'forged' })).toMatchObject({ errorCode: 'INVALID_ARGS' });
    }
    expect(dispatchCount).toBe(1);
    expect(query("SELECT id FROM projects WHERE name='Forged'")).toEqual([]);
  });
  it('keeps bot agency separate from same-ID owner and accepts verified owner agency', async () => {
    bot(); ownerInput = false;
    expect(await mutate({ action: 'update', projectId: 'p', name: 'Bad' })).toMatchObject({ errorCode: 'NOT_PROJECT_OWNER' });
    expect(await mutate({ action: 'bindSession', projectId: 'q', sessionId: 'target' })).toMatchObject({ ok: true });
    ownerInput = true;
    expect(await mutate({ action: 'update', projectId: 'p', name: 'Owner action' })).toMatchObject({ ok: true });
    expect(dispatchCount).toBe(2);
  });
  it('uses transaction membership recheck if access is revoked after service prechecks', async () => {
    beforeTx = () => run("DELETE FROM project_members WHERE project_id='p' AND subject_kind='account' AND subject_id='owner'");
    expect(await mutate({ action: 'update', projectId: 'p', name: 'Must not write' })).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(query("SELECT name FROM projects WHERE id='p'")).toEqual([{ name: 'Same name' }]);
    expect(dispatchCount).toBe(1);
  });
  it.each(['owner-epoch', 'input', 'db-epoch', 'instance'])('blocks %s change during asynchronous project prechecks before dispatch', async mode => {
    afterQuery = sql => {
      if (!sql.includes('SELECT owner_id AS ownerId FROM projects')) return;
      if (mode === 'owner-epoch') host.generation++;
      if (mode === 'input') inputKey = 'other-input';
      if (mode === 'db-epoch') setCurrentDbClient(client, 'owner');
      if (mode === 'instance') live = { ...live!, instanceId: 'other' };
    };
    expect(await mutate({ action: 'update', projectId: 'p', name: 'Must not write' })).toMatchObject({ ok: false, data: { writeOutcome: 'not-applied' } });
    expect(dispatchCount).toBe(0);
    expect(query("SELECT name FROM projects WHERE id='p'")).toEqual([{ name: 'Same name' }]);
  });
  it.each(['owner-epoch', 'input', 'caller-deleted', 'notice', 'exception'])('reports unknown after commit when %s fails without retrying or leaking content', async mode => {
    afterTx = () => {
      if (mode === 'owner-epoch') host.generation++;
      if (mode === 'input') inputKey = 'other-input';
      if (mode === 'caller-deleted') run("DELETE FROM sessions WHERE id='caller'");
      if (mode === 'notice') host.failNotice = true;
      if (mode === 'exception') throw new Error('private-path-secret');
    };
    const result = await mutate({ action: 'update', projectId: 'p', name: 'Committed' });
    expect(result).toMatchObject({ ok: false, data: { writeOutcome: 'unknown' } });
    expect(JSON.stringify(result)).not.toContain('private-path-secret');
    expect(query("SELECT name FROM projects WHERE id='p'")).toEqual([{ name: 'Committed' }]);
    expect(dispatchCount).toBe(1);
  });
  it('does not turn loss of project read access after a successful action into an uncommitted write', async () => {
    afterTx = () => run("DELETE FROM project_members WHERE project_id='p' AND subject_kind='account' AND subject_id='owner'");
    expect(await mutate({ action: 'update', projectId: 'p', name: 'Committed' })).toEqual({ ok: true, projectId: 'p', sessionId: null });
    afterTx = undefined;
    expect(await call('get_project_entity', { project_id: 'p' })).toMatchObject({ ok: false, errorCode: 'NOT_PROJECT_MEMBER' });
    expect(dispatchCount).toBe(1);
  });
  it('requires a live group owner lease and rechecks it after asynchronous prechecks', async () => {
    bot('group');
    expect(await mutate({ action: 'update', projectId: 'p', name: 'Bad' })).toMatchObject({ ok: false });
    let current = true;
    unregister = registerGroupToolAuthority('caller', { botId: 'owner', mode: 'owner', validate: async () => undefined, isCurrent: () => current });
    expect(await mutate({ action: 'update', projectId: 'p', name: 'Owner group' })).toMatchObject({ ok: true });
    afterQuery = sql => { if (sql.includes('SELECT owner_id AS ownerId FROM projects')) current = false; };
    expect(await mutate({ action: 'update', projectId: 'p', name: 'Bad' })).toMatchObject({ ok: false, data: { writeOutcome: 'not-applied' } });
    expect(dispatchCount).toBe(1);
  });
  it.each(['shared', 'remote', 'channel-guest', 'missing-runtime'])('rejects %s provenance without actor fallback or writes', async mode => {
    if (mode === 'shared') run("UPDATE sessions SET source='shared' WHERE id='caller'");
    if (mode === 'remote') run("UPDATE sessions SET remote_host_id='remote' WHERE id='caller'");
    if (mode === 'missing-runtime') live = undefined;
    if (mode === 'channel-guest') {
      bot('channel');
      unregister = beginChannelToolScope({ sessionId: 'caller', sessionInstanceId: 'instance', scope: {
        channel: 'discord', botId: 'owner', laneUserId: 'guest', chatId: 'group', chatKind: 'group', requesterIsOwner: false, companion: true,
      } });
    }
    expect(await mutate({ action: 'create', input: { name: 'Bad', owner: account } })).toMatchObject({ ok: false });
    expect(dispatchCount).toBe(0);
    expect(query("SELECT id FROM projects WHERE name='Bad'")).toEqual([]);
  });
  it.each(['plan', 'permission-revoked'])('keeps original task permission behavior for %s', async mode => {
    bot(); ownerInput = true;
    if (mode === 'plan') { plan = true; ownerInput = false; }
    if (mode === 'permission-revoked') afterQuery = sql => {
      if (sql.includes('SELECT owner_id AS ownerId FROM projects')) permissionCurrent = false;
    };
    expect(await mutate({ action: 'update', projectId: 'p', name: 'Bad' })).toMatchObject({ ok: false });
    expect(dispatchCount).toBe(0);
    expect(query("SELECT name FROM projects WHERE id='p'")).toEqual([{ name: 'Same name' }]);
  });
  it('reports a deterministic progress refusal as not-applied instead of an unknown write', async () => {
    // Rule: a refusal the progress transaction raises before any insert (stale revision,
    // illegal transition, missing note, not the owner for done) provably wrote nothing.
    // Reporting it as unknown tells the model to reread and hesitate instead of fixing input.
    run("UPDATE sessions SET project_id='p' WHERE id='target'");
    const base = { action: 'recordProgress', projectId: 'p', sessionId: 'target', expectedBindingRevision: 0 };
    expect(await mutate({ ...base, expectedRevision: 0, requestId: 'seed-doing', to: 'doing' })).toMatchObject({ ok: true });
    expect(await mutate({ ...base, expectedRevision: 0, requestId: 'stale-review', to: 'review' }))
      .toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED', data: { writeOutcome: 'not-applied' } });
    expect(await mutate({ ...base, expectedRevision: 1, requestId: 'missing-note', to: 'done' }))
      .toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED', data: { writeOutcome: 'not-applied' } });
    expect(query("SELECT status,revision FROM work_item_progress WHERE session_id='target'")).toEqual([{ status: 'doing', revision: 1 }]);
  });
  it('keeps the observed timestamp when a supplement repeats the same content', async () => {
    // `updated_at` is both the edit observation and the activity timestamp, so a no-op
    // must not advance it: otherwise the caller's own repeat looks stale and the task
    // jumps to the top of the list although nothing changed.
    run("UPDATE sessions SET project_id='p',title='Original',task_objective='Initial',updated_at=100 WHERE id='caller'");
    const intent = { action: 'updateWorkItem', projectId: 'p', sessionId: 'caller',
      expectedBindingRevision: 0, expectedUpdatedAt: new Date(100).toISOString(), title: 'Refined', taskObjective: 'Clarified objective' };
    expect(await mutate(intent)).toMatchObject({ ok: true });
    const observed = (query("SELECT updated_at AS updatedAt FROM sessions WHERE id='caller'") as Array<{ updatedAt: number }>)[0].updatedAt;
    expect(await mutate({ ...intent, expectedUpdatedAt: new Date(observed).toISOString() })).toMatchObject({ ok: true });
    expect(query("SELECT title,task_objective,updated_at AS updatedAt FROM sessions WHERE id='caller'"))
      .toEqual([{ title: 'Refined', task_objective: 'Clarified objective', updatedAt: observed }]);
  });
  it('creates one unsent project task through the host path and reports an id collision as not-applied', async () => {
    // M4/M3: the host path (openSession -> model admission -> dialogue dir -> emitSessionCreated)
    // had no DB-tier evidence, and a caller-supplied id collision surfaced as INTERNAL + unknown.
    const create = { action: 'createWorkItem', projectId: 'p', sessionId: 'newtask', title: 'Draft task',
      taskObjective: 'Prepare the draft', assignee: { kind: 'account', id: 'owner' } };
    expect(await mutate(create)).toMatchObject({ ok: true, projectId: 'p', sessionId: 'newtask' });
    expect(query("SELECT project_id,title,task_objective,assignee_id FROM sessions WHERE id='newtask'"))
      .toEqual([{ project_id: 'p', title: 'Draft task', task_objective: 'Prepare the draft', assignee_id: 'owner' }]);
    expect(await mutate({ ...create, title: 'Different title' }))
      .toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED', data: { writeOutcome: 'not-applied' } });
    expect(query("SELECT title FROM sessions WHERE id='newtask'")).toEqual([{ title: 'Draft task' }]);
  });
  it('keeps the committed progress receipt when the change broadcast fails', async () => {
    // The receipt is the caller's proof of commit; an invalidation that could not be delivered
    // must not turn it into INTERNAL/unknown (same rule as localDb/ipc/projectProgress.ts).
    run("UPDATE sessions SET project_id='p' WHERE id='target'");
    host.failNotice = true;
    expect(await mutate({ action: 'recordProgress', projectId: 'p', sessionId: 'target',
      expectedRevision: 0, expectedBindingRevision: 0, requestId: 'broadcast-failure', to: 'doing' }))
      .toMatchObject({ ok: true, progressReceipt: { revision: 1, replayed: false } });
    expect(query("SELECT count(*) AS n FROM work_item_progress_events WHERE session_id='target'")).toEqual([{ n: 1 }]);
  });
  it('reports unknown, not not-applied, when the post-write guard fails after the event was committed', async () => {
    // The whitelist only covers transaction-phase refusals. A failure after commit means the
    // write may exist, so it must stay unknown even though its code looks like a refusal.
    run("UPDATE sessions SET project_id='p' WHERE id='target'");
    afterTx = () => { host.generation = 2; };
    expect(await mutate({ action: 'recordProgress', projectId: 'p', sessionId: 'target',
      expectedRevision: 0, expectedBindingRevision: 0, requestId: 'post-write-guard', to: 'doing' }))
      .toMatchObject({ ok: false, data: { writeOutcome: 'unknown' } });
    expect(query("SELECT count(*) AS n FROM work_item_progress_events WHERE session_id='target'")).toEqual([{ n: 1 }]);
  });
  it('keeps domain invariants and rolls back partial transaction writes', async () => {
    expect(await mutate({ action: 'removeMember', projectId: 'p', subject: account })).toMatchObject({ errorCode: 'PRECONDITION_FAILED' });
    expect(await mutate({ action: 'bindSession', sessionId: 'target', projectId: 'p' })).toMatchObject({ ok: true });
    expect(await mutate({ action: 'setAssignee', sessionId: 'target', assignee: member })).toMatchObject({ errorCode: 'PRECONDITION_FAILED' });
    // Transaction inserts the project before validating each member subject; rollback must remove it.
    // (Member count is no longer capped, so an over-long subject id is the failing input.)
    expect(await mutate({ action: 'create', input: { name: 'Rollback', members: [{ ...member, id: 'x'.repeat(201) }] } })).toMatchObject({ errorCode: 'INVALID_PARAMS' });
    expect(query("SELECT id FROM projects WHERE name='Rollback'")).toEqual([]);
    expect(query("SELECT assignee_id FROM sessions WHERE id='target'")).toEqual([{ assignee_id: null }]);
    expect(dispatchCount).toBe(4);
  });
});
