// @vitest-environment jsdom
/** Integration: actual R3 page/typed service -> eight registered public channels ->
 * real dispatcher/R1/S transactions/full generated0150 SQLite and temporary files.
 * Existing UI tests mock receipts and cannot detect a page/R2 scope mismatch.
 * Minimal: bindingRevision1, same bytes in t1/t3, v1 snapshot followed by t1 v2.
 * Auth/owner, sender, media broker and native UI primitives controlled; text/files/SQL are real.
 * No model/real user DB/Host claims. One module/migration load, explicit promise gates, no sleeps.
 */
import { mkdtempSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkItemMaterialsPage } from '../WorkItemMaterialsPage';
import { registerProjectProgressIpc } from '../../../../main/localDb/ipc/projectProgress';
import { beforeAll, beforeEach, afterEach, afterAll, expect, it, vi } from 'vitest';
import { ipcRenderer } from 'electron';
import { createMaterialReferenceBridge } from '../../../../preload/materialReferenceBridge';
import { registerMaterialsIpc } from '../../../../main/localDb/ipc/materials';
import * as io from '../../../../main/localDb/ipc/materialReferenceIo';

import { createBetterSqliteDatabase } from '../../../../main/localDb/betterSqliteFactory';
import { runMigrationReplay } from '../../../../main/localDb/migrationRunner';
import { dispatch } from '../../../../main/localDb/worker/dispatcher';
import { setCurrentDbClient, clearCurrentDbClient } from '../../../../main/localDb/client/current';
import type { DbClient } from '../../../../main/localDb/client/DbClient';
import { runProjectsTransaction } from '../../../../main/localDb/worker/opHandlers/projectsTx';
import type { MaterialScope } from '../../../../shared/materials';

const h = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
 route: {projectId:'p',sessionId:'t1'}, gate: undefined as Promise<void>|undefined, hold: '', listeners: [] as (()=>void)[], requests: [] as {channel:string;request:unknown}[], user: 'owner' as string | null, generation: 0, trusted: true, invoked: [] as string[], ingest: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (e: unknown,r: unknown)=>Promise<unknown>) => h.handlers.set(name,fn) },
 ipcRenderer: { invoke: async (name: string, request: unknown) => { h.invoked.push(name);h.requests.push({channel:name,request}); const value=await h.handlers.get(name)!({},request);if(h.hold===name)await h.gate;return value; } }, BrowserWindow: {} }));
vi.mock('../../../../main/localDb/index', () => ({ getCurrentUserId: () => h.user }));
vi.mock('../../../../main/localDb/ipc/sessions', () => ({ broadcastSessionPatched: vi.fn() }));
vi.mock('../../../../main/security/trustedAppRenderer', () => ({ assertTrustedAppRendererEvent: () => { if (!h.trusted) throw new Error('UNTRUSTED_RENDERER'); } }));
vi.mock('../../../../main/device-link/broadcast-tap', () => ({ captureDataOwnerBroadcastScope: () => ({ generation: h.generation, ownerScopeKey: `${h.user}:${h.generation}` }),
 isDataOwnerBroadcastScopeCurrent: (scope: { generation: number }) => scope.generation === h.generation }));
