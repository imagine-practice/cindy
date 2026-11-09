import type { BotDelegationService } from './botDelegationService';
import { createProjectWorkItemExecutionService } from './projectWorkItemExecutionService';
import { captureEntityProjectAuthority, EntityProjectAccessError, type EntityProjectRuntime } from '../mcp-integrations/entityProjectAuthority';
import { getCurrentDbClientSnapshot } from '../localDb/client/current';
import type { ProjectWorkItemStartInput } from '../../shared/projectWorkItemExecution';

/** Main-only factory. Caller is bound by the existing MCP/host invocation, never
 * taken from model intent. No historical group message creates an execution lease.
 */
export function createProjectWorkItemHost(deps: {
  callerSessionId: string;
  runtime: EntityProjectRuntime;
  delegation: BotDelegationService;
}) {
  const { callerSessionId, runtime, delegation } = deps;
  const denied = (code: string) => ({ ok: false as const, errorCode: code, message: 'Project work-item access rejected' });
  return {
    // Explicit main callers must supply the real pause source. No public start tool
    // is installed by this factory; it cannot invent a native input for UI clicks.
    start(intent: Omit<ProjectWorkItemStartInput, 'callerSessionId'>, isExecutionPaused: (id: string) => boolean) {
      return createProjectWorkItemExecutionService({ delegation, now: Date.now,
        runtime: { input: id => runtime.input(id), getSession: id => runtime.getSession(id), callerSessionId: () => callerSessionId, isExecutionPaused },
      }).start({ ...intent, callerSessionId });
    },
    async get(taskId: string, queuedMessageId?: string) {
      try {
        const snapshot = getCurrentDbClientSnapshot();
        if (!snapshot) return denied('HOST_NOT_READY');
        let row = await snapshot.client.queryOne<{ snapshot: string; childId: string | null }>(
          'SELECT permission_snapshot_json AS snapshot, child_session_id AS childId FROM bot_delegations WHERE id=?', [taskId]);
        if (getCurrentDbClientSnapshot() !== snapshot) return denied('OWNER_SCOPE_CHANGED');
        if (!row) {
          // An ACK can be lost before the delegation ID reaches the caller. The
          // original project Session ID remains a read-only recovery locator.
          const candidates = await snapshot.client.query<{ id: string; snapshot: string; childId: string | null }>(
            'SELECT id,permission_snapshot_json AS snapshot,child_session_id AS childId FROM bot_delegations WHERE child_session_id=?', [taskId]);
          if (getCurrentDbClientSnapshot() !== snapshot) return denied('OWNER_SCOPE_CHANGED');
          const projects = candidates.filter(value => {
            const plan: unknown = JSON.parse(value.snapshot);
            return !!plan && typeof plan === 'object' && 'projectWorkItemExecution' in plan && !!plan.projectWorkItemExecution;
          });
          if (projects.length > 1) return denied('TASK_UNAVAILABLE');
          if (!projects.length) return delegation.getSessionTask(callerSessionId, taskId, queuedMessageId);
          row = projects[0]; taskId = projects[0].id;
        }
        const plan: unknown = JSON.parse(row.snapshot);
        const scope: unknown = plan && typeof plan === 'object' && 'projectWorkItemExecution' in plan ? plan.projectWorkItemExecution : null;
        // Keep ordinary task lookup and its existing ownership rules unchanged.
        if (!scope) return delegation.getSessionTask(callerSessionId, taskId, queuedMessageId);
        if (typeof scope !== 'object' || !('version' in scope) || scope.version !== 1 ||
          !('projectId' in scope) || typeof scope.projectId !== 'string' ||
          !('sessionId' in scope) || typeof scope.sessionId !== 'string' || scope.sessionId !== row?.childId ||
          !('bindingRevision' in scope) || typeof scope.bindingRevision !== 'number' || !Number.isSafeInteger(scope.bindingRevision)) {
          return denied('BINDING_CONFLICT');
        }
        const { projectId, sessionId, bindingRevision } = scope;
        const authority = await captureEntityProjectAuthority(callerSessionId, runtime);
        if (authority.client !== snapshot.client) return denied('OWNER_SCOPE_CHANGED');
        const guard = async () => {
          await authority.refresh([projectId]);
          const current = await authority.client.queryOne<{ projectId: string; revision: number; snapshot: string; status: string }>(
            `SELECT s.project_id AS projectId,s.project_binding_revision AS revision,d.permission_snapshot_json AS snapshot,s.status
             FROM bot_delegations d JOIN sessions s ON s.id=d.child_session_id WHERE d.id=? AND s.id=?`, [taskId, sessionId]);
          authority.assertCurrent();
          if (!current || current.status === 'deleted' || current.projectId !== projectId || current.revision !== bindingRevision || current.snapshot !== row.snapshot) {
            throw new EntityProjectAccessError('BINDING_CONFLICT');
          }
          await authority.refresh([projectId]);
          authority.assertCurrent();
        };
        await guard();
        const result = await delegation.getSessionTask(callerSessionId, taskId, queuedMessageId, guard);
        await guard();
        return result;
      } catch (error) {
        return denied(error instanceof EntityProjectAccessError ? error.code : 'TASK_UNAVAILABLE');
      }
    },
  };
}
