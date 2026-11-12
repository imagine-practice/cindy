/** DB tier: real DbClient -> inproc/native file-worker -> formal SQLite migrations.
 * Gap: adoption's controlled transact callback cannot detect a missing worker case.
 * Minimal input: admit an existing task, lose its ACK, reopen the client and inspect
 * the original request. Preserve the Session, reject stale binding/ACL and never
 * infer permission to dispatch from a durable pending/unknown receipt. No provider.
 * Recovery consent regression: an automatic queued input outlives its originating
 * turn. Reopen both real transports, then revoke consent, change/remove the file,
 * or approve a different hash: reject before model input; explicit input survives.
 */
import { copyFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createDbClient, createInprocDbClient, type DbClient } from '../client/DbClient';
import { createProjectWorkItemExecutionService } from '../../maker-ipc/projectWorkItemExecutionService';
import { createProjectWorkItemExecution } from '../../mcp-integrations/projectWorkItemExecution';
import { AgentInputCoordinator } from '../../maker-ipc/agent-input-coordinator';
import { validateWorkItemInputBeforePersistence, settleDiscardedInputDelivery } from '../../maker-ipc/inputDeliveryLifecycle';
import { readDelegations, readFollowups, projectWorkItemExecutionState } from '../../project-execution/context';
import { saveAgentInputQueueSnapshot, loadAgentInputQueueSnapshot, getPersistedInputClientIds, awaitAgentInputQueueSnapshotPersistence } from '../agentInputQueueSnapshots';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue';
import { setCurrentDbClient,clearCurrentDbClient } from '../client/current';
import { buildDbWorkerBundle } from './dbWorkerTestUtils';
import { createJointFollowupDb, openJointFollowupDb } from '../ipc/__tests__/jointFollowupMigration.fixture';
import type { ProjectWorkItemExecutionRequest, ProjectWorkItemExecutionResult } from '../../../shared/projectWorkItemExecution';

