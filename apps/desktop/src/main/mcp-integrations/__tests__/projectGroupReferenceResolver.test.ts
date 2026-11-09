/** Unit/SQLite boundary: real G1-A codec -> new main resolver -> real G2-C authority,
 * project service and fully replayed fixed migrations. G0 G-04/05/06/11/12: a same-UUID
 * card must not read a different owner/device, nor release stale private titles. Existing
 * entity tests lack device/reference/binding scope. Minimal failure: device differs or p->q->p.
 * Host account/turn/device facts and Electron are controlled; real channel/group lease guards
 * and in-process DbClient run. No real server, worker process, account files, group or model.
 * Migrations load once; each fixture is transaction-isolated, no waits/resetModules.
 */
import path from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProjectGroupReferenceCard, readProjectGroupReferenceCard, type ProjectGroupReference }
  from '@cindy/maker-shared';
import { createBetterSqliteDatabase } from '../../localDb/betterSqliteFactory';
import { runMigrationReplay } from '../../localDb/migrationRunner';
import { createInprocDbClient, type DbClient } from '../../localDb/client/DbClient';
import { setCurrentDbClient, clearCurrentDbClient } from '../../localDb/client/current';
import { runProjectsTransaction } from '../../localDb/worker/opHandlers/projectsTx';
import { registerGroupToolAuthority } from '../../maker-ipc/botGroupToolAuthorization';
import { beginChannelToolScope } from '../../im/shared/channelToolScope';
import { resolveProjectGroupReference, type ProjectGroupReferenceResolverRuntime } from '../projectGroupReferenceResolver';
import * as schema from '../../localDb/schema';

const host=vi.hoisted(()=>({generation:1,pending:false,user:'owner',db:undefined as Database.Database|undefined}));
vi.mock('../../localDb/index',()=>({getRawDb:()=>host.db,getDrizzle:()=>drizzle(host.db!,{schema}),getCurrentUserId:()=>host.user}));
vi.mock('../../appSessionState',()=>({getActiveAppSession:()=>({mode:'authenticated',dataOwnerId:host.user,generation:host.generation}),
  activeOwnerScopeKey:()=>`${host.user}:${host.generation}`,isAppSessionBoundaryPending:()=>host.pending}));
vi.mock('../../localDb/ipc/sessions',()=>({broadcastSessionPatched:()=>undefined}));
vi.mock('../../device-link/broadcast-tap',()=>({captureDataOwnerBroadcastScope:()=>host.generation,
  isDataOwnerBroadcastScopeCurrent:(generation:number)=>host.generation===generation}));
vi.mock('../../i18n',()=>({t:(key:string)=>key}));
vi.mock('../../logger',()=>({createLogger:()=>({trace(){},debug(){},info(){},warn(){},error(){}})}));
vi.mock('../../localDb/client/WorkerThreadTransport',()=>({WorkerThreadTransport:class{constructor(){throw Error('Native transport not in this fixture');}}}));

