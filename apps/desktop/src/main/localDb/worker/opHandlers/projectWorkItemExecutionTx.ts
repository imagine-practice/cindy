import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_AUTOMATION_REL_SEGMENTS } from '../../../../shared/projectAutomationPaths.js';
import type {
  ProjectWorkItemExecutionRequest,
  ProjectWorkItemExecutionResult,
  ProjectWorkItemStartResult,
} from '../../../../shared/projectWorkItemExecution.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const fail = (errorCode: string): Extract<ProjectWorkItemExecutionResult, { ok: false }> => ({
  ok: false,
  errorCode,
  message: 'Project work-item execution was not admitted',
});
type AdmissionRow = {
  admissionKind: 'explicit' | 'automatic' | null;
  consentWorkingDir: string | null;
  consentConfigHash: string | null;
};

/** Read and freeze consent in the same host transaction that admits the input.
 * Recovery checks the original basis, even if the active turn is now explicit.
 * Pre-evidence rows have no trustworthy origin and must not resume automatically.
 */
function readAdmission(
  db: Database.Database,
  callerSessionId: string,
  automatic: boolean,
  stored?: AdmissionRow,
): { ok: true; basis: AdmissionRow } | Extract<ProjectWorkItemExecutionResult, { ok: false }> {
  const kind = stored ? stored.admissionKind : automatic ? 'automatic' : 'explicit';
  if (kind === 'explicit')
    return {
      ok: true,
      basis: { admissionKind: kind, consentWorkingDir: null, consentConfigHash: null },
    };
  if (kind !== 'automatic') return fail('AUTOMATION_CONSENT_REQUIRED');
  const caller = db
    .prepare('SELECT COALESCE(project_dir,working_dir) AS dir FROM sessions WHERE id=?')
    .get(callerSessionId) as { dir: string | null } | undefined;
  if (!caller?.dir || (stored && stored.consentWorkingDir !== caller.dir))
    return fail('AUTOMATION_CONSENT_REQUIRED');
  const consent = db
    .prepare('SELECT config_hash AS hash FROM project_automation_consents WHERE working_dir=?')
    .get(caller.dir) as { hash: string } | undefined;
  if (!consent || (stored && stored.consentConfigHash !== consent.hash))
    return fail('AUTOMATION_CONSENT_REQUIRED');
  try {
    const content = readFileSync(path.join(caller.dir, ...PROJECT_AUTOMATION_REL_SEGMENTS), 'utf8');
    if (digest(content) !== consent.hash) return fail('AUTOMATION_CONSENT_REQUIRED');
  } catch {
    return fail('AUTOMATION_CONSENT_REQUIRED');
  }
  return {
    ok: true,
    basis: { admissionKind: kind, consentWorkingDir: caller.dir, consentConfigHash: consent.hash },
  };
}
const config = [
  'id',
  'source',
  'status',
  'title',
  'project_id',
  'project_binding_revision',
  'parent_session_id',
  'permission_mode',
  'model',
  'provider_id',
  'agent_kind',
  'agent_device_id',
  'remote_host_id',
  'working_dir',
  'project_dir',
  'worktree_path',
  'workspace_kind',
  'extra_dirs',
  'fast_mode',
  'effort',
  'cleared_at',
  'assignee_kind',
  'assignee_id',
];