vi.mock('../../appSessionState',()=>({activeOwnerScopeKey:()=> 'fixture-owner',isAppSessionBoundaryPending:()=>false,getActiveAppSession:()=>({dataOwnerId:'owner'})}));
const h = vi.hoisted(() => ({ db: undefined as Database.Database | undefined }));
vi.mock('../index', () => ({ getRawDb: () => h.db, getDrizzle: () => drizzle(h.db!), ensureReady: async () => ({ ready: true }) }));
vi.mock('../../logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));

const root = path.resolve(__dirname, '../../../..');
let dir: string, template: string, workerScriptPath: string;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
beforeAll(async () => {
  vi.stubEnv('XDT_DB_INPROC', 'false');
  dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-workitem-registration-'));
  template = path.join(dir, 'formal-0152.sqlite');
  createJointFollowupDb(dir, template).close();
  workerScriptPath = await buildDbWorkerBundle(path.join(dir, 'worker-build'));
});
afterAll(() => {
  vi.unstubAllEnvs();
  if (dir && path.dirname(dir) === os.tmpdir() && path.basename(dir).startsWith('cindy-workitem-registration-')) rmSync(dir, { recursive: true, force: true });
});

for (const mode of ['inproc', 'file-worker'] as const) {
  it(`${mode}: original-key recovery preserves the existing Session and rechecks ACL/binding`, async () => {
    const file = path.join(dir, `${mode}.sqlite`); copyFileSync(template, file);
    const db = openJointFollowupDb(file); h.db = db;
    db.exec(`INSERT INTO sessions(id,title,source,status,working_dir,permission_mode,created_at,updated_at)
      VALUES ('caller','Bot lane','bot','active','/fixture/caller','ask',1,1),('work','Original title','desktop','active','/fixture/work','ask',1,1),
      ('work2','Existing task two','desktop','active','/fixture/work2','ask',1,1),
      ('work3','Existing task three','desktop','active','/fixture/work3','bypassPermissions',1,1),
      ('work4','Automation target','desktop','active','/fixture/work4','ask',1,1);
      INSERT INTO bot_profiles(id,display_name,canonical_session_id,created_at,updated_at) VALUES ('executor','Executor','caller',1,1);
      INSERT INTO bot_session_links(id,bot_id,session_id,role,created_at) VALUES ('lane','executor','caller','canonical',1);
      INSERT INTO projects(id,name,owner_id,status,created_at,updated_at) VALUES ('p','Project','owner','active',1,1);
      INSERT INTO project_members VALUES ('p','account','owner','owner',1),('p','bot','executor','member',1);
      UPDATE sessions SET project_id='p',project_binding_revision=7,assignee_kind='bot',assignee_id='executor' WHERE id IN ('work','work2','work3','work4');`);
    const connect = () => mode === 'inproc' ? createInprocDbClient() : createDbClient({ transport: 'worker-thread',
      dbPath: file, drizzleDir: path.join(root, 'drizzle'), workerScriptPath, useInlineWorker: false,
      betterSqliteModulePath: require.resolve('better-sqlite3'),
      sqliteVecExtPath: path.join(root, 'native/sqlite-vec', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib') });
    let client: DbClient = await connect();
    const request = { intent: 'start' as const, callerSessionId: 'caller', targetBotId: 'executor', projectId: 'p', sessionId: 'work',
      expectedBindingRevision: 7, requestId: 'original-key', objective: 'Explicit existing task execution', automatic: false, actor: { kind: 'account' as const, id: 'owner' } };
    const execute = (p: ProjectWorkItemExecutionRequest) => client.tx('projects.executeWorkItem', p);
    const requireView = (r: ProjectWorkItemExecutionResult) => { expect(r.ok).toBe(true); if (!r.ok) throw new Error(r.errorCode); return r.view; };
    const original = db.prepare('SELECT * FROM sessions ORDER BY id').all();
    try {
      expect(await client.queryOne("SELECT value FROM migration_meta WHERE key='schema_version'")).toEqual({ value: '160' });
      const first = requireView(await execute({ ...request, action: 'inspect' }));
      const admit = {...request,action:'admit' as const,fingerprint:first.fingerprint,now:10};
      await client.exec("CREATE TRIGGER fail_workitem_ledger BEFORE INSERT ON project_work_item_executions BEGIN SELECT RAISE(ABORT,'injected ledger failure'); END");
      await expect(execute(admit)).rejects.toThrow('injected ledger failure');
      expect(db.prepare('SELECT COUNT(*) n FROM project_work_item_executions').get()).toEqual({n:0});
      expect(db.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(original);
      await client.exec('DROP TRIGGER fail_workitem_ledger');
      await execute(admit); // Discard ACK; reopening must not infer permission to dispatch.
      await client.dispose(); client=await connect();
      expect(requireView(await execute({...request,action:'inspect'}))).toMatchObject({inputId:first.inputId,phase:'admitted',receipt:null,existing:true});
      expect(await execute(admit)).toMatchObject({ok:true,newlyAdmitted:false});
      expect(await execute({...admit,requestId:'new-key-after-lost-ack'})).toMatchObject({ok:false,errorCode:'FOLLOWUP_OUTCOME_UNKNOWN'});
      expect(await execute({...admit,objective:'Changed same-key intent'})).toMatchObject({ok:false,errorCode:'IDEMPOTENCY_CONFLICT'});
      expect(await execute({...request,action:'verify',fingerprint:first.fingerprint})).toMatchObject({ok:false,errorCode:'EXECUTION_CHANGED'});
      expect(await execute({...request,action:'claim',fingerprint:first.fingerprint,now:11})).toMatchObject({ok:true,claimed:true});
      requireView(await execute({...request,action:'verify',fingerprint:first.fingerprint}));
      expect(await client.tx('projects.validateWorkItemDelivery',{sessionId:'work',inputId:first.inputId})).toEqual({ok:true});
      // A reassignment does not change bindingRevision and A remains a project member.
      // The restored delivery must still reject A, rather than treating membership as assignment.
      await client.exec("UPDATE sessions SET assignee_id='replacement' WHERE id='work'");
      expect(await client.tx('projects.validateWorkItemDelivery',{sessionId:'work',inputId:first.inputId}))
        .toMatchObject({ok:false,errorCode:'EXECUTOR_MISMATCH'});
      expect(await execute({...request,action:'inspect'})).toMatchObject({ok:false,errorCode:'EXECUTOR_MISMATCH'});
      await client.exec("UPDATE sessions SET assignee_id='executor' WHERE id='work'");
      await client.exec("UPDATE sessions SET cleared_at=9 WHERE id='caller'");
      expect(await client.tx('projects.validateWorkItemDelivery',{sessionId:'work',inputId:first.inputId}))
        .toMatchObject({ok:false,errorCode:'SESSION_CONFIG_CHANGED'});
      await client.exec("UPDATE sessions SET cleared_at=NULL WHERE id='caller'");
      await execute({...request,action:'unknown',fingerprint:first.fingerprint,now:12});
      await client.dispose(); client=await connect();
      expect(requireView(await execute({...request,action:'inspect'}))).toMatchObject({inputId:first.inputId,phase:'unknown'});
      expect(await execute({...request,action:'claim',fingerprint:first.fingerprint,now:13})).toMatchObject({ok:true,claimed:false});
      expect(await execute({...request,action:'verify',fingerprint:first.fingerprint})).toMatchObject({ok:false,errorCode:'EXECUTION_CHANGED'});
      expect(db.prepare('SELECT COUNT(*) n FROM bot_delegations').get()).toEqual({n:0});
      expect(db.prepare('SELECT COUNT(*) n FROM bot_task_followup_requests').get()).toEqual({n:0});
      expect(db.prepare('SELECT COUNT(*) n FROM project_work_item_executions').get()).toEqual({n:1});
      // Real public service -> registered SQL transport. Lost completion ACK must replay
      // the stored result, never enqueue another input or change existing permissions.
      setCurrentDbClient(client,'owner');
      const live={instanceId:'fixture',getCurrentTurnOrigin:()=>null};
      const runtime={input:()=>({key:'owner-input',boundary:'turn',ownerInput:true}),getSession:()=>live,
        callerSessionId:()=> 'caller',isExecutionPaused:()=>false};
      const send=vi.fn(async (input:Parameters<import('../../maker-ipc/projectWorkItemExecutionService').ProjectWorkItemSend>[0])=>{
        await input.authorizationGuard.validate();
        expect(input).toMatchObject({targetSessionId:'work2',forceQueue:true,resumeWithStoredPermissionMode:true});
        return {ok:true as const,targetSessionId:input.targetSessionId,wakeKind:'queued',queuedMessageId:input.deliveryClientId};
      });
      let loseAck=true;
      const service=createProjectWorkItemExecutionService({runtime,sendToSession:send,now:()=>20,
        transact:async (db,operation)=>{
          const result=await db.tx('projects.executeWorkItem',operation);
          if(operation.action==='finish' && loseAck){loseAck=false;throw new Error('lost completion ACK');}
          return result;
        }});
      const start={...request,sessionId:'work2',requestId:'service-key'};
      const {actor:ignoredActor,automatic:ignoredAutomatic,...publicStart}=start;
      expect(await service.start(publicStart)).toMatchObject({ok:false,errorCode:'FOLLOWUP_OUTCOME_UNKNOWN'});
      expect(await service.start(publicStart)).toMatchObject({ok:true,childSessionId:'work2',queued:true,queuedMessageId:expect.any(String)});
      expect(send).toHaveBeenCalledOnce();
      expect(await service.start({...publicStart,objective:'changed-body'})).toMatchObject({ok:false,errorCode:'IDEMPOTENCY_CONFLICT'});
      const failedSend=vi.fn(async()=>{throw new Error('queue snapshot write failed');});
      const failed=createProjectWorkItemExecutionService({runtime,sendToSession:failedSend,now:()=>30});
      const failedStart={...publicStart,sessionId:'work3',requestId:'failed-queue'};
      expect(await failed.start(failedStart)).toMatchObject({ok:false,errorCode:'FOLLOWUP_OUTCOME_UNKNOWN'});
      expect(await failed.start(failedStart)).toMatchObject({ok:false,errorCode:'FOLLOWUP_OUTCOME_UNKNOWN'});
      expect(failedSend).toHaveBeenCalledOnce();
      expect(db.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(original);
      expect(db.prepare('SELECT COUNT(*) n FROM bot_delegations').get()).toEqual({n:0});
      expect(db.prepare('SELECT COUNT(*) n FROM bot_task_followup_requests').get()).toEqual({n:0});
      const automationDir=path.join(dir,`automation-${mode}`);
      mkdirSync(path.join(automationDir,'.cindy','automations'),{recursive:true});
      const automationConfig=JSON.stringify({version:1,schedules:[]});
      writeFileSync(path.join(automationDir,'.cindy','automations','schedules.json'),automationConfig);
      db.prepare("UPDATE sessions SET working_dir=? WHERE id='caller'").run(automationDir);
      const automaticSend=vi.fn(async(input:Parameters<import('../../maker-ipc/projectWorkItemExecutionService').ProjectWorkItemSend>[0])=>{
        await input.authorizationGuard.validate();
        return {ok:true as const,targetSessionId:input.targetSessionId,wakeKind:'queued',queuedMessageId:input.deliveryClientId};
      });
      const automaticRuntime={...runtime,input:()=>({key:'automation',boundary:'turn',ownerInput:false,automatic:true})};
      const automatic=createProjectWorkItemExecutionService({runtime:automaticRuntime,
        sendToSession:automaticSend,now:()=>40});
      const automaticInput={...publicStart,sessionId:'work4',requestId:`project-workitem-execution:${digest('automation-key')}`};
      const recover=createProjectWorkItemExecution({...automaticRuntime,sendToSession:automaticSend});
      const recovery={callerSessionId:'caller',intent:{action:'recover' as const,projectId:'p',sessionId:'work4',
        expectedBindingRevision:7,objective:automaticInput.objective,requestToken:automaticInput.requestId}};
      expect(await automatic.start(automaticInput)).toMatchObject({ok:false,errorCode:'AUTOMATION_CONSENT_REQUIRED'});
      expect(automaticSend).not.toHaveBeenCalled();
      expect(await automatic.start({...automaticInput,...{automatic:false}})).toMatchObject({ok:false,errorCode:'INVALID_ARGS'});
      db.prepare('INSERT INTO project_automation_consents(working_dir,consented_at,config_hash) VALUES (?,1,?)').run(automationDir,'stale-hash');
      expect(await automatic.start(automaticInput)).toMatchObject({ok:false,errorCode:'AUTOMATION_CONSENT_REQUIRED'});
      expect(automaticSend).not.toHaveBeenCalled();
      db.prepare('UPDATE project_automation_consents SET config_hash=? WHERE working_dir=?').run(digest(automationConfig),automationDir);
      const queued=await automatic.start(automaticInput);
      expect(queued).toMatchObject({ok:true,childSessionId:'work4',queued:true});
      expect(automaticSend).toHaveBeenCalledOnce();
      const automaticInputId=automaticSend.mock.calls[0][0].deliveryClientId;
      expect(db.prepare('SELECT admission_kind,consent_working_dir,consent_config_hash FROM project_work_item_executions WHERE input_id=?').get(automaticInputId))
        .toEqual({admission_kind:'automatic',consent_working_dir:automationDir,consent_config_hash:digest(automationConfig)});
      await client.dispose(); client=await connect(); setCurrentDbClient(client,'owner');
      const validateAutomatic=()=>client.tx('projects.validateWorkItemDelivery',{sessionId:'work4',inputId:automaticInputId});
      const denied={ok:false,errorCode:'AUTOMATION_CONSENT_REQUIRED'};
      expect(await validateAutomatic()).toEqual({ok:true});
      expect(await recover(recovery)).toMatchObject({ok:true,state:'queued',requestToken:automaticInput.requestId,childSessionId:'work4'});
      db.prepare('DELETE FROM project_automation_consents WHERE working_dir=?').run(automationDir);
      await client.dispose(); client=await connect(); setCurrentDbClient(client,'owner');
      expect(await validateAutomatic()).toMatchObject(denied);
      expect(await recover(recovery)).toMatchObject(denied);
      // Explicit requests neither require automation consent nor acquire new permissions.
      expect(await client.tx('projects.validateWorkItemDelivery',{sessionId:'work2',inputId:send.mock.calls[0][0].deliveryClientId})).toEqual({ok:true});
      expect(await automatic.start(automaticInput)).toMatchObject(denied);
      // A retry under a new explicit turn cannot relabel the original automatic request.
      expect(await service.start(automaticInput)).toMatchObject({ok:false,errorCode:'IDEMPOTENCY_CONFLICT'});
      expect(await execute({...automaticInput,automatic:false,actor:{kind:'bot',id:'executor'},action:'inspect'})).toMatchObject(denied);
      expect(send).toHaveBeenCalledOnce(); expect(automaticSend).toHaveBeenCalledOnce();
      db.prepare('INSERT INTO project_automation_consents(working_dir,consented_at,config_hash) VALUES (?,1,?)').run(automationDir,digest(automationConfig));
      const configPath=path.join(automationDir,'.cindy','automations','schedules.json');
      const changedConfig=JSON.stringify({version:1,schedules:[{id:'changed'}]});
      writeFileSync(configPath,changedConfig);
      await client.dispose(); client=await connect(); setCurrentDbClient(client,'owner');
      expect(await validateAutomatic()).toMatchObject(denied);
      // Approval of a different config does not authorize an input from the old config.
      db.prepare('UPDATE project_automation_consents SET config_hash=? WHERE working_dir=?').run(digest(changedConfig),automationDir);
      expect(await validateAutomatic()).toMatchObject(denied);
      db.prepare('UPDATE project_automation_consents SET config_hash=? WHERE working_dir=?').run(digest(automationConfig),automationDir);
      rmSync(configPath);
      expect(await validateAutomatic()).toMatchObject(denied);
      writeFileSync(configPath,automationConfig);
      expect(await validateAutomatic()).toEqual({ok:true});
      db.prepare("UPDATE sessions SET project_dir=? WHERE id='caller'").run(path.join(dir,'other-project'));
      expect(await validateAutomatic()).toMatchObject(denied);
      db.prepare("UPDATE sessions SET project_dir=NULL WHERE id='caller'").run();
      expect(await automatic.start(automaticInput)).toEqual(queued);
      expect(automaticSend).toHaveBeenCalledOnce();
      // Frozen 0159 rows have no origin evidence; never infer explicit owner intent.
      db.prepare('UPDATE project_work_item_executions SET admission_kind=NULL WHERE input_id=?').run(first.inputId);
      expect(await client.tx('projects.validateWorkItemDelivery',{sessionId:'work',inputId:first.inputId})).toMatchObject(denied);
      db.prepare("UPDATE project_work_item_executions SET admission_kind='explicit' WHERE input_id=?").run(first.inputId);
      // Real restore -> pre-persist rejection -> register's discard handler -> durable
      // cancellation -> project projection. A read-only refusal alone is not settlement.
      const projection=async()=>projectWorkItemExecutionState({delivered:false,
        delegation:(await readDelegations(client,'p')).find(row=>row.childSessionId==='work4')??null,
        followup:(await readFollowups(client,'p')).find(row=>row.childSessionId==='work4')??null});
      const ledgerBefore=db.prepare('SELECT * FROM project_work_item_executions WHERE input_id=?').get(automaticInputId);
      const queuedItem:AgentInputQueuedMessage={clientId:automaticInputId,text:automaticInput.objective,
        persistedContent:automaticInput.objective,model:'fixture-model',effort:'medium',permissionMode:'ask',workingDir:'/fixture/work4',
        chatMessage:{clientId:automaticInputId,role:'user',content:automaticInput.objective,createdAt:new Date().toISOString()},
        createOpts:{agentKind:'claude-code',model:'fixture-model',effort:'medium',permissionMode:'ask',workingDir:'/fixture/work4',userPrompt:'',makerMemoryEnabled:true,displayReasoning:'summarized'}};
      await saveAgentInputQueueSnapshot('work4',[queuedItem]);
      db.prepare('DELETE FROM project_automation_consents WHERE working_dir=?').run(automationDir);
      expect(await validateAutomatic()).toMatchObject(denied);
      expect(await projection()).toBe('accepted');
      expect(db.prepare('SELECT * FROM project_work_item_executions WHERE input_id=?').get(automaticInputId)).toEqual(ledgerBefore);
      let running=true;
      let discardedResolve!:()=>void,discardedReject!:(error:unknown)=>void;
      const discarded=new Promise<void>((resolve,reject)=>{discardedResolve=resolve;discardedReject=reject;});
      const vendor=vi.fn(async()=>{throw new Error('Rejected automatic input reached vendor');});
      const createUser=vi.fn(async()=>{throw new Error('Rejected automatic input persisted a user row');});
      const coordinator=new AgentInputCoordinator({sendToAgent:vendor,steerToAgent:async()=>{},abortSession:async()=>{},
        isTurnRunning:()=>running,hasPendingInteraction:()=>false,getAgentKind:()=> 'claude-code',getSdkSessionId:async()=>undefined,
        createUserMessage:createUser,touchUserSend:async()=>{},emitProjection:()=>{},
        loadQueueSnapshot:loadAgentInputQueueSnapshot,getPersistedClientIds:getPersistedInputClientIds,
        persistQueueSnapshot:saveAgentInputQueueSnapshot,validateInputBeforePersistence:validateWorkItemInputBeforePersistence,
        onDiscardedQueuedMessage:(sessionId,item)=>{settleDiscardedInputDelivery(sessionId,item).then(discardedResolve,discardedReject);}});
      await coordinator.ensureQueueRestored('work4');
      expect(coordinator.getProjection('work4').pendingQueue).toHaveLength(1);
      running=false;coordinator.wakeSession('work4','consent-revoked');
      await discarded;await awaitAgentInputQueueSnapshotPersistence('work4');
      expect(vendor).not.toHaveBeenCalled();expect(createUser).not.toHaveBeenCalled();
      expect(coordinator.getProjection('work4').pendingQueue).toEqual([]);
      expect(await loadAgentInputQueueSnapshot('work4')).toEqual([]);
      expect(await projection()).toBe('failed');
      expect(db.prepare('SELECT role FROM messages WHERE session_id=?').all('work4')).toEqual([{role:'message_tombstone'}]);
      await client.dispose();client=await connect();setCurrentDbClient(client,'owner');
      expect(await projection()).toBe('failed');
      expect(await recover(recovery)).toMatchObject({ok:false,errorCode:'INPUT_DELIVERY_CANCELLED'});
      expect(db.prepare('SELECT * FROM project_work_item_executions WHERE input_id=?').get(automaticInputId)).toEqual(ledgerBefore);
      // A late discard cannot replace a user message that already won delivery.
      const acceptedInputId=send.mock.calls[0][0].deliveryClientId;
      db.prepare("INSERT INTO messages(id,session_id,client_id,role,content,created_at) VALUES ('accepted-fixture','work2',?,'user','\"delivered\"',1)").run(acceptedInputId);
      const acceptedBefore=db.prepare('SELECT * FROM messages WHERE id=?').get('accepted-fixture');
      const receiptBefore=db.prepare('SELECT result_json FROM project_work_item_executions WHERE input_id=?').get(acceptedInputId);
      await settleDiscardedInputDelivery('work2',{...queuedItem,clientId:acceptedInputId});
      expect(db.prepare('SELECT * FROM messages WHERE id=?').get('accepted-fixture')).toEqual(acceptedBefore);
      expect(db.prepare('SELECT result_json FROM project_work_item_executions WHERE input_id=?').get(acceptedInputId)).toEqual(receiptBefore);
      expect(await client.tx('projects.validateWorkItemDelivery',{sessionId:'work2',inputId:acceptedInputId})).toEqual({ok:true});
      db.prepare("UPDATE sessions SET working_dir='/fixture/caller' WHERE id='caller'").run();
      clearCurrentDbClient();
      // Same string, other principal kind does not acquire membership.
      expect(await execute({ ...request, actor: { kind: 'bot', id: 'owner' }, action: 'inspect' })).toMatchObject({ ok: false, errorCode: 'FORBIDDEN' });
      await client.exec("DELETE FROM project_members WHERE subject_kind='bot' AND subject_id='executor'");
      expect(await execute({ ...request, action: 'inspect' })).toMatchObject({ ok: false, errorCode: 'FORBIDDEN' });
      await client.exec("INSERT INTO project_members VALUES ('p','bot','executor','member',1)");
      await client.exec("UPDATE sessions SET project_binding_revision=9 WHERE id='work'");
      expect(await execute({ ...request, action: 'inspect' })).toMatchObject({ ok: false, errorCode: 'BINDING_CONFLICT' });
      await client.exec("UPDATE sessions SET project_binding_revision=7 WHERE id='work'");
      expect(db.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(original);
      expect(db.prepare('SELECT role,COUNT(*) n FROM messages GROUP BY role ORDER BY role').all()).toEqual([{role:'message_tombstone',n:1},{role:'user',n:1}]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(requireView(await execute({...request,action:'inspect'}))).toMatchObject({phase:'unknown',inputId:first.inputId});
    } finally { clearCurrentDbClient(); await client.dispose(); db.close(); h.db = undefined; }
  });
}
