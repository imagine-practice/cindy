/** Material bridge DB/integration tier: actual eight-channel preload factory -> registered IPC ->
 * production dispatcher/inline worker -> full current migrations SQLite and real temporary text files.
 * Gap: fixed R2 tests bypass registration/preload and call the core transaction directly.
 * Minimal failures: raw.actor elevates an outsider, stale epoch survives rebind, or text leaks after owner switch.
 * Native sender/auth generation and media broker are controlled; no real Host/user DB/media recycler.
 * Migrate and import once; no module resets or real sleeps. Fixture client adapts the transport boundary only.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { beforeAll, beforeEach, afterEach, afterAll, expect, it, vi } from 'vitest';
import { ipcRenderer } from 'electron';
import { createMaterialReferenceBridge } from '../../../preload/materialReferenceBridge';
import { registerMaterialsIpc } from '../ipc/materials';
import * as io from '../ipc/materialReferenceIo';
import { listMaterials as legacyListMaterials, removeMaterialReference as legacyRemoveMaterialReference } from '../../../renderer/features/materials/materialsService';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runMigrationReplay } from '../migrationRunner';
import { dispatch } from '../worker/dispatcher';
import { WorkerThreadTransport } from '../client/WorkerThreadTransport';
import { setCurrentDbClient, clearCurrentDbClient } from '../client/current';
import type { DbClient } from '../client/DbClient';
import { runProjectsTransaction } from '../worker/opHandlers/projectsTx';
import type { MaterialReference, MaterialScope } from '../../../shared/materials';

const h = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
 user: 'owner' as string | null, generation: 0, trusted: true, invoked: [] as string[], ingest: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (e: unknown,r: unknown)=>Promise<unknown>) => h.handlers.set(name,fn) },
 ipcRenderer: { invoke: (name: string, request: unknown) => { h.invoked.push(name); return h.handlers.get(name)!({},request); } }, BrowserWindow: {} }));
vi.mock('../index', () => ({ getCurrentUserId: () => h.user }));
vi.mock('../ipc/sessions', () => ({ broadcastSessionPatched: vi.fn() }));
vi.mock('../../security/trustedAppRenderer', () => ({ assertTrustedAppRendererEvent: () => { if (!h.trusted) throw new Error('UNTRUSTED_RENDERER'); } }));
vi.mock('../../device-link/broadcast-tap', () => ({ captureDataOwnerBroadcastScope: () => ({ generation: h.generation, ownerScopeKey: `${h.user}:${h.generation}` }),
 isDataOwnerBroadcastScopeCurrent: (scope: { generation: number }) => scope.generation === h.generation }));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../../cindy-media/ingest', () => ({ ingestMedia: h.ingest }));
vi.mock('../../cindy-media/blobStore', () => ({ openBlobFile: vi.fn() }));
vi.mock('../../cindy-media/ledger', () => ({ removeRefById: vi.fn() }));
vi.mock('../../cindy-media/refCompensationJournal', () => ({ captureMediaRefCompensationScope: () => ({ assertStillValid() {} }) }));
vi.mock('../../localFileProtocol', () => ({ isLocalFilePreviewPathSupported: () => false }));
const api = createMaterialReferenceBridge();
const owner = { kind: 'account' as const, id: 'owner' };
const scope: MaterialScope = { projectId: 'p', workItemId: 't1', bindingRevision: 1 };
const other: MaterialScope = { projectId: 'p', workItemId: 't3', bindingRevision: 1 };
const locator = (r: MaterialReference, s: MaterialScope = scope) => ({ ...s, referenceId: r.id, materialId: r.materialId, version: r.version });
let db: Database.Database, root: string, filename: string, client: DbClient;
let bridge: ReturnType<typeof vi.fn>;
let beforeTx: ((input: unknown) => void) | undefined;
let afterText = false;
let textFile: { name: string; path: string };
const desktop = path.resolve(__dirname, '../../../..');
const count = (table: string) => db.prepare('SELECT COUNT(*) FROM '+table).pluck().get();
const bind = (projectId: string | null) => runProjectsTransaction(db, { action:'bindSession', actor:owner, sessionId:'t1', projectId, now:2 });

beforeAll(() => {
 root = mkdtempSync(path.join(os.tmpdir(),'cindy-material-ipc-')); filename=path.join(root,'fixture.db'); db=createBetterSqliteDatabase(filename);
 db.loadExtension(path.join(desktop,'native/sqlite-vec',`${process.platform}-${process.arch}`,process.platform==='win32'?'vec0.dll':'vec0.dylib'));
 runMigrationReplay(db,{drizzleDir:path.join(desktop,'drizzle')}); registerMaterialsIpc();
});
beforeEach(() => {
 vi.clearAllMocks(); h.user='owner'; h.generation++; h.trusted=true; h.invoked=[]; beforeTx=undefined; afterText=false;
 db.exec('DELETE FROM material_contexts; DELETE FROM material_references; DELETE FROM material_versions; DELETE FROM materials; DELETE FROM work_item_progress; DELETE FROM work_item_progress_events; DELETE FROM sessions; DELETE FROM project_members; DELETE FROM projects;');
 for (const p of ['p','q']) runProjectsTransaction(db,{ action:'create', actor:owner, now:1, newId:p, input:{name:p,owner,members:p==='p'?[{kind:'account',id:'member'},{kind:'bot',id:'owner'}]:[]} });
 db.exec("INSERT INTO sessions(id,created_at,updated_at) VALUES('t1',1,1),('t3',1,1)"); bind('p');
 runProjectsTransaction(db,{action:'bindSession',actor:owner,now:1,sessionId:'t3',projectId:'p'});
 textFile={name:'one.txt',path:path.join(root,'one.txt')};writeFileSync(textFile.path,'Original private body');
 bridge=vi.fn(async(name:string,args:unknown)=>{beforeTx?.(args);return dispatch('tx',{name,args},db);});
 client={query:async(sql:string,args:unknown[]=[])=>db.prepare(sql).all(...args),queryOne:async(sql:string,args:unknown[]=[])=>db.prepare(sql).get(...args),tx:bridge,drizzle:{}} as unknown as DbClient;
 setCurrentDbClient(client,'owner');
 const actual=io.readVerifiedMaterialText;
 vi.spyOn(io,'readVerifiedMaterialText').mockImplementation(async row=>{const result=await actual(row);if(afterText){h.generation++;h.user='other';}return result;});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();clearCurrentDbClient();});
afterAll(()=>{db.close();const relative=path.relative(os.tmpdir(),root);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Unsafe fixture cleanup');rmSync(root,{recursive:true,force:true});});

it.each(['dispatcher','inline-worker'])('round-trips all eight registered capabilities using %s and real migrated versions/references',async mode=>{
 const worker=mode==='inline-worker'?new WorkerThreadTransport({useInlineWorker:true,dbPath:filename,drizzleDir:path.join(desktop,'drizzle'),betterSqliteModulePath:require.resolve('better-sqlite3')}):undefined;
 if(worker)bridge.mockImplementation((name,args)=>worker.send('tx',{name,args}));
 try{
  const added=await api.materials.add({...scope,files:[textFile]});expect(added.referenceContract).toBe(1);const first=added.references[0];
  const reused=await api.materials.add({...other,existing:[{materialId:first.materialId,version:1}]});const pinned=reused.references[0];
  const context=await api.materialContexts.create({...other,workItemId:'t3',purpose:'reference',refs:[{referenceId:pinned.id,materialId:pinned.materialId,version:1}]});
  const file={name:'two.txt',path:path.join(root,'two.txt')};writeFileSync(file.path,'New version body');
  expect(await api.materials.addVersion({...scope,referenceId:first.id,materialId:first.materialId,file})).toMatchObject({referenceContract:1,reference:{version:2}});
  expect(await api.materials.list(scope)).toMatchObject({referenceContract:1,scope,materials:[{currentVersion:2,latestVersion:2}]});
  expect(await api.materials.list(other)).toMatchObject({materials:[{currentVersion:1,latestVersion:2}]});
  expect(await api.materials.preview(locator(pinned,other))).toMatchObject({referenceContract:1,version:1,text:'Original private body'});
  expect(await api.materials.retryRead(locator(pinned,other))).toMatchObject({referenceContract:1,version:{version:1,readState:'ready'}});
  expect(await api.materialContexts.list({...other,workItemId:'t3'})).toMatchObject({referenceContract:1,contexts:[{id:context.context.id,bindingRevision:1}]});
  expect(await api.materials.removeReference({...other,referenceId:pinned.id})).toMatchObject({referenceContract:1,reference:{status:'removed'}});
  expect((await api.materials.list(other)).materials).toEqual([]);
  expect(await api.materials.preview({contextId:context.context.id,materialId:pinned.materialId,version:1})).toMatchObject({text:'Original private body'});
  expect(await api.materials.list({projectId:'p',workItemId:'t3',history:true})).toMatchObject({history:true,materials:[{reference:{id:pinned.id,status:'removed'}}]});
  expect(count('material_versions')).toBe(2);expect(count('material_references')).toBe(2);expect(h.ingest).not.toHaveBeenCalled();
 }finally{await worker?.close();}
});
it('uses host account identity and refuses raw actor elevation, missing identity and untrusted source before disclosure',async()=>{
 const r=(await api.materials.add({...scope,files:[textFile]})).references[0];
 // Host identity is the main-owned current DbClient snapshot (`resolveProjectActor`), not the legacy
 // inproc `getCurrentUserId` (null while the worker client is ready) and never the renderer payload.
 // Keep the snapshot and `h.user` (broadcast scope only) in step when the simulated account changes.
 setCurrentDbClient(client,'outsider');
 await expect(ipcRenderer.invoke('local-db:materials:preview',{...locator(r),actor:owner,role:'owner',now:1})).rejects.toThrow('FORBIDDEN');
 // Without a current host profile there is no material actor: refuse before any transaction or read.
 const reads=bridge.mock.calls.length;
 clearCurrentDbClient();
 await expect(ipcRenderer.invoke('local-db:materials:list',{...scope,actor:owner})).rejects.toThrow('DbClient not ready');
 expect(bridge.mock.calls.length).toBe(reads);
 setCurrentDbClient(client,'owner');h.trusted=false;const n=bridge.mock.calls.length;
 await expect(api.materials.list(scope)).rejects.toThrow('UNTRUSTED_RENDERER');expect(bridge.mock.calls.length).toBe(n);
});
it('never hands material bodies to an outsider even when raw actor/role/now claim the owner',async()=>{
 const r=(await api.materials.add({...scope,files:[textFile]})).references[0];
 setCurrentDbClient(client,'outsider');
 const refused=await Promise.all([
  {channel:'local-db:materials:preview',payload:{...locator(r),actor:owner,role:'owner',now:1}},
  {channel:'local-db:materials:list',payload:{...scope,actor:owner}},
  {channel:'local-db:materials:retry-read',payload:{...locator(r),actor:owner}},
 ].map(({channel,payload})=>ipcRenderer.invoke(channel,payload).then(()=>undefined,error=>error)));
 for (const error of refused) {
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(/FORBIDDEN/);
  expect(JSON.stringify(error,Object.getOwnPropertyNames(error))).not.toContain('Original private body');
 }
 expect(count('material_references')).toBe(1);
});
it('rejects legacy missing scope and oversized locators while allowing a 400-character reference through the actual bridge',async()=>{
 const r=(await api.materials.add({...scope,files:[textFile]})).references[0],id='r'.repeat(400);
 db.prepare('UPDATE material_references SET id=? WHERE id=?').run(id,r.id);
 expect(await api.materials.preview({...locator(r),referenceId:id})).toMatchObject({text:'Original private body'});
 const n=count('material_references');
 await expect(ipcRenderer.invoke('local-db:materials:remove-reference',{materialId:r.materialId})).rejects.toThrow('REFERENCE_SCOPE_REQUIRED');
 await expect(api.materials.preview({...locator(r),referenceId:id+'r'})).rejects.toThrow('INVALID_PARAMS');
 await expect(api.materials.preview({...locator(r),materialId:'m'.repeat(201)})).rejects.toThrow('INVALID_PARAMS');
 expect(count('material_references')).toBe(n);
});
it('rejects old observed epochs after real p-q-p rebinding but preserves explicit historical context access',async()=>{
 const r=(await api.materials.add({...scope,files:[textFile]})).references[0];
 const context=await api.materialContexts.create({...scope,workItemId:'t1',purpose:'reference',refs:[{referenceId:r.id,materialId:r.materialId,version:1}]});
 bind('q');bind('p');
 await expect(api.materials.removeReference({...scope,referenceId:r.id})).rejects.toThrow('BINDING_CONFLICT');
 await expect(api.materials.preview(locator(r))).rejects.toThrow('BINDING_CONFLICT');
 expect(await api.materials.list({...scope,bindingRevision:3})).toMatchObject({materials:[]});
 expect(await api.materialContexts.list({...scope,workItemId:'t1',bindingRevision:3})).toMatchObject({contexts:[]});
 expect(await api.materialContexts.list({projectId:'p',workItemId:'t1',history:true})).toMatchObject({history:true,contexts:[{id:context.context.id,bindingRevision:1}]});
 expect(await api.materials.preview({contextId:context.context.id,materialId:r.materialId,version:1})).toMatchObject({text:'Original private body'});
 expect(db.prepare('SELECT status FROM material_references WHERE id=?').pluck().get(r.id)).toBe('active');
});
it('rechecks revocation inside the actual dispatched write after successful main prechecks',async()=>{
 h.user='member';setCurrentDbClient(client,'member');beforeTx=input=>{if(input&&typeof input==='object'&&'action'in input&&input.action==='add')runProjectsTransaction(db,{action:'removeMember',actor:owner,now:2,projectId:'p',subject:{kind:'account',id:'member'}});};
 await expect(api.materials.add({...scope,files:[textFile]})).rejects.toThrow('FORBIDDEN');
 expect(count('materials')).toBe(0);expect(count('material_references')).toBe(0);
});
it('does not return text read from the old account across the final verify-read response boundary',async()=>{
 const r=(await api.materials.add({...scope,files:[textFile]})).references[0];afterText=true;
 await expect(api.materials.preview(locator(r))).rejects.toThrow('PRECONDITION_FAILED');
 expect(io.readVerifiedMaterialText).toHaveBeenCalledOnce();
});

it('demonstrates the frozen old UI service remains incompatible instead of mistaking full typecheck for R3 acceptance',async()=>{
 vi.stubGlobal('window',{electronAPI:{localDb:api}});
 await expect(legacyListMaterials('p','t1')).rejects.toMatchObject({code:'UNKNOWN',message:expect.stringContaining('REFERENCE_SCOPE_REQUIRED')});
 await expect(legacyRemoveMaterialReference('old-material-id')).rejects.toThrow('REFERENCE_SCOPE_REQUIRED');
 expect(count('material_references')).toBe(0);expect(count('materials')).toBe(0);
});
