/** DB boundary, dispatch contract input (2026-11-06): stable message keys, immutable
 * preparation and separate consumers. Existing material tests have no message handoff
 * or external outcome recovery. Minimal failures: lost receipt followed by repeat send,
 * or publish v2 drifting an old v1 context. Real generated migrations/material/project/
 * dispatch transactions, in-memory SQLite. Consumer result/host identity are controlled;
 * no actual Session/provider/vision/Host/network or media-pin/recycler claim. Modules and
 * full migration load once; fixtures use SAVEPOINTs, no waits. Unit/DB boundary tier.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runMigrationReplay } from '../migrationRunner';
import { runProjectsTransaction } from '../worker/opHandlers/projectsTx';
import { runMaterialsTransaction } from '../worker/opHandlers/materialsTx';
import { runMaterialDispatchTransaction, type MaterialDispatchRequest } from '../worker/opHandlers/materialDispatchTx';
import { materialDispatchPreparationFromItems } from '../materialDispatchPreparation';
import type { PreparedMaterialItem, MaterialPdfCoverage } from './fixtures/materialDispatchPdfProducer';
import { parseMaterialDispatchSelector, type MaterialDispatchReadResult, type MaterialDispatchSelector,
  type MaterialDispatchPreparation, type MaterialDispatchBeginResult, type MaterialDispatchConsumer,
  type MaterialDispatchWriteResult } from '../../../shared/materialDispatch';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const owner={kind:'account' as const,id:'owner'},otherKind={kind:'bot' as const,id:'owner'};
const key={sessionId:'task',clientId:'input'},body=JSON.stringify({text:'private user body'}),bodyHash=sha(body);
const selected:MaterialDispatchSelector={contextId:'context',projectId:'p',workItemId:'task',bindingRevision:1,purpose:'reference'};
const prepared:MaterialDispatchPreparation={preparationKey:sha('preparation'),items:[{referenceId:'ref',materialId:'m',version:1,
  versionId:'v1',expectedSha256:sha('bytes-v1'),verifiedSha256:sha('bytes-v1'),readiness:'ready',failureCode:null,representation:'text',textSha256:sha('normalized-v1'),coverage:null}]};

describe('material dispatch durable consumption metadata',()=>{
  let db:Database.Database;
  const host=()=>({actor:owner,now:1000});
  const call=(args:Record<string,unknown>)=>runMaterialDispatchTransaction(db,{key,host:host(),...args});
  const queue=(extra:Record<string,unknown>={})=>call({action:'queue',expectedRevision:0,selector:selected,contentSha256:bodyHash,...extra});
  const prepare=(extra:Record<string,unknown>={})=>call({action:'prepare',revision:1,preparation:prepared,...extra});
  const message=(content=body,clientId='input')=>db.prepare("INSERT INTO messages(id,session_id,client_id,role,content,created_at,agent_meta) VALUES (?, 'task',?,'user',?,1,?)")
    .run('message-'+clientId,clientId,content,JSON.stringify({sdk:'unchanged'}));
  const attach=()=>call({action:'attachMessage',revision:1,messageId:'message-input'}) as MaterialDispatchWriteResult;
  const ready=()=>{queue();prepare();message();attach();};
  const begin=(consumer:MaterialDispatchConsumer='provider',extra:Record<string,unknown>={})=>call({action:'begin',revision:1,attemptId:'attempt',turnGeneration:7,
    consumer,preparationKey:prepared.preparationKey,referenceIds:['ref'],payloadSha256:sha('actual wire'),...extra}) as MaterialDispatchBeginResult;
  const record=(consumer:MaterialDispatchConsumer='provider',outcome:'confirmed'|'not-consumed'|'unknown'='confirmed',extra:Record<string,unknown>={})=>
    call({action:'recordOutcome',revision:1,attemptId:'attempt',turnGeneration:7,consumer,
      evidence:{source:consumer==='provider'?'session-send-result':'vision-result',outcome,receiptSha256:sha(consumer+outcome)},...extra});
  const read=(extra:Record<string,unknown>={})=>call({action:'read',history:true,...extra}) as MaterialDispatchReadResult;
  const stored=()=>['material_dispatch_messages','material_dispatch_revisions','material_dispatch_attempts','material_dispatch_observations']
    .map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const rejects=(fn:()=>unknown,code:string)=>{const before=stored();expect(fn).toThrow('['+code+']');expect(stored()).toEqual(before);};
  beforeAll(()=>{
    db=createBetterSqliteDatabase(':memory:');const root=path.resolve(__dirname,'../../../..');
    db.loadExtension(path.join(root,'native/sqlite-vec',`${process.platform}-${process.arch}`,process.platform==='win32'?'vec0.dll':'vec0.dylib'));
    runMigrationReplay(db,{drizzleDir:path.join(root,'drizzle')});
  });
  beforeEach(()=>{
    db.exec('BEGIN');db.prepare("INSERT INTO sessions(id,title,created_at,updated_at) VALUES ('task','private task',1,1)").run();
    for(const id of ['p','q'])runProjectsTransaction(db,{action:'create',actor:owner,newId:id,now:1,input:{name:'private project',owner,members:[]}});
    runProjectsTransaction(db,{action:'bindSession',actor:owner,sessionId:'task',projectId:'p'});
    runMaterialsTransaction(db,{action:'add',...selected,actor:owner,now:1,files:[{referenceId:'ref',versionId:'v1',materialId:'m',name:'private.txt',sha256:sha('bytes-v1'),
      sizeBytes:8,mime:'text/plain',storageKind:'file',storageRef:'/controlled-not-read',sourceMtime:1}]});
    runMaterialsTransaction(db,{action:'createContext',...selected,actor:owner,now:2,newId:'context',refs:[{referenceId:'ref',materialId:'m',version:1}]});
  });
  afterEach(()=>db.exec('ROLLBACK'));
  afterAll(()=>db.close());

  it('roundtrips the strict queue selector and persists the exact key before and after real user-message attachment',()=>{
    expect(parseMaterialDispatchSelector(JSON.parse(JSON.stringify(selected)))).toEqual(selected);
    expect(queue()).toEqual({revision:1,replayed:false});expect(queue()).toEqual({revision:1,replayed:true});
    expect(read()).toMatchObject({key,currentRevision:1,messageId:null,revisions:[{selector:selected,state:'queued'}]});
    prepare();message();expect(attach()).toEqual({revision:1,replayed:false});expect(attach().replayed).toBe(true);
    expect(read()).toMatchObject({messageId:'message-input',revisions:[{state:'attached',preparation:prepared}]});
    expect(db.prepare('SELECT agent_meta FROM messages').get()).toEqual({agent_meta:JSON.stringify({sdk:'unchanged'})});
    expect(JSON.stringify(stored())).not.toMatch(/private user body|private project|private.txt|controlled-not-read|base64|grant/);
  });
  it('same key changed frozen intent conflicts, while another clientId can explicitly reference the same context',()=>{
    queue();rejects(()=>queue({contentSha256:sha('edited')}),'INTENT_CONFLICT');
    expect(queue({key:{...key,clientId:'another'}})).toMatchObject({revision:1,replayed:false});
    expect(stored()[0]).toHaveLength(2);
  });
  it('CAS-edits a queued revision, preserves old preparation and cannot mix its old body into a new selector',()=>{
    queue();prepare();expect(queue({expectedRevision:1,contentSha256:sha('new serialized body')})).toEqual({revision:2,replayed:false});
    expect(read().revisions).toMatchObject([{revision:1,state:'superseded',preparation:prepared},{revision:2,state:'queued',preparation:null}]);
    rejects(()=>begin(),'REVISION_CONFLICT');message();rejects(()=>call({action:'attachMessage',revision:2,messageId:'message-input'}),'MESSAGE_MISMATCH');
  });
  it('freezes intent after attachment; edits require a new explicit clientId',()=>{
    ready();rejects(()=>queue({expectedRevision:1,contentSha256:sha('changed')}),'INTENT_FROZEN');
    rejects(()=>prepare({preparation:{...prepared,preparationKey:sha('changed')}}),'PREPARATION_CONFLICT');
  });
  it('cancels before dispatch and never creates consumed evidence or allows cancelled intent resurrection',()=>{
    ready();expect(call({action:'cancel',revision:1})).toEqual({revision:1,replayed:false});
    rejects(()=>begin(),'CANCELLED');rejects(()=>queue(),'CANCELLED');expect(read().revisions[0].attempts).toEqual([]);
    expect(db.prepare('SELECT count(*) n FROM messages').get()).toEqual({n:1});
  });
  it('keeps v1 preparation and dispatch after publishing v2; later bytes cannot rewrite pinned SHA or textSha',()=>{
    ready();runMaterialsTransaction(db,{action:'addVersion',...selected,actor:owner,now:3,referenceId:'ref',materialId:'m',replaceCurrentReference:true,
      file:{referenceId:'new-ref',versionId:'v2',materialId:'unused',name:'private.txt',sha256:sha('bytes-v2'),sizeBytes:8,mime:'text/plain',storageKind:'file',storageRef:'/controlled-not-read',sourceMtime:2}});
    expect(begin()).toMatchObject({started:true,attempt:{preparationKey:prepared.preparationKey}});
    expect(read().revisions[0].preparation).toEqual(prepared);
    rejects(()=>prepare({preparation:{...prepared,items:[{...prepared.items[0],version:2,versionId:'v2',verifiedSha256:sha('bytes-v2')}]}}),'PREPARATION_CONFLICT');
    rejects(()=>prepare({preparation:{...prepared,items:[{...prepared.items[0],textSha256:sha('new text')}]}}),'PREPARATION_CONFLICT');
  });
  it.each(['clipped','no-text-pages','page-limit','no-text','full-text','failed-with-coverage'])('losslessly maps actual frozen PreparedMaterialItem for PDF %s without fabricated page IDs or assertion',mode=>{
    const text=mode==='no-text'?'':'Page 1\nprivate extracted text';
    const coverage:MaterialPdfCoverage={kind:'extractable-text-only',numPages:5,pagesInspected:mode==='page-limit'?3:5,
      textPages:mode==='no-text'?0:4,clipped:mode==='clipped',completeText:false,textSha256:sha(text),textChars:text.length,
      characterLimit:24000,pagesWithoutTextOrNotInspected:mode==='no-text'?5:1,visualCoverage:'not-assessed'};
    if(mode==='page-limit'){coverage.textPages=2;coverage.pagesWithoutTextOrNotInspected=3;}
    if(mode==='clipped'||mode==='full-text'){coverage.textPages=5;coverage.pagesWithoutTextOrNotInspected=0;}
    if(mode==='full-text')coverage.completeText=true;
    const identity={referenceId:'ref',materialId:'m',version:1,versionId:'v1',expectedSha256:sha('bytes-v1')};
    const actual:PreparedMaterialItem=mode==='no-text'?{...identity,status:'unsupported',code:'PDF_NO_TEXT',pdf:coverage}:
      mode==='failed-with-coverage'?{...identity,status:'failed',code:'PDF_PROCESS_FAILED',pdf:coverage}:
      {...identity,status:mode==='full-text'?'prepared':'partial',verifiedSha256:sha('bytes-v1'),content:{kind:'text',text},pdf:coverage};
    const pdf=materialDispatchPreparationFromItems(prepared.preparationKey,[actual]);
    queue();prepare({preparation:pdf});message();attach();expect(read().revisions[0].preparation).toEqual(pdf);
    expect(pdf.items[0].coverage).toEqual(coverage);expect(pdf.items[0].readiness).toBe(mode==='no-text'?'unsupported':mode==='failed-with-coverage'?'failed':mode==='full-text'?'ready':'partial');
    expect(pdf.items[0].coverage?.visualCoverage).toBe('not-assessed');
    expect(JSON.stringify(stored())).not.toMatch(/private extracted text|coveredPages|base64/);
    if(mode==='no-text'||mode==='failed-with-coverage')rejects(()=>begin(),'PREPARATION_CONFLICT');else expect(begin().started).toBe(true);
    const changed=structuredClone(pdf);changed.items[0].coverage!.clipped=!coverage.clipped;
    rejects(()=>prepare({preparation:changed}),'PREPARATION_CONFLICT');
  });
  it('records explicit unsupported readiness and rejects pretending the filename was delivered',()=>{
    queue();prepare({preparation:{...prepared,items:[{...prepared.items[0],readiness:'unsupported',failureCode:'UNSUPPORTED_CONTENT',representation:'unavailable',verifiedSha256:null,textSha256:null}]}});
    message();attach();rejects(()=>begin(),'PREPARATION_CONFLICT');expect(read().revisions[0].preparation?.items[0].readiness).toBe('unsupported');
  });
  it('vision success is separate from provider rejection and does not mark provider used',()=>{
    ready();expect(begin('vision').started).toBe(true);record('vision');expect(begin().started).toBe(true);record('provider','not-consumed');
    expect(read().revisions[0].attempts.map(a=>[a.consumer,a.outcome])).toEqual([['provider','not-consumed'],['vision','confirmed']]);
    expect(call({action:'cancel',revision:1})).toMatchObject({replayed:false});expect(read().revisions[0].attempts[1].outcome).toBe('confirmed');
  });
  it('beforeProvider, queued, prepared or onAccepted are not vision results and cannot unlock a pending vision consumer',()=>{
    ready();begin('vision');rejects(()=>begin(),'OUTCOME_UNRESOLVED');
    for(const source of ['before-provider','queued','prepared','onAccepted'])
      rejects(()=>record('vision','confirmed',{evidence:{source,outcome:'confirmed',receiptSha256:sha(source)}}),'INVALID_PARAMS');
    rejects(()=>record('vision','confirmed',{evidence:{source:'session-send-result',outcome:'confirmed',receiptSha256:sha('wrong phase')}}),'EVIDENCE_CONFLICT');
    expect(read().revisions[0].attempts).toMatchObject([{consumer:'vision',outcome:'pending',observations:[]}]);
    record('vision','not-consumed'); // Controlled explicit evidence of no vision call, not inference from fallback.
    expect(begin().started).toBe(true);expect(read().revisions[0].attempts.find(a=>a.consumer==='vision')?.outcome).toBe('not-consumed');
  });
  it('pending write precedes the controlled consumer and receipt-write failure leaves recoverable pending without resending',()=>{
    ready();let sends=0;const first=begin();if(first.started)sends++;
    db.exec("CREATE TRIGGER fail_observation BEFORE INSERT ON material_dispatch_observations BEGIN SELECT RAISE(ABORT,'private body /path'); END");
    rejects(()=>record(),'INTERNAL');expect(read().revisions[0].attempts[0].outcome).toBe('pending');
    db.exec('DROP TRIGGER fail_observation');const recovery=begin();if(recovery.started)sends++;
    expect(sends).toBe(1);expect(recovery.started).toBe(false);record('provider','confirmed',{evidence:{source:'reconciliation',outcome:'confirmed',receiptSha256:sha('formal receipt')}});
    expect(read().revisions[0].attempts[0].outcome).toBe('confirmed');rejects(()=>begin('provider',{attemptId:'blind-retry'}),'OUTCOME_UNRESOLVED');
  });
  it('unknown blocks every new consumer attempt until explicit original-key evidence reconciliation and retains original observation',()=>{
    ready();begin();record('provider','unknown');expect(begin().started).toBe(false);
    rejects(()=>begin('provider',{attemptId:'next'}),'OUTCOME_UNRESOLVED');rejects(()=>begin('vision',{attemptId:'next'}),'OUTCOME_UNRESOLVED');
    rejects(()=>record('provider','not-consumed'),'EVIDENCE_CONFLICT');
    record('provider','confirmed',{evidence:{source:'reconciliation',outcome:'confirmed',receiptSha256:sha('reconciled')}});
    expect(read().revisions[0].attempts[0].observations.map(e=>e.outcome)).toEqual(['unknown','confirmed']);
    expect(record('provider','unknown')).toEqual({recorded:true,replayed:true});expect(read().revisions[0].attempts[0].outcome).toBe('confirmed');
  });
  it('an explicitly rejected attempt permits only a new actual attempt identity, without rewriting the old evidence',()=>{
    ready();begin();record('provider','not-consumed');expect(begin()).toMatchObject({started:false,attempt:{outcome:'not-consumed'}});
    expect(begin('provider',{attemptId:'new-actual',turnGeneration:8}).started).toBe(true);expect(read().revisions[0].attempts).toHaveLength(2);
  });
  it.each(['member','kind','binding','removed','deleted'])('revalidates %s before preparing/starting; immutable history never grants new consumption',mode=>{
    ready();
    if(mode==='member')db.prepare("DELETE FROM project_members WHERE project_id='p'").run();
    if(mode==='kind')return rejects(()=>begin('provider',{host:{actor:otherKind,now:3}}),'FORBIDDEN');
    if(mode==='binding'){runProjectsTransaction(db,{action:'bindSession',actor:owner,sessionId:'task',projectId:null});runProjectsTransaction(db,{action:'bindSession',actor:owner,sessionId:'task',projectId:'p'});}
    if(mode==='removed')runMaterialsTransaction(db,{action:'removeReference',...selected,actor:owner,now:3,referenceId:'ref'});
    if(mode==='deleted')db.prepare("UPDATE sessions SET status='deleted' WHERE id='task'").run();
    const expected=mode==='member'?'FORBIDDEN':mode==='binding'?'BINDING_CONFLICT':mode==='removed'?'REFERENCE_INVALID':'SCOPE_MISMATCH';
    rejects(()=>begin(),expected);rejects(()=>prepare(),expected);
    if(mode==='member')rejects(()=>read(),'FORBIDDEN');else expect(read().revisions[0].preparation).toEqual(prepared);
  });
  it('trusted original consumer can append only a minimal terminal fact after revocation, never read or start',()=>{
    ready();begin();db.prepare("DELETE FROM project_members WHERE project_id='p'").run();
    expect(record()).toEqual({recorded:true,replayed:false});expect(record()).toEqual({recorded:true,replayed:true});
    rejects(()=>read(),'FORBIDDEN');rejects(()=>begin(),'FORBIDDEN');
    rejects(()=>record('provider','confirmed',{host:{actor:otherKind,now:2}}),'EVIDENCE_CONFLICT');
    rejects(()=>record('provider','not-consumed'),'EVIDENCE_CONFLICT');
  });
  it('validates exact attempt, reserved generation, evidence phase and wire hash instead of guessing latest',()=>{
    ready();begin();rejects(()=>begin('provider',{turnGeneration:8}),'INTENT_CONFLICT');
    rejects(()=>begin('provider',{payloadSha256:sha('changed body')}),'INTENT_CONFLICT');
    rejects(()=>record('provider','confirmed',{turnGeneration:8}),'EVIDENCE_CONFLICT');
    rejects(()=>record('provider','confirmed',{evidence:{source:'vision-result',outcome:'confirmed',receiptSha256:sha('wrong')}}),'EVIDENCE_CONFLICT');
    rejects(()=>begin('provider',{turnGeneration:undefined}),'INVALID_PARAMS');
  });
  it('attaches in the actual message INSERT transaction and rolls back both on mismatch; split-commit recovery retains selector',()=>{
    queue();expect(()=>db.transaction(()=>{message(JSON.stringify({text:'different'}));attach();})()).toThrow('[MESSAGE_MISMATCH]');
    expect(db.prepare('SELECT count(*) n FROM messages').get()).toEqual({n:0});expect(read().messageId).toBeNull();
    message();expect(read()).toMatchObject({messageId:null,revisions:[{selector:selected}]});
    expect(attach()).toMatchObject({replayed:false});expect(attach()).toMatchObject({replayed:true});
    prepare();expect(begin().started).toBe(true);
  });
  it('will not borrow edited or rewound persisted content, or add an intent after a preexisting message',()=>{
    message();rejects(()=>queue(),'INTENT_FROZEN');db.prepare('DELETE FROM messages').run();ready();
    db.prepare("UPDATE messages SET content='different' WHERE client_id='input'").run();rejects(()=>begin(),'MESSAGE_MISMATCH');
    db.prepare('UPDATE messages SET content=?,rewind_at=2').run(body);rejects(()=>begin(),'MESSAGE_MISMATCH');
  });
  it.each(['actor','grant','preparedBody','evidence'])('public queue selector rejects %s without persisting it',field=>{
    expect(parseMaterialDispatchSelector({...selected,[field]:true})).toBeNull();rejects(()=>queue({selector:{...selected,[field]:true}}),'INVALID_PARAMS');
  });
  it('a failed revision insert rolls back head/superseded state and inline serialization executes the same transaction',()=>{
    db.exec("CREATE TRIGGER fail_intent BEFORE INSERT ON material_dispatch_revisions BEGIN SELECT RAISE(ABORT,'private'); END");
    rejects(()=>queue(),'INTERNAL');db.exec('DROP TRIGGER fail_intent');
    const inline=new Function('require','return ('+runMaterialDispatchTransaction.toString()+')')(require) as typeof runMaterialDispatchTransaction;
    const args:MaterialDispatchRequest={action:'queue',key,host:host(),expectedRevision:0,selector:selected,contentSha256:bodyHash};
    expect(inline(db,args)).toEqual({revision:1,replayed:false});expect(read().revisions).toHaveLength(1);
  });
});
