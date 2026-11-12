/** DB tier: real DbClient -> inproc/native file-worker -> formal 0152 SQLite.
 * Gap: adoption's controlled transact callback cannot detect a missing worker case.
 * Minimal input: admit an existing task, lose its ACK, reopen the client and inspect
 * the original request. Preserve the Session, reject stale binding/ACL and never
 * infer permission to dispatch from a durable pending/unknown receipt. No provider.
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
      expectedBindingRevision: 7, requestId: 'original-key', objective: 'Explicit existing task execution', actor: { kind: 'account' as const, id: 'owner' } };
    const execute = (p: ProjectWorkItemExecutionRequest) => client.tx('projects.executeWorkItem', p);
    const requireView = (r: ProjectWorkItemExecutionResult) => { expect(r.ok).toBe(true); if (!r.ok) throw new Error(r.errorCode); return r.view; };
    const original = db.prepare('SELECT * FROM sessions ORDER BY id').all();
    try {
      expect(await client.queryOne("SELECT value FROM migration_meta WHERE key='schema_version'")).toEqual({ value: '159' });
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
      const {actor:ignoredActor,...publicStart}=start;
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
      const automatic=createProjectWorkItemExecutionService({runtime:{...runtime,input:()=>({key:'automation',boundary:'turn',ownerInput:false,automatic:true})},
        sendToSession:automaticSend,now:()=>40});
      const automaticInput={...publicStart,sessionId:'work4',requestId:'automation-key'};
      expect(await automatic.start(automaticInput)).toMatchObject({ok:false,errorCode:'AUTOMATION_CONSENT_REQUIRED'});
      expect(automaticSend).not.toHaveBeenCalled();
      db.prepare('INSERT INTO project_automation_consents(working_dir,consented_at,config_hash) VALUES (?,1,?)').run(automationDir,'stale-hash');
      expect(await automatic.start(automaticInput)).toMatchObject({ok:false,errorCode:'AUTOMATION_CONSENT_REQUIRED'});
      expect(automaticSend).not.toHaveBeenCalled();
      db.prepare('UPDATE project_automation_consents SET config_hash=? WHERE working_dir=?').run(digest(automationConfig),automationDir);
      expect(await automatic.start(automaticInput)).toMatchObject({ok:true,childSessionId:'work4',queued:true});
      expect(automaticSend).toHaveBeenCalledOnce();
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
      expect(db.prepare('SELECT COUNT(*) n FROM messages').get()).toEqual({ n: 0 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(requireView(await execute({...request,action:'inspect'}))).toMatchObject({phase:'unknown',inputId:first.inputId});
    } finally { clearCurrentDbClient(); await client.dispose(); db.close(); h.db = undefined; }
  });
}
