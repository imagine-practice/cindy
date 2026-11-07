/** Main/SQLite boundary: frozen local-link contract §§4–8. Existing A/B tests lack
 * coordinator lifetime and ACK classification. Minimal failure: revoke after precheck,
 * or commit then lose ACK. Real A adapter, entity authority, B worker and generated
 * migrations; HTTP GET responses, app owner/device/turn and dispatch are controlled.
 * No real Chat Server, worker transport, Host, account files, group writes or model.
 * Schema/modules load once; transaction-isolated fixtures, no waits. Unit tier.
 */
import path from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBetterSqliteDatabase } from '../../localDb/betterSqliteFactory';
import { runMigrationReplay } from '../../localDb/migrationRunner';
import { createInprocDbClient, type DbClient } from '../../localDb/client/DbClient';
import { setCurrentDbClient, clearCurrentDbClient } from '../../localDb/client/current';
import { createDbTransportError, DB_TRANSPORT_OUTCOME_UNKNOWN, DB_TRANSPORT_NOT_SENT } from '../../localDb/client/DbTransport';
import { runProjectsTransaction } from '../../localDb/worker/opHandlers/projectsTx';
import { runProjectGroupLinksTransaction } from '../../localDb/worker/opHandlers/projectGroupLinksTx';
import { createChatGroupAuthority } from '../../maker-ipc/chatGroupAuthority';
import { registerGroupToolAuthority } from '../../maker-ipc/botGroupToolAuthorization';
import { beginChannelToolScope } from '../../im/shared/channelToolScope';
import { coordinateProjectGroupLinksFromUi, coordinateProjectGroupLinksFromTask,
  type ProjectGroupLinksTaskRuntime, type ProjectGroupLinksUiRuntime } from '../projectGroupLinksCoordinator';
import type { ProjectGroupLinksResponse } from '../../../shared/projectGroupLinks';
import * as schema from '../../localDb/schema';

const host=vi.hoisted(()=>({generation:1,pending:false,user:'owner',db:undefined as Database.Database|undefined}));
vi.mock('../../localDb/index',()=>({getRawDb:()=>host.db,getDrizzle:()=>drizzle(host.db!,{schema}),getCurrentUserId:()=>host.user}));
vi.mock('../../appSessionState',()=>({getActiveAppSession:()=>({dataOwnerId:host.user,generation:host.generation}),
  activeOwnerScopeKey:()=>`${host.user}:${host.generation}`,isAppSessionBoundaryPending:()=>host.pending}));
vi.mock('../../i18n',()=>({t:(key:string)=>key}));
vi.mock('../../logger',()=>({createLogger:()=>({trace(){},debug(){},info(){},warn(){},error(){}})}));
vi.mock('../../localDb/client/WorkerThreadTransport',()=>({WorkerThreadTransport:class{constructor(){throw Error('Native transport outside fixture');}}}));

const group={endpoint:'https://chat.example/Case/API',roomId:'aaaaaaaa-1111-4111-8111-111111111111'};
const self='bbbbbbbb-1111-4111-8111-111111111111',botActor='cccccccc-1111-4111-8111-111111111111';
const owner={kind:'account' as const,id:'owner'},botSubject={kind:'bot' as const,id:'owner'};
const target=(projectId='p')=>({accountId:'owner',deviceId:'cached-device',projectId});
const link=(requestId='r1',expectedRevision=0,projectId='p')=>({action:'link',group,target:target(projectId),requestId,expectedRevision});
const list=(rest:object={})=>({action:'list',group,...rest});

