import type { ProjectsAction } from '../../../shared/projects';

export type PendingProjectTask = Extract<ProjectsAction, { action: 'createWorkItem' }>;

// Chromium storage belongs to the current application profile. Account and project
// are both part of the key; never restore another account's pending task metadata.
export function pendingProjectTaskKey(ownerId: string | null | undefined, projectId: string): string {
  if (!ownerId) throw new Error('No current data owner');
  return `cindy.projects.pendingCreate.v1.${JSON.stringify([ownerId, projectId])}`;
}

export function readPendingProjectTask(key: string, projectId: string): PendingProjectTask | null {
  // Each request owns a record, so another window cannot overwrite an uncertain
  // request for this project. Resolve outstanding records before making a new one.
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    .filter((entry): entry is string => entry !== null && entry.startsWith(`${key}.`)).sort();
  const selectedKey = keys[0];
  const raw = selectedKey ? localStorage.getItem(selectedKey) : null;
  if (raw === null) return null;
  const value = JSON.parse(raw) as PendingProjectTask;
  if (!value || value.action !== 'createWorkItem' || value.projectId !== projectId
    || selectedKey !== `${key}.${value.sessionId}`
    || typeof value.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value.sessionId)
    || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 120
    || typeof value.taskObjective !== 'string' || !value.taskObjective.trim() || value.taskObjective.length > 2000
    || (value.assignee !== null && (!value.assignee || !['account', 'bot'].includes(value.assignee.kind)
      || typeof value.assignee.id !== 'string' || !value.assignee.id || value.assignee.id.length > 200))) {
    throw new Error('Invalid pending creation');
  }
  // Rebuild the intent; never pass arbitrary storage fields (identity/SQL) to IPC.
  return { action: 'createWorkItem', projectId, sessionId: value.sessionId, title: value.title,
    taskObjective: value.taskObjective, assignee: value.assignee
      ? { kind: value.assignee.kind, id: value.assignee.id } : null };
}