/** Standalone real SQLite core. Central named-operation registration is not part of this slice. */
export function runProjectWorkItemExecutionTransaction(
  db: Database.Database,
  p: ProjectWorkItemExecutionRequest,
): ProjectWorkItemExecutionResult {
  return db
    .transaction((): ProjectWorkItemExecutionResult => {
      if (
        p.intent !== 'start' ||
        !p.requestId ||
        !p.objective.trim() ||
        !Number.isSafeInteger(p.expectedBindingRevision) ||
        p.expectedBindingRevision < 0 ||
        typeof p.automatic !== 'boolean' ||
        !['account', 'bot'].includes(p.actor.kind) ||
        !p.actor.id
      )
        return fail('INVALID_ARGS');
      const checked = readExecutionFacts(db, p);
      if (!checked.ok) return checked;
      const fingerprint = checked.fingerprint;
      if (p.action !== 'inspect' && p.fingerprint !== fingerprint)
        return fail('SESSION_CONFIG_CHANGED');
      const key = digest(p.requestId);
      const body = digest(
        JSON.stringify([
          p.projectId,
          p.sessionId,
          p.expectedBindingRevision,
          p.targetBotId,
          p.actor.kind,
          p.actor.id,
          p.intent,
          p.objective.trim(),
        ]),
      );
      const id = `project-workitem:${digest(JSON.stringify([p.sessionId, p.targetBotId, key]))}`;
      const old = db
        .prepare(
          `SELECT id,input_id AS inputId,body_digest AS body,phase,result_json AS receipt,
      admission_kind AS admissionKind,consent_working_dir AS consentWorkingDir,consent_config_hash AS consentConfigHash
      FROM project_work_item_executions WHERE session_id=? AND executor_bot_id=? AND key_digest=?`,
        )
        .get(p.sessionId, p.targetBotId, key) as
        | (AdmissionRow & { id: string; inputId: string; body: string; phase: string; receipt: string | null })
        | undefined;
      if (old && old.body !== body) return fail('IDEMPOTENCY_CONFLICT');
      const inputId = old?.inputId ?? `project-workitem-input:${digest(id)}`;
      if (db.prepare("SELECT 1 FROM messages WHERE session_id=? AND client_id=? AND role='message_tombstone'").get(p.sessionId, inputId))
        return fail('INPUT_DELIVERY_CANCELLED');
      // Recording an uncertain/completed outcome never grants permission to deliver.
      const admission = p.action === 'unknown' || p.action === 'finish'
        ? undefined : readAdmission(db, p.callerSessionId, p.automatic, old);
      if (admission && !admission.ok) return admission;
      const view = {
        fingerprint,
        delegationId: id,
        inputId,
        existing: !!old,
        receipt: old?.receipt ? (JSON.parse(old.receipt) as ProjectWorkItemStartResult) : null,
        phase: old?.phase ?? null,
      };
      if (p.action === 'inspect') return { ok: true, view };
      if (p.action === 'admit') {
        if (old) return { ok: true, view, newlyAdmitted: false };
        if (!admission) return fail('INVALID_ARGS');
        if (
          db
            .prepare(
              "SELECT 1 FROM project_work_item_executions WHERE session_id=? AND phase IN ('admitted','dispatching','unknown')",
            )
            .get(p.sessionId)
        )
          return fail('FOLLOWUP_OUTCOME_UNKNOWN');
        db.prepare(
          `INSERT INTO project_work_item_executions
        (id,project_id,session_id,binding_revision,executor_bot_id,caller_session_id,actor_kind,actor_id,
         key_digest,body_digest,fingerprint,input_id,phase,created_at,updated_at,
         admission_kind,consent_working_dir,consent_config_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'admitted',?,?,?,?,?)`,
        ).run(
          id,
          p.projectId,
          p.sessionId,
          p.expectedBindingRevision,
          p.targetBotId,
          p.callerSessionId,
          p.actor.kind,
          p.actor.id,
          key,
          body,
          fingerprint,
          view.inputId,
          p.now,
          p.now,
          admission.basis.admissionKind,
          admission.basis.consentWorkingDir,
          admission.basis.consentConfigHash,
        );
        return { ok: true, view: { ...view, phase: 'admitted' }, newlyAdmitted: true };
      }
      if (!old) return fail('REQUEST_NOT_FOUND');
      if (p.action === 'claim') {
        const changed = db
          .prepare(
            "UPDATE project_work_item_executions SET phase='dispatching',updated_at=? WHERE id=? AND phase='admitted'",
          )
          .run(p.now, id).changes;
        return {
          ok: true,
          view: { ...view, phase: changed ? 'dispatching' : view.phase },
          claimed: changed === 1,
        };
      }
      if (p.action === 'verify')
        return old.phase === 'dispatching' ? { ok: true, view } : fail('EXECUTION_CHANGED');
      if (p.action === 'unknown') {
        db.prepare(
          "UPDATE project_work_item_executions SET phase='unknown',updated_at=? WHERE id=? AND phase='dispatching'",
        ).run(p.now, id);
        return {
          ok: true,
          view: { ...view, phase: old.phase === 'dispatching' ? 'unknown' : old.phase },
        };
      }
      if (old.phase !== 'dispatching') return { ok: true, view };
      db.prepare(
        "UPDATE project_work_item_executions SET phase='settled',result_json=?,updated_at=? WHERE id=? AND phase='dispatching'",
      ).run(JSON.stringify(p.result), p.now, id);
      return { ok: true, view: { ...view, phase: 'settled', receipt: p.result } };
    })
    .immediate();
}

