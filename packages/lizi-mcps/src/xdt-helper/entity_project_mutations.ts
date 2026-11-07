import { z } from 'zod';
import type { LiziMcpSessionContext } from '../types.js';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

// Independent wire contract: never import desktop runtime or infer an actor here.
const id = z.string().trim().min(1).refine(
  value => !/[\\/]/.test(value) && !value.includes('::') && !/^[A-Za-z]:/.test(value),
  'Use a stable local ID, not a directory path or remote identifier.',
);
const subject = z.strictObject({ kind: z.enum(['account', 'bot']), id: z.string().trim().min(1) });
const name = z.string().trim().min(1).max(120);
const goal = z.string().max(2000).nullable();
const intentSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), input: z.strictObject({
    name, goal: goal.optional(), owner: subject.optional(), members: z.array(subject).optional(),
  }) }),
  z.strictObject({ action: z.literal('update'), projectId: id, name: name.optional(), goal: goal.optional(), status: z.enum(['active', 'archived']).optional() }),
  z.strictObject({ action: z.literal('addMember'), projectId: id, subject }),
  z.strictObject({ action: z.literal('removeMember'), projectId: id, subject }),
  z.strictObject({ action: z.literal('transferOwner'), projectId: id, subject }),
  z.strictObject({ action: z.literal('bindSession'), sessionId: id, projectId: id.nullable() }),
  z.strictObject({ action: z.literal('setAssignee'), sessionId: id, assignee: subject.nullable() }),
]);

export type EntityProjectMutationIntent = z.infer<typeof intentSchema>;
const errorCode = z.enum(['INVALID_PARAMS', 'NOT_FOUND', 'NOT_PROJECT_MEMBER', 'NOT_PROJECT_OWNER',
  'PRECONDITION_FAILED', 'PERMISSION_DENIED', 'CANCELLED', 'UNAVAILABLE', 'INTERNAL']);
const resultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), projectId: id.nullable(), sessionId: id.nullable() }),
  z.object({ ok: z.literal(false), errorCode, writeOutcome: z.enum(['not-applied', 'unknown']) }),
]);
export type EntityProjectMutationResult = z.infer<typeof resultSchema>;
/** Host must resolve identity and live permissions from callerSessionId, recheck
 * account/instance after awaits, and execute only this intent. owner is business
 * data, never the calling actor. Only report not-applied when zero writes is known;
 * post-commit notification errors and uncertain receipts must remain unknown.
 */
export type EntityProjectMutationCallback = (params: {
  callerSessionId: string;
  intent: EntityProjectMutationIntent;
}) => Promise<EntityProjectMutationResult>;

export function registerEntityProjectMutationTool(registry: XdtHelperToolRegistry, deps: {
  getSessionContext: () => LiziMcpSessionContext | undefined;
  mutate: EntityProjectMutationCallback;
}): void {
  const unknown = () => errorPayload('WRITE_OUTCOME_UNKNOWN',
    'The write may have taken effect. Read the project or task state before deciding what to do; do not automatically retry.',
    { writeOutcome: 'unknown' });
  registry.register({
    name: 'mutate_project_entity', category: 'control', inputShape: { intent: intentSchema },
    description: 'Modify a local entity project with exactly one action: create, update (including archive), addMember, removeMember, transferOwner, bindSession or setAssignee. projectId is an entity ID from list_project_entities; sessionId is a Cindy task ID, never project_path/working_dir. create.input.owner is the intended owner, not caller identity; omit it for the host default. Members use stable kind/id (same names may identify different subjects); host handles deduplication and membership rules. Null clears binding/assignee. This does not create directories, dispatch tasks, send messages, cancel executions or call models. Host checks live task permissions. Local only; unknown write outcomes require reading state, never automatic retry.',
    handler: async ({ intent }) => {
      const context = deps.getSessionContext();
      if (!context?.sessionId?.trim()) return errorPayload('NO_SESSION_CONTEXT', 'No trusted Cindy task context is available.', { writeOutcome: 'not-applied' });
      if (context.remoteHostId || context.vendorOptions?.orcaRemoteLead) return errorPayload('UNSUPPORTED_CAPABILITY', 'Entity project writes are not connected for this remote execution context.', { writeOutcome: 'not-applied' });
      try {
        const parsed = resultSchema.safeParse(await deps.mutate({ callerSessionId: context.sessionId, intent }));
        if (!parsed.success) return unknown();
        const result = parsed.data;
        if (result.ok) return okPayload({ projectId: result.projectId, sessionId: result.sessionId });
        return errorPayload(result.errorCode, result.writeOutcome === 'unknown'
          ? 'The write may have taken effect. Read state before deciding what to do; do not automatically retry.'
          : 'The host did not apply this change. Check access and project state before making a new request.',
        { writeOutcome: result.writeOutcome });
      } catch {
        // Never expose raw exceptions (which can contain paths, SQL or credentials).
        return unknown();
      }
    },
  });
}
