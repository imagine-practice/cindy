import type { DbClient } from '../localDb/client/DbClient.js';
import { captureEntityProjectAuthority, type EntityProjectRuntime, EntityProjectAccessError } from '../mcp-integrations/entityProjectAuthority.js';
import type { ProjectWorkItemStartInput, ProjectWorkItemStartResult, ProjectWorkItemExecutionScope, ProjectWorkItemExecutionRequest, ProjectWorkItemExecutionResult } from '../../shared/projectWorkItemExecution.js';

export interface WorkItemExecutionHost {
  scope: ProjectWorkItemExecutionScope;
  transact(request: ProjectWorkItemExecutionRequest): Promise<ProjectWorkItemExecutionResult>;
  refresh(): Promise<void>;
  assertCurrent(): void;
  now(): number;
  isExecutionPaused(sessionId: string): boolean;
  finish(inputId: string, delegationId: string, result: ProjectWorkItemStartResult): Promise<void>;
}
export interface WorkItemExecutionDelegate {
  adoptProjectWorkItem(input: ProjectWorkItemStartInput, host: WorkItemExecutionHost): Promise<ProjectWorkItemStartResult>;
}

/** No public registration. The integration supplies the captured-client named transport. */
export function createProjectWorkItemExecutionService(deps: {
  runtime: EntityProjectRuntime & { callerSessionId(): string; isExecutionPaused(sessionId: string): boolean }; delegation: WorkItemExecutionDelegate; now: () => number;
  transact?: (client: DbClient, request: ProjectWorkItemExecutionRequest) => Promise<ProjectWorkItemExecutionResult>;
}) {
  return { async start(input: ProjectWorkItemStartInput): Promise<ProjectWorkItemStartResult> {
    const keys = ['intent','callerSessionId','targetBotId','projectId','sessionId','expectedBindingRevision','requestId','objective'];
    if (!input || Object.keys(input).some(k => !keys.includes(k)) || input.intent !== 'start'
      || ['callerSessionId','targetBotId','projectId','sessionId','requestId','objective'].some(k => typeof input[k as keyof typeof input] !== 'string' || !String(input[k as keyof typeof input]).trim())
      || !Number.isSafeInteger(input.expectedBindingRevision) || input.expectedBindingRevision < 0) {
      return { ok: false,errorCode: 'INVALID_ARGS',message: 'Explicit start intent and exact work-item locator are required' };
    }
    if (input.callerSessionId !== deps.runtime.callerSessionId()) return { ok: false,errorCode: 'CALLER_MISMATCH',message: 'Caller must come from the trusted host context' };
    // Once admission is submitted, a thrown transport/postcheck cannot prove rollback.
    // Keep this per invocation; the durable ledger, not this flag, handles replay.
    let admissionMayHaveCommitted = false;
    try {
      // This establishes a principal/source only. The formal delegation service still
      // validates its actual caller/executor, group lease and task mutation authority.
      const authority = await captureEntityProjectAuthority(input.callerSessionId,deps.runtime);
      const scope = { ...input,actor: authority.actor };
      const refresh = async () => { await authority.refresh([input.projectId]); authority.assertCurrent(); };
      await refresh();
      return await deps.delegation.adoptProjectWorkItem(input,{
        scope,refresh,assertCurrent: authority.assertCurrent,now: deps.now,
        isExecutionPaused: id => deps.runtime.isExecutionPaused(id),
        transact: async request => {
          await refresh(); authority.assertCurrent();
          if (request.action === 'admit') admissionMayHaveCommitted = true;
          const result = await (deps.transact ?? ((client, request) => client.tx('bots.adoptProjectWorkItem', request)))(authority.client,request);
          // A definitive worker rejection is a known no-write result. Thrown ACKs
          // remain uncertain, including a transport failure after actual commit.
          if (request.action === 'admit' && !result.ok) admissionMayHaveCommitted = false;
          authority.assertCurrent();
          // verify is the final single-transaction ACL/binding/config snapshot.
          // Do not append a different async read that could reopen an earlier-item gap.
          if (request.action !== 'verify') await refresh();
          return result;
        },
        finish: async (inputId,taskId,result) => {
          await refresh();
          await authority.client.tx('bots.followupRequest',{ action: 'finish',taskId,inputId,result,now: deps.now() });
          authority.assertCurrent(); await refresh();
        },
      });
    } catch (error) {
      if (admissionMayHaveCommitted) return { ok: false,errorCode: 'FOLLOWUP_OUTCOME_UNKNOWN',
        message: 'Project work-item admission may have committed; retry only with the same requestId' };
      return { ok: false,errorCode: error instanceof EntityProjectAccessError ? error.code : 'EXECUTION_NOT_ADMITTED',
        message: 'Project work-item execution was not admitted' };
    }
  } };
}