function readExecutionFacts(
  db: Database.Database,
  p: Omit<import('../../../../shared/projectWorkItemExecution.js').ProjectWorkItemExecutionScope, 'automatic'>,
): { ok: true; fingerprint: string } | { ok: false; errorCode: string; message: string } {
  const member = db.prepare(
    "SELECT 1 FROM project_members WHERE project_id=? AND subject_kind=? AND subject_id=? AND role IN ('owner','member')",
  );
  const project = db
    .prepare("SELECT 1 FROM projects WHERE id=? AND status='active'")
    .get(p.projectId);
  if (
    !project ||
    !member.get(p.projectId, p.actor.kind, p.actor.id) ||
    !member.get(p.projectId, 'bot', p.targetBotId)
  )
    return fail('FORBIDDEN');
  const caller = db
    .prepare(
      `SELECT l.bot_id AS botId, l.role, p.canonical_session_id AS canonical, s.cleared_at AS clearedAt FROM bot_session_links l
      JOIN sessions s ON s.id=l.session_id JOIN bot_profiles p ON p.id=l.bot_id
      WHERE l.session_id=? AND l.archived_at IS NULL AND s.status='active' AND p.status='active'`,
    )
    .get(p.callerSessionId) as
    { botId: string; role: string; canonical: string; clearedAt: number | null } | undefined;
  if (
    !caller ||
    caller.botId !== p.targetBotId ||
    !['canonical', 'thread', 'routine', 'delegation', 'group'].includes(caller.role) ||
    (caller.role === 'canonical' && caller.canonical !== p.callerSessionId)
  )
    return fail('EXECUTOR_MISMATCH');
  const target = db.prepare('SELECT * FROM sessions WHERE id=?').get(p.sessionId) as
    Record<string, unknown> | undefined;
  if (
    !target ||
    target.project_id !== p.projectId ||
    target.project_binding_revision !== p.expectedBindingRevision
  )
    return fail('BINDING_CONFLICT');
  if (target.assignee_kind !== 'bot' || target.assignee_id !== p.targetBotId) return fail('EXECUTOR_MISMATCH');
  if (target.status !== 'active')
    return fail(target.status === 'archived' ? 'ARCHIVED' : 'DELETED');
  if (
    target.source !== 'desktop' ||
    db.prepare('SELECT 1 FROM bot_session_links WHERE session_id=?').get(p.sessionId)
  )
    return fail('PRIVATE_BOT_LANE');
  if (!target.working_dir || target.remote_host_id || target.agent_device_id)
    return fail('UNSUPPORTED_EXECUTION_HOST');
  const fingerprint = JSON.stringify([
    ...config.map((k) => target[k] ?? null),
    caller.clearedAt ?? null,
  ]);
  return { ok: true as const, fingerprint };
}

/** Restored queues resolve host-owned evidence from SQLite, never from model metadata. */
export function validateProjectWorkItemDelivery(
  db: Database.Database,
  input: { sessionId: string; inputId: string },
) {
  return db
    .transaction(() => {
      const row = db
        .prepare(
          `SELECT project_id AS projectId,session_id AS sessionId,binding_revision AS expectedBindingRevision,
      executor_bot_id AS targetBotId,caller_session_id AS callerSessionId,actor_kind AS actorKind,actor_id AS actorId,
      fingerprint,phase,admission_kind AS admissionKind,consent_working_dir AS consentWorkingDir,
      consent_config_hash AS consentConfigHash FROM project_work_item_executions WHERE session_id=? AND input_id=?`,
        )
        .get(input.sessionId, input.inputId) as
        | (AdmissionRow & {
            projectId: string;
            sessionId: string;
            expectedBindingRevision: number;
            targetBotId: string;
            callerSessionId: string;
            actorKind: 'account' | 'bot';
            actorId: string;
            fingerprint: string;
            phase: string;
          })
        | undefined;
      if (!row || !['dispatching', 'settled', 'unknown'].includes(row.phase))
        return { ok: false as const, errorCode: 'EXECUTION_CHANGED' };
      if (db.prepare("SELECT 1 FROM messages WHERE session_id=? AND client_id=? AND role='message_tombstone'").get(input.sessionId, input.inputId))
        return { ok: false as const, errorCode: 'INPUT_DELIVERY_CANCELLED' };
      const checked = readExecutionFacts(db, {
        ...row,
        intent: 'start',
        actor: { kind: row.actorKind, id: row.actorId },
        requestId: 'delivery',
        objective: 'delivery',
      });
      if (!checked.ok) return checked;
      if (checked.fingerprint !== row.fingerprint)
        return { ok: false as const, errorCode: 'SESSION_CONFIG_CHANGED' };
      const admission = readAdmission(db, row.callerSessionId, false, row);
      return admission.ok ? { ok: true as const } : admission;
    })
    .immediate();
}