describe('group/project links main coordination',()=>{
  let db:Database.Database,client:DbClient,device:string|null,uiTrusted:boolean,ownerInput:boolean,inputKey:string;
  let live:ReturnType<ProjectGroupLinksTaskRuntime['getSession']>;
  let service:ReturnType<ProjectGroupLinksUiRuntime['groupService']>;
  let role:'owner'|'admin'|'member',joined:boolean,botJoined:boolean,botRole:'owner'|'admin'|'member',endpoint:string;
  let httpCount:number,txCount:number,reads:string[],beforeTx:(()=>void)|undefined,afterTx:(()=>void)|undefined;
  let atHttp:((count:number,route:string)=>void)|undefined,atFinal:(()=>void)|undefined;
  let ack:'normal'|'lost'|'not-sent'|'arbitrary',unregister:(()=>void)|undefined,leaseCurrent:boolean;
  const run=(sql:string,...args:unknown[])=>db.prepare(sql).run(...args);
  const stored=()=>({links:db.prepare('SELECT * FROM project_group_links ORDER BY id').all(),receipts:db.prepare('SELECT * FROM project_group_link_requests ORDER BY request_id').all()});
  const ui:ProjectGroupLinksUiRuntime={groupService:()=>service,currentDeviceId:()=>device,
    assertTrustedUi:()=>{if(!uiTrusted)throw Error('GROUP_ACCESS_DENIED');}};
  const task:ProjectGroupLinksTaskRuntime={...ui,input:()=>({key:inputKey,boundary:'instance:1',ownerInput}),getSession:()=>live};
  const request=(raw:unknown=link(),source:'ui'|'task'='ui')=>source==='ui'?coordinateProjectGroupLinksFromUi(raw,ui):coordinateProjectGroupLinksFromTask(raw,'caller',task);
  function denied(value:ProjectGroupLinksResponse,commitState='not-committed',code?:string){
    expect(value).toMatchObject({ok:false,commitState,...(code?{errorCode:code}:{})});
    expect(Object.keys(value).sort()).toEqual(['commitState','errorCode','message','ok']);
    expect(JSON.stringify(value)).not.toMatch(/private-title|private-goal|secret SQL|storageRef|token|\/private\/path/);
  }
  function bot(role='canonical'){
    run("UPDATE sessions SET source='bot' WHERE id='caller'");
    run("INSERT INTO bot_profiles(id,display_name,canonical_session_id,created_at,updated_at) VALUES ('owner','private-title','caller',1,1)");
    run("INSERT INTO bot_session_links(id,bot_id,session_id,role,created_at) VALUES ('b','owner','caller',?,1)",role);
  }
  beforeAll(()=>{
    db=createBetterSqliteDatabase(':memory:');host.db=db;
    const root=path.resolve(__dirname,'../../../..');
    db.loadExtension(path.join(root,'native/sqlite-vec',`${process.platform}-${process.arch}`,process.platform==='win32'?'vec0.dll':'vec0.dylib'));
    runMigrationReplay(db,{drizzleDir:path.join(root,'drizzle')});
  });
  beforeEach(async()=>{
    db.exec('BEGIN');host.generation=1;host.pending=false;host.user='owner';device='cached-device';uiTrusted=true;
    ownerInput=true;inputKey='turn';live={instanceId:'instance',getCurrentTurnOrigin:()=>null};
    role='admin';joined=true;botJoined=true;botRole='admin';endpoint=group.endpoint;leaseCurrent=true;
    httpCount=0;txCount=0;reads=[];beforeTx=undefined;afterTx=undefined;atHttp=undefined;atFinal=undefined;ack='normal';
    run("INSERT INTO sessions(id,title,created_at,updated_at) VALUES ('caller','private-title',1,1)");
    for(const id of ['p','q'])runProjectsTransaction(db,{action:'create',actor:owner,newId:id,now:1,input:{name:'private-title',owner,members:[]}});
    client=await createInprocDbClient();
    const queryOne=client.queryOne.bind(client);
    client.queryOne=async<T>(sql:string,args?:unknown[])=>{if(sql.includes('project-group-links-final'))atFinal?.();return queryOne<T>(sql,args);};
    // Dispatch is the only controlled DB boundary: the actual frozen B worker always runs.
    vi.spyOn(client,'tx').mockImplementation(async(name,args)=>{
      txCount++;expect(name).toBe('projectGroupLinks.execute');beforeTx?.();
      if(ack==='not-sent')throw createDbTransportError(DB_TRANSPORT_NOT_SENT,'unsent');
      if(ack==='arbitrary')throw Error('secret SQL /private/path');
      let result;try{result=runProjectGroupLinksTransaction(db,args);}catch(error){
        if(error instanceof Error)Object.assign(error,{code:'WORKER_RPC_ERROR'});throw error;
      }
      afterTx?.();if(ack==='lost')throw createDbTransportError(DB_TRANSPORT_OUTCOME_UNKNOWN,'lost ACK');return result;
    });
    setCurrentDbClient(client,'owner');
    const authority=createChatGroupAuthority({captureBoundary:()=>{
      const generation=host.generation,user=host.user,base=endpoint;
      return {endpoint:base,ownerId:user,assertCurrent:()=>{
        if(host.generation!==generation||host.user!==user||endpoint!==base)throw Error('OWNER_SCOPE_CHANGED');
      },resolveRoom:room=>room,read:async(route,as)=>{
        reads.push(route);atHttp?.(++httpCount,route);
        if(route==='/me')return {actor:{id:self,kind:'human',externalId:user}};
        if(route==='/actors')return [{id:botActor,kind:'bot',externalId:'owner'}];
        expect(route).toBe(`/conversations/${group.roomId}/snapshot`);
        if(as)expect(as).toBe(botActor);
        return {room:{id:group.roomId,kind:'group',revision:1,archived:false},members:[
          {id:self,kind:'human',ownerActorId:self,state:joined?'joined':'left',role,accessRevision:1},
          {id:botActor,kind:'bot',ownerActorId:self,state:botJoined?'joined':'left',role:botRole,accessRevision:1}]};
      }};
    }});
    service={groupAuthority:authority};
  });
  afterEach(()=>{unregister?.();unregister=undefined;clearCurrentDbClient();vi.restoreAllMocks();db.exec('ROLLBACK');});
  afterAll(()=>{db.close();host.db=undefined;});

  it('uses genuine A read/configure and B persistence for link/list/unlink with commit/current separation',async()=>{
    const a=await request();expect(a).toMatchObject({ok:true,replayed:false,current:{revision:1,status:'active'}});
    if(!a.ok||!('current'in a))throw Error('fixture');
    expect(await request(list())).toMatchObject({ok:true,links:[{relationId:a.current.relationId}]});
    expect(await request({action:'unlink',group,target:target(),requestId:'r2',relationId:a.current.relationId,expectedRevision:1})).toMatchObject({ok:true,current:{revision:2,status:'removed'}});
    expect(await request()).toMatchObject({ok:true,replayed:true,commit:{revision:1,statusAtCommit:'active'},current:{revision:2,status:'removed'}});
    expect(await request(link('r3',2))).toMatchObject({ok:true,current:{revision:3,status:'active'}});
    expect(stored().receipts).toHaveLength(3);expect(reads.every(route=>route==='/me'||route==='/actors'||route.endsWith('/snapshot'))).toBe(true);
    expect(JSON.stringify(stored())).not.toMatch(/private-title|private-goal|actorId|accessRevision|token/);
  });
  it('uses native account management actor selection without borrowing it for autonomous same-id bot',async()=>{
    role='member';expect(await request()).toMatchObject({ok:true}); // owned admin bot, native account semantics
    bot();ownerInput=false;botRole='member';denied(await request(link('bot'),'task'),'not-committed','GROUP_CONFIGURATION_REQUIRED');
    botRole='admin';denied(await request(link('bot'),'task'),'not-committed','NOT_PROJECT_MEMBER');
    runProjectsTransaction(db,{action:'addMember',actor:owner,projectId:'p',subject:botSubject,now:2});
    runProjectsTransaction(db,{action:'transferOwner',actor:owner,projectId:'p',subject:botSubject,now:2});
    expect(await request(link('bot',1),'task')).toMatchObject({ok:true});
    denied(await request(link('account',1)),'not-committed','NOT_PROJECT_OWNER');
  });
  it('retains native ordinary owner task identity while autonomous bot cannot fall back to account',async()=>{
    expect(await request(link(),'task')).toMatchObject({ok:true});bot();ownerInput=false;
    denied(await request(link('bot'),'task'),'not-committed','NOT_PROJECT_MEMBER');
    ownerInput=true;expect(await request(link('owner-agency',1),'task')).toMatchObject({ok:true});
  });
  it.each(['actor','context','grant','canManage','callerSessionId'])('rejects raw %s and performs no transaction',async field=>{
    denied(await request({...link(),[field]:true}),'not-committed','INVALID_PARAMS');expect(txCount).toBe(0);expect(httpCount).toBe(0);
  });
  it.each(['service','authority','ui','device','account','remote-device','endpoint','endpoint-case'])('fails closed before tx for %s boundary',async mode=>{
    const raw=link();if(mode==='service')service=null;if(mode==='authority')service={};if(mode==='ui')uiTrusted=false;
    if(mode==='device')device=null;if(mode==='account')raw.target.accountId='elsewhere';if(mode==='remote-device')raw.target.deviceId='remote';
    if(mode==='endpoint')endpoint='https://other.example/Case/API';if(mode==='endpoint-case')endpoint=group.endpoint.toLowerCase();
    denied(await request(raw));expect(txCount).toBe(0);expect(stored().links).toEqual([]);
  });
  it('allows read for native members, requires configure for removed history and rejects no current group member',async()=>{
    await request();role='member';botRole='member';expect(await request(list())).toMatchObject({ok:true,links:[{}]});
    denied(await request(list({includeRemoved:true})),'not-committed','GROUP_ACCESS_DENIED');
    joined=false;botJoined=false;denied(await request(list()),'not-committed','GROUP_ACCESS_DENIED');
  });
  it.each(['group','role','actor','owner','device','service'])('refreshes and denies precommit %s changes with zero DB write',async mode=>{
    atHttp=count=>{if(count!==4)return;
      if(mode==='group'){joined=false;botJoined=false;}if(mode==='role')role='member';if(mode==='actor')joined=false;
      if(mode==='owner')host.generation++;if(mode==='device')device='changed';if(mode==='service')service={};
    };denied(await request());expect(txCount).toBe(0);expect(stored().links).toEqual([]);
  });
  it('has the real B worker reject project owner changes at dispatch atomically',async()=>{
    runProjectsTransaction(db,{action:'addMember',actor:owner,projectId:'p',subject:{kind:'account',id:'other'},now:2});
    beforeTx=()=>runProjectsTransaction(db,{action:'transferOwner',actor:owner,projectId:'p',subject:{kind:'account',id:'other'},now:2});
    denied(await request(),'not-committed','NOT_PROJECT_OWNER');expect(txCount).toBe(1);expect(stored()).toEqual({links:[],receipts:[]});
  });
  it.each(['group','project','owner','input','lease','device','db'])('suppresses committed metadata after late %s revocation',async mode=>{
    if(mode==='input'||mode==='lease'){
      bot('group');unregister=registerGroupToolAuthority('caller',{botId:'owner',mode:'owner',isCurrent:()=>leaseCurrent,validate:async()=>{}});
    }
    afterTx=()=>{if(mode==='group'){joined=false;botJoined=false;}if(mode==='project')run("DELETE FROM project_members WHERE project_id='p'");
      if(mode==='owner')host.generation++;if(mode==='input')inputKey='changed';if(mode==='lease')leaseCurrent=false;
      if(mode==='device')device='changed';if(mode==='db')setCurrentDbClient(client,'owner');};
    denied(await request(link(),mode==='input'||mode==='lease'?'task':'ui'),'committed');expect(stored().links).toHaveLength(1);expect(stored().receipts).toHaveLength(1);
  });
  it('keeps unknown ACK, reauthenticates same-key reconciliation, and never repeats the state change',async()=>{
    ack='lost';denied(await request(),'unknown');expect(stored().receipts).toHaveLength(1);
    ack='normal';const prior=stored();expect(await request()).toMatchObject({ok:true,replayed:true,current:{revision:1}});expect(stored()).toEqual(prior);
    role='member';botRole='member';denied(await request(),'not-committed','GROUP_ACCESS_DENIED');expect(stored()).toEqual(prior);
  });
  it('returns the original commit with newly read current removed after concurrent postcommit unlink',async()=>{
    afterTx=()=>{
      const relation=db.prepare('SELECT id FROM project_group_links').get() as {id:string};
      runProjectGroupLinksTransaction(db,{intent:{action:'unlink',group,target:target(),relationId:relation.id,requestId:'concurrent',expectedRevision:1},
        context:{actor:owner,accountId:'owner',deviceId:'cached-device',group,now:Date.now()}});
    };
    expect(await request()).toMatchObject({ok:true,commit:{revision:1,statusAtCommit:'active'},current:{revision:2,status:'removed'}});
    expect(stored().receipts).toHaveLength(2);
  });
  it('reauthenticates unknown-commit recovery against revoked project ownership, never resurrecting the row',async()=>{
    ack='lost';denied(await request(),'unknown');const before=stored();
    runProjectsTransaction(db,{action:'addMember',actor:owner,projectId:'p',subject:{kind:'account',id:'other'},now:2});
    runProjectsTransaction(db,{action:'transferOwner',actor:owner,projectId:'p',subject:{kind:'account',id:'other'},now:3});
    ack='normal';denied(await request(),'not-committed','NOT_PROJECT_OWNER');expect(stored()).toEqual(before);
  });
  it('rejects final local UI lifetime expiry even while cached device and group facts remain unchanged',async()=>{
    atFinal=()=>{uiTrusted=false;};denied(await request(list()),'not-committed','GROUP_ACCESS_DENIED');expect(txCount).toBe(1);
  });
  it.each(['not-sent','arbitrary'])('distinguishes %s failure without inventing a rollback or private error',async mode=>{
    ack=mode as typeof ack;denied(await request(),mode==='not-sent'?'not-committed':'unknown');expect(stored()).toEqual({links:[],receipts:[]});
  });
  it('filters actual member/owner SQL before pagination, never emits hidden totals, and fences final revocation',async()=>{
    await request();await request(link('q',0,'q'));
    runProjectsTransaction(db,{action:'create',actor:{kind:'account',id:'other'},newId:'hidden',now:1,input:{name:'private-title',owner:{kind:'account',id:'other'},members:[]}});
    runProjectGroupLinksTransaction(db,{intent:link('hidden',0,'hidden'),context:{actor:{kind:'account',id:'other'},accountId:'owner',deviceId:'cached-device',group,now:1},newRelationId:'a-hidden'});
    const a=await request(list({limit:1}));expect(a).toMatchObject({ok:true,links:[{}]});expect(a).not.toHaveProperty('total');
    if(!a.ok||!('links'in a)||!('nextCursor'in a))throw Error('fixture');expect(JSON.stringify(a)).not.toContain('a-hidden');
    expect(await request(list({limit:1,cursor:a.nextCursor}))).toMatchObject({ok:true,links:[{}],nextCursor:null});
    atFinal=()=>run("DELETE FROM project_members WHERE project_id IN ('p','q')");denied(await request(list()),'not-committed','NOT_PROJECT_MEMBER');
  });
  it.each(['input','caller','lease','owner'])('cached same device never grants authorization after final %s expiry',async mode=>{
    bot('group');unregister=registerGroupToolAuthority('caller',{botId:'owner',mode:'owner',isCurrent:()=>leaseCurrent,validate:async()=>{}});
    atFinal=()=>{if(mode==='input')inputKey='next';if(mode==='caller')run("UPDATE sessions SET status='deleted' WHERE id='caller'");
      if(mode==='lease')leaseCurrent=false;if(mode==='owner')host.generation++;};
    denied(await request(list(),'task'));expect(device).toBe('cached-device');expect(stored()).toEqual({links:[],receipts:[]});
  });
  it('refuses a missing formal caller and nonowner channel without fabricating an account UI entry',async()=>{
    live=undefined;denied(await request(link(),'task'));expect(txCount).toBe(0);
    live={instanceId:'instance',getCurrentTurnOrigin:()=>null};
    const scope=beginChannelToolScope({sessionId:'caller',sessionInstanceId:'instance',scope:{channel:'discord',botId:'connection',laneUserId:'lane',chatId:'channel',chatKind:'direct',requesterIsOwner:false,companion:true}});
    try{denied(await request(link(),'task'));expect(txCount).toBe(0);}finally{scope();}
  });
});
