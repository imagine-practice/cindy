/** Regression: an adopted project retains local-v1/member and is hidden after
 * login. Existing migration tests prove copy publication, not this repair.
 * Minimum input: identical source/target with bot owner, local member and task.
 * Tier: local DB boundary; production service and transaction with in-memory
 * SQLite/generated 0149 DDL. No real auth, user DB, backup or UI claims.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import type { DbClient } from '../client/DbClient';
import { createProjectMembershipRecoveryService, type ProjectMembershipRecoveryDeps, type ProjectMembershipRecoveryScope } from '../projectMembershipRecovery';
import { runProjectMembershipRecoveryTransaction, type ProjectMembershipRecoveryRequest, type ProjectMembershipRecoverySnapshot } from '../worker/opHandlers/projectMembershipRecoveryTx';
import { dispatch } from '../worker/dispatcher';

const dir=path.resolve(__dirname,'../../../../drizzle');
const ddl=fs.readFileSync(path.join(dir,fs.readdirSync(dir).find(f=>f.startsWith('0149_')&&f.endsWith('.sql'))!),'utf8').split('--> statement-breakpoint').join(';');
let db:Database.Database, source:ProjectMembershipRecoverySnapshot, scope:ProjectMembershipRecoveryScope, current:ProjectMembershipRecoveryScope;
let deps:ProjectMembershipRecoveryDeps, dropped:boolean;
const snapshot=() => {
  const r=runProjectMembershipRecoveryTransaction(db,{ action:'inspect',projectId:'p' });
  if (!('snapshot' in r)) throw new Error('Expected snapshot'); return r.snapshot;
};
beforeEach(()=>{
  db=createBetterSqliteDatabase(':memory:'); db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'active');"+ddl);
  db.exec(`INSERT INTO projects(id,name,goal,owner_id,status,created_at,updated_at) VALUES('p','Synthetic recovery',NULL,'bot','active',1,1);
    INSERT INTO project_members VALUES('p','bot','bot','owner',1);
    INSERT INTO project_members VALUES('p','account','local-v1','member',2);
    INSERT INTO sessions(id,project_id,assignee_kind,assignee_id) VALUES('s','p','bot','bot');`);
  dropped=false;
  const client={tx:async (name:string,args:ProjectMembershipRecoveryRequest)=>{
    const result=await dispatch('tx',{name,args},db);
    if(args.action==='repair'&&dropped){dropped=false;throw new Error('Synthetic lost ACK');}
    return result;
  }} as unknown as DbClient;
  scope={ownerId:'cloud',generation:1,clientEpoch:1,client};current=scope;source=snapshot();
  deps={capture:()=>scope,isCurrent:s=>s===current,proveSource:vi.fn(async()=>structuredClone(source)),
    backup:vi.fn(async()=>'/synthetic-private/before.db'),confirm:vi.fn(async()=>true),changed:vi.fn()};
});
afterEach(()=>db.close());

it('previews without writes/backup and repairs only one member identity, preserving owner/tasks/history metadata',async()=>{
  const service=createProjectMembershipRecoveryService(deps);const before=snapshot();
  const p=await service.preview('p');expect(p).toMatchObject({projectId:'p',taskCount:1,from:'local-v1/member',botOwnerUnchanged:true});
  expect(snapshot()).toEqual(before);expect(deps.backup).not.toHaveBeenCalled();
  const result=await service.repair(p.previewId);expect(result.status).toBe('repaired');
  const after=snapshot();expect(after.project).toEqual(before.project);expect(after.tasks).toEqual(before.tasks);
  expect(after.members).toEqual([{kind:'account',id:'cloud',role:'member',addedAt:2},{kind:'bot',id:'bot',role:'owner',addedAt:1}]);
  await service.repair(p.previewId);expect(deps.backup).toHaveBeenCalledTimes(1);expect(deps.confirm).toHaveBeenCalledTimes(1);
});
it('moves tasks assigned to the legacy local account onto the repaired identity, leaving no non-member assignee',async()=>{
  // In local mode "assigned to the current account" is stored as account/local-v1, so replacing
  // only project_members would leave those tasks pointing at an identity that is no longer a member.
  db.exec("INSERT INTO sessions(id,project_id,assignee_kind,assignee_id) VALUES('s2','p','account','local-v1')");
  vi.mocked(deps.proveSource).mockImplementation(async()=>snapshot());
  const service=createProjectMembershipRecoveryService(deps);const p=await service.preview('p');
  expect(await service.repair(p.previewId)).toMatchObject({status:'repaired'});
  const after=snapshot();
  expect(after.tasks.find(task=>task.id==='s2')).toMatchObject({assigneeKind:'account',assigneeId:'cloud'});
  const members=new Set(after.members.map(member=>`${member.kind}:${member.id}`));
  for (const task of after.tasks) {
    if (task.assigneeKind && task.assigneeId) expect(members.has(`${task.assigneeKind}:${task.assigneeId}`)).toBe(true);
  }
  // The bot-owned task stays untouched.
  expect(after.tasks.find(task=>task.id==='s')).toMatchObject({assigneeKind:'bot',assigneeId:'bot'});
});
it('does not write when the exact confirmation is cancelled or backup fails',async()=>{
  const before=snapshot();vi.mocked(deps.confirm).mockResolvedValue(false);
  const service=createProjectMembershipRecoveryService(deps),p=await service.preview('p');
  await expect(service.repair(p.previewId)).rejects.toMatchObject({code:'CANCELLED'});expect(deps.backup).not.toHaveBeenCalled();
  vi.mocked(deps.confirm).mockResolvedValue(true);vi.mocked(deps.backup).mockRejectedValue(new Error('Synthetic backup failure'));
  await expect(service.repair(p.previewId)).rejects.toThrow('Synthetic backup failure');expect(snapshot()).toEqual(before);
});
it('fails closed for unproven source and diverged target rather than granting membership',async()=>{
  const service=createProjectMembershipRecoveryService(deps);vi.mocked(deps.proveSource).mockRejectedValueOnce(new Error('No bound adoption proof'));
  await expect(service.preview('p')).rejects.toThrow('No bound adoption proof');
  db.prepare("UPDATE projects SET owner_id='other' WHERE id='p'").run();
  await expect(service.preview('p')).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
  expect(snapshot().members.some(m=>m.id==='cloud')).toBe(false);
});
it('rejects old account generations after awaits, even when the same account returns',async()=>{
  vi.mocked(deps.proveSource).mockImplementationOnce(async()=>{current={...scope,generation:2};return source;});
  await expect(createProjectMembershipRecoveryService(deps).preview('p')).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
  expect(deps.backup).not.toHaveBeenCalled();
});
it('rechecks account/client and target state after backup',async()=>{
  const service=createProjectMembershipRecoveryService(deps),p=await service.preview('p');
  vi.mocked(deps.backup).mockImplementationOnce(async()=>{current={...scope,clientEpoch:2};return '/synthetic';});
  await expect(service.repair(p.previewId)).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
  expect(snapshot().members.some(m=>m.id==='local-v1')).toBe(true);
  current=scope;vi.mocked(deps.backup).mockImplementationOnce(async()=>{
    db.prepare("DELETE FROM project_members WHERE subject_id='local-v1'").run();return '/synthetic';
  });
  await expect(service.repair(p.previewId)).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
});
it('reconciles a lost ACK with the same preview without a second confirmation, backup or member write',async()=>{
  const service=createProjectMembershipRecoveryService(deps),p=await service.preview('p');dropped=true;
  await expect(service.repair(p.previewId)).rejects.toThrow('Synthetic lost ACK');
  expect((await service.repair(p.previewId)).status).toBe('already-repaired');
  expect(deps.backup).toHaveBeenCalledTimes(1);expect(deps.confirm).toHaveBeenCalledTimes(1);
  expect(snapshot().members.filter(m=>m.id==='cloud')).toHaveLength(1);
});
it('keeps the same in-flight intent unknown to a concurrent caller until its ACK resolves',async()=>{
  let release!:()=>void,entered!:()=>void;
  const hold=new Promise<void>(r=>{release=r;}), dispatched=new Promise<void>(r=>{entered=r;});
  const original=scope.client.tx.bind(scope.client);
  scope.client.tx=(async(name:string,args:ProjectMembershipRecoveryRequest)=>{
    const result=await original(name,args);
    if(args.action==='repair'){entered();await hold;}
    return result;
  }) as DbClient['tx'];
  const api=createProjectMembershipRecoveryService(deps),p=await api.preview('p');
  const first=api.repair(p.previewId);await dispatched;
  await expect(api.repair(p.previewId)).rejects.toMatchObject({code:'PRECONDITION_FAILED',writeOutcome:'unknown'});
  release();expect((await first).status).toBe('repaired');
  expect(deps.confirm).toHaveBeenCalledTimes(1);expect(deps.backup).toHaveBeenCalledTimes(1);
});
it('rejects changed task bindings, archival, existing target roles and unknown preview ids',async()=>{
  const service=createProjectMembershipRecoveryService(deps),p=await service.preview('p');
  await expect(service.repair('unknown')).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
  db.prepare("UPDATE sessions SET assignee_id=NULL WHERE id='s'").run();
  await expect(service.repair(p.previewId)).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
  db.prepare("UPDATE sessions SET assignee_id='bot'").run();db.prepare("UPDATE projects SET status='archived'").run();source=snapshot();
  await expect(service.preview('p')).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
  db.prepare("UPDATE projects SET status='active'").run();db.prepare("INSERT INTO project_members VALUES('p','account','cloud','member',3)").run();source=snapshot();
  await expect(service.preview('p')).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
});
it('rolls back on storage failure and supports the same self-contained inline-worker transaction',()=>{
  const before=snapshot();db.exec("CREATE TRIGGER fail_member BEFORE UPDATE ON project_members BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END;");
  const embedded=new Function('return ('+runProjectMembershipRecoveryTransaction.toString()+')')() as typeof runProjectMembershipRecoveryTransaction;
  expect(()=>embedded(db,{action:'repair',projectId:'p',verifiedOwnerId:'cloud',expected:before})).toThrow('Synthetic failure');
  expect(snapshot()).toEqual(before);
});
