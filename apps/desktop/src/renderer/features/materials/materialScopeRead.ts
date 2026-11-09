import { ApiError } from '@/lib/httpClient';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import type {
  ProjectProgressReadRequest,
  ProjectProgressReadResult,
} from '../../../shared/projectProgressApi';
import type { MaterialScope } from '../../../shared/materials';

/** Uses S's actual read entry. A missing host/token is an error, never an inferred epoch zero. */
export async function readMaterialTaskScope(
  projectId: string,
  sessionId: string,
): Promise<{
  scope: MaterialScope & { workItemId: string };
  title: string;
  canWrite: boolean;
}> {
  const owner = getDataOwnerGeneration();
  const read = (
    window as unknown as {
      electronAPI?: {
        localDb?: {
          projectProgress?: {
            read(input: ProjectProgressReadRequest): Promise<ProjectProgressReadResult>;
          };
        };
      };
    }
  ).electronAPI?.localDb?.projectProgress;
  if (!read || typeof read.read !== 'function')
    throw new ApiError('PRECONDITION_FAILED', 0, 'Progress read host is unavailable');
  const result = await read.read({ projectId });
  if (!isDataOwnerGenerationCurrent(owner))
    throw new ApiError('PRECONDITION_FAILED', 0, 'Read scope expired');
  if (
    !result ||
    result.projectId !== projectId ||
    !Array.isArray(result.items) ||
    typeof result.capabilities?.canRecord !== 'boolean'
  )
    throw new ApiError('REFERENCE_SCOPE_REQUIRED', 0, 'Invalid progress read response');
  const items = result.items.filter((item) => item.sessionId === sessionId);
  const item = items[0];
  if (items.length !== 1 || item.projectId !== projectId || item.sessionStatus === 'deleted') {
    throw new ApiError('PROJECT_NOT_FOUND', 0, 'Work item is not available in this project');
  }
  if (
    typeof item.bindingRevision !== 'number' ||
    !Number.isSafeInteger(item.bindingRevision) ||
    item.bindingRevision < 0 ||
    typeof item.title !== 'string'
  )
    throw new ApiError('REFERENCE_SCOPE_REQUIRED', 0, 'Binding token is missing');
  if (!result.capabilities.canRecord)
    throw new ApiError('FORBIDDEN', 0, 'Work item is not writable');
  return {
    scope: { projectId, workItemId: sessionId, bindingRevision: item.bindingRevision },
    title: item.title,
    canWrite: true,
  };
}