vi.mock('../../../../main/logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../../../../main/cindy-media/ingest', () => ({ ingestMedia: h.ingest }));
vi.mock('../../../../main/cindy-media/blobStore', () => ({ openBlobFile: vi.fn() }));
vi.mock('../../../../main/cindy-media/ledger', () => ({ removeRefById: vi.fn() }));
vi.mock('../../../../main/cindy-media/refCompensationJournal', () => ({ captureMediaRefCompensationScope: () => ({ assertStillValid() {} }) }));
vi.mock('../../../../main/localFileProtocol', () => ({ isLocalFilePreviewPathSupported: () => false }));
const api = createMaterialReferenceBridge();
const owner = { kind: 'account' as const, id: 'owner' };
const scope: MaterialScope = { projectId: 'p', workItemId: 't1', bindingRevision: 1 };
const other: MaterialScope = { projectId: 'p', workItemId: 't3', bindingRevision: 1 };
let db: Database.Database, root: string, filename: string, client: DbClient;
let bridge: ReturnType<typeof vi.fn>;
let beforeTx: ((input: unknown) => void) | undefined;
let afterText = false;
let textFile: { name: string; path: string };
const desktop = path.resolve(__dirname, '../../../../..');
const count = (table: string) => db.prepare('SELECT COUNT(*) FROM '+table).pluck().get();
const bind = (projectId: string | null) => runProjectsTransaction(db, { action:'bindSession', actor:owner, sessionId:'t1', projectId, now:2 });

beforeAll(() => {
 root = mkdtempSync(path.join(os.tmpdir(),'cindy-material-ipc-')); filename=path.join(root,'fixture.db'); db=createBetterSqliteDatabase(filename);
 db.loadExtension(path.join(desktop,'native/sqlite-vec',`${process.platform}-${process.arch}`,process.platform==='win32'?'vec0.dll':'vec0.dylib'));
 runMigrationReplay(db,{drizzleDir:path.join(desktop,'drizzle')}); registerMaterialsIpc();registerProjectProgressIpc();
});
beforeEach(() => {
 vi.clearAllMocks();h.route={projectId:'p',sessionId:'t1'};h.hold='';h.gate=undefined;h.listeners=[];h.requests=[]; h.user='owner'; h.generation++; h.trusted=true; h.invoked=[]; beforeTx=undefined; afterText=false;
 db.exec('DELETE FROM material_contexts; DELETE FROM material_references; DELETE FROM material_versions; DELETE FROM materials; DELETE FROM work_item_progress; DELETE FROM work_item_progress_events; DELETE FROM sessions; DELETE FROM project_members; DELETE FROM projects;');
 for (const p of ['p','q']) runProjectsTransaction(db,{ action:'create', actor:owner, now:1, newId:p, input:{name:p,owner,members:p==='p'?[{kind:'account',id:'member'},{kind:'bot',id:'owner'}]:[]} });
 db.exec("INSERT INTO sessions(id,title,created_at,updated_at) VALUES('t1','Task-t1',1,1),('t3','Task-t3',1,1)"); bind('p');
 runProjectsTransaction(db,{action:'bindSession',actor:owner,now:1,sessionId:'t3',projectId:'p'});
 textFile={name:'one.txt',path:path.join(root,'one.txt')};writeFileSync(textFile.path,'Original private body');
 bridge=vi.fn(async(name:string,args:unknown)=>{beforeTx?.(args);return dispatch('tx',{name,args},db);});
 client={query:async(sql:string,args:unknown[]=[])=>db.prepare(sql).all(...args),queryOne:async(sql:string,args:unknown[]=[])=>db.prepare(sql).get(...args),tx:bridge,drizzle:{}} as unknown as DbClient;
 setCurrentDbClient(client,'owner');
 const actual=io.readVerifiedMaterialText;
 vi.spyOn(io,'readVerifiedMaterialText').mockImplementation(async row=>{const result=await actual(row);if(afterText){h.generation++;h.user='other';}return result;});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();clearCurrentDbClient();});
