import type { ControlResult, EntityProjectCallbacks } from '@cindy/mcps';
import { listProjects, readProjectDetail } from '../localDb/ipc/projects';
import type { ProjectProgressReadResult } from '../../shared/projectProgressApi';
import { captureEntityProjectAuthority, EntityProjectAccessError, type EntityProjectRuntime } from './entityProjectAuthority';

/** Desktop local-only adapter. Never call S's account-default progress wrapper for a
 * teammate principal. All reads use the captured client and an explicit trusted actor.
 */
export function createEntityProjectManagement(runtime: EntityProjectRuntime): EntityProjectCallbacks {
  async function run<T extends object>(id: string, operation: (authority: Awaited<ReturnType<typeof captureEntityProjectAuthority>>) =>
    Promise<{ value: T; projectIds: string[] }>): Promise<ControlResult<T, string>> {
    try {
      const authority = await captureEntityProjectAuthority(id, runtime);
      const { value, projectIds } = await operation(authority);
      await authority.refresh(projectIds);
      authority.assertCurrent();
      return { ok: true, ...value };
    } catch (error) {
      // Storage errors can contain SQL/user data. Only a fixed code and generic text leave main.
      const supplied = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const bracket = error instanceof Error ? /^\[([A-Z_]+)\]/.exec(error.message)?.[1] : undefined;
      const allowed = new Set(['HOST_NOT_READY','OWNER_SCOPE_CHANGED','TASK_UNAVAILABLE','TASK_ACTION_SOURCE_UNAUTHORIZED',
        'TASK_ACTION_AUTHORIZATION_EXPIRED','BOT_SESSION_INACTIVE','UNSUPPORTED_CAPABILITY','NOT_PROJECT_MEMBER',
        'NOT_FOUND','FORBIDDEN','INVALID_PARAMS','GROUP_AUTHORIZATION_REQUIRED','GROUP_AUTHORIZATION_UNAVAILABLE']);
      const code = error instanceof EntityProjectAccessError ? error.code :
        typeof supplied === 'string' && allowed.has(supplied) ? supplied : bracket && allowed.has(bracket) ? bracket : 'INTERNAL';
      return { ok: false, errorCode: code, message: 'Entity project read unavailable or access changed.' };
    }
  }
  return {
    list: ({ callerSessionId }) => run(callerSessionId, async authority => {
      const projects = await listProjects(authority.actor, authority.client);
      return { value: { projects }, projectIds: projects.map(project => project.id) };
    }),
    detail: ({ callerSessionId, projectId }) => run(callerSessionId, async authority => ({
      value: await readProjectDetail(projectId, authority.actor, authority.client), projectIds: [projectId],
    })),
    progress: ({ callerSessionId, projectId, beforeEventId }) => run(callerSessionId, async authority => ({
      value: await authority.client.tx<ProjectProgressReadResult>('projectProgress.read', {
        request: { projectId, ...(beforeEventId === undefined ? {} : { beforeEventId }) }, context: { actor: authority.actor },
      }), projectIds: [projectId],
    })),
  };
}
