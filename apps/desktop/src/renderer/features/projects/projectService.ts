/**
 * 项目内核 v1（M1）renderer 侧 IPC 封装。
 *
 * 规则全部在 main 强制；这里只负责把 IPC 错误转成统一的 ApiError，
 * 让 UI 能用 code 说清「为什么被拒」（转交负责人 / 非成员 / 未绑定）。
 */
import type {
  ProjectCreateInput,
  ProjectDetail,
  ProjectRecord,
  ProjectSubjectRef,
  ProjectsAction,
} from '../../../shared/projects';
import { ApiError } from '@/lib/httpClient';
import { extractIpcError } from '@/utils/ipcError';

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((err: unknown) => {
    const ipcError = extractIpcError(err);
    if (ipcError) {
      throw new ApiError(ipcError.code, 0, ipcError.message);
    }
    if (err instanceof Error) {
      throw new ApiError('UNKNOWN', 0, err.message);
    }
    throw new ApiError('UNKNOWN', 0, String(err));
  });
}

export async function listProjects(): Promise<ProjectRecord[]> {
  return wrap(window.electronAPI.localDb.projects.list());
}

export async function readProjectDetail(projectId: string): Promise<ProjectDetail> {
  return wrap(window.electronAPI.localDb.projects.detail(projectId));
}

export async function createProject(input: ProjectCreateInput): Promise<void> {
  await mutateProject({ action: 'create', input });
}

export async function renameProject(
  projectId: string,
  patch: { name?: string; goal?: string | null; status?: 'active' | 'archived' },
): Promise<void> {
  await mutateProject({ action: 'update', projectId, ...patch });
}

export async function addProjectMember(
  projectId: string,
  subject: ProjectSubjectRef,
): Promise<void> {
  await mutateProject({ action: 'addMember', projectId, subject });
}

export async function removeProjectMember(
  projectId: string,
  subject: ProjectSubjectRef,
): Promise<void> {
  await mutateProject({ action: 'removeMember', projectId, subject });
}

export async function transferProjectOwner(
  projectId: string,
  subject: ProjectSubjectRef,
): Promise<void> {
  await mutateProject({ action: 'transferOwner', projectId, subject });
}

/** 真删除。二次确认由调用方界面负责，这里只发一次请求。 */
export async function deleteProject(projectId: string): Promise<void> {
  await mutateProject({ action: 'delete', projectId });
}

export async function bindSessionProject(
  sessionId: string,
  projectId: string | null,
): Promise<void> {
  await mutateProject({ action: 'bindSession', sessionId, projectId });
}

export async function setSessionAssignee(
  sessionId: string,
  assignee: ProjectSubjectRef | null,
): Promise<void> {
  await mutateProject({ action: 'setAssignee', sessionId, assignee });
}

/** `newId` / `now` are filled in by main; the renderer only shapes the action. */
async function mutateProject(mutation: ProjectsAction): Promise<void> {
  await wrap(window.electronAPI.localDb.projects.mutate(mutation));
}

export function onProjectsChanged(cb: () => void): () => void {
  return window.electronAPI.localDb.projects.onChanged(cb);
}
