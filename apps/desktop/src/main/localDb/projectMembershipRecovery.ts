import { randomUUID } from 'node:crypto';
import type { DbClient } from './client/DbClient';
import type { ProjectMembershipRecoverySnapshot, ProjectMembershipRecoveryResult } from './worker/opHandlers/projectMembershipRecoveryTx';
import type { ProjectMembershipRecoveryPreview } from '../../shared/projectMembershipRecovery';
export type { ProjectMembershipRecoveryPreview } from '../../shared/projectMembershipRecovery';

export interface ProjectMembershipRecoveryScope {
  ownerId: string; generation: number; clientEpoch: number; client: DbClient;
}
export interface ProjectMembershipRecoveryDeps {
  capture(): ProjectMembershipRecoveryScope;
  isCurrent(scope: ProjectMembershipRecoveryScope): boolean;
  /** Read-only proof from this installation's adoption receipt and local source. */
  proveSource(scope: ProjectMembershipRecoveryScope, projectId: string): Promise<ProjectMembershipRecoverySnapshot>;
  /** Online target backup, integrity check and exact preview-state verification. */
  backup(scope: ProjectMembershipRecoveryScope, expected: ProjectMembershipRecoverySnapshot): Promise<string>;
  confirm(scope: ProjectMembershipRecoveryScope, preview: ProjectMembershipRecoveryPreview): Promise<boolean>;
  changed(scope: ProjectMembershipRecoveryScope): void;
}
/** Preview creates no backup and never writes either user DB. Repair is separate,
 * bound to a main-held intent and native confirmation; callers supply no actor,
 * target DB, role, source identity or SQL. Unknown ACK retains the same intent.
 */
export function createProjectMembershipRecoveryService(deps: ProjectMembershipRecoveryDeps) {
  const intents = new Map<string, { scope: ProjectMembershipRecoveryScope; expected: ProjectMembershipRecoverySnapshot; preview: ProjectMembershipRecoveryPreview; busy: boolean; backupPath?: string; dispatched?: boolean; receipt?: { status: 'repaired' | 'already-repaired'; backupPath: string } }>();
  const fail = (code = 'PRECONDITION_FAILED'): never => { throw Object.assign(new Error('Project membership recovery unavailable'), { code }); };
  const guard = (scope: ProjectMembershipRecoveryScope) => { if (!deps.isCurrent(scope)) fail(); };
  const inspect = async (scope: ProjectMembershipRecoveryScope, projectId: string) => {
    const result = await scope.client.tx<ProjectMembershipRecoveryResult>('projectMembershipRecovery.execute', { action: 'inspect', projectId });
    guard(scope);
    if (!('snapshot' in result)) return fail();
    return result.snapshot;
  };
  return {
    async preview(projectId: string): Promise<ProjectMembershipRecoveryPreview> {
      if (!projectId || projectId.length > 200 || /[\\/]/.test(projectId) || projectId.includes('::')) return fail('INVALID_PARAMS');
      const scope = deps.capture(); guard(scope);
      const source = await deps.proveSource(scope, projectId); guard(scope);
      const target = await inspect(scope, projectId);
      // This narrow repair supports a still-identical adopted membership/task
      // projection. Diverged targets need an explicit conflict design, not merge.
      if (JSON.stringify(source) !== JSON.stringify(target) || target.project.status !== 'active') return fail();
      const legacy = target.members.filter(m => m.kind === 'account' && m.id === 'local-v1');
      const owners = target.members.filter(m => m.role === 'owner');
      if (legacy.length !== 1 || legacy[0].role !== 'member'
        || target.members.some(m => m.kind === 'account' && m.id === scope.ownerId)
        || owners.length !== 1 || owners[0].kind !== 'bot' || owners[0].id !== target.project.ownerId) return fail();
      for (const [key, value] of intents) if (!deps.isCurrent(value.scope)) intents.delete(key);
      const preview: ProjectMembershipRecoveryPreview = { previewId: randomUUID(), projectId,
        projectName: target.project.name, taskCount: target.tasks.length, from:'local-v1/member',
        to:'current-authenticated-account/member', botOwnerUnchanged:true, backupRequired:true };
      intents.set(preview.previewId, { scope, expected: target, preview, busy:false });
      return preview;
    },
    async repair(previewId: string): Promise<{ status: 'repaired' | 'already-repaired'; backupPath: string }> {
      const intent = intents.get(previewId);
      if (!intent) {
        // It may belong to a previous document/process whose ACK was lost.
        throw Object.assign(new Error('Project membership recovery intent unavailable'), { code:'PRECONDITION_FAILED', writeOutcome:'unknown' });
      }
      if (!deps.isCurrent(intent.scope)) {
        throw Object.assign(new Error('Project membership recovery unavailable'), { code:'PRECONDITION_FAILED', writeOutcome:intent.dispatched?'unknown':'not-applied' });
      }
      if (intent.receipt) return intent.receipt;
      if (intent.busy) {
        // The same intent is still in flight; another caller cannot conclude
        // zero writes, even while its confirmation/backup is still pending.
        throw Object.assign(new Error('Project membership recovery in progress'), { code:'PRECONDITION_FAILED', writeOutcome:'unknown' });
      }
      intent.busy = true;
      try {
        // Recheck source proof before showing the exact retained intent.
        const source = await deps.proveSource(intent.scope, intent.preview.projectId); guard(intent.scope);
        if (JSON.stringify(source) !== JSON.stringify(intent.expected)) return fail();
        if (!intent.dispatched) {
          if (!(await deps.confirm(intent.scope, intent.preview))) return fail('CANCELLED');
          guard(intent.scope);
          const backupPath = await deps.backup(intent.scope, intent.expected); guard(intent.scope);
          if (!backupPath) return fail();
          intent.backupPath = backupPath;
          const current = await inspect(intent.scope, intent.preview.projectId);
          if (JSON.stringify(current) !== JSON.stringify(intent.expected)) return fail();
        }
        // An unknown ACK retries this exact retained intent through the worker's
        // before/after comparison, using the already verified backup/confirmation.
        if (!intent.backupPath) return fail();
        const freshSource = await deps.proveSource(intent.scope, intent.preview.projectId); guard(intent.scope);
        if (JSON.stringify(freshSource) !== JSON.stringify(intent.expected)) return fail();
        intent.dispatched = true;
        const result = await intent.scope.client.tx<ProjectMembershipRecoveryResult>('projectMembershipRecovery.execute', {
          action:'repair', projectId:intent.preview.projectId, verifiedOwnerId:intent.scope.ownerId, expected:intent.expected,
        });
        guard(intent.scope);
        if (!('status' in result)) return fail();
        intent.receipt = { status:result.status, backupPath:intent.backupPath };
        // Notification failure must never change an acknowledged durable repair.
        try { deps.changed(intent.scope); } catch { /* read after success */ }
        return intent.receipt;
      } catch (error) {
        // A transport failure or owner switch after dispatch cannot be called a
        // rejected write. Keep the preview ID so a later read can reconcile it.
        if (error && typeof error === 'object') Object.assign(error,{writeOutcome:intent.dispatched?'unknown':'not-applied'});
        throw error;
      } finally { intent.busy = false; }
    },
  };
}
