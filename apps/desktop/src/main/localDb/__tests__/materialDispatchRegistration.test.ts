/** Integration/DB: missing named registration or broken inline serialization loses durable
 * selectors. Real dispatcher + inline + production-configured CJS file worker, full formal migrations.
 * Minimal failure: queue ACK lost then original key reread/replay, or revoked replay.
 * Actual original message writer INSERT + attach share its outer transaction.
 * No public IPC/queue/consumer or real user data claim.
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildDbWorkerBundle } from './dbWorkerTestUtils';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runMigrationReplay } from '../migrationRunner';
import { dispatch } from '../worker/dispatcher';
import { WorkerThreadTransport } from '../client/WorkerThreadTransport';
import { saveAgentInputQueueSnapshot, loadAgentInputQueueSnapshot, awaitAgentInputQueueSnapshotPersistence } from '../agentInputQueueSnapshots';
import { ScriptTarget, transpileModule } from 'typescript';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { DbClient } from '../client/DbClient';
import { setCurrentDbClient, clearCurrentDbClient, getCurrentDbClientSnapshot } from '../client/current';
import { createMaterialInputAdmission, parseQueuedMaterialIntent } from '../../maker-ipc/materialInputAdmission';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue';
import type { DbTxArgsByName, DbTxResultByName } from '../client/tx/types';

let db: Database.Database;
let dir: string;
const root = path.resolve(__dirname, '../../../..');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-material-dispatch-registration-'));
  db = createBetterSqliteDatabase(path.join(dir, 'test.db'));
  db.loadExtension(path.join(root, 'native/sqlite-vec', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib'));
  runMigrationReplay(db, { drizzleDir: path.join(root, 'drizzle') });
  db.exec(`INSERT INTO projects(id,name,owner_id,status,created_at,updated_at) VALUES ('p','fixture','owner','active',1,1);
    INSERT INTO sessions(id,title,created_at,updated_at,project_id,project_binding_revision) VALUES ('task','fixture',1,1,'p',1);
    INSERT INTO project_members VALUES ('p','account','owner','owner',1);
    INSERT INTO material_contexts(id,work_item_id,purpose,refs_json,created_at,project_id,binding_revision,created_by_kind,created_by_id) VALUES ('context','task','reference','[]',1,'p',1,'account','owner');`);
});
afterAll(() => {
  db?.close();
  if (dir && path.dirname(dir) === os.tmpdir() && path.basename(dir).startsWith('cindy-material-dispatch-registration-')) rmSync(dir, { recursive: true, force: true });
});

for (const mode of ['dispatcher', 'inline', 'file-worker'] as const) {
  it(`${mode}: durable selector recovery, identity separation and revoked replay on formal 0151`, async () => {
    db.exec("INSERT OR IGNORE INTO project_members VALUES ('p','account','owner','owner',1)");
    let workerScriptPath: string | undefined;
    if (mode === 'file-worker') {
      workerScriptPath = await buildDbWorkerBundle(path.join(dir, 'worker-build'));
    }
    const worker = mode === 'dispatcher' ? undefined : new WorkerThreadTransport({ dbPath: path.join(dir, 'test.db'), drizzleDir: path.join(root, 'drizzle'),
      useInlineWorker: mode === 'inline', workerScriptPath, betterSqliteModulePath: require.resolve('better-sqlite3') });
    const send = (op: string, args: unknown) => worker ? worker.send(op, args) : dispatch(op, args, db);
    const execute = (args: unknown) => send('tx', { name: 'materialDispatch.execute', args });
    const key = { sessionId: 'task', clientId: mode };
    const host = { actor: { kind: 'account' as const, id: 'owner' }, now: 1000 };
    const selector = { contextId: 'context', projectId: 'p', workItemId: 'task', bindingRevision: 1, purpose: 'reference' as const };
    const queue: DbTxArgsByName['materialDispatch.execute'] = { action: 'queue', key, host, expectedRevision: 0, selector, contentSha256: hash('exact serialized body') };
    try {
      // Deliberately discard first ACK, then recover by the same stable key; never resend.
      await execute(queue);
      const recovered: DbTxResultByName['materialDispatch.execute'] = await execute({ action: 'read', key, host }) as DbTxResultByName['materialDispatch.execute'];
      expect(recovered).toMatchObject({ key, currentRevision: 1, messageId: null, revisions: [{ selector, state: 'queued', attempts: [] }] });
      expect(await execute(queue)).toEqual({ revision: 1, replayed: true });
      await expect(execute({ ...queue, host: undefined })).rejects.toThrow('[INVALID_PARAMS]');
      await expect(execute({ ...queue, host: { ...host, actor: { kind: 'bot', id: 'owner' } } })).rejects.toThrow('[FORBIDDEN]');
      await expect(execute({ ...queue, selector: { ...selector, bindingRevision: 0 } })).rejects.toThrow();
      await send('exec', { sql: "DELETE FROM project_members WHERE project_id='p'" });
      await expect(execute(queue)).rejects.toThrow('[FORBIDDEN]');
      await expect(execute({ action: 'read', key, host })).rejects.toThrow('[FORBIDDEN]');
      expect(await send('queryOne', { sql: 'SELECT COUNT(*) n FROM material_dispatch_revisions WHERE client_id=?', params: [mode] })).toEqual({ n: 1 });
      expect(await send('queryOne', { sql: 'SELECT COUNT(*) n FROM material_dispatch_attempts' })).toEqual({ n: 0 });
      const message: DbTxArgsByName['message.insert'] = { id: `message-${mode}`, clientId: key.clientId, sessionId: key.sessionId,
        role: 'user', content: 'exact serialized body', toolUseId: null, agentMeta: '{"sdk":"preserved"}', agentKind: 'cc', createdAt: 1001,
        guarded: false, materialDispatch: { revision: 1, host } };
      const write = (args: unknown) => send('tx', { name: 'message.insert', args });
      const messageCount = () => send('queryOne', { sql: 'SELECT COUNT(*) n FROM messages WHERE client_id=?', params: [mode] });
      // The real original writer inserts before attach: each rejection must undo that insert.
      await expect(write(message)).rejects.toThrow('[FORBIDDEN]');
      expect(await messageCount()).toEqual({ n: 0 });
      await send('exec', { sql: "INSERT INTO project_members VALUES ('p','account','owner','owner',1)" });
      await expect(write({ ...message, content: 'edited after queue' })).rejects.toThrow('[MESSAGE_MISMATCH]');
      expect(await messageCount()).toEqual({ n: 0 });
      await send('exec', { sql: "UPDATE sessions SET project_binding_revision=2 WHERE id='task'" });
      await expect(write(message)).rejects.toThrow('[BINDING_CONFLICT]');
      expect(await messageCount()).toEqual({ n: 0 });
      await send('exec', { sql: "UPDATE sessions SET project_binding_revision=1 WHERE id='task'" });
      await expect(write({ ...message, guarded: true, expectedClearBoundaryMs: 999 })).rejects.toThrow('REMOTE_OPTIMISTIC_INPUT_CLEARED');
      expect(await messageCount()).toEqual({ n: 0 });
      await send('exec', { sql: "CREATE TRIGGER abort_material_attach BEFORE UPDATE ON material_dispatch_messages BEGIN SELECT RAISE(ABORT,'injected attach failure'); END" });
      await expect(write(message)).rejects.toThrow();
      expect(await messageCount()).toEqual({ n: 0 });
      expect(await execute({ action: 'read', key, host })).toMatchObject({ messageId: null, revisions: [{ state: 'queued' }] });
      await send('exec', { sql: 'DROP TRIGGER abort_material_attach' });
      // Drop the writer ACK. Recovery retries only the same message intent, not an external send.
      await write(message);
      expect(await execute({ action: 'read', key, host })).toMatchObject({ messageId: message.id, revisions: [{ state: 'attached', attempts: [] }] });
      expect(await write({ ...message, id: `retry-${mode}` })).toEqual({ changes: 0 });
      expect(await messageCount()).toEqual({ n: 1 });
      await expect(write({ ...message, guarded: true, expectedClearBoundaryMs: 999 })).rejects.toThrow('REMOTE_OPTIMISTIC_INPUT_CLEARED');
      expect(await send('queryOne', { sql: 'SELECT id,agent_meta FROM messages WHERE client_id=?', params: [mode] }))
        .toEqual({ id: message.id, agent_meta: message.agentMeta });
      await expect(write({ ...message, content: 'edited retry' })).rejects.toThrow('[MESSAGE_MISMATCH]');
      await send('exec', { sql: "DELETE FROM project_members WHERE project_id='p'" });
      await expect(write(message)).rejects.toThrow('[FORBIDDEN]');
      expect(await messageCount()).toEqual({ n: 1 }); // prior commit remains a historical fact

    } finally { await worker?.close(); }
  });
}

// Real production handler -> admission -> named transaction -> formal SQLite. The
// coordinator duplicate boundary, renderer trust predicate and external services are controlled;
// no native Electron or provider claim. Regression: a raw actor or missing selector must
// not upgrade an existing material key or turn an unknown prior dispatch into a fresh send.
const registerSource = readFileSync(path.join(root, 'src/main/maker-ipc/register.ts'), 'utf8').replace(/\r\n/g, '\n');
function handlerFor(channel: 'INPUT_ENQUEUE' | 'INPUT_STEER', admission: ReturnType<typeof createMaterialInputAdmission>, trusted = true, observed: AgentInputQueuedMessage[] = [], fresh = false) {
  const start = registerSource.indexOf(`    MAKER_INVOKE.${channel},`);
  const begin = registerSource.indexOf('    async (event, sessionId: unknown, item: unknown, opts?: unknown) => {', start);
  const end = registerSource.indexOf('\n  );', begin);
  const source = registerSource.slice(begin, end).trim().replace(/,$/, '');
  const no = () => undefined;
  const projection: { pendingQueue: AgentInputQueuedMessage[]; steeringQueueClientIds: string[] } = { pendingQueue: [], steeringQueueClientIds: [] };
  const bindings = {
    materialInputAdmission: admission, getCurrentDbClientSnapshot,
    requireSessionId: (id: string) => id, parseQueuedMaterialIntent, requireSessionRefs: () => undefined,
    prepareSharedTaskInput: async (_sid: string, item: AgentInputQueuedMessage) => { observed.push(item); return item; },
    awaitAgentInputQueueSnapshotPersistence,
    remoteInputClientIdWasPersisted: async () => false, hasInputDeliveryCancellation: () => false,
    materializeQueuedOssAttachmentsDeferred: async (_sid: string, item: AgentInputQueuedMessage) => ({ item }),
    registerQueuedAttachmentOwnership: () => null, hydrateQueuedAgentReferences: async (item: AgentInputQueuedMessage) => item,
    stampTurnUiLanguage: (item: AgentInputQueuedMessage) => item,
    stampTrustedDesktopQueuedOrigin: (item: AgentInputQueuedMessage) => item,
    stampTrustedDeviceLinkQueuedOrigin: (item: AgentInputQueuedMessage) => item,
    stampMobileClientOrigin: (item: AgentInputQueuedMessage) => item,
    readDeviceLinkInvokeSourceDevice: no, isMobileControllerInvoke: () => false,
    readClaimedUiLanguage: no, readClaimedClassicalStyle: no,
    getResolvedMainLocale: () => 'en', getMainClassicalStyle: () => 'prose',
    prepareDeviceLinkAutoTitle: async () => no,
    CONTINUE_AFTER_APP_EXIT_PROMPT: 'controlled unrelated continuation',
    markQueuedAttachmentDurableAfterSnapshot: no,
    isDeviceLinkInvoke: () => false,
    assertTrustedAppRendererEvent: () => { if (!trusted) throw new Error('PERMISSION_DENIED'); },
    assertReviewExternalInputAllowed: no, withSessionPermissionChange: no,
    beginRemoteSendTrace: no, assertRemoteInputClearNotInFlight: no,
    readRemoteInputClearBoundaryPrecondition: no, observeLocalInputClearBoundary: no,
    inputCoordinator: { getGeneration: () => 1, isGenerationCurrent: () => true,
      ensureQueueRestored: async () => undefined, hasKnownClientId: () => !fresh, getProjection: () => projection,
      enqueue: (sid: string, item: AgentInputQueuedMessage) => {
        projection.pendingQueue = [item];
        // Real durable snapshot writer; only the coordinator scheduling/provider is controlled.
        void saveAgentInputQueueSnapshot(sid, projection.pendingQueue);
        return projection;
      } },
    throwIpcError: (code: string) => { throw new Error(code); },
  };
  const normalizerStart = registerSource.indexOf('  const requireQueuedMessage = (');
  const normalizerEnd = registerSource.indexOf('\n  };', normalizerStart);
  const normalizer = registerSource.slice(normalizerStart, normalizerEnd + 5).replace('  const requireQueuedMessage = ', '');
  const normalizeCode = transpileModule(`return (${normalizer.replace(/;$/, '')});`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  const requireQueuedMessage = new Function(...Object.keys(bindings), normalizeCode)(...Object.values(bindings));
  const finalBindings = { ...bindings, requireQueuedMessage };
  const compiled = transpileModule(`return (${source});`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(finalBindings), compiled)(...Object.values(finalBindings)) as
    (event: object, sessionId: string, item: AgentInputQueuedMessage) => Promise<unknown>;
}
function admissionClient(): DbClient {
  return {
    query: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
    queryOne: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
    exec: async (sql, params = []) => db.prepare(sql).run(...params),
    tx: async <R>(name: string, args: unknown) => await dispatch('tx', { name, args }, db) as R,
    drizzle: drizzle(db), vecAvailable: true, dispose: async () => undefined,
  };
}
function materialItem(clientId: string): AgentInputQueuedMessage {
  return { clientId, text: 'reference selected material', persistedContent: 'exact serialized body',
    model: 'fixture', effort: '', permissionMode: 'default', workingDir: '',
    chatMessage: { clientId, role: 'user', content: 'reference selected material' },
    createOpts: { agentKind: 'claude-code', workingDir: '', model: 'fixture' },
    materialDispatch: { selector: { contextId: 'context', projectId: 'p', workItemId: 'task', bindingRevision: 1, purpose: 'reference' }, expectedRevision: 0 } };
}
for (const channel of ['INPUT_ENQUEUE', 'INPUT_STEER'] as const) {
  it(`${channel}: actual handler durably admits only the Profile actor and original material intent`, async () => {
    db.exec("INSERT OR IGNORE INTO project_members VALUES ('p','account','owner','owner',1)");
    const client = admissionClient(); setCurrentDbClient(client, 'owner');
    const admission = createMaterialInputAdmission();
    const item = materialItem(`admission-${channel}`);
    // Unrelated raw actor is not a credential; nested actor/prepared fields are rejected.
    const forged = Object.assign({ ...item, materialDispatchRevision: 999 }, { actor: { kind: 'bot', id: 'owner' } });
    await expect(handlerFor(channel, admission, false)({}, 'task', forged)).rejects.toThrow('PERMISSION_DENIED');
    expect(db.prepare('SELECT COUNT(*) n FROM material_dispatch_messages WHERE client_id=?').get(item.clientId)).toEqual({ n: 0 });
    const observed: AgentInputQueuedMessage[] = [];
    await handlerFor(channel, admission, true, observed, channel === 'INPUT_ENQUEUE')({}, 'task', forged);
    expect(observed[0]).toMatchObject({ durableDelivery: true, materialDispatchRevision: 1 });
    expect(item.materialDispatchRevision).toBeUndefined(); // public body was not stamped or trusted

    expect(db.prepare('SELECT selector_json FROM material_dispatch_revisions WHERE client_id=?').get(item.clientId))
      .toEqual({ selector_json: JSON.stringify(item.materialDispatch!.selector) });
    await expect(handlerFor(channel, admission)({}, 'task', { ...item,
      materialDispatch: { ...item.materialDispatch!, expectedRevision: 1 }, persistedContent: 'edited via enqueue' })).rejects.toThrow('[INTENT_FROZEN]');
    expect(db.prepare('SELECT current_revision AS revision FROM material_dispatch_messages WHERE client_id=?').get(item.clientId)).toEqual({ revision: 1 });
    const queueSnapshot = channel === 'INPUT_ENQUEUE'
      ? (await loadAgentInputQueueSnapshot('task'))[0]!
      : JSON.parse(JSON.stringify(observed[0])) as AgentInputQueuedMessage;
    expect(queueSnapshot).toMatchObject({ materialDispatchRevision: 1, materialDispatch: item.materialDispatch });
    // Drop ACK / recreate service: recover data with fresh authority, without a new revision.
    const restored = createMaterialInputAdmission();
    await restored.restore('task', [queueSnapshot]);
    const authority = await restored.messageAuthority('task', item.clientId, item.persistedContent);
    expect(authority?.actor).toEqual({ kind: 'account', id: 'owner' });
    await expect(restored.assertConsumerConnected('task', item.clientId)).rejects.toThrow('[NOT_READY]');
    const stripped = { ...item }; delete stripped.materialDispatch;
    await expect(restored.admit('task', stripped, () => undefined)).rejects.toThrow('[INTENT_FROZEN]');
    const wrongRevision = { ...queueSnapshot, materialDispatchRevision: 999 };
    await expect(restored.restore('task', [wrongRevision])).rejects.toThrow('[REVISION_CONFLICT]');
    setCurrentDbClient(client, 'other');
    await expect(createMaterialInputAdmission().restore('task', [queueSnapshot])).rejects.toThrow('[FORBIDDEN]');
    setCurrentDbClient(client, 'owner');
    db.exec("UPDATE sessions SET project_binding_revision=2 WHERE id='task'");
    await expect(restored.restore('task', [queueSnapshot])).rejects.toThrow('[BINDING_CONFLICT]');
    await expect(restored.admit('task', materialItem(`stale-${channel}`), () => undefined)).rejects.toThrow('[BINDING_CONFLICT]');
    db.exec("UPDATE sessions SET project_binding_revision=1 WHERE id='task'; DELETE FROM project_members WHERE project_id='p'");
    await expect(restored.restore('task', [queueSnapshot])).rejects.toThrow('[FORBIDDEN]');
    expect(db.prepare('SELECT COUNT(*) n FROM material_dispatch_attempts WHERE client_id=?').get(item.clientId)).toEqual({ n: 0 });
    db.exec("INSERT OR IGNORE INTO project_members VALUES ('p','account','owner','owner',1)");
    await client.tx('message.insert', { id: `attached-${channel}`, sessionId: 'task', clientId: item.clientId,
      role: 'user', content: item.persistedContent, agentMeta: null, toolUseId: null, agentKind: 'cc',
      createdAt: 1002, guarded: false, materialDispatch: { revision: 1, host: { actor: { kind: 'account', id: 'owner' }, now: 1002 } } });
    await expect(createMaterialInputAdmission().restore('task', [queueSnapshot])).rejects.toThrow('[OUTCOME_UNRESOLVED]');
    await expect(handlerFor(channel, admission)({}, 'task', forged)).rejects.toThrow('[OUTCOME_UNRESOLVED]');
    expect(db.prepare('SELECT COUNT(*) n FROM messages WHERE client_id=?').get(item.clientId)).toEqual({ n: 1 });
    clearCurrentDbClient(client);
  });
}
it('material admission rejects extra evidence, missing CAS, wrong task, and owner switch after queue commit', async () => {
  db.exec("INSERT OR IGNORE INTO project_members VALUES ('p','account','owner','owner',1)");
  const item = materialItem('owner-switch-admission');
  expect(() => parseQueuedMaterialIntent({ ...item.materialDispatch, actor: { kind: 'account', id: 'owner' } })).toThrow('[INVALID_PARAMS]');
  expect(() => parseQueuedMaterialIntent({ selector: item.materialDispatch!.selector })).toThrow('[INVALID_PARAMS]');
  expect(() => parseQueuedMaterialIntent({ ...item.materialDispatch, expectedRevision: -1 })).toThrow('[INVALID_PARAMS]');
  const base = admissionClient();
  const client: DbClient = { ...base, tx: async <R>(name: string, args: unknown) => {
    const result = await base.tx<R>(name, args);
    setCurrentDbClient(base, 'other'); return result;
  } };
  setCurrentDbClient(client, 'owner');
  await expect(createMaterialInputAdmission().admit('other-task', item, () => undefined)).rejects.toThrow('[SCOPE_MISMATCH]');
  await expect(createMaterialInputAdmission().admit('task', item, () => undefined)).rejects.toThrow('[PRECONDITION_FAILED]');
  expect(db.prepare('SELECT COUNT(*) n FROM material_dispatch_revisions WHERE client_id=?').get(item.clientId)).toEqual({ n: 1 });
  expect(item.materialDispatchRevision).toBeUndefined(); // A committed queue is not a delivered ACK.
  clearCurrentDbClient();
});

it('main dispatch callback rejects a cloned material selector even when its new key has no ledger', async () => {
  const begin = registerSource.indexOf('    assertInputDispatchable: ');
  const end = registerSource.indexOf('\n    rewindPersistedUserMessageAfterClear:', begin);
  const arrow = registerSource.slice(begin, end).trim().replace(/^assertInputDispatchable: /, '').replace(/,$/, '');
  const compiled = transpileModule(`return (${arrow});`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  const client = admissionClient(); setCurrentDbClient(client, 'owner');
  const admission = createMaterialInputAdmission();
  const check = new Function('materialInputAdmission', compiled)(admission) as
    (sessionId: string, item: AgentInputQueuedMessage) => Promise<void>;
  await expect(check('task', materialItem('cloned-unadmitted-key'))).rejects.toThrow('[NOT_READY]');
  const revisionOnly = materialItem('cloned-revision-only');
  delete revisionOnly.materialDispatch;
  revisionOnly.materialDispatchRevision = 1;
  await expect(check('task', revisionOnly)).rejects.toThrow('[NOT_READY]');
  const original = materialItem('original-ledger-key');
  await admission.admit('task', original, () => undefined);
  delete original.materialDispatch;
  delete original.materialDispatchRevision;
  await expect(check('task', original)).rejects.toThrow('[NOT_READY]');
  await expect(admission.admit('task', original, () => undefined)).rejects.toThrow('[INTENT_FROZEN]');
  expect(db.prepare('SELECT COUNT(*) n FROM material_dispatch_attempts WHERE client_id IN (?, ?, ?)')
    .get('cloned-unadmitted-key', 'cloned-revision-only', 'original-ledger-key')).toEqual({ n: 0 });
  clearCurrentDbClient(client);
});
