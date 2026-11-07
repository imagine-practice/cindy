/**
 * Integration: real consumer adapter -> frozen preparation -> attach -> pending attempt.
 *
 * Proves the slice's actual boundary, not a UI mock: a selected material context is
 * prepared from pinned bytes, the message attach happens in the real writer, and the
 * provider consumption point records exactly one `pending` attempt. Minimal failures:
 * a send without prepared bytes, a second attempt for a pending dispatch, or a context
 * that was removed before dispatch. No model/provider call, account DB or real Electron.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createBetterSqliteDatabase } from '../../localDb/betterSqliteFactory';
import { runMigrationReplay } from '../../localDb/migrationRunner';
import { dispatch } from '../../localDb/worker/dispatcher';
import { runMaterialsTransaction, type MaterialVersionInput } from '../../localDb/worker/opHandlers/materialsTx';
import { setCurrentDbClient, clearCurrentDbClient } from '../../localDb/client/current';
import type { DbClient } from '../../localDb/client/DbClient';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue';
import type { MaterialDispatchReadResult } from '../../../shared/materialDispatch';
import * as schema from '../../localDb/schema';
import { createMaterialConsumptionConnector } from '../materialConsumption';

let db: Database.Database;
let dir: string;
let sequence = 0;
const root = path.resolve(__dirname, '../../../..');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const host = { actor: { kind: 'account' as const, id: 'owner' }, now: 1000 };

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-material-consumption-'));
  db = createBetterSqliteDatabase(path.join(dir, 'test.db'));
  db.loadExtension(
    path.join(
      root,
      'native/sqlite-vec',
      `${process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib',
    ),
  );
  runMigrationReplay(db, { drizzleDir: path.join(root, 'drizzle') });
});

afterAll(async () => {
  db?.close();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  clearCurrentDbClient();
  db.exec('DELETE FROM messages; DELETE FROM material_dispatch_attempts; DELETE FROM material_dispatch_revisions;'
    + ' DELETE FROM material_dispatch_messages; DELETE FROM material_contexts; DELETE FROM material_references;'
    + ' DELETE FROM material_versions; DELETE FROM materials; DELETE FROM project_members; DELETE FROM sessions; DELETE FROM projects;');
});

function client(): DbClient {
  return {
    query: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
    queryOne: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
    exec: async (sql, params = []) => db.prepare(sql).run(...params),
    tx: async <R>(name: string, args: unknown) => (await dispatch('tx', { name, args }, db)) as R,
    drizzle: drizzle(db, { schema }),
    vecAvailable: true,
    dispose: async () => undefined,
  };
}

async function fixture(): Promise<{
  dbClient: DbClient;
  selector: { contextId: string; projectId: string; workItemId: string; bindingRevision: number; purpose: 'reference' };
  content: string;
  filePath: string;
}> {
  const tag = `t${sequence++}`;
  const projectId = `p-${tag}`;
  const sessionId = `s-${tag}`;
  const contextId = `c-${tag}`;
  const filePath = path.join(dir, `material-${tag}.txt`);
  const text = `pinned material body ${tag}`;
  await fs.writeFile(filePath, text);
  db.exec(`INSERT INTO projects(id,name,owner_id,status,created_at,updated_at) VALUES ('${projectId}','P','owner','active',1,1);
    INSERT INTO project_members(project_id,subject_kind,subject_id,role,added_at) VALUES ('${projectId}','account','owner','owner',1);
    INSERT INTO sessions(id,project_id,project_binding_revision,created_at,updated_at) VALUES ('${sessionId}','${projectId}',1,1,1);`);
  const scope = { projectId, workItemId: sessionId, bindingRevision: 1 };
  const descriptor: MaterialVersionInput = {
    referenceId: `r-${tag}`,
    versionId: `v-${tag}`,
    materialId: `m-${tag}`,
    name: 'material.txt',
    sameNameAction: 'create-new',
    sha256: hash(text),
    sizeBytes: Buffer.byteLength(text),
    mime: 'text/plain',
    storageKind: 'file',
    storageRef: filePath,
    sourceMtime: 1,
  };
  runMaterialsTransaction(db, { action: 'add', ...scope, files: [descriptor], actor: host.actor, now: 1 });
  runMaterialsTransaction(db, {
    action: 'createContext',
    ...scope,
    newId: contextId,
    purpose: 'reference',
    refs: [{ referenceId: descriptor.referenceId, materialId: descriptor.materialId, version: 1 }],
    actor: host.actor,
    now: 1,
  });
  const dbClient = client();
  setCurrentDbClient(dbClient, 'owner');
  return {
    dbClient,
    selector: { contextId, projectId, workItemId: sessionId, bindingRevision: 1, purpose: 'reference' },
    content: text,
    filePath,
  };
}

function itemFor(
  selector: { contextId: string; projectId: string; workItemId: string; bindingRevision: number; purpose: 'reference' },
  clientId: string,
  content: string,
): AgentInputQueuedMessage {
  return {
    clientId,
    text: 'send with material',
    persistedContent: content,
    model: 'fixture',
    effort: '',
    permissionMode: 'default',
    workingDir: '',
    chatMessage: { clientId, role: 'user', content: 'send with material' },
    createOpts: { agentKind: 'claude-code', workingDir: '', model: 'fixture' },
    materialDispatch: { selector, expectedRevision: 0 },
  };
}

async function readLedger(sessionId: string, clientId: string): Promise<MaterialDispatchReadResult> {
  return (await dispatch('tx', {
    name: 'materialDispatch.execute',
    args: { action: 'read', key: { sessionId, clientId }, host },
  }, db)) as MaterialDispatchReadResult;
}

it('prepares pinned bytes, keeps the persisted body untouched and records one pending attempt', async () => {
  const { dbClient, selector, content } = await fixture();
  const clientId = 'client-1';
  const item = itemFor(selector, clientId, content);
  const queued = await dbClient.tx<{ revision: number }>('materialDispatch.execute', {
    action: 'queue',
    key: { sessionId: selector.workItemId, clientId },
    host,
    expectedRevision: 0,
    selector,
    contentSha256: hash(content),
  });
  item.materialDispatchRevision = queued.revision;

  const connector = createMaterialConsumptionConnector();
  const prepared = await connector.prepare(selector.workItemId, item);
  expect(prepared).not.toBeNull();
  const blocks = prepared!.blocks;
  // Material rides as ordinary user-content blocks: no provider format change.
  expect(blocks).toEqual([{ type: 'text', text: content }]);

  // The real message writer attaches the queued intent in the same transaction.
  db.exec(`INSERT INTO messages(id,client_id,session_id,role,content,created_at) VALUES
    ('msg-1','${clientId}','${selector.workItemId}','user','${content.replace(/'/g, "''")}',1);`);
  await dispatch('tx', {
    name: 'materialDispatch.execute',
    args: { action: 'attachMessage', key: { sessionId: selector.workItemId, clientId }, host, revision: queued.revision, messageId: 'msg-1' },
  }, db);

  await prepared!.consume(1);
  const after = await readLedger(selector.workItemId, clientId);
  expect(after.currentRevision).toBe(queued.revision);
  expect(after.messageId).toBe('msg-1');
  expect(after.revisions[0]).toMatchObject({ state: 'attached' });
  expect(after.revisions[0].attempts).toHaveLength(1);
  expect(after.revisions[0].attempts[0]).toMatchObject({ consumer: 'provider', outcome: 'pending', turnGeneration: 1 });
  expect(after.revisions[0].preparation?.items[0]).toMatchObject({ readiness: 'ready', representation: 'text' });
  // pending is durable; it is not a receipt and the message body was never rewritten.
  expect(db.prepare('SELECT content FROM messages WHERE id=?').pluck().get('msg-1')).toBe(content);

  // Re-entering the same handle is a no-op, and a fresh consumer cannot start a second attempt.
  await prepared!.consume(1);
  expect((await readLedger(selector.workItemId, clientId)).revisions[0].attempts).toHaveLength(1);
  const retry = await connector.prepare(selector.workItemId, item);
  await expect(retry!.consume(1)).rejects.toThrow('[OUTCOME_UNRESOLVED]');
  expect((await readLedger(selector.workItemId, clientId)).revisions[0].attempts).toHaveLength(1);
});

it('refuses to send when the source file changed after the pinned version', async () => {
  const { dbClient, selector, content, filePath } = await fixture();
  const clientId = 'client-changed';
  const item = itemFor(selector, clientId, content);
  const queued = await dbClient.tx<{ revision: number }>('materialDispatch.execute', {
    action: 'queue',
    key: { sessionId: selector.workItemId, clientId },
    host,
    expectedRevision: 0,
    selector,
    contentSha256: hash(content),
  });
  item.materialDispatchRevision = queued.revision;
  // 源文件在钉版之后被改：哈希不再匹配，整单拒绝，绝不能按旧版本悄悄发出去。
  await fs.writeFile(filePath, 'changed body after pin');

  const connector = createMaterialConsumptionConnector();
  await expect(connector.prepare(selector.workItemId, item)).rejects.toThrow('[SOURCE_CHANGED]');
  const ledger = await readLedger(selector.workItemId, clientId);
  expect(ledger.revisions[0].attempts ?? []).toHaveLength(0);
});

it('refuses to prepare a removed context so no message or attempt is created', async () => {
  const { selector, content } = await fixture();
  db.exec(`UPDATE material_references SET status='removed' WHERE project_id='${selector.projectId}'`);
  const connector = createMaterialConsumptionConnector();
  await expect(connector.prepare(selector.workItemId, itemFor(selector, 'client-2', content)))
    .rejects.toThrow(/REFERENCE_NOT_FOUND|PRECONDITION_FAILED/);
  expect(db.prepare('SELECT COUNT(*) FROM messages').pluck().get()).toBe(0);
  expect(db.prepare('SELECT COUNT(*) FROM material_dispatch_attempts').pluck().get()).toBe(0);
});

it('reads dispatch state per session only for current project members', async () => {
  const { dbClient, selector, content } = await fixture();
  const clientId = 'client-3';
  await dbClient.tx('materialDispatch.execute', {
    action: 'queue',
    key: { sessionId: selector.workItemId, clientId },
    host,
    expectedRevision: 0,
    selector,
    contentSha256: hash(content),
  });
  const read = await dbClient.tx<{ sessionId: string; messages: MaterialDispatchReadResult[] }>(
    'materialDispatch.execute',
    { action: 'readSession', sessionId: selector.workItemId, host },
  );
  expect(read.sessionId).toBe(selector.workItemId);
  expect(read.messages).toHaveLength(1);
  expect(read.messages[0]).toMatchObject({ key: { sessionId: selector.workItemId, clientId }, currentRevision: 1 });
  expect(read.messages[0].revisions[0].state).toBe('queued');

  db.exec(`DELETE FROM project_members WHERE project_id='${selector.projectId}'`);
  const hidden = await dbClient.tx<{ messages: MaterialDispatchReadResult[] }>('materialDispatch.execute', {
    action: 'readSession',
    sessionId: selector.workItemId,
    host,
  });
  expect(hidden.messages).toEqual([]);
});
