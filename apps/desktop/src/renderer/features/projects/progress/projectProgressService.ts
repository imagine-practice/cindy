import type { WorkItemProgressIntent, WorkItemProgressResult } from '../../../../shared/workItemProgress';
import type { ProjectProgressReadRequest, ProjectProgressReadResult } from '../../../../shared/projectProgressApi';
import type {
  ProjectWorkItemExecutionReadRequest,
  ProjectWorkItemExecutionReadResult,
  ProjectWorkItemExecutionRequestIntent,
  ProjectWorkItemExecutionRequestResult,
  ProjectWorkItemFollowupIntent,
  ProjectWorkItemFollowupResult,
} from '../../../../shared/projectWorkItemExecutionRequest';
import { ApiError } from '@/lib/httpClient';
import { extractIpcError } from '@/utils/ipcError';

export async function readProjectProgress(request: ProjectProgressReadRequest): Promise<ProjectProgressReadResult> {
  try { return await window.electronAPI.localDb.projectProgress.read(request); }
  catch (error) {
    const ipc = extractIpcError(error);
    throw new ApiError(ipc?.code ?? 'UNKNOWN', 0, ipc?.message ?? 'Project progress unavailable');
  }
}

export async function updateProjectProgress(intent: WorkItemProgressIntent): Promise<WorkItemProgressResult> {
  try { return await window.electronAPI.localDb.projectProgress.update(intent); }
  catch (error) {
    const ipc = extractIpcError(error);
    throw new ApiError(ipc?.code ?? 'UNKNOWN', 0, ipc?.message ?? 'Project progress outcome unknown');
  }
}

/** Executor/state projection for the 「请该伙伴执行」 entry; read-only, main decides everything. */
export async function readProjectWorkItemExecution(
  request: ProjectWorkItemExecutionReadRequest,
): Promise<ProjectWorkItemExecutionReadResult> {
  try { return await window.electronAPI.localDb.projectExecution.read(request); }
  catch (error) {
    const ipc = extractIpcError(error);
    throw new ApiError(ipc?.code ?? 'UNKNOWN', 0, ipc?.message ?? 'Project execution state unavailable');
  }
}

/** Delivery intent only: no executor, request key or caller identity comes from the renderer. */
export async function requestProjectWorkItemExecution(
  intent: ProjectWorkItemExecutionRequestIntent,
): Promise<ProjectWorkItemExecutionRequestResult> {
  try { return await window.electronAPI.localDb.projectExecution.request(intent); }
  catch (error) {
    const ipc = extractIpcError(error);
    throw new ApiError(ipc?.code ?? 'UNKNOWN', 0, ipc?.message ?? 'Project execution outcome unknown');
  }
}

/**
 * 执行后续（继续 / 批准 / 排队 / 换模型）。同样只传动作：执行者、幂等键、
 * 待确认项与模型合法性全由 main 现读真实行后自己判定。
 */
export async function requestProjectWorkItemFollowup(
  intent: ProjectWorkItemFollowupIntent,
): Promise<ProjectWorkItemFollowupResult> {
  try { return await window.electronAPI.localDb.projectExecution.followup(intent); }
  catch (error) {
    const ipc = extractIpcError(error);
    throw new ApiError(ipc?.code ?? 'UNKNOWN', 0, ipc?.message ?? 'Project follow-up outcome unknown');
  }
}
