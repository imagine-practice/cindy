import { BrowserWindow, ipcMain } from 'electron';
import type { ProjectProgressReadRequest, ProjectProgressReadResult } from '../../../shared/projectProgressApi';
import type { WorkItemProgressIntent, WorkItemProgressResult } from '../../../shared/workItemProgress';
import { PROJECTS_CHANGED_CHANNEL } from '../../../shared/projects';
import { isIpcErrorCode } from '../../../shared/ipc-errors';
import { getCurrentDbClientSnapshot } from '../client/current';
import { assertTrustedAppRendererEvent, isTrustedAppRendererWindow } from '../../security/trustedAppRenderer';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent, tapWindowBroadcast } from '../../device-link/broadcast-tap';
import { throwIpcError } from '../../utils/ipcValidate';

function captureAuthority() {
  const owner = getCurrentDbClientSnapshot();
  if (!owner || !owner.userId) throwIpcError('PRECONDITION_FAILED', 'Project progress owner unavailable');
  const scope = captureDataOwnerBroadcastScope();
  const assertCurrent = () => {
    if (getCurrentDbClientSnapshot() !== owner || !isDataOwnerBroadcastScopeCurrent(scope)) {
      throwIpcError('PRECONDITION_FAILED', 'Project progress owner changed');
    }
  };
  assertCurrent();
  return { client: owner.client, actor: { kind: 'account' as const, id: owner.userId }, scope, assertCurrent };
}

/** Only fixed error codes cross IPC; unknown storage errors cannot expose user content. */
async function progressResult<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const supplied = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const code = isIpcErrorCode(supplied) ? supplied
      : error instanceof Error ? /^\[([A-Z_]+)\]/.exec(error.message)?.[1] : undefined;
    throwIpcError(isIpcErrorCode(code) ? code : 'INTERNAL', 'Project progress request rejected');
  }
}

export async function readProjectProgress(request: ProjectProgressReadRequest): Promise<ProjectProgressReadResult> {
  const authority = captureAuthority();
  const result = await progressResult(() => authority.client.tx('projectProgress.read', {
    request, context: { actor: authority.actor },
  }));
  authority.assertCurrent();
  return result;
}

export async function updateProjectProgress(intent: WorkItemProgressIntent): Promise<WorkItemProgressResult> {
  const authority = captureAuthority();
  const result = await progressResult(() => authority.client.tx('workItemProgress.execute', {
    intent, context: { actor: authority.actor, now: Date.now() },
  }));
  authority.assertCurrent();
  // This is an invalidation only. Window/relay failure must not fail an already committed write.
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        if (isTrustedAppRendererWindow(window)) window.webContents.send(PROJECTS_CHANGED_CHANNEL, {}, authority.scope.ownerStamp);
      } catch { /* A closed or navigated window is no longer a recipient. */ }
    }
  } catch { /* Window enumeration can race shutdown. */ }
  try { tapWindowBroadcast(PROJECTS_CHANGED_CHANNEL, {}, authority.scope.ownerStamp); }
  catch { /* Consumers can reload; preserve the committed result. */ }
  return result;
}

export function registerProjectProgressIpc(): void {
  ipcMain.handle('local-db:project-progress:read', async (event, request: ProjectProgressReadRequest) => {
    assertTrustedAppRendererEvent(event);
    return readProjectProgress(request);
  });
  ipcMain.handle('local-db:project-progress:update', async (event, intent: WorkItemProgressIntent) => {
    assertTrustedAppRendererEvent(event);
    return updateProjectProgress(intent);
  });
}
