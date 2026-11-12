import type { EntityProjectMutationCallback, EntityProjectMutationResult } from '@cindy/mcps';
import { captureTaskActionGuard, captureTaskActionSyncGuard } from '../maker-ipc/taskActionAuthorization';
import { mutateProjects, broadcastProjectsChanged } from '../localDb/ipc/projects';
import { captureDataOwnerBroadcastScope } from '../device-link/broadcast-tap';
import { captureEntityProjectAuthority, type EntityProjectRuntime } from './entityProjectAuthority';

type PublicCode = Extract<EntityProjectMutationResult, { ok: false }>['errorCode'];
const codes: Readonly<Record<string, PublicCode>> = {
  INVALID_PARAMS: 'INVALID_PARAMS', NOT_FOUND: 'NOT_FOUND',
  NOT_PROJECT_MEMBER: 'NOT_PROJECT_MEMBER', NOT_PROJECT_OWNER: 'NOT_PROJECT_OWNER',
  PRECONDITION_FAILED: 'PRECONDITION_FAILED', FORBIDDEN: 'PERMISSION_DENIED',
  // Same caller-supplied sessionId with a different title/objective/assignee: refused before any insert.
  ALREADY_EXISTS: 'PRECONDITION_FAILED',
  MUST_TRANSFER_OWNER_FIRST: 'PRECONDITION_FAILED', ASSIGNEE_NOT_MEMBER: 'PRECONDITION_FAILED',
  PROJECT_TASK_UNBOUND: 'PRECONDITION_FAILED', PERMISSION_DENIED: 'PERMISSION_DENIED',
  TASK_ACTION_SOURCE_UNAUTHORIZED: 'PERMISSION_DENIED',
  GROUP_AUTHORIZATION_REQUIRED: 'PERMISSION_DENIED',
  GROUP_AUTHORIZATION_UNAVAILABLE: 'UNAVAILABLE', HOST_NOT_READY: 'UNAVAILABLE',
  OWNER_SCOPE_CHANGED: 'UNAVAILABLE', TASK_UNAVAILABLE: 'UNAVAILABLE',
  TASK_ACTION_AUTHORIZATION_EXPIRED: 'UNAVAILABLE', BOT_SESSION_INACTIVE: 'UNAVAILABLE',
  UNSUPPORTED_CAPABILITY: 'UNAVAILABLE', CANCELLED: 'CANCELLED',
  PROJECT_MISMATCH: 'PRECONDITION_FAILED', SESSION_DELETED: 'PRECONDITION_FAILED',
  BINDING_CONFLICT: 'PRECONDITION_FAILED', REVISION_CONFLICT: 'PRECONDITION_FAILED', REQUEST_CONFLICT: 'PRECONDITION_FAILED',
  REASON_REQUIRED: 'PRECONDITION_FAILED', UNBLOCK_CONDITION_REQUIRED: 'PRECONDITION_FAILED',
  RESOLUTION_REQUIRED: 'PRECONDITION_FAILED', COMPLETION_NOTE_REQUIRED: 'PRECONDITION_FAILED', ILLEGAL_TRANSITION: 'PRECONDITION_FAILED',
};

/** Business rejections `workItemProgress.execute` raises before it inserts anything.
 * For these the write provably did not happen, so they must not be reported as
 * `unknown`: a model told "maybe written, read first" for a stale revision or a
 * missing completion note pays an extra round trip for a deterministic refusal.
 * Transport, database and post-write authority failures stay `unknown`.
 */
const progressRejections: ReadonlySet<string> = new Set([
  'INVALID_PARAMS', 'NOT_FOUND', 'FORBIDDEN', 'PERMISSION_DENIED',
  'NOT_PROJECT_MEMBER', 'NOT_PROJECT_OWNER', 'PRECONDITION_FAILED',
  'PROJECT_MISMATCH', 'SESSION_DELETED', 'BINDING_CONFLICT', 'REVISION_CONFLICT', 'REQUEST_CONFLICT',
  'ILLEGAL_TRANSITION', 'REASON_REQUIRED', 'UNBLOCK_CONDITION_REQUIRED', 'RESOLUTION_REQUIRED',
  'COMPLETION_NOTE_REQUIRED',
]);

