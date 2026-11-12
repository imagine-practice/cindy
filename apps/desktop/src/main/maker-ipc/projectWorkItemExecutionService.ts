import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DbClient } from '../localDb/client/DbClient.js';
import {
  captureEntityProjectAuthority,
  type EntityProjectRuntime,
  EntityProjectAccessError,
} from '../mcp-integrations/entityProjectAuthority.js';
import { PROJECT_AUTOMATION_REL_SEGMENTS } from '../../shared/projectAutomationPaths.js';
import type {
  ProjectWorkItemStartInput,
  ProjectWorkItemStartResult,
  ProjectWorkItemExecutionRequest,
  ProjectWorkItemExecutionResult,
} from '../../shared/projectWorkItemExecution.js';

export interface ProjectWorkItemSend {
  (input: {
    targetSessionId: string;
    dispatcherSessionId: string;
    message: string;
    deliveryClientId: string;
    forceQueue: true;
    resumeWithStoredPermissionMode: true;
    authorizationGuard: { validate(): Promise<void>; assertCurrent(): void };
  }): Promise<
    | { ok: true; targetSessionId: string; wakeKind: string; queuedMessageId?: string }
    | { ok: false; errorCode: string; message: string }
  >;
}

/** Existing work items always jump to their original Session. Recipient permissions are
 * preserved; this path never creates a replacement task or inherits dispatcher permissions.
 * The SQL ledger claims each request once. An uncertain ACK is reconciliation, not a retry.
 */
