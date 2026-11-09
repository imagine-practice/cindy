import { createHash } from 'node:crypto';
import type { ProjectWorkItemExecuteCallback, ProjectWorkItemExecuteResult } from '@cindy/mcps';
import { captureEntityProjectAuthority, EntityProjectAccessError, type EntityProjectRuntime } from './entityProjectAuthority';
import { captureTaskActionGuard, captureTaskActionSyncGuard } from '../maker-ipc/taskActionAuthorization';
import { createProjectWorkItemExecutionService } from '../maker-ipc/projectWorkItemExecutionService';
import type { BotDelegationService } from '../maker-ipc/botDelegationService';

export function createProjectWorkItemExecution(runtime: EntityProjectRuntime & {
  delegation(): BotDelegationService | null | undefined;
  isExecutionPaused(id: string): boolean | undefined;
}): ProjectWorkItemExecuteCallback {
  return async ({ callerSessionId, intent }) => {
    const guard = captureTaskActionGuard(), sync = captureTaskActionSyncGuard();
    let requestToken: string | null = intent.action === 'recover' ? intent.requestToken : null, submitted = false;
    const failure = (errorCode: string, state: ProjectWorkItemExecuteResult['state'] = submitted || intent.action === 'recover' ? 'unknown' : 'rejected'): ProjectWorkItemExecuteResult => ({ ok: false, errorCode, state, requestToken });
    try {
      await guard?.();
      const authority = await captureEntityProjectAuthority(callerSessionId, runtime);
      const caller = await authority.client.queryOne<{ botId: string; role: string }>(
        'SELECT bot_id AS botId,role FROM bot_session_links WHERE session_id=? AND archived_at IS NULL', [callerSessionId]);
      authority.assertCurrent();
      if (!caller || caller.role === 'group') return failure('UNSUPPORTED_CAPABILITY');
      const delegation = runtime.delegation();
      if (!delegation || runtime.isExecutionPaused(intent.sessionId) === undefined) return failure('HOST_NOT_READY');
      const source = runtime.input(callerSessionId);
      requestToken = intent.action === 'recover' ? intent.requestToken : 'project-workitem-execution:' + createHash('sha256')
        .update(JSON.stringify([caller.botId, source.key, intent.projectId, intent.sessionId, intent.expectedBindingRevision])).digest('hex');
      const input = { intent: 'start' as const, callerSessionId, targetBotId: caller.botId, projectId: intent.projectId,
        sessionId: intent.sessionId, expectedBindingRevision: intent.expectedBindingRevision, requestId: requestToken, objective: intent.objective };
      await authority.refresh([intent.projectId]); await guard?.(); authority.assertCurrent(); sync?.();
      if (intent.action === 'recover') {
        // Read only. Deletion/races cannot turn reconciliation into a fresh admit.
        const result = await authority.client.tx('bots.adoptProjectWorkItem', { ...input, actor: authority.actor, action: 'inspect' });
        await authority.refresh([intent.projectId]); authority.assertCurrent(); sync?.();
        if (!result.ok) return failure(result.errorCode);
        if (!result.view.phase) return failure('REQUEST_NOT_FOUND');
        const receipt = result.view.receipt;
        if (receipt?.ok) return { ok: true, state: receipt.queued ? 'queued' : 'accepted', requestToken,
          delegationId: receipt.delegationId, childSessionId: receipt.childSessionId, existing: receipt.existing };
        return failure(result.view.phase === 'admitted' ? 'FOLLOWUP_PENDING' : 'FOLLOWUP_OUTCOME_UNKNOWN', result.view.phase === 'admitted' ? 'pending' : 'unknown');
      }
      submitted = true;
      const result = await createProjectWorkItemExecutionService({ delegation, now: Date.now,
        runtime: { input: id => runtime.input(id), getSession: id => runtime.getSession(id), callerSessionId: () => callerSessionId,
          isExecutionPaused: id => {
            const paused = runtime.isExecutionPaused(id);
            if (paused === undefined) throw new Error('HOST_NOT_READY');
            return paused;
          } },
        transact: (client, request) => client.tx('bots.adoptProjectWorkItem', request.action === 'admit' ? { ...request, requireSettledExisting: true } : request),
      }).start(input);
      await authority.refresh([intent.projectId]); authority.assertCurrent(); sync?.();
      if (!result.ok) {
        if (result.errorCode === 'FOLLOWUP_OUTCOME_UNKNOWN') {
          const original = await authority.client.queryOne('SELECT 1 FROM bot_task_followup_requests WHERE child_session_id=? AND requester_bot_id=? AND key_digest=?',
            [intent.sessionId, caller.botId, createHash('sha256').update(requestToken).digest('hex')]);
          authority.assertCurrent();
          if (!original) requestToken = null;
        }
        return failure(result.errorCode, result.errorCode === 'FOLLOWUP_PENDING' ? 'pending' : 'unknown');
      }
      return { ok: true, state: result.queued ? 'queued' : 'accepted', requestToken, delegationId: result.delegationId, childSessionId: result.childSessionId, existing: result.existing };
    } catch (error) { return failure(error instanceof EntityProjectAccessError ? error.code : submitted || intent.action === 'recover' ? 'OUTCOME_UNKNOWN' : 'EXECUTION_NOT_ADMITTED'); }
  };
}