/** Caller is supplied by the bound public MCP server. Actor and captured DB always
 * come from authority; create.owner remains business data. Runtime tool permission
 * review stays at the existing Host entry, not a new role/scope policy here.
 */
export function createEntityProjectMutation(runtime: EntityProjectRuntime): EntityProjectMutationCallback {
  return async ({ callerSessionId, intent }) => {
    const permissionGuard = captureTaskActionGuard();
    const permissionSyncGuard = captureTaskActionSyncGuard();
    // Which phase failed decides whether a failure may be called "not applied": only a
    // transaction-phase refusal provably wrote nothing. Anything after it is unknown.
    let stage: 'pre' | 'tx' | 'post' = 'pre';
    let notificationFailed = false;
    try {
      const authority = await captureEntityProjectAuthority(callerSessionId, runtime);
      if (intent.action === 'recordProgress') {
        const scope = captureDataOwnerBroadcastScope();
        await permissionGuard?.();
        await authority.refresh();
        authority.assertCurrent();
        permissionSyncGuard?.();
        const { action: _action, ...progressIntent } = intent;
        stage = 'tx';
        const progress = await authority.client.tx('workItemProgress.execute', {
          intent: progressIntent, context: { actor: authority.actor, now: Date.now() },
        });
        stage = 'post';
        // The event is committed. Announce it first, the way the UI progress path does
        // (localDb/ipc/projectProgress.ts): a window or relay failure must neither fail
        // the write nor replace the receipt the caller needs for its requestId.
        try { broadcastProjectsChanged(scope); } catch { /* Invalidation only; reload covers a closed window. */ }
        await permissionGuard?.();
        await authority.refresh();
        authority.assertCurrent();
        permissionSyncGuard?.();
        return { ok: true, projectId: intent.projectId, sessionId: intent.sessionId,
          progressReceipt: { eventId: progress.eventId, revision: progress.revision, replayed: progress.replayed } };
      }
      const result = await mutateProjects(intent, authority.actor, authority.client, {
        beforeDispatch: async () => { await permissionGuard?.(); await authority.refresh(); },
        dispatching: () => {
          // Synchronous after the final await, immediately before capturedClient.tx.
          authority.assertCurrent();
          permissionSyncGuard?.();
          stage = 'tx';
        },
        notificationFailed: () => { notificationFailed = true; },
      });
      stage = 'post';
      // Do not require post-write membership: a completed transfer/removal is not
      // undone merely because the caller can no longer read project contents.
      await permissionGuard?.();
      await authority.refresh();
      authority.assertCurrent();
      permissionSyncGuard?.();
      if (notificationFailed) return { ok: false, errorCode: 'INTERNAL', writeOutcome: 'unknown' };
      return { ok: true, projectId: result.projectId, sessionId: result.sessionId };
    } catch (error) {
      const supplied = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const code = typeof supplied === 'string' ? supplied
        : error instanceof Error ? /^\[([A-Z_]+)\]/.exec(error.message)?.[1] : undefined;
      // Never return exception text, SQL, paths or arbitrary codes. A refusal the transaction
      // raises before writing (recordProgress business rejections, createWorkItem collision)
      // is reported as not-applied; anything after dispatch stays unknown so nobody
      // silently re-sends an already committed write.
      const refusedInTransaction = stage === 'tx' && code !== undefined
        && (intent.action === 'recordProgress' ? progressRejections.has(code)
          : intent.action === 'createWorkItem' && code === 'ALREADY_EXISTS');
      return { ok: false, errorCode: code && Object.hasOwn(codes, code) ? codes[code] : 'INTERNAL',
        writeOutcome: refusedInTransaction || stage === 'pre' ? 'not-applied' : 'unknown' };
    }
  };
}