export function createProjectWorkItemExecutionService(deps: {
  runtime: EntityProjectRuntime & {
    callerSessionId(): string;
    isExecutionPaused(id: string): boolean;
  };
  sendToSession: ProjectWorkItemSend;
  now: () => number;
  transact?: (
    client: DbClient,
    request: ProjectWorkItemExecutionRequest,
  ) => Promise<ProjectWorkItemExecutionResult>;
}) {
  return {
    async start(input: ProjectWorkItemStartInput): Promise<ProjectWorkItemStartResult> {
      const keys = [
        'intent',
        'callerSessionId',
        'targetBotId',
        'projectId',
        'sessionId',
        'expectedBindingRevision',
        'requestId',
        'objective',
      ];
      const fail = (
        errorCode: string,
        message = 'Project work-item execution was not admitted',
      ): ProjectWorkItemStartResult => ({ ok: false, errorCode, message });
      if (
        !input ||
        Object.keys(input).some((k) => !keys.includes(k)) ||
        input.intent !== 'start' ||
        ['callerSessionId', 'targetBotId', 'projectId', 'sessionId', 'requestId', 'objective'].some(
          (k) =>
            typeof input[k as keyof typeof input] !== 'string' ||
            !String(input[k as keyof typeof input]).trim(),
        ) ||
        !Number.isSafeInteger(input.expectedBindingRevision) ||
        input.expectedBindingRevision < 0
      )
        return fail('INVALID_ARGS');
      if (input.callerSessionId !== deps.runtime.callerSessionId()) return fail('CALLER_MISMATCH');
      let mayHaveCommitted = false;
      let markUnknown: (() => Promise<unknown>) | undefined;
      try {
        const authority = await captureEntityProjectAuthority(input.callerSessionId, deps.runtime);
        const scope = { ...input, actor: authority.actor };
        const refresh = async () => {
          await authority.refresh([input.projectId]);
          authority.assertCurrent();
        };
        const automatic = deps.runtime.input(input.callerSessionId).automatic === true;
        const checkConsent = async () => {
          if (!automatic) return;
          const row = await authority.client.queryOne<{ dir: string }>(
            'SELECT COALESCE(project_dir,working_dir) AS dir FROM sessions WHERE id=?',
            [input.callerSessionId],
          );
          if (!row?.dir) throw new EntityProjectAccessError('AUTOMATION_CONSENT_REQUIRED');
          const consent = await authority.client.queryOne<{ hash: string }>(
            'SELECT config_hash AS hash FROM project_automation_consents WHERE working_dir=?',
            [row.dir],
          );
          let content: string;
          try {
            content = await fs.readFile(
              path.join(row.dir, ...PROJECT_AUTOMATION_REL_SEGMENTS),
              'utf8',
            );
          } catch {
            throw new EntityProjectAccessError('AUTOMATION_CONSENT_REQUIRED');
          }
          if (!consent || consent.hash !== createHash('sha256').update(content).digest('hex'))
            throw new EntityProjectAccessError('AUTOMATION_CONSENT_REQUIRED');
          authority.assertCurrent();
        };
        const tx = async (request: ProjectWorkItemExecutionRequest) => {
          await refresh();
          await checkConsent();
          authority.assertCurrent();
          const result = await (
            deps.transact ?? ((client, request) => client.tx('projects.executeWorkItem', request))
          )(authority.client, request);
          authority.assertCurrent();
          return result;
        };
        await refresh();
        await checkConsent();
        if (deps.runtime.isExecutionPaused(input.sessionId)) return fail('TASK_PAUSED');
        const inspected = await tx({ ...scope, action: 'inspect' });
        if (!inspected.ok) return inspected;
        const fingerprint = inspected.view.fingerprint;
        mayHaveCommitted = true;
        const admitted = await tx({ ...scope, action: 'admit', fingerprint, now: deps.now() });
        if (!admitted.ok) {
          mayHaveCommitted = false;
          return admitted;
        }
        if (!admitted.newlyAdmitted)
          return (
            admitted.view.receipt ??
            fail(
              admitted.view.phase === 'admitted' ? 'FOLLOWUP_PENDING' : 'FOLLOWUP_OUTCOME_UNKNOWN',
            )
          );
        const claimed = await tx({ ...scope, action: 'claim', fingerprint, now: deps.now() });
        if (!claimed.ok) return claimed;
        if (!claimed.claimed) return fail('FOLLOWUP_OUTCOME_UNKNOWN');
        markUnknown = () => tx({ ...scope, action: 'unknown', fingerprint, now: deps.now() });
        const validate = async () => {
          if (deps.runtime.isExecutionPaused(input.sessionId))
            throw new EntityProjectAccessError('TASK_PAUSED');
          const verified = await tx({ ...scope, action: 'verify', fingerprint });
          if (!verified.ok) throw new EntityProjectAccessError(verified.errorCode);
        };
        await validate();
        const delivered = await deps.sendToSession({
          targetSessionId: input.sessionId,
          dispatcherSessionId: input.callerSessionId,
          message: input.objective.trim(),
          deliveryClientId: admitted.view.inputId,
          forceQueue: true,
          resumeWithStoredPermissionMode: true,
          authorizationGuard: { validate, assertCurrent: authority.assertCurrent },
        });
        const result: ProjectWorkItemStartResult = delivered.ok
          ? {
              ok: true,
              delegationId: admitted.view.delegationId,
              childSessionId: input.sessionId,
              existing: inspected.view.existing,
              status: delivered.wakeKind === 'queued' ? 'queued' : 'running',
              resumed: false,
              queued: delivered.wakeKind === 'queued',
              ...(delivered.queuedMessageId ? { queuedMessageId: delivered.queuedMessageId } : {}),
              delivery: delivered.wakeKind === 'queued' ? 'queued' : 'accepted',
            }
          : delivered;
        const finished = await tx({
          ...scope,
          action: 'finish',
          fingerprint,
          now: deps.now(),
          result,
        });
        if (!finished.ok) return fail('FOLLOWUP_OUTCOME_UNKNOWN');
        return result;
      } catch (error) {
        if (mayHaveCommitted) {
          await markUnknown?.().catch(() => undefined);
          return fail(
            'FOLLOWUP_OUTCOME_UNKNOWN',
            'Delivery may have committed; inspect the original request key before continuing',
          );
        }
        return fail(
          error instanceof EntityProjectAccessError ? error.code : 'EXECUTION_NOT_ADMITTED',
        );
      }
    },
  };
}
