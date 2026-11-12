import { z } from 'zod';
import type { LiziMcpSessionContext } from '../types.js';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

// Independent wire contract: never import desktop runtime or infer an actor here.
const id = z.string().trim().min(1).max(200).refine(
  value => !/[\\/]/.test(value) && !value.includes('::') && !/^[A-Za-z]:/.test(value),
  'Use a stable local ID, not a directory path or remote identifier.',
);
const subject = z.strictObject({ kind: z.enum(['account', 'bot']), id: z.string().trim().min(1) });
const name = z.string().trim().min(1).max(120);
const goal = z.string().max(2000).nullable();
// The transaction stores these as 4000-character text; reject longer input here instead of
// letting the write fail inside the worker, where it would look like an unknown outcome.
const note = z.string().max(4000).nullable().optional();
// `expectedUpdatedAt` is both an equality observation and a wire value, so it must round-trip
// through Date exactly: the IPC layer compares `new Date(Date.parse(v)).toISOString() === v`.
const observedIso = z.string().refine(value => {
  const stamp = Date.parse(value);
  return Number.isSafeInteger(stamp) && new Date(stamp).toISOString() === value;
}, 'Copy workItem.updatedAt exactly as returned (canonical ISO 8601).');
const intentSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('recordProgress'), projectId: id, sessionId: id,
    expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expectedBindingRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), requestId: id,
    to: z.enum(['todo', 'doing', 'blocked', 'review', 'done']), reason: note,
    unblockCondition: note, resolution: note, completionNote: note }),
  z.strictObject({ action: z.literal('updateWorkItem'), projectId: id, sessionId: id,
    expectedBindingRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expectedUpdatedAt: observedIso, title: name.optional(),
    taskObjective: z.string().trim().min(1).max(2000).optional() }),
  z.strictObject({ action: z.literal('createWorkItem'), projectId: id,
    sessionId: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/), title: name,
    taskObjective: z.string().trim().min(1).max(2000), assignee: subject.nullable() }),
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
  z.object({ ok: z.literal(true), projectId: id.nullable(), sessionId: id.nullable(),
    progressReceipt: z.object({ eventId: z.number().int().positive(), revision: z.number().int().nonnegative(), replayed: z.boolean() }).optional() }),
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
    description: 'recordProgress writes an explicit requested business progress update on the same project/session using the existing progress transaction. First read get_project_progress; copy expectedRevision and expectedBindingRevision (when progress is null, expectedRevision is 0 and expectedBindingRevision comes from the item). A deterministic refusal (stale revision, illegal transition, missing reason/completion note, not a member, not the owner for done) means nothing was written: correct the input and call again. Only a lost receipt after a committed write is unknown: keep the same requestId, read the state, and let the replay return that requestId\'s receipt. Returns progressReceipt eventId/revision/replayed only on confirmed commit. Do not infer updates from ordinary discussion, model exit or archive. Completion requires an authorized project owner and completionNote; group membership alone grants no project permission. No automatic group messages. Modify a local entity project with exactly one action: create, update (including archive), addMember, removeMember, transferOwner, bindSession, setAssignee, createWorkItem or updateWorkItem. updateWorkItem supplements title and/or taskObjective on the same existing task; first read get_project_entity and copy workItem.updatedAt exactly into expectedUpdatedAt and workItem.bindingRevision into expectedBindingRevision. Hosts missing either observation cannot safely supplement. A stale edit is refused: reread before deciding, never overwrite automatically. This does not change business progress or assignee; use setAssignee separately for an explicit assignment. createWorkItem saves a normal unsent task with its title, taskObjective and assignee in the project. Supply one stable sessionId for creation; a reused sessionId with different content is refused as a conflict (nothing written), while an uncertain outcome keeps the same id and reads the project to recover. projectId is an entity ID; sessionId is a Cindy task ID, never a directory. create.input.owner is business data, not caller identity. Members use stable kind/id. Null clears binding/assignee. Does not dispatch tasks, send messages or call models. Host checks live permissions, including group-source authority and project membership.',
    handler: async ({ intent }) => {
      const context = deps.getSessionContext();
      if (!context?.sessionId?.trim()) return errorPayload('NO_SESSION_CONTEXT', 'No trusted Cindy task context is available.', { writeOutcome: 'not-applied' });
      if (context.remoteHostId || context.vendorOptions?.orcaRemoteLead) return errorPayload('UNSUPPORTED_CAPABILITY', 'Entity project writes are not connected for this remote execution context.', { writeOutcome: 'not-applied' });
      try {
        const parsed = resultSchema.safeParse(await deps.mutate({ callerSessionId: context.sessionId, intent }));
        if (!parsed.success) return unknown();
        const result = parsed.data;
        if (result.ok && intent.action === 'recordProgress' &&
          (!result.progressReceipt || result.projectId !== intent.projectId || result.sessionId !== intent.sessionId)) return unknown();
        if (result.ok) return okPayload({ projectId: result.projectId, sessionId: result.sessionId,
          ...(result.progressReceipt ? { progressReceipt: result.progressReceipt } : {}) });
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
