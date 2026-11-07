import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { ProjectWorkItemExecutionRequest, ProjectWorkItemExecutionResult, ProjectWorkItemStartResult } from '../../../../shared/projectWorkItemExecution.js';
import { workingDirEquals } from '../../../../shared/workingDir.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const fail = (errorCode: string): ProjectWorkItemExecutionResult => ({ ok: false, errorCode, message: 'Project work-item execution was not admitted' });
const config = ['id','source','status','title','project_id','project_binding_revision','parent_session_id',
  'permission_mode','model','provider_id','agent_kind','agent_device_id','remote_host_id','working_dir',
  'project_dir','worktree_path','workspace_kind','extra_dirs','fast_mode','effort','cleared_at'];

/** Standalone real SQLite core. Central named-operation registration is not part of this slice. */
export function runProjectWorkItemExecutionTransaction(db: Database.Database, p: ProjectWorkItemExecutionRequest): ProjectWorkItemExecutionResult {
  return db.transaction((): ProjectWorkItemExecutionResult => {
    if (p.intent !== 'start' || !p.requestId || !p.objective.trim() || !Number.isSafeInteger(p.expectedBindingRevision)
      || p.expectedBindingRevision < 0 || !['account','bot'].includes(p.actor.kind) || !p.actor.id) return fail('INVALID_ARGS');
    const member = db.prepare("SELECT 1 FROM project_members WHERE project_id=? AND subject_kind=? AND subject_id=? AND role IN ('owner','member')");
    const project = db.prepare("SELECT 1 FROM projects WHERE id=? AND status='active'").get(p.projectId);
    if (!project || !member.get(p.projectId,p.actor.kind,p.actor.id) || !member.get(p.projectId,'bot',p.targetBotId)) return fail('FORBIDDEN');
    const caller = db.prepare(`SELECT l.bot_id AS botId, l.role, p.canonical_session_id AS canonical FROM bot_session_links l
      JOIN sessions s ON s.id=l.session_id JOIN bot_profiles p ON p.id=l.bot_id
      WHERE l.session_id=? AND l.archived_at IS NULL AND s.status='active' AND p.status='active'`).get(p.callerSessionId) as
      { botId: string; role: string; canonical: string } | undefined;
    if (!caller || caller.botId !== p.targetBotId || !['canonical','thread','routine','delegation','group'].includes(caller.role)
      || (caller.role === 'canonical' && caller.canonical !== p.callerSessionId)) return fail('EXECUTOR_MISMATCH');
    const target = db.prepare('SELECT * FROM sessions WHERE id=?').get(p.sessionId) as Record<string, unknown> | undefined;
    if (!target || target.project_id !== p.projectId || target.project_binding_revision !== p.expectedBindingRevision) return fail('BINDING_CONFLICT');
    if (target.status !== 'active') return fail(target.status === 'archived' ? 'ARCHIVED' : 'DELETED');
    if (target.source !== 'desktop' || db.prepare('SELECT 1 FROM bot_session_links WHERE session_id=?').get(p.sessionId)) return fail('PRIVATE_BOT_LANE');
    if (!target.working_dir || target.remote_host_id || target.agent_device_id) return fail('UNSUPPORTED_EXECUTION_HOST');
    const fingerprint = JSON.stringify(config.map(k => target[k] ?? null));
    if (p.action !== 'inspect' && p.fingerprint !== fingerprint) return fail('SESSION_CONFIG_CHANGED');
    const rows = db.prepare('SELECT id,requesting_bot_id AS botId,status,run_sequence AS run,permission_snapshot_json AS snapshot FROM bot_delegations WHERE child_session_id=?')
      .all(p.sessionId) as { id: string; botId: string; status: string; run: number; snapshot: string }[];
    if (rows.length > 1 || (rows[0] && rows[0].botId !== p.targetBotId)) return fail('EXECUTION_CONFLICT');
    const priorScope = rows[0] ? JSON.parse(rows[0].snapshot).projectWorkItemExecution : null;
    if (priorScope && (priorScope.version !== 1 || priorScope.projectId !== p.projectId
      || priorScope.sessionId !== p.sessionId || priorScope.bindingRevision !== p.expectedBindingRevision)) return fail('BINDING_CONFLICT');
    const delegationId = rows[0]?.id ?? `project-workitem:${digest(p.sessionId)}`;
    const key = digest(p.requestId);
    const body = digest(JSON.stringify([p.projectId,p.sessionId,p.expectedBindingRevision,p.targetBotId,p.actor.kind,p.actor.id,p.intent,p.objective.trim()]));
    const old = db.prepare(`SELECT input_id AS inputId,body_digest AS body,phase,result_json AS receipt FROM bot_task_followup_requests
      WHERE task_id=? AND requester_bot_id=? AND key_digest=?`).get(delegationId,p.targetBotId,key) as
      { inputId: string; body: string; phase: string; receipt: string | null } | undefined;
    if (old && old.body !== body) return fail('IDEMPOTENCY_CONFLICT');
    const view = { fingerprint,delegationId,inputId: old?.inputId ?? `bot-delegation-interject:${delegationId}:request-${key}`,
      existing: rows.length > 0,receipt: old?.receipt ? JSON.parse(old.receipt) as ProjectWorkItemStartResult : null,phase: old?.phase ?? null };
    if (p.action === 'inspect') return { ok: true,view };
    if (p.action === 'verify') {
      if (!rows[0] || !['queued','running'].includes(rows[0].status) || old?.phase !== 'dispatching') return fail('EXECUTION_CHANGED');
      const state = JSON.parse(rows[0].snapshot);
      if (state.taskPause || state.taskCancelRequested) return fail('TASK_PAUSED');
      return { ok: true,view };
    }
    if (old) return { ok: true,view };
    if (p.requireSettledExisting && db.prepare("SELECT 1 FROM bot_task_followup_requests WHERE task_id=? AND phase IN ('admitted','dispatching','unknown')").get(delegationId)) return fail('FOLLOWUP_OUTCOME_UNKNOWN');
    if (rows[0]) {
      if (!p.existingResult?.ok || p.existingResult.delegationId !== delegationId) return fail('EXISTING_EXECUTION');
    } else {
      if (!Number.isSafeInteger(p.maxActiveChildren) || p.maxActiveChildren < 1) return fail('INVALID_ARGS');
      const count = db.prepare("SELECT COUNT(*) FROM bot_delegations WHERE requesting_bot_id=? AND status IN ('queued','running','waiting')").pluck().get(p.targetBotId) as number;
      if (count >= p.maxActiveChildren) return fail('CONCURRENCY_LIMIT');
      const pending = db.prepare('SELECT payload FROM agent_input_queue_snapshots WHERE session_id=?').get(p.sessionId) as {payload:string}|undefined;
      if (pending && JSON.stringify(JSON.parse(pending.payload)) !== '[]') return fail('SESSION_QUEUED');
      if (Number(target.active_turn_started_at ?? 0) > Number(target.last_turn_ended_at ?? 0)) return fail('SESSION_RUNNING');
      const occupied = db.prepare(`SELECT s.working_dir AS dir FROM sessions s WHERE s.id<>? AND
        (COALESCE(s.active_turn_started_at,0)>COALESCE(s.last_turn_ended_at,0) OR EXISTS
          (SELECT 1 FROM bot_delegations d WHERE d.child_session_id=s.id AND d.status IN ('queued','running','waiting')))`)
        .all(p.sessionId) as { dir: string | null }[];
      if (occupied.some(x => workingDirEquals(x.dir, target.working_dir as string))) return fail('WORKING_DIR_BUSY');
      const plan = JSON.parse(p.permissionSnapshotJson);
      const scope = plan.projectWorkItemExecution;
      if (!scope || scope.version !== 1 || scope.projectId !== p.projectId || scope.sessionId !== p.sessionId || scope.bindingRevision !== p.expectedBindingRevision
        || scope.targetBotId !== p.targetBotId || scope.actor?.kind !== p.actor.kind || scope.actor?.id !== p.actor.id) return fail('PLAN_SNAPSHOT_INVALID');
      if (plan.permission?.mode !== target.permission_mode || plan.targetBotId !== null
        || plan.taskInput?.inputId !== view.inputId) return fail('PLAN_SNAPSHOT_INVALID');
      db.prepare(`INSERT INTO bot_delegations (id,requesting_bot_id,target_bot_id,parent_session_id,child_session_id,objective,
        context_refs_json,artifact_refs_json,permission_snapshot_json,lineage_json,depth,status,run_sequence,created_at,updated_at)
        VALUES (?, ?, NULL, ?, ?, ?, '[]','[]',?, ?, 1,'queued',1,?,?)`)
        .run(delegationId,p.targetBotId,p.callerSessionId,p.sessionId,p.objective.trim(),p.permissionSnapshotJson,JSON.stringify([p.targetBotId]),p.now,p.now);
    }
    db.prepare(`INSERT INTO bot_task_followup_requests (task_id,requester_bot_id,key_digest,body_digest,input_id,admitted_run_sequence,
      child_session_id,phase,native_accepted_at,result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?)`)
      .run(delegationId,p.targetBotId,key,body,view.inputId,rows[0]?.run ?? 1,p.sessionId,rows[0]?'settled':'admitted',
        rows[0]?JSON.stringify(p.existingResult):null,p.now,p.now);
    return { ok: true,view: { ...view,receipt: rows[0]?p.existingResult!:null,phase: rows[0]?'settled':'admitted' } };
  }).immediate();
}