describe('local authorized project group reference resolution',()=>{
  let db:Database.Database,client:DbClient,deviceId:string|null,ownerInput:boolean,inputKey:string;
  let live:ReturnType<ProjectGroupReferenceResolverRuntime['getSession']>;
  let beforeQuery:((sql:string)=>void)|undefined,afterQuery:((sql:string)=>void)|undefined;
  let unregister:(()=>void)|undefined;
  const owner={kind:'account' as const,id:'owner'};
  const runtime:ProjectGroupReferenceResolverRuntime={currentDeviceId:()=>deviceId,
    input:()=>({key:inputKey,boundary:'instance:1',ownerInput}),getSession:()=>live};
  const reference=(kind:'project'|'work-item'='work-item'):ProjectGroupReference=>({kind,
    locator:kind==='project'?{accountId:'owner',deviceId:'directory:self-route',projectId:'p'}:
      {accountId:'owner',deviceId:'directory:self-route',projectId:'p',sessionId:'target',bindingRevision:1},
    source:{endpoint:'https://chat.example/Case/API',roomId:'unverified-room',threadRootId:null}} as ProjectGroupReference);
  const run=(sql:string,...args:unknown[])=>db.prepare(sql).run(...args);
  const bind=(projectId:string|null)=>runProjectsTransaction(db,{action:'bindSession',actor:owner,sessionId:'target',projectId});
  const changes=()=>db.prepare('SELECT total_changes()').pluck().get();
  async function resolve(ref=reference(),caller='caller'){
    const parsed=readProjectGroupReferenceCard(JSON.parse(JSON.stringify(buildProjectGroupReferenceCard(ref))));
    if(!parsed)throw Error('fixture codec failed');
    return resolveProjectGroupReference(parsed,caller,runtime);
  }
  function denied(value:unknown,code?:string){
    expect(value).toMatchObject({ok:false,...(code?{errorCode:code}:{})});
    expect(Object.keys(value as object).sort()).toEqual(['errorCode','message','ok']);
    expect(JSON.stringify(value)).not.toMatch(/private-project|private-task|private-goal|storageRef|secret SQL|\/private\/path/);
  }
  function bot(role='canonical'){
    run("UPDATE sessions SET source='bot' WHERE id='caller'");
    run("INSERT INTO bot_profiles(id,display_name,canonical_session_id,created_at,updated_at) VALUES ('owner','same name','caller',1,1)");
    run("INSERT INTO bot_session_links(id,bot_id,session_id,role,created_at) VALUES ('link','owner','caller',?,1)",role);
  }
  beforeAll(()=>{
    db=createBetterSqliteDatabase(':memory:');host.db=db;
    const root=path.resolve(__dirname,'../../../..');
    db.loadExtension(path.join(root,'native/sqlite-vec',`${process.platform}-${process.arch}`,process.platform==='win32'?'vec0.dll':'vec0.dylib'));
    runMigrationReplay(db,{drizzleDir:path.join(root,'drizzle')});
  });
  beforeEach(async()=>{
    db.exec('BEGIN');host.generation=1;host.pending=false;host.user='owner';
    deviceId='directory:self-route';ownerInput=true;inputKey='accepted-input';
    live={instanceId:'instance',getCurrentTurnOrigin:()=>null};beforeQuery=undefined;afterQuery=undefined;
    run("INSERT INTO sessions(id,title,created_at,updated_at) VALUES ('caller','caller',1,1),('target','private-task',1,1)");
    for(const id of ['p','q'])runProjectsTransaction(db,{action:'create',actor:owner,newId:id,now:1,
      input:{name:'private-project',owner,members:id==='q'?[{kind:'bot',id:'owner'}]:[]}});
    run("UPDATE projects SET goal='private-goal' WHERE id='p'");bind('p');
    client=await createInprocDbClient();
    const query=client.query.bind(client),queryOne=client.queryOne.bind(client);
    client.query=async<T>(sql:string,args?:unknown[])=>{beforeQuery?.(sql);const result=await query<T>(sql,args);afterQuery?.(sql);return result;};
    client.queryOne=async<T>(sql:string,args?:unknown[])=>{beforeQuery?.(sql);const result=await queryOne<T>(sql,args);afterQuery?.(sql);return result;};
    setCurrentDbClient(client,'owner');
  });
  afterEach(()=>{unregister?.();unregister=undefined;clearCurrentDbClient();db.exec('ROLLBACK');});
  afterAll(()=>{db.close();host.db=undefined;});

  it('returns only authorized minimal project/work-item views with exact stable locators and zero writes',async()=>{
    const before=changes();
    const p=await resolve(reference('project')),s=await resolve();
    expect(p).toEqual({ok:true,entity:{kind:'project',locator:reference('project').locator,title:'private-project',status:'active'}});
    expect(s).toEqual({ok:true,entity:{kind:'work-item',locator:reference().locator,title:'private-task',status:'active'}});
    expect(JSON.stringify([p,s])).not.toMatch(/private-goal|unverified-room|actor|storageRef|ownerVerified/);
    expect(changes()).toBe(before);
  });

  it.each(['account','device','missing-device'])('never falls back to local same UUID on %s mismatch',async mode=>{
    const ref=reference();if(mode==='account')ref.locator.accountId='another-account';
    if(mode==='device')ref.locator.deviceId='another-device';if(mode==='missing-device')deviceId=null;
    let targetReads=0;beforeQuery=sql=>{if(sql.includes('FROM projects')||sql.includes('project-group-reference-final'))targetReads++;};
    const before=changes();denied(await resolve(ref),mode==='missing-device'?'DEVICE_UNAVAILABLE':'UNSUPPORTED_CAPABILITY');
    expect(targetReads).toBe(0);expect(changes()).toBe(before);
  });

  it('rejects a nonmember without owner-string fallback and keeps same-ID bot/account principals distinct',async()=>{
    bot();ownerInput=false;
    const before=changes();denied(await resolve(reference('project')),'NOT_PROJECT_MEMBER');
    const q=reference('project');q.locator.projectId='q';expect(await resolve(q)).toMatchObject({ok:true});
    ownerInput=true;expect(await resolve(reference('project'))).toMatchObject({ok:true});
    expect(changes()).toBe(before);
  });

  it('does not promote an account missing its member row from projects.owner_id',async()=>{
    run("DELETE FROM project_members WHERE project_id='p' AND subject_kind='account' AND subject_id='owner'");
    const before=changes();denied(await resolve(),'NOT_PROJECT_MEMBER');expect(changes()).toBe(before);
  });

  it.each(['q',null])('rejects real p -> %s -> p old binding tokens without rewriting the card',async via=>{
    const ref=reference();bind(via);bind('p');const before=changes();
    denied(await resolve(ref),'BINDING_CONFLICT');expect(changes()).toBe(before);
    if(ref.kind!=='work-item')throw Error('fixture');ref.locator.bindingRevision=3;
    expect(await resolve(ref)).toMatchObject({ok:true,entity:{locator:{bindingRevision:3}}});
  });

  it.each(['missing','deleted','other-project'])('rejects %s work items, without leaking project or task text',async mode=>{
    const ref=reference();if(ref.kind!=='work-item')throw Error('fixture');
    if(mode==='missing')ref.locator.sessionId='absent';if(mode==='deleted')run("UPDATE sessions SET status='deleted' WHERE id='target'");
    if(mode==='other-project')bind('q');
    const before=changes();denied(await resolve(ref),'REFERENCE_UNAVAILABLE');expect(changes()).toBe(before);
  });

  it.each(['revoke','binding','deleted-target','deleted-caller','caller-source'])('rechecks %s after project service preparation in the final SQLite scope snapshot',async mode=>{
    let expectedChanges:unknown;
    afterQuery=sql=>{if(!sql.includes('FROM bot_profiles'))return;afterQuery=undefined;
      if(mode==='revoke')run("DELETE FROM project_members WHERE project_id='p' AND subject_kind='account' AND subject_id='owner'");
      if(mode==='binding')bind(null);
      if(mode==='deleted-target')run("UPDATE sessions SET status='deleted' WHERE id='target'");
      if(mode==='deleted-caller')run("UPDATE sessions SET status='deleted' WHERE id='caller'");
      if(mode==='caller-source')run("UPDATE sessions SET source='shared' WHERE id='caller'");
      expectedChanges=changes();
    };
    denied(await resolve(),mode==='revoke'?'NOT_PROJECT_MEMBER':mode.startsWith('deleted-caller')||mode==='caller-source'?'TASK_ACTION_AUTHORIZATION_EXPIRED':'REFERENCE_UNAVAILABLE');
    expect(expectedChanges).toBeDefined();expect(changes()).toBe(expectedChanges);
  });

  it.each(['membership','binding','caller'])('final metadata query rejects late %s changes after the last authority refresh',async mode=>{
    let expectedChanges:unknown;
    beforeQuery=sql=>{if(!sql.includes('project-group-reference-final'))return;beforeQuery=undefined;
      if(mode==='membership')run("DELETE FROM project_members WHERE project_id='p' AND subject_kind='account' AND subject_id='owner'");
      if(mode==='binding'){bind(null);bind('p');}
      if(mode==='caller')run("UPDATE sessions SET source='shared' WHERE id='caller'");
      expectedChanges=changes();
    };
    denied(await resolve(),mode==='membership'?'REFERENCE_UNAVAILABLE':mode==='binding'?'BINDING_CONFLICT':'TASK_ACTION_AUTHORIZATION_EXPIRED');
    expect(expectedChanges).toBeDefined();expect(changes()).toBe(expectedChanges);
  });

  it.each(['owner-epoch','account','client','device','input','runtime'])('discards final results after in-flight %s changes',async mode=>{
    let fired=false;
    afterQuery=sql=>{if(!sql.includes('project-group-reference-final'))return;afterQuery=undefined;
      fired=true;
      if(mode==='owner-epoch')host.generation++;
      if(mode==='account')host.user='another-account';
      if(mode==='client')setCurrentDbClient(client,'owner');
      if(mode==='device')deviceId='moved-device';
      if(mode==='input')inputKey='other-turn';
      if(mode==='runtime')live=undefined;
    };
    const before=changes();denied(await resolve(),mode==='device'?'DEVICE_UNAVAILABLE':mode==='input'||mode==='runtime'?'TASK_ACTION_AUTHORIZATION_EXPIRED':'OWNER_SCOPE_CHANGED');
    expect(fired).toBe(true);expect(changes()).toBe(before);
    // A cached ACK ID can survive disconnection/account change. Same ID is not a grant.
    if(mode!=='device')expect(runtime.currentDeviceId()).toBe('directory:self-route');
  });

  it('ignores card source claims for authority and enforces the real group owner lease through final return',async()=>{
    bot('group');const ref=reference();ref.source.roomId='owner-action-is-not-a-grant';
    denied(await resolve(ref),'GROUP_AUTHORIZATION_REQUIRED');
    unregister=registerGroupToolAuthority('caller',{botId:'owner',mode:'tools',validate:async()=>undefined,isCurrent:()=>true});
    denied(await resolve(ref),'GROUP_AUTHORIZATION_REQUIRED');unregister();
    let active=true;unregister=registerGroupToolAuthority('caller',{botId:'owner',mode:'owner',validate:async()=>undefined,isCurrent:()=>active});
    expect(await resolve(ref)).toMatchObject({ok:true});
    afterQuery=sql=>{if(sql.includes('project-group-reference-final'))active=false;};
    denied(await resolve(ref),'GROUP_AUTHORIZATION_REQUIRED');
    expect(runtime.currentDeviceId()).toBe('directory:self-route');
  });

  it('preserves the formal task boundary instead of inventing UI/guest owner access',async()=>{
    const before=changes();denied(await resolve(reference(),'absent'),'TASK_UNAVAILABLE');
    live=undefined;denied(await resolve(),'TASK_UNAVAILABLE');
    expect(changes()).toBe(before);
  });

  it('rejects a real nonowner channel scope despite owner-looking card metadata',async()=>{
    bot('channel');unregister=beginChannelToolScope({sessionId:'caller',sessionInstanceId:'instance',scope:{
      channel:'discord',botId:'owner',laneUserId:'guest',chatId:'group',chatKind:'group',requesterIsOwner:false,companion:true,
    }});
    denied(await resolve(),'TASK_ACTION_SOURCE_UNAUTHORIZED');
  });

  it('sanitizes storage exceptions, unknown error codes and forged fields; errors perform zero writes',async()=>{
    const before=changes();afterQuery=()=>{throw Object.assign(Error('secret SQL private-task /private/path storageRef'),{code:'PRIVATE_SECRET_CODE'});};
    denied(await resolve(),'INTERNAL');afterQuery=undefined;
    const forged={...reference(),actor:owner};
    denied(await resolveProjectGroupReference(forged,'caller',runtime),'INVALID_REFERENCE');
    expect(changes()).toBe(before);
  });
});
