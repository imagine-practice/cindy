/** Integration tier: real preparation -> frozen R1/R2 transaction -> migrated
 * SQLite + temporary text/image bytes. R2 preview tests cannot prove that a
 * prepared body remains bound to context v1 when v2 exists or authority changes.
 * Minimal failures: v1 snapshot with v2 catalogue, or membership removed on a read.
 * Controlled: main actor/owner lease, named transport routing, Electron userData.
 * No models, real account DB, real queues, pin/recycler or provider acceptance.
 * One migration replay/module load, rollback fixtures, no real waits.
 * Initial 2026-11-06: 22/22, 1.96s total / 286ms test body.
 * Revision 2: 27/27, 1.99s total / 318ms test body (same original 22 retained).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBetterSqliteDatabase } from '../../localDb/betterSqliteFactory';
import { runMigrationReplay } from '../../localDb/migrationRunner';
import { runMaterialsTransaction, type MaterialVersionInput } from '../../localDb/worker/opHandlers/materialsTx';
import { runProjectsTransaction } from '../../localDb/worker/opHandlers/projectsTx';
import type { DbClient } from '../../localDb/client/DbClient';
import type { MaterialContextCreateResult, MaterialContextCreateParams } from '../../../shared/materials';
import { writeBlob, resolveSafe } from '../../cindy-media/blobStore';
import { buildMakerUserMessage, type AgentInputQueuedMessage } from '../../../shared/agentInputQueue';
import { prepareMaterialExecutionInput, type MaterialExecutionHost, type MaterialExecutionRequest } from '../materialExecutionInput';
import * as schema from '../../localDb/schema';

const env = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({ app: { getPath: () => env.root } }));

describe('material snapshot preparation for formal task input', () => {
  let db: Database.Database;
  let client: DbClient;
  let host: MaterialExecutionHost & { dispatch: typeof dispatch };
  let generation: number;
  let sourceCurrent: boolean;
  let fixture: string;
  let sequence = 0;
  let afterQuery: ((sql: string) => void) | undefined;
  let afterTx: ((raw: unknown) => void) | undefined;
  const dispatch = vi.fn();
  const actor = { kind: 'account' as const, id: 'same' };
  const scope = { projectId: 'p', workItemId: 's', bindingRevision: 0 };
  const request: MaterialExecutionRequest = { ...scope, contextId: 'c', purpose: 'redecompose' };
  const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  const run = (sql: string, ...values: unknown[]) => db.prepare(sql).run(...values);
  const material = (raw: object) => runMaterialsTransaction(db, { ...raw, actor, now: 1 });
  async function add(id: string, bytes: string | Buffer, mime = 'text/plain', storageKind: 'file' | 'media' = 'file', name = 'same-name') {
    const buffer = Buffer.from(bytes);
    const filePath = path.join(fixture, id);
    const storageRef = storageKind === 'media' ? (await writeBlob({ buffer, mimeType: mime })).url : filePath;
    if (storageKind === 'file') await fs.writeFile(filePath, buffer);
    const descriptor: MaterialVersionInput = { referenceId: `r-${id}`, versionId: `v-${id}`, materialId: id, name, sameNameAction: 'create-new',
      sha256: hash(buffer), sizeBytes: buffer.length, mime, storageKind, storageRef, sourceMtime: storageKind === 'file' ? 1 : null };
    material({ action: 'add', ...scope, files: [descriptor] });
    return { descriptor, filePath };
  }
  function snapshot(refs: MaterialContextCreateParams['refs']) {
    return runMaterialsTransaction(db, { action: 'createContext', ...scope, newId: 'c', purpose: request.purpose, refs, actor, now: 2 }) as MaterialContextCreateResult;
  }
  const ref = (id: string) => ({ referenceId: `r-${id}`, materialId: id, version: 1 });
  const contextBytes = () => db.prepare("SELECT refs_json FROM material_contexts WHERE id='c'").pluck().get();
  const prepare = (raw: unknown = request) => prepareMaterialExecutionInput(raw, host);
  beforeAll(async () => {
    env.root = await fs.mkdtemp(path.join(tmpdir(), 'cindy-material-input-'));
    db = createBetterSqliteDatabase(':memory:');
    const desktop = path.resolve(__dirname, '../../../..');
    db.loadExtension(path.join(desktop, 'native/sqlite-vec', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib'));
    runMigrationReplay(db, { drizzleDir: path.join(desktop, 'drizzle') });
  });
  beforeEach(async () => {
    db.exec('BEGIN'); generation = 1; sourceCurrent = true; afterQuery = undefined; afterTx = undefined; dispatch.mockClear();
    fixture = path.join(env.root, `fixture-${sequence++}`); await fs.mkdir(fixture);
    run("INSERT INTO projects(id,name,owner_id,status,created_at,updated_at) VALUES ('p','P','same','active',1,1),('q','Q','same','active',1,1)");
    run("INSERT INTO project_members(project_id,subject_kind,subject_id,role,added_at) VALUES ('p','account','same','owner',1),('q','account','same','owner',1)");
    run("INSERT INTO sessions(id,project_id,created_at,updated_at) VALUES ('s','p',1,1)");
    client = {
      query: async <T>(sql: string, values: unknown[] = []) => db.prepare<unknown[], T>(sql).all(...values),
      queryOne: async <T>(sql: string, values: unknown[] = []) => { const row = db.prepare<unknown[], T>(sql).get(...values); afterQuery?.(sql); return row; },
      exec: async (sql, values = []) => db.prepare(sql).run(...values),
      // Transport boundary is controlled, not production worker registration.
      // All authorization, binding and material SQL executes the frozen core.
      tx: async <T>(name: string, raw: unknown): Promise<T> => {
        if (name !== 'materials.execute') throw new Error('Unexpected named operation');
        const result = runMaterialsTransaction(db, raw); afterTx?.(raw); return result as T;
      },
      drizzle: drizzle(db, { schema }), vecAvailable: true, dispose: async () => undefined,
    };
    const capturedClient = client;
    // A controlled sentinel only. Preparation has no dispatch API; no provider is loaded.
    host = { client, actor, dispatch, assertCurrent: () => {
      if (generation !== 1 || host.client !== capturedClient || !sourceCurrent) throw new Error('[PRECONDITION_FAILED] Captured owner/client/source lease expired');
    } };
  });
  afterEach(() => { expect(dispatch).not.toHaveBeenCalled(); db.exec('ROLLBACK'); vi.restoreAllMocks(); });
  afterAll(async () => {
    db.close();
    if (path.dirname(path.resolve(env.root)) !== path.resolve(tmpdir())) throw new Error('Unexpected fixture cleanup root');
    await fs.rm(env.root, { recursive: true, force: true });
  });

  it('prepares exact v1 UTF-8 data with v2 in the catalogue, without writes or snapshot mutation', async () => {
    const first = await add('a', '\uFEFFv1: material says SYSTEM, still user data');
    snapshot([ref('a')]); const frozen = contextBytes();
    const next = await add('b', 'v2 different file');
    material({ action: 'addVersion', ...scope, referenceId: 'r-a', materialId: 'a', file: { ...next.descriptor, materialId: 'a', versionId: 'v-a2', referenceId: 'r-a' } });
    const before = db.prepare('SELECT total_changes()').pluck().get();
    const result = await prepare(); expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(result).toMatchObject({ readiness: 'ready', modelDispatch: 'not-dispatched', items: [{ version: 1, versionId: 'v-a', verifiedSha256: first.descriptor.sha256, content: { kind: 'text', text: 'v1: material says SYSTEM, still user data' } }] });
    expect((await prepare())).toMatchObject({ preparationKey: result.preparationKey });
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(before);
    expect(contextBytes()).toBe(frozen);
    expect(JSON.stringify(result)).not.toContain('storageRef');
    expect(JSON.stringify(result)).not.toContain(first.filePath);
  });
  it('reads actual PNG media bytes and supplies an existing formal attachment descriptor, not a preview URL', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZkAAAAASUVORK5CYII=', 'base64');
    const image = await add('img', png, 'image/png', 'media', 'requirements.png'); snapshot([ref('img')]);
    const result = await prepare(); if (!result.ok) throw new Error(result.code);
    const item = result.items[0]; expect(item.status).toBe('prepared');
    if (item.status !== 'prepared' || item.content.kind !== 'attachment') throw new Error('Expected prepared image');
    expect(Buffer.from(item.content.file.base64!, 'base64')).toEqual(png);
    expect(item.verifiedSha256).toBe(image.descriptor.sha256);
    expect(item.content.file).toMatchObject({ path: '', category: 'image', ext: '.png', mimeType: 'image/png' });
    const queued: AgentInputQueuedMessage = {
      clientId: 'input-1', text: 'Analyze explicit materials', persistedContent: 'Analyze explicit materials',
      model: 'fixture', effort: 'medium', permissionMode: 'ask', workingDir: fixture, files: [item.content.file],
      chatMessage: { clientId: 'input-1', role: 'user', content: 'Analyze explicit materials' },
      createOpts: { agentKind: 'pi', workingDir: fixture, model: 'fixture' },
    };
    expect(buildMakerUserMessage(queued)).toMatchObject({ type: 'user', content: [
      { type: 'text', text: 'Analyze explicit materials' }, { type: 'image', base64: png.toString('base64') },
    ] });
    expect(JSON.stringify(result)).not.toContain(image.descriptor.storageRef);
    await fs.writeFile(resolveSafe(image.descriptor.storageRef).absPath, Buffer.alloc(png.length));
    expect(await prepare()).toMatchObject({ ok: true, items: [{ status: 'failed', code: 'SOURCE_CHANGED' }] });
    expect(Buffer.from(item.content.file.base64!, 'base64')).toEqual(png);
  });
  it.each(['changed', 'missing'])('reports %s original file per item without substituting a new version', async mode => {
    const file = await add('a', 'original'); snapshot([ref('a')]); const frozen = contextBytes();
    if (mode === 'changed') await fs.writeFile(file.filePath, 'modified'); else await fs.unlink(file.filePath);
    expect(await prepare()).toMatchObject({ ok: true, readiness: 'not-prepared', items: [{ status: 'failed', code: mode === 'changed' ? 'SOURCE_CHANGED' : 'SOURCE_MISSING' }] });
    expect(contextBytes()).toBe(frozen);
  });
  it('hashes the final text buffer when the file changes after open, not an earlier path check', async () => {
    const file = await add('a', 'original'); snapshot([ref('a')]);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args); await fs.writeFile(file.filePath, 'modified'); return handle;
    });
    expect(await prepare()).toMatchObject({ ok: true, items: [{ status: 'failed', code: 'SOURCE_CHANGED' }] });
  });
  it('does not pretend PDF/Office paths or unsupported decoding are prepared document bodies', async () => {
    await add('pdf', '%PDF-1.7 mock body', 'application/pdf');
    await add('office', Buffer.from([0x50, 0x4b, 3, 4, 0, 0]), 'application/zip');
    await add('invalid-utf8', Buffer.from([0xff, 0xfe]), 'text/plain');
    snapshot([ref('pdf'), ref('office'), ref('invalid-utf8')]);
    expect(await prepare()).toMatchObject({ ok: true, readiness: 'not-prepared', items: [
      { status: 'unsupported', code: 'UNSUPPORTED_CONTENT' }, { status: 'unsupported', code: 'UNSUPPORTED_CONTENT' }, { status: 'unsupported', code: 'UNSUPPORTED_CONTENT' },
    ] });
  });
  it('keeps same-name different bytes separate and reports partial preparation', async () => {
    await add('a', 'alpha'); await add('b', 'beta', 'text/plain', 'file', 'same-name');
    // The second name conflict is an explicit R1 action, not implicit replacement.
    // add() explicitly uses create-new for this fixture; both exact versions survive.
    snapshot([ref('a'), ref('b')]);
    expect(await prepare()).toMatchObject({ ok: true, items: [
      { content: { kind: 'text', text: 'alpha' } }, { content: { kind: 'text', text: 'beta' } },
    ] });
    run("UPDATE material_versions SET read_state='failed' WHERE id='v-b'");
    const result = await prepare(); expect(result).toMatchObject({ ok: true, readiness: 'partial', items: [
      { materialId: 'a', status: 'prepared', expectedSha256: hash('alpha') }, { materialId: 'b', status: 'failed', expectedSha256: hash('beta') },
    ] });
  });
  it.each(['actor', 'path', 'refs', 'now'])('strictly rejects caller-supplied %s before any reads', async field => {
    let reads = 0; afterTx = () => { reads++; };
    expect(await prepare({ ...request, [field]: field === 'actor' ? actor : '/forged' })).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(reads).toBe(0);
  });
  it('rejects a foreign project context or same UUID material reference and distinct actor kind', async () => {
    const uuid = '11111111-2222-4333-8444-555555555555';
    await add(uuid, 'private'); snapshot([ref(uuid)]);
    expect(await prepare({ ...request, projectId: 'q' })).toMatchObject({ ok: false, code: 'REFERENCE_MISMATCH' });
    host.actor = { kind: 'bot', id: 'same' };
    expect(await prepare()).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    host.actor = actor;
    run("UPDATE materials SET project_id='q' WHERE id=?", uuid);
    expect(await prepare()).toMatchObject({ ok: false, code: 'REFERENCE_MISMATCH' });
  });
  it.each(['q', null])('rejects p -> %s -> p via the real frozen binding core and never revives old context', async destination => {
    await add('a', 'old'); snapshot([ref('a')]); const frozen = contextBytes();
    for (const projectId of [destination, 'p']) runProjectsTransaction(db, { action: 'bindSession', sessionId: 's', projectId, actor, now: 3 });
    expect(await prepare()).toMatchObject({ ok: false, code: 'BINDING_CONFLICT' });
    expect(await prepare({ ...request, bindingRevision: 2 })).toMatchObject({ ok: false, code: 'REFERENCE_NOT_FOUND' });
    expect(contextBytes()).toBe(frozen);
  });
  it.each(['membership', 'owner', 'client', 'binding', 'removed-reference'])('discards all prepared content after %s changes during reading', async mode => {
    await add('a', 'private'); snapshot([ref('a')]); const frozen = contextBytes();
    afterQuery = () => {
      afterQuery = undefined;
      if (mode === 'membership') run("DELETE FROM project_members WHERE project_id='p'");
      if (mode === 'owner') generation++;
      if (mode === 'client') host.client = { ...client };
      if (mode === 'binding') runProjectsTransaction(db, { action: 'bindSession', sessionId: 's', projectId: null, actor, now: 4 });
      if (mode === 'removed-reference') material({ action: 'removeReference', ...scope, referenceId: 'r-a' });
    };
    const result = await prepare(); expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('items'); expect(JSON.stringify(result)).not.toContain('private');
    expect(contextBytes()).toBe(frozen);
  });
  it('checks explicit purpose and exposes a revocable preparation lease without marking used', async () => {
    await add('a', 'private'); snapshot([ref('a')]);
    expect(await prepare({ ...request, purpose: 'reference' })).toMatchObject({ ok: false, code: 'PURPOSE_MISMATCH' });
    const result = await prepare(); if (!result.ok) throw new Error(result.code);
    run("DELETE FROM project_members WHERE project_id='p'");
    await expect(result.revalidate()).rejects.toThrow('[FORBIDDEN]');
    expect(result.modelDispatch).toBe('not-dispatched');
  });
  it.each(['membership', 'owner'])('drops verified text when %s is revoked after the byte read completes', async mode => {
    await add('a', 'verified but not authorized for delivery'); snapshot([ref('a')]);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        if (mode === 'membership') run("DELETE FROM project_members WHERE project_id='p'"); else generation++;
      };
      return handle;
    });
    const result = await prepare(); expect(result.ok).toBe(false); expect(result).not.toHaveProperty('items');
  });
  // Coordination's real-transaction late-removal counterexample: the last
  // context resolve receipt is older than the mutation, while listContexts
  // cannot see removed references. Cover the same gap for a previously checked
  // first item and for mutable readState, at preparation and live revalidation.
  it.each(['prepare', 'live'] as const)('%s rejects every late change from one final read snapshot', async phase => {
    for (const scenario of ['single-reference', 'earlier-reference', 'read-state'] as const) {
      // Each scenario needs a fresh scope within the same isolated fixture.
      db.exec('SAVEPOINT late_change');
      try {
        await add('a', 'private a');
        const refs = [ref('a')];
        if (scenario === 'earlier-reference') { await add('b', 'private b'); refs.push(ref('b')); }
        snapshot(refs);
        const frozen = contextBytes();
        const ready = phase === 'live' ? await prepare() : undefined;
        if (ready && !ready.ok) throw new Error(ready.code);
        let resolutions = 0;
        const trigger = refs.length * (phase === 'prepare' ? 4 : 2);
        afterTx = raw => {
          const request = raw as { action?: string; contextId?: string };
          if (request.action !== 'resolveVersion' || request.contextId !== 'c') return;
          if (++resolutions !== trigger) return;
          if (scenario === 'read-state') material({ action: 'retryRead', ...scope, referenceId: 'r-a', materialId: 'a', version: 1, readState: 'failed', failureReason: 'SOURCE_MISSING' });
          else material({ action: 'removeReference', ...scope, referenceId: 'r-a' });
        };
        if (phase === 'prepare') {
          const result = await prepare();
          expect(result.ok, scenario).toBe(false);
          expect(result).not.toHaveProperty('items');
          expect(JSON.stringify(result)).not.toContain('private');
        } else if (ready?.ok) {
          await expect(ready.revalidate(), scenario).rejects.toThrow();
          expect(ready.modelDispatch).toBe('not-dispatched');
        }
        expect(resolutions).toBe(trigger);
        expect(contextBytes()).toBe(frozen);
      } finally {
        afterTx = undefined;
        db.exec('ROLLBACK TO late_change; RELEASE late_change');
      }
    }
  });
  it.each(['prepare', 'live'] as const)('%s still checks owner/client/source synchronously after the final SQL receipt', async phase => {
    await add('a', 'private'); snapshot([ref('a')]);
    const ready = phase === 'live' ? await prepare() : undefined;
    if (ready && !ready.ok) throw new Error(ready.code);
    for (const change of ['owner', 'client', 'source']) {
      const capturedClient = host.client;
      let snapshots = 0;
      afterQuery = sql => {
        if (!sql.includes('material-execution-final-snapshot') || ++snapshots !== (phase === 'prepare' ? 2 : 1)) return;
        if (change === 'owner') generation++;
        if (change === 'client') host.client = { ...client };
        if (change === 'source') sourceCurrent = false;
      };
      try {
        if (phase === 'prepare') {
          const result = await prepare(); expect(result).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' });
          expect(result).not.toHaveProperty('items');
        } else if (ready?.ok) await expect(ready.revalidate()).rejects.toThrow('[PRECONDITION_FAILED]');
        expect(snapshots).toBe(phase === 'prepare' ? 2 : 1);
      } finally { afterQuery = undefined; generation = 1; sourceCurrent = true; host.client = capturedClient; }
    }
  });
  it('compares final readState with the bytes selection, even when state returns to its initial value', async () => {
    await add('a', 'private'); snapshot([ref('a')]);
    const setState = (readState: 'ready' | 'failed') => material({ action: 'retryRead', ...scope,
      referenceId: 'r-a', materialId: 'a', version: 1, readState, failureReason: readState === 'failed' ? 'SOURCE_MISSING' : null });
    setState('failed');
    afterQuery = sql => {
      if (!sql.includes('material-execution-final-snapshot')) return;
      afterQuery = undefined; setState('ready');
    };
    let resolutions = 0;
    afterTx = raw => {
      const input = raw as { action?: string; contextId?: string };
      if (input.action === 'resolveVersion' && input.contextId === 'c' && ++resolutions === 4) setState('failed');
    };
    const result = await prepare();
    expect(resolutions).toBe(4); expect(result.ok).toBe(false); expect(result).not.toHaveProperty('items');
  });
});
