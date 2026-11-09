import type { EntityProjectMutationCallback, EntityProjectMutationResult } from '@cindy/mcps';
import { captureTaskActionGuard, captureTaskActionSyncGuard } from '../maker-ipc/taskActionAuthorization';
import { mutateProjects } from '../localDb/ipc/projects';
import { captureEntityProjectAuthority, type EntityProjectRuntime } from './entityProjectAuthority';

type PublicCode = Extract<EntityProjectMutationResult, { ok: false }>['errorCode'];
const codes: Readonly<Record<string, PublicCode>> = {
  INVALID_PARAMS: 'INVALID_PARAMS', NOT_FOUND: 'NOT_FOUND',
  NOT_PROJECT_MEMBER: 'NOT_PROJECT_MEMBER', NOT_PROJECT_OWNER: 'NOT_PROJECT_OWNER',
  PRECONDITION_FAILED: 'PRECONDITION_FAILED', FORBIDDEN: 'PERMISSION_DENIED',
  MUST_TRANSFER_OWNER_FIRST: 'PRECONDITION_FAILED', ASSIGNEE_NOT_MEMBER: 'PRECONDITION_FAILED',
  PROJECT_TASK_UNBOUND: 'PRECONDITION_FAILED', PERMISSION_DENIED: 'PERMISSION_DENIED',
  TASK_ACTION_SOURCE_UNAUTHORIZED: 'PERMISSION_DENIED',
  GROUP_AUTHORIZATION_REQUIRED: 'PERMISSION_DENIED',
  GROUP_AUTHORIZATION_UNAVAILABLE: 'UNAVAILABLE', HOST_NOT_READY: 'UNAVAILABLE',
  OWNER_SCOPE_CHANGED: 'UNAVAILABLE', TASK_UNAVAILABLE: 'UNAVAILABLE',
  TASK_ACTION_AUTHORIZATION_EXPIRED: 'UNAVAILABLE', BOT_SESSION_INACTIVE: 'UNAVAILABLE',
  UNSUPPORTED_CAPABILITY: 'UNAVAILABLE', CANCELLED: 'CANCELLED',
};

/** Caller is supplied by the bound public MCP server. Actor and captured DB always
 * come from authority; create.owner remains business data. Runtime tool permission
 * review stays at the existing Host entry, not a new role/scope policy here.
 */
export function createEntityProjectMutation(runtime: EntityProjectRuntime): EntityProjectMutationCallback {
  return async ({ callerSessionId, intent }) => {
    const permissionGuard = captureTaskActionGuard();
    const permissionSyncGuard = captureTaskActionSyncGuard();
    let dispatched = false;
    let notificationFailed = false;
    try {
      const authority = await captureEntityProjectAuthority(callerSessionId, runtime);
      const result = await mutateProjects(intent, authority.actor, authority.client, {
        beforeDispatch: async () => { await permissionGuard?.(); await authority.refresh(); },
        dispatching: () => {
          // Synchronous after the final await, immediately before capturedClient.tx.
          authority.assertCurrent();
          permissionSyncGuard?.();
          dispatched = true;
        },
        notificationFailed: () => { notificationFailed = true; },
      });
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
      // Never return exception text, SQL, paths or arbitrary codes. After dispatch
      // even a recognizable error may be a lost post-commit receipt; never retry.
      return { ok: false, errorCode: code && Object.hasOwn(codes, code) ? codes[code] : 'INTERNAL',
        writeOutcome: dispatched ? 'unknown' : 'not-applied' };
    }
  };
}
