import { z } from 'zod';
import type { LiziMcpSessionContext } from '../types.js';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

const locator = { projectId: z.string().trim().min(1).max(200), sessionId: z.string().trim().min(1).max(200),
  expectedBindingRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), objective: z.string().trim().min(1) };
const intent = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start'), ...locator }),
  z.strictObject({ action: z.literal('recover'), ...locator, requestToken: z.string().regex(/^project-workitem-execution:[a-f0-9]{64}$/) }),
]);
export type ProjectWorkItemExecuteIntent = z.infer<typeof intent>;
const result = z.object({ ok: z.boolean(), errorCode: z.string().optional(),
  requestToken: z.string().regex(/^project-workitem-execution:[a-f0-9]{64}$/).nullable(),
  delegationId: z.string().optional(), childSessionId: z.string().optional(), existing: z.boolean().optional(),
  state: z.enum(['accepted', 'queued', 'pending', 'unknown', 'rejected']) });
export type ProjectWorkItemExecuteResult = z.infer<typeof result>;
export type ProjectWorkItemExecuteCallback = (p: { callerSessionId: string; intent: ProjectWorkItemExecuteIntent }) => Promise<ProjectWorkItemExecuteResult>;

export function registerProjectWorkItemExecutionTool(registry: XdtHelperToolRegistry, deps: {
  getSessionContext: () => LiziMcpSessionContext | undefined; execute?: ProjectWorkItemExecuteCallback;
}) {
  if (!deps.execute) return;
  const execute = deps.execute;
  registry.register({ name: 'execute_project_work_item', category: 'control', inputShape: { intent },
    description: 'Explicitly execute an EXISTING local project task in the current Bot, preserving its Session ID. Read its actual binding revision first; never guess or refresh the precondition. Does not create a child task or reopen a prior execution; existing:true means the original execution was returned without another turn. Caller, executor, actor and request identity come from the host. Group lanes must use the separately authorized group follow-up path. On pending/unknown retain requestToken and use recover with the exact original locator/objective: recover only reads the original request and never sends again. Native accepted does not mean provider consumption or completion. No resume, approval, queue edit or model-route control.',
    handler: async ({ intent }) => {
      // Codes the model may act on. TASK_UNAVAILABLE is a caller-side refusal before any
      // write (no live caller task / missing caller session), so it must not be folded into
      // OUTCOME_UNKNOWN: unknown means "may have been admitted, reconcile only".
      const codes = new Set(['OUTCOME_UNKNOWN','FORBIDDEN','NOT_PROJECT_MEMBER','NOT_PROJECT_OWNER','BINDING_CONFLICT','IDEMPOTENCY_CONFLICT','TASK_PAUSED','FOLLOWUP_PENDING','FOLLOWUP_OUTCOME_UNKNOWN','UNSUPPORTED_CAPABILITY','HOST_NOT_READY','REQUEST_NOT_FOUND','PERMISSION_CONFIG_CONFLICT','SESSION_RUNNING','EXECUTION_NOT_ADMITTED','EXECUTOR_MISMATCH','INVALID_ARGS','CONCURRENCY_LIMIT','WORKING_DIR_BUSY','SESSION_QUEUED','TASK_UNAVAILABLE']);
      const unknown = () => errorPayload('OUTCOME_UNKNOWN', 'Execution outcome is unknown. Do not start again; query get_session_task using the original project Session ID.', { state: 'unknown', requestToken: null });
      try {
        const context = deps.getSessionContext();
        if (!context?.sessionId || context.remoteHostId || context.vendorOptions?.orcaRemoteLead) return errorPayload('UNSUPPORTED_CAPABILITY', 'A trusted local Bot context is required.', { state: 'rejected', requestToken: null });
        const parsed = result.safeParse(await execute({ callerSessionId: context.sessionId, intent }));
        if (!parsed.success) return unknown();
        const value = parsed.data;
        if (value.ok) {
          if (typeof value.existing !== 'boolean' || !value.delegationId || value.childSessionId !== intent.sessionId || !['accepted','queued'].includes(value.state)) return unknown();
          return okPayload(value);
        }
        const code = value.errorCode && codes.has(value.errorCode) ? value.errorCode : 'OUTCOME_UNKNOWN';
        return errorPayload(code, 'Use the original request for reconciliation; do not automatically resend.', { ...value, errorCode: code });
      } catch { return unknown(); }
    },
  });
}
