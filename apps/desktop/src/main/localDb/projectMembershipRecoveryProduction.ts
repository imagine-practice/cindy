import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';
import { getActiveAppSession, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState';
import { readBoundedFileNoFollowSync } from '../utils/readBoundedFile';
import { createProductionLocalProfileDataMigrationDeps, LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX } from '../localProfileDataMigration';
import { getCurrentDbClientSnapshot } from './client/current';
import { createBetterSqliteDatabase } from './betterSqliteFactory';
import { ownerDatabasePath } from './modelDefaultsProfile';
import { readModelVisibilityAdoption } from './modelVisibilityAdoption';
import { runProjectMembershipRecoveryTransaction } from './worker/opHandlers/projectMembershipRecoveryTx';
import { createProjectMembershipRecoveryService, type ProjectMembershipRecoveryDeps, type ProjectMembershipRecoveryScope } from './projectMembershipRecovery';

/** Main-only adapter: no renderer-provided paths, identity, proof or backup.
 * The adoption file-identity marker is essential: reservation alone can exist
 * even when the target predated adoption and must never authorize this repair.
 */
export function createProductionProjectMembershipRecovery(
  confirm: ProjectMembershipRecoveryDeps['confirm'], changed: ProjectMembershipRecoveryDeps['changed'],
  // Required on purpose: a caller that forgets the "requesting window still exists" gate must not
  // silently get a pass. The IPC layer supplies it from the sender/frame/navigation epoch.
  isRequesterCurrent: () => boolean,
) {
  const fail = (): never => { throw Object.assign(new Error('Project membership recovery precondition failed'), { code:'PRECONDITION_FAILED' }); };
  const fileIdentity = (file: string) => {
    const stat = fs.statSync(file, { bigint:true });
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  };
  const proofs = new WeakMap<ProjectMembershipRecoveryScope, { targetPath: string; targetIdentity: string; receipt: string }>();
  const isCurrent = (scope: ProjectMembershipRecoveryScope) => {
    const auth = getActiveAppSession(), db = getCurrentDbClientSnapshot();
    return !isAppSessionBoundaryPending() && isRequesterCurrent()
      && auth.mode === 'cloud' && auth.dataOwnerId === scope.ownerId && auth.generation === scope.generation
      && db?.client === scope.client && db.userId === scope.ownerId && db.clientEpoch === scope.clientEpoch;
  };
  const guard = (scope: ProjectMembershipRecoveryScope) => { if (!isCurrent(scope)) fail(); };
  const verifyFiles = (scope: ProjectMembershipRecoveryScope) => {
    guard(scope);
    const root = fs.realpathSync(app.getPath('userData'));
    const targetPath = ownerDatabasePath(root, scope.ownerId);
    const sourcePath = ownerDatabasePath(root, 'local-v1');
    for (const file of [sourcePath, targetPath]) {
      if (fs.realpathSync(file) !== path.resolve(file) || path.dirname(fs.realpathSync(file)) !== root) return fail();
    }
    const markerPath = `${sourcePath.slice(0,-3)}${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`;
    const bytes = readBoundedFileNoFollowSync(markerPath, 4096, { containWithin:root });
    if (!bytes) return fail();
    const receipt = bytes.toString('utf8');
    if (JSON.parse(receipt)?.ownerId !== scope.ownerId || readModelVisibilityAdoption(targetPath) !== 'adopted') return fail();
    const proof = { targetPath, targetIdentity:fileIdentity(targetPath), receipt };
    const previous = proofs.get(scope);
    if (previous && JSON.stringify(previous) !== JSON.stringify(proof)) return fail();
    proofs.set(scope,proof);
    return { sourcePath, targetPath };
  };
  return createProjectMembershipRecoveryService({
    capture() {
      const auth = getActiveAppSession(), db = getCurrentDbClientSnapshot();
      if (isAppSessionBoundaryPending() || !isRequesterCurrent() || auth.mode !== 'cloud' || !auth.dataOwnerId || !db || db.userId !== auth.dataOwnerId
        || auth.dataOwnerId === 'local-v1' || /[\\/]/.test(auth.dataOwnerId) || auth.dataOwnerId.includes('::')) return fail();
      return { ownerId:auth.dataOwnerId, generation:auth.generation, clientEpoch:db.clientEpoch, client:db.client };
    },
    isCurrent,
    async proveSource(scope, projectId) {
      const { sourcePath, targetPath } = verifyFiles(scope);
      const databases = await scope.client.query<{ name:string; file:string }>('PRAGMA database_list');
      guard(scope); verifyFiles(scope);
      const main = databases.find(row => row.name === 'main');
      if (!main?.file || fs.realpathSync(main.file) !== fs.realpathSync(targetPath)) return fail();
      const source = createBetterSqliteDatabase(sourcePath, { readonly:true, fileMustExist:true });
      try {
        const result = runProjectMembershipRecoveryTransaction(source,{ action:'inspect',projectId });
        if (!('snapshot' in result)) return fail();
        return result.snapshot;
      } finally { source.close(); }
    },
    async backup(scope, expected) {
      const { targetPath } = verifyFiles(scope);
      const parent = ownerScopedUserDataPath('project-membership-recovery');
      fs.mkdirSync(parent,{ recursive:true, mode:0o700 });
      if (fs.realpathSync(parent) !== path.resolve(parent)) return fail();
      // An exclusive per-attempt directory prevents any existing snapshot from
      // being replaced by the existing online-backup helper's writable target.
      const directory = path.join(parent,randomUUID());
      fs.mkdirSync(directory,{ mode:0o700 });
      const backupPath = path.join(directory,'before.db');
      const deps = createProductionLocalProfileDataMigrationDeps(app.getPath('userData'),BRAND_IDENTITY.dbFilePrefix);
      await deps.fs.backupDatabase(targetPath,backupPath);
      guard(scope); verifyFiles(scope);
      const backup = createBetterSqliteDatabase(backupPath,{ readonly:true,fileMustExist:true });
      try {
        if (backup.pragma('quick_check',{ simple:true }) !== 'ok') return fail();
        const result = runProjectMembershipRecoveryTransaction(backup,{ action:'inspect',projectId:expected.project.id });
        if (!('snapshot' in result) || JSON.stringify(result.snapshot) !== JSON.stringify(expected)) return fail();
      } finally { backup.close(); }
      return backupPath;
    },
    confirm, changed,
  });
}
