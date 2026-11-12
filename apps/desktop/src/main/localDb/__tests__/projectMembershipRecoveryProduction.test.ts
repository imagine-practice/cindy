/** DB adapter regression: a first-account reservation is not proof that an
 * existing target was adopted. Service mocks cannot test file-identity binding,
 * actual DB selection, private online backup or source non-mutation.
 * Tier: synthetic local DB/filesystem boundary, tiny mkdtemp DBs only. Auth/OS
 * confirmation are injected; no real account, user profile or desktop action.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { clearCurrentDbClient, setCurrentDbClient, getCurrentDbClientSnapshot } from '../client/current';
import type { DbClient } from '../client/DbClient';
import { createProductionProjectMembershipRecovery } from '../projectMembershipRecoveryProduction';
import { ownerDatabasePath } from '../modelDefaultsProfile';
import { recordModelVisibilityAdoption } from '../modelVisibilityAdoption';
import { runProjectMembershipRecoveryTransaction, type ProjectMembershipRecoveryRequest } from '../worker/opHandlers/projectMembershipRecoveryTx';
import { dispatch } from '../worker/dispatcher';
import { registerProjectMembershipRecoveryIpc } from '../ipc/projectMembershipRecovery';

const h=vi.hoisted(()=>({root:'',owner:'cloud',generation:1,pending:false,requester:true,selectedPath:'',
  frame:{url:'http://localhost:5173/'},destroyed:false,allowed:true,onDialog:undefined as (()=>void)|undefined,response:0,
  handlers:new Map<string,(event:unknown,id:unknown)=>Promise<unknown>>(),listeners:new Map<string,(...args:unknown[])=>void>(),
}));
vi.mock('electron',()=>({app:{getPath:()=>h.root,isPackaged:false},
  ipcMain:{handle:(name:string,handler:(event:unknown,id:unknown)=>Promise<unknown>)=>h.handlers.set(name,handler)},
  BrowserWindow:{fromWebContents:()=>({})},dialog:{showMessageBox:async()=>{h.onDialog?.();return {response:h.response};}},
}));
vi.mock('../../security/trustedAppRenderer',()=>({assertTrustedAppRendererEvent:()=>{if(!h.allowed)throw new Error('Untrusted renderer');}}));
vi.mock('../../device-link/broadcast-tap',()=>({captureDataOwnerBroadcastScope:()=>({ownerStamp:{}}),isDataOwnerBroadcastScopeCurrent:()=>true}));
vi.mock('../../appSessionState',()=>({
  getActiveAppSession:()=>({mode:'cloud',dataOwnerId:h.owner,generation:h.generation}),
  isAppSessionBoundaryPending:()=>h.pending,
  ownerScopedUserDataPath:(...parts:string[])=>path.join(h.root,'owners','synthetic-owner',...parts),
}));
let db:Database.Database, target:string, source:string;
const dir=path.resolve(__dirname,'../../../../drizzle');
const ddl=fs.readFileSync(path.join(dir,fs.readdirSync(dir).find(f=>f.startsWith('0149_')&&f.endsWith('.sql'))!),'utf8').split('--> statement-breakpoint').join(';');
beforeEach(async()=>{
  h.root=fs.mkdtempSync(path.join(os.tmpdir(),'cindy-project-recovery-'));h.owner='cloud';h.generation=1;h.pending=false;h.requester=true;
  h.handlers.clear();h.listeners.clear();h.destroyed=false;h.allowed=true;h.onDialog=undefined;h.response=0;
  source=ownerDatabasePath(h.root,'local-v1');target=ownerDatabasePath(h.root,h.owner);h.selectedPath=target;
  const local=createBetterSqliteDatabase(source);
  local.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'active');"+ddl);
  local.exec(`INSERT INTO projects(id,name,owner_id,status,created_at,updated_at) VALUES('p','Synthetic recovery','bot','active',1,1);
    INSERT INTO project_members VALUES('p','bot','bot','owner',1);
    INSERT INTO project_members VALUES('p','account','local-v1','member',2);
    INSERT INTO sessions(id,project_id,assignee_kind,assignee_id) VALUES('s','p','bot','bot');`);
  await local.backup(target);local.close();
  fs.writeFileSync(source.slice(0,-3)+'.local-profile-migration.json',JSON.stringify({ownerId:h.owner,claimedAt:1}));
  db=createBetterSqliteDatabase(target);
  const client={query:async(sql:string,params:unknown[]=[])=>sql==='PRAGMA database_list'?[{name:'main',file:h.selectedPath}]:db.prepare(sql).all(...params),
    tx:async(name:string,args:ProjectMembershipRecoveryRequest)=>dispatch('tx',{name,args},db)} as unknown as DbClient;
  setCurrentDbClient(client,h.owner);
  registerProjectMembershipRecoveryIpc();
});
afterEach(()=>{
  clearCurrentDbClient();db.close();
  const actual=fs.realpathSync(h.root),parent=fs.realpathSync(os.tmpdir());
  if(path.dirname(actual)!==parent||!path.basename(actual).startsWith('cindy-project-recovery-'))throw new Error('Unsafe fixture cleanup');
  fs.rmSync(actual,{recursive:true,force:true});
});
const service=(confirm=vi.fn(async()=>true))=>createProductionProjectMembershipRecovery(confirm,vi.fn(),()=>h.requester);
it('rejects reservation-only and replaced-file adoption markers; preview has no backup or writes',async()=>{
  await expect(service().preview('p')).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
  fs.writeFileSync(target+'.model-visibility-adoption.v1.json',JSON.stringify({version:1,identity:'unrelated-file'}));
  await expect(service().preview('p')).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
  recordModelVisibilityAdoption(target);
  expect(await service().preview('p')).toMatchObject({projectId:'p',taskCount:1});
  expect(fs.existsSync(path.join(h.root,'owners'))).toBe(false);
  expect(db.prepare("SELECT role FROM project_members WHERE subject_id='local-v1'").pluck().get()).toBe('member');
});
it('requires the verified account receipt, exact current DB selection and no teardown boundary',async()=>{
  recordModelVisibilityAdoption(target);
  const receipt=source.slice(0,-3)+'.local-profile-migration.json';fs.writeFileSync(receipt,JSON.stringify({ownerId:'other'}));
  await expect(service().preview('p')).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
  fs.writeFileSync(receipt,JSON.stringify({ownerId:'cloud',claimedAt:1}));h.selectedPath=source;
  await expect(service().preview('p')).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
  h.selectedPath=target;h.pending=true;
  await expect(service().preview('p')).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
});
it('creates a verified private online backup, then changes one member and preserves the source/target tasks',async()=>{
  recordModelVisibilityAdoption(target);const api=service(),p=await api.preview('p');
  const result=await api.repair(p.previewId);expect(result.status).toBe('repaired');
  expect(result.backupPath.startsWith(path.join(h.root,'owners','synthetic-owner')+path.sep)).toBe(true);
  const backup=createBetterSqliteDatabase(result.backupPath,{readonly:true,fileMustExist:true});
  const local=createBetterSqliteDatabase(source,{readonly:true,fileMustExist:true});
  try {
    for(const check of [backup,local])expect(check.prepare("SELECT role FROM project_members WHERE subject_id='local-v1'").pluck().get()).toBe('member');
    expect(backup.pragma('quick_check',{simple:true})).toBe('ok');
    expect(db.prepare("SELECT role FROM project_members WHERE subject_id='cloud'").pluck().get()).toBe('member');
    expect(db.prepare('SELECT owner_id FROM projects').pluck().get()).toBe('bot');
    expect(db.prepare('SELECT id,project_id,assignee_id FROM sessions').get()).toEqual({id:'s',project_id:'p',assignee_id:'bot'});
  } finally {backup.close();local.close();}
});
it('cancels before backup and refuses a stale caller or account generation after confirmation',async()=>{
  recordModelVisibilityAdoption(target);const cancelled=service(vi.fn(async()=>false)),p=await cancelled.preview('p');
  await expect(cancelled.repair(p.previewId)).rejects.toMatchObject({code:'CANCELLED'});expect(fs.existsSync(path.join(h.root,'owners'))).toBe(false);
  const changed=service(vi.fn(async()=>{h.generation++;return true;})),p2=await changed.preview('p');
  await expect(changed.repair(p2.previewId)).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
  expect(db.prepare("SELECT COUNT(*) FROM project_members WHERE subject_id='cloud'").pluck().get()).toBe(0);
  h.requester=false;await expect(service().preview('p')).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
});
const sender={id:1,get mainFrame(){return h.frame;},isDestroyed:()=>h.destroyed,send:vi.fn(),
  once:(name:string,listener:(...args:unknown[])=>void)=>h.listeners.set(name,listener),
  on:(name:string,listener:(...args:unknown[])=>void)=>h.listeners.set(name,listener),
};
const request=(action:'preview'|'apply',id:string)=>h.handlers.get('local-db:projects:membership-recovery-'+action)!({sender,senderFrame:h.frame},id);
it('registered IPC rejects an untrusted sender and native cancellation never applies a repair',async()=>{
  recordModelVisibilityAdoption(target);h.allowed=false;
  await expect(request('preview','p')).rejects.toThrow('Untrusted renderer');h.allowed=true;
  const p=await request('preview','p') as {ok:true;preview:{previewId:string}};expect(p.ok).toBe(true);
  expect(await request('apply',p.preview.previewId)).toEqual({ok:false,errorCode:'CANCELLED',writeOutcome:'not-applied'});
  expect(fs.existsSync(path.join(h.root,'owners'))).toBe(false);
});
it('invalidates the same-URL renderer document on main-frame navigation during native confirmation',async()=>{
  recordModelVisibilityAdoption(target);
  const p=await request('preview','p') as {ok:true;preview:{previewId:string}};h.response=1;
  h.onDialog=()=>h.listeners.get('did-start-navigation')?.({},h.frame.url,false,true);
  expect(await request('apply',p.preview.previewId)).toEqual({ok:false,errorCode:'PRECONDITION_FAILED',writeOutcome:'not-applied'});
  expect(db.prepare("SELECT COUNT(*) FROM project_members WHERE subject_id='cloud'").pluck().get()).toBe(0);
  expect(fs.existsSync(path.join(h.root,'owners'))).toBe(false);
  expect(await request('apply',p.preview.previewId)).toMatchObject({ok:false,errorCode:'PRECONDITION_FAILED'});
});
it('retains unknown outcome after a committed lost ACK and same-URL navigation revokes the writable preview',async()=>{
  recordModelVisibilityAdoption(target);h.response=1;
  const client=getCurrentDbClientSnapshot()!.client,original=client.tx.bind(client);
  client.tx=(async(name:string,args:ProjectMembershipRecoveryRequest)=>{
    const result=await original(name,args);
    if(args.action==='repair')throw new Error('Synthetic lost ACK');
    return result;
  }) as DbClient['tx'];
  const p=await request('preview','p') as {ok:true;preview:{previewId:string}};
  expect(await request('apply',p.preview.previewId)).toMatchObject({ok:false,writeOutcome:'unknown'});
  expect(db.prepare("SELECT COUNT(*) FROM project_members WHERE subject_id='cloud'").pluck().get()).toBe(1);
  h.listeners.get('did-start-navigation')?.({},h.frame.url,false,true);
  expect(await request('apply',p.preview.previewId)).toEqual({ok:false,errorCode:'PRECONDITION_FAILED',writeOutcome:'unknown'});
  expect(db.prepare("SELECT COUNT(*) FROM project_members WHERE subject_id='cloud'").pluck().get()).toBe(1);
});