afterAll(()=>{db.close();const relative=path.relative(os.tmpdir(),root);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Unsafe fixture cleanup');rmSync(root,{recursive:true,force:true});});


// Only host/native/UI primitive boundaries are controlled. Page, service, public bridge,
// registered material/progress IPC, named dispatcher, files and generated SQLite are real.
vi.mock('react-router-dom',()=>({useParams:()=>h.route,useNavigate:()=>vi.fn()}));
vi.mock('@/contexts/AuthContext',()=>({useOptionalAuth:()=>({dataOwnerId:h.user,dataOwnerGeneration:h.generation}),useOptionalDataOwnerGeneration:()=>h.generation}));
vi.mock('@/contexts/dataOwnerGeneration',()=>({getDataOwnerGeneration:()=>h.generation,isDataOwnerGenerationCurrent:(n:number)=>n===h.generation}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string,options?:{version?:number})=>key+(options?.version?':'+options.version:'')})}));
vi.mock('@/lib/toast',()=>({toast:{success:vi.fn(),info:vi.fn(),error:vi.fn()}}));
vi.mock('@/components/chat/FileLightbox',()=>({FileLightbox:()=>null}));
vi.mock('@/components/ui/select',()=>({Select:(p:{label:string;value:string;disabled?:boolean;options:{label:string;value:string}[];onValueChange:(v:string)=>void})=><select aria-label={p.label} value={p.value} disabled={p.disabled} onChange={e=>p.onValueChange(e.target.value)}>{p.options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>}));
let picked=new WeakMap<File,string>();
beforeEach(()=>{
 picked=new WeakMap();
 Object.defineProperty(window,'electronAPI',{configurable:true,value:{
  getFilePath:(f:File)=>picked.get(f)??'',
  localDb:{...api,projectProgress:{read:(request:unknown)=>ipcRenderer.invoke('local-db:project-progress:read',request)},
   projects:{onChanged:(f:()=>void)=>{h.listeners.push(f);return()=>{h.listeners=h.listeners.filter(x=>x!==f);};}}},
 }});
});
const show=()=>screen.findByRole('heading',{name:'Task-'+h.route.sessionId});
async function pick(files:{name:string;path:string}[], beforeSend?:()=>void){
 const input=document.querySelector<HTMLInputElement>('input[type="file"]');if(!input)throw Error('Missing actual file input');
 const values=files.map(f=>{const value=new File([new Uint8Array(readFileSync(f.path))],f.name,{type:'text/plain'});picked.set(value,f.path);return value;});
 beforeSend?.();await act(async()=>fireEvent.change(input,{target:{files:values}}));
}
async function switchTask(page:ReturnType<typeof render>,sessionId:string){h.route={projectId:'p',sessionId};page.rerender(<WorkItemMaterialsPage/>);await show();}
const materialRows=()=>db.prepare('SELECT id,name FROM materials ORDER BY created_at,id').all() as {id:string;name:string}[];
const refRows=()=>db.prepare('SELECT id,material_id AS materialId,work_item_id AS task,version,status FROM material_references ORDER BY id').all() as {id:string;materialId:string;task:string;version:number;status:string}[];

it('real page loads actual binding and adds same content to independent task references; snapshot v1 survives v2 and independent removal',async()=>{
 const page=render(<WorkItemMaterialsPage/>);await show();await pick([textFile]);
 await waitFor(()=>expect(refRows()).toHaveLength(1));
 expect(h.requests.find(x=>x.channel==='local-db:materials:add')?.request).toMatchObject({bindingRevision:1,workItemId:'t1'});
 const first=refRows()[0];await switchTask(page,'t3');await pick([textFile]);
 await waitFor(()=>expect(refRows()).toHaveLength(2));expect(materialRows()).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:'ccAgent.materials.snapshot.create'}));
 fireEvent.click(await screen.findByRole('button',{name:'ccAgent.materials.snapshot.confirm'}));
 await waitFor(()=>expect(count('material_contexts')).toBe(1));
 const context=(await api.materialContexts.list(other)).contexts[0];expect(context.refs[0]).toMatchObject({version:1});
 await switchTask(page,'t1');
 const v2={name:'one.txt',path:path.join(root,'version2.txt')};writeFileSync(v2.path,'New immutable version');await pick([v2]);
 fireEvent.click(await screen.findByRole('button',{name:'ccAgent.materials.conflict.newVersion'}));
 await waitFor(()=>expect(refRows().find(x=>x.id===first.id)?.version).toBe(2));
 expect((await api.materials.list(other)).materials[0]).toMatchObject({currentVersion:1,latestVersion:2});
 expect(await api.materials.preview({contextId:context.id,materialId:first.materialId,version:1})).toMatchObject({text:'Original private body',version:1});
 expect(await api.materials.retryRead({contextId:context.id,materialId:first.materialId,version:1})).toMatchObject({referenceContract:1});
 fireEvent.click(screen.getByRole('button',{name:'ccAgent.materials.removeReference'}));
 fireEvent.click(await screen.findByRole('button',{name:'ccAgent.materials.removeConfirmAction'}));
 await waitFor(()=>expect(refRows().find(x=>x.id===first.id)?.status).toBe('removed'));
 expect(refRows().find(x=>x.task==='t3')?.status).toBe('active');
 expect(new Set(h.invoked.filter(x=>x.includes('materials:')||x.includes('material-contexts:')))).toEqual(new Set([
 'local-db:materials:list','local-db:materials:add','local-db:materials:add-version','local-db:materials:remove-reference','local-db:materials:preview','local-db:materials:retry-read','local-db:material-contexts:create','local-db:material-contexts:list']));
});
it('real same-name create-new path preserves explicit choice into the registered transaction',async()=>{
 render(<WorkItemMaterialsPage/>);await show();await pick([textFile]);await waitFor(()=>expect(refRows()).toHaveLength(1));
 const second={name:'one.txt',path:path.join(root,'separate.txt')};writeFileSync(second.path,'Separate content');await pick([second]);
 fireEvent.click(await screen.findByRole('button',{name:'ccAgent.materials.conflict.newMaterial'}));
 await waitFor(()=>expect(materialRows()).toHaveLength(2));
 expect(h.requests.filter(x=>x.channel==='local-db:materials:add').at(-1)?.request).toMatchObject({files:[{sameNameAction:'create-new'}]});
 expect(materialRows().map(x=>x.name)).toEqual(['one.txt','one.txt']);
});
it.each(['route','owner'] as const)('old real list reply is discarded after %s changes',async mode=>{
 await api.materials.add({...scope,files:[textFile]});
 let release!:()=>void;h.gate=new Promise<void>(resolve=>{release=resolve;});h.hold='local-db:materials:list';
 const page=render(<WorkItemMaterialsPage/>);await waitFor(()=>expect(h.invoked).toContain('local-db:materials:list'));
 h.hold='';if(mode==='route')h.route={projectId:'p',sessionId:'t3'};else{h.generation++;h.user='other';setCurrentDbClient(client,h.user);}
 page.rerender(<WorkItemMaterialsPage/>);await act(async()=>release());
 if(mode==='route'){await show();await waitFor(()=>expect(screen.queryByText('one.txt')).toBeNull());}
 else await waitFor(()=>expect(screen.queryByText('one.txt')).toBeNull());
 expect(count('material_references')).toBe(1);
});

it('single-item retry after a real missing-file rejection never repeats the successful addition',async()=>{
 render(<WorkItemMaterialsPage/>);await show();
 const bad={name:'retry.txt',path:path.join(root,'retry.txt')};writeFileSync(bad.path,'Retry exact body');
 const backup=path.join(root,'retry.backup');
 await pick([textFile,bad],()=>renameSync(bad.path,backup));
 const retry=await screen.findByRole('button',{name:'ccAgent.materials.retryAdd'});
 await waitFor(()=>expect(refRows()).toHaveLength(1));
 renameSync(backup,bad.path);fireEvent.click(retry);
 await waitFor(()=>expect(refRows()).toHaveLength(2));
 expect(materialRows()).toHaveLength(2);
 expect(h.requests.filter(x=>x.channel==='local-db:materials:add').at(-1)?.request).toMatchObject({files:[{name:'retry.txt',path:bad.path}]});
});
