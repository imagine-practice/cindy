import type Database from 'better-sqlite3';

export interface ProjectMembershipRecoverySnapshot {
  project: { id: string; name: string; ownerId: string; status: string; createdAt: number };
  members: Array<{ kind: string; id: string; role: string; addedAt: number }>;
  tasks: Array<{ id: string; assigneeKind: string | null; assigneeId: string | null; status: string }>;
}
export type ProjectMembershipRecoveryRequest =
  | { action: 'inspect'; projectId: string }
  | { action: 'repair'; projectId: string; verifiedOwnerId: string; expected: ProjectMembershipRecoverySnapshot };
export type ProjectMembershipRecoveryResult =
  | { snapshot: ProjectMembershipRecoverySnapshot }
  | { status: 'repaired' | 'already-repaired' };

/** Main-only maintenance operation, never a normal project permission exception.
 * Self-contained for the legacy inline worker. Main must prove local adoption,
 * verify the current account/client generation, confirm, and verify a backup.
 * The transaction independently limits the write to one legacy member identity.
 */
export function runProjectMembershipRecoveryTransaction(
  db: Database.Database, raw: ProjectMembershipRecoveryRequest,
): ProjectMembershipRecoveryResult {
  const fail = (): never => { throw Object.assign(new Error('Project recovery precondition failed'), { code: 'PRECONDITION_FAILED' }); };
  const id = (value: unknown): string => {
    if (typeof value !== 'string' || !value || value.length > 200 || /[\\/]/.test(value) || value.includes('::')) return fail();
    return value;
  };
  if (!raw || (raw.action !== 'inspect' && raw.action !== 'repair')) return fail();
  const projectId = id(raw.projectId);
  return db.transaction((): ProjectMembershipRecoveryResult => {
    const project = db.prepare('SELECT id,name,owner_id AS ownerId,status,created_at AS createdAt FROM projects WHERE id=?').get(projectId) as ProjectMembershipRecoverySnapshot['project'] | undefined;
    if (!project) return fail();
    const members = db.prepare('SELECT subject_kind AS kind,subject_id AS id,role,added_at AS addedAt FROM project_members WHERE project_id=? ORDER BY subject_kind,subject_id').all(projectId) as ProjectMembershipRecoverySnapshot['members'];
    const tasks = db.prepare('SELECT id,assignee_kind AS assigneeKind,assignee_id AS assigneeId,status FROM sessions WHERE project_id=? ORDER BY id').all(projectId) as ProjectMembershipRecoverySnapshot['tasks'];
    const snapshot = { project, members, tasks };
    if (raw.action === 'inspect') return { snapshot };
    const ownerId = id(raw.verifiedOwnerId);
    if (ownerId === 'local-v1' || !raw.expected || project.status !== 'active') return fail();
    const expected = raw.expected;
    if (expected.project?.id !== projectId || expected.project.status !== 'active' || !Array.isArray(expected.members) || !Array.isArray(expected.tasks)) return fail();
    const legacy = expected.members.filter(m => m.kind === 'account' && m.id === 'local-v1');
    const owners = expected.members.filter(m => m.role === 'owner');
    if (legacy.length !== 1 || legacy[0].role !== 'member'
      || expected.members.some(m => m.kind === 'account' && m.id === ownerId)
      || owners.length !== 1 || owners[0].kind !== 'bot' || owners[0].id !== expected.project.ownerId) return fail();
    // The same identity substitution also owns the tasks assigned to it: `assignee_id='local-v1'`
    // is how "assigned to the current account" looks in local mode, so leaving it behind would
    // point those tasks at a member id that no longer exists (and violates ASSIGNEE_NOT_MEMBER).
    const reassigned = (task: ProjectMembershipRecoverySnapshot['tasks'][number]) =>
      task.assigneeKind === 'account' && task.assigneeId === 'local-v1' ? { ...task, assigneeId: ownerId } : task;
    const after = {
      ...expected,
      members: expected.members.map(m => m.kind === 'account' && m.id === 'local-v1' ? { ...m, id: ownerId } : m)
        .sort((a,b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      tasks: expected.tasks.map(reassigned),
    };
    if (JSON.stringify(snapshot) === JSON.stringify(after)) return { status: 'already-repaired' };
    if (JSON.stringify(snapshot) !== JSON.stringify(expected)) return fail();
    const legacyAssignees = expected.tasks.filter(task => task.assigneeKind === 'account' && task.assigneeId === 'local-v1').length;
    const result = db.prepare("UPDATE project_members SET subject_id=? WHERE project_id=? AND subject_kind='account' AND subject_id='local-v1' AND role='member'").run(ownerId,projectId);
    if (result.changes !== 1) return fail();
    const movedAssignees = db.prepare("UPDATE sessions SET assignee_id=? WHERE project_id=? AND assignee_kind='account' AND assignee_id='local-v1'").run(ownerId,projectId);
    if (movedAssignees.changes !== legacyAssignees) return fail();
    return { status: 'repaired' };
  })();
}
