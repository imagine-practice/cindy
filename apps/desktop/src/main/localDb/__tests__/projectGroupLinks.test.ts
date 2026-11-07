/** DB boundary: frozen local-link contract §2/3/5/6/8. Real generated 0146..0150
 * DDL and production link/project transactions; no server/group authorization claim.
 * Existing project/material tests lack durable relation replay, five-key isolation and
 * filtered pagination. Minimal regression: replay old link after unlink or revoke owner.
 * Context is controlled main input, NOT authentication evidence. SQL/modules load once,
 * in-memory fixtures only; actual upgrade/reopen is in migrationReplay.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runProjectsTransaction } from '../worker/opHandlers/projectsTx';
import { runProjectGroupLinksTransaction, type ProjectGroupLinksTxContext } from '../worker/opHandlers/projectGroupLinksTx';
import { parseProjectGroupLinksIntent, type ProjectGroupLinkMutationResult, type ProjectGroupLinksListResult } from '../../../shared/projectGroupLinks';
const dir=path.resolve(__dirname,'../../../../drizzle');
const ddl=['0146_','0147_','0148_','0149_','0150_'].map(prefix=>fs.readFileSync(path.join(dir,fs.readdirSync(dir).find(n=>n.startsWith(prefix)&&n.endsWith('.sql'))!),'utf8').split('--> statement-breakpoint').join(';')).join(';');
const owner={kind:'account' as const,id:'owner'},other={kind:'account' as const,id:'other'},bot={kind:'bot' as const,id:'owner'};
const group={endpoint:'https://chat.example/Case/API',roomId:'aaaaaaaa-1111-4111-8111-111111111111'};
const target=(projectId='p')=>({accountId:'account-A',deviceId:'device-A',projectId});
describe('local group/project link transaction',()=>{
  let db:Database.Database,seq:number;
  const context=(patch:Partial<ProjectGroupLinksTxContext>={}):ProjectGroupLinksTxContext=>({actor:owner,accountId:'account-A',deviceId:'device-A',group,now:1000,...patch});
  const call=(intent:Record<string,unknown>,patch:Partial<ProjectGroupLinksTxContext>={},newRelationId?:string)=>runProjectGroupLinksTransaction(db,{intent,context:context(patch),
    ...(intent.action==='link'?{newRelationId:newRelationId??'row-'+(++seq)}:{})});
  const link=(requestId='link',expectedRevision=0,projectId='p',patch:Partial<ProjectGroupLinksTxContext>={},rowId?:string)=>
    call({action:'link',requestId,group:patch.group??group,target:{...target(projectId),accountId:patch.accountId??'account-A',deviceId:patch.deviceId??'device-A'},expectedRevision},patch,rowId) as ProjectGroupLinkMutationResult;
  const unlink=(rowId:string,expectedRevision=1,requestId='unlink')=>call({action:'unlink',requestId,group,target:target(),relationId:rowId,expectedRevision}) as ProjectGroupLinkMutationResult;
  const list=(input:Record<string,unknown>={},patch:Partial<ProjectGroupLinksTxContext>={})=>call({action:'list',group:patch.group??group,...input},patch) as ProjectGroupLinksListResult;
  const stored=()=>({links:db.prepare('SELECT * FROM project_group_links ORDER BY id').all(),requests:db.prepare('SELECT * FROM project_group_link_requests ORDER BY actor_kind,actor_id,request_id').all()});
  const rejects=(fn:()=>unknown,code:string)=>{const before=stored();expect(fn).toThrow('['+code+']');expect(stored()).toEqual(before);};
  beforeEach(()=>{
    seq=0;db=createBetterSqliteDatabase(':memory:');db.pragma('foreign_keys=ON');
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'active')");db.exec(ddl);
    for(const [id,subject,members] of [['p',owner,[bot,{kind:'account',id:'member'}]],['q',other,[]],['r',bot,[]]] as const)
      runProjectsTransaction(db,{action:'create',actor:id==='q'?other:owner,newId:id,now:1,input:{name:'private-title',goal:'private-goal',owner:subject,members}});
  });
  afterEach(()=>db.close());

  it('persists only metadata and separate historical commit/current states across r1/r2/old replay/r3',()=>{
    const a=link();expect(a).toMatchObject({replayed:false,change:'linked',commit:{revision:1,statusAtCommit:'active'},current:{revision:1,status:'active'}});
    const removed=unlink(a.current.relationId);expect(removed.current).toMatchObject({revision:2,status:'removed'});
    const before=stored();const replay=link();
    expect(replay).toMatchObject({replayed:true,commit:{revision:1,statusAtCommit:'active'},current:{revision:2,status:'removed'}});expect(stored()).toEqual(before);
    const restored=link('restore',2);expect(restored.current).toMatchObject({relationId:a.current.relationId,revision:3,status:'active'});
    const oldUnlink=unlink(a.current.relationId);expect(oldUnlink).toMatchObject({replayed:true,commit:{revision:2,statusAtCommit:'removed'},current:{revision:3,status:'active'}});
    expect(JSON.stringify(stored())).not.toMatch(/private-title|private-goal|storageRef|grant|canManage/);
  });

  it('keeps no-op revisions stable but persists one immutable successful request receipt',()=>{
    const a=link();const noChange=link('same-state',1);
    expect(noChange).toMatchObject({change:'unchanged',commit:{revision:1},current:{revision:1}});
    expect(stored().links).toHaveLength(1);expect(stored().requests).toHaveLength(2);
    expect(unlink(a.current.relationId).current.revision).toBe(2);
    expect(unlink(a.current.relationId,2,'already-removed')).toMatchObject({change:'unchanged',current:{revision:2}});
  });

  it('reauthenticates owner before replay and never promotes owner_id or same-id bot membership',()=>{
    link();rejects(()=>link('bot',0,'p',{actor:bot}),'NOT_PROJECT_OWNER');
    runProjectsTransaction(db,{action:'transferOwner',actor:owner,projectId:'p',subject:{kind:'account',id:'member'},now:2});
    rejects(()=>link(),'NOT_PROJECT_OWNER');
    expect(list().links).toHaveLength(1);expect(list({includeRemoved:true}).links).toEqual([]);
    // The old owner string alone, even if put back, supplies no owner membership.
    db.prepare("UPDATE projects SET owner_id='owner' WHERE id='p'").run();
    rejects(()=>link(),'NOT_PROJECT_OWNER');
  });

  it('honors real bot ownership without borrowing the creating account member role',()=>{
    rejects(()=>link('account-r',0,'r'),'NOT_PROJECT_OWNER');
    expect(link('bot-r',0,'r',{actor:bot})).toMatchObject({current:{target:{projectId:'r'}}});
    expect(list({includeRemoved:true},{actor:bot}).links.map(r=>r.target.projectId)).toEqual(['r']);
  });

  it('rejects missing projects, relation mismatch, stale CAS and changed intents with atomic zero persistence',()=>{
    rejects(()=>link('missing',0,'absent'),'NOT_PROJECT_OWNER');
    const a=link();rejects(()=>link('stale',0),'REVISION_CONFLICT');
    rejects(()=>unlink('other-id'),'RELATION_NOT_FOUND');
    rejects(()=>link('link',1),'REQUEST_CONFLICT');
    rejects(()=>unlink(a.current.relationId,9,'bad-cas'),'REVISION_CONFLICT');
    rejects(()=>call({action:'unlink',group,target:target('q'),relationId:a.current.relationId,expectedRevision:1,requestId:'foreign'},{actor:other}),'RELATION_NOT_FOUND');
  });

  it('reuses canonical endpoint/UUID identity but preserves endpoint URL path distinctions',()=>{
    const a=link();
    const variant={endpoint:' https://chat.example/Case/API/// ',roomId:group.roomId.toUpperCase()};
    const same=call({action:'link',requestId:'link',group:variant,target:target(),expectedRevision:0},{group:variant}) as ProjectGroupLinkMutationResult;
    expect(same.replayed).toBe(true);expect(same.current.relationId).toBe(a.current.relationId);
    const lower={...group,endpoint:'https://chat.example/case/API'};link('lower',0,'p',{group:lower});
    expect(stored().links).toHaveLength(2);expect(list().links).toHaveLength(1);expect(list({}, {group:lower}).links).toHaveLength(1);
  });

  it('separates all five tuple fields and binds public target/group to controlled main context',()=>{
    link();link('other-project',0,'r',{actor:bot});
    link('other-account',0,'p',{accountId:'account-B'});link('other-device',0,'p',{deviceId:'device-B'});
    const endpoint={...group,endpoint:'https://other.example/API'};link('other-server',0,'p',{group:endpoint});
    const room={...group,roomId:'bbbbbbbb-1111-4111-8111-111111111111'};link('other-room',0,'p',{group:room});
    expect(stored().links).toHaveLength(6);expect(list().links).toHaveLength(2);
    expect(list({}, {accountId:'account-B'}).links).toHaveLength(1);expect(list({}, {deviceId:'device-B'}).links).toHaveLength(1);
    rejects(()=>call({action:'link',requestId:'x',group,target:{...target(),accountId:'account-B'},expectedRevision:0}),'UNSUPPORTED_CAPABILITY');
    rejects(()=>call({action:'list',group:endpoint}),'UNSUPPORTED_CAPABILITY');
  });

  it('filters membership before pagination and never emits a hidden record count or hidden cursor',()=>{
    link('hidden',0,'q',{actor:other},'a-hidden');link('first',0,'p',{},'b-visible');link('second',0,'r',{actor:bot},'c-visible');
    const a=list({limit:1});expect(a.links.map(r=>r.relationId)).toEqual(['b-visible']);expect(a).not.toHaveProperty('total');
    const decoded=Buffer.from(a.nextCursor!,'base64url').toString('utf8');expect(decoded).not.toContain('a-hidden');
    const b=list({limit:1,cursor:a.nextCursor});expect(b.links.map(r=>r.relationId)).toEqual(['c-visible']);expect(b.nextCursor).toBeNull();
    expect(list({includeRemoved:true}).links.map(r=>r.relationId)).toEqual(['b-visible']);
    db.prepare("DELETE FROM project_members WHERE project_id='r' AND subject_kind='account' AND subject_id='owner'").run();
    expect(list({limit:1,cursor:a.nextCursor}).links).toEqual([]);
    rejects(()=>list({limit:1,cursor:a.nextCursor,includeRemoved:true}),'INVALID_PARAMS');
    rejects(()=>list({cursor:a.nextCursor},{actor:other}),'INVALID_PARAMS');
  });

  it('restricts removed records to current project owners and keeps another actor request key independent',()=>{
    const a=link();unlink(a.current.relationId);
    expect(list().links).toEqual([]);expect(list({includeRemoved:true}).links).toHaveLength(1);
    expect(list({includeRemoved:true},{actor:{kind:'account',id:'member'}}).links).toEqual([]);
    expect(link('link',0,'q',{actor:other}).replayed).toBe(false);
    expect(list({}, {actor:other}).links.map(r=>r.target.projectId)).toEqual(['q']);
  });

  it.each(['actor','grant','canManage','canManageGroup','ownerVerified'])('rejects public %s and forged context fields',field=>{
    const intent={action:'link',requestId:'bad',group,target:target(),expectedRevision:0,[field]:true};
    expect(parseProjectGroupLinksIntent(intent)).toBeNull();rejects(()=>call(intent),'INVALID_PARAMS');
    rejects(()=>runProjectGroupLinksTransaction(db,{intent:{action:'list',group},context:{...context(),[field]:true}}),'INVALID_PARAMS');
  });

  it.each(['not-a-uuid',group.roomId+'\n'])('rejects malformed room %s in both public and worker parsers',roomId=>{
    const intent={action:'list',group:{...group,roomId}};expect(parseProjectGroupLinksIntent(intent)).toBeNull();rejects(()=>call(intent,{group:{...group,roomId}}),'INVALID_PARAMS');
  });

  it('rolls back the relation too if durable receipt insertion fails; unexpected SQL details are sanitized',()=>{
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON project_group_link_requests BEGIN SELECT RAISE(ABORT,'private-goal /private/path'); END");
    rejects(()=>link(),'INTERNAL');db.exec('DROP TRIGGER fail_receipt');
    expect(link().current.revision).toBe(1);
    expect(() => db.prepare("INSERT INTO project_group_links SELECT * FROM project_group_links").run()).toThrow(/UNIQUE/);
    expect(() => db.prepare("DELETE FROM projects WHERE id='p'").run()).toThrow(/FOREIGN KEY/);
  });

  it('recovers an intentionally discarded acknowledgement by replaying the same durable intent',()=>{
    link();const before=stored();const result=link();
    expect(result.replayed).toBe(true);expect(result.commit.revision).toBe(1);expect(stored()).toEqual(before);
  });

  it('executes the same self-contained entry after inline-worker serialization',()=>{
    const inline=new Function('return ('+runProjectGroupLinksTransaction.toString()+')')() as typeof runProjectGroupLinksTransaction;
    const intent={action:'link',requestId:'inline',group,target:target(),expectedRevision:0};
    expect(inline(db,{intent,context:context(),newRelationId:'inline-row'})).toMatchObject({replayed:false,current:{relationId:'inline-row',revision:1}});
    expect(call(intent)).toMatchObject({replayed:true,commit:{relationId:'inline-row',revision:1}});
  });
});
