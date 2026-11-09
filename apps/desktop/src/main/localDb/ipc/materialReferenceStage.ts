/** Exact-id cleanup for this material request only; unknown business commits retain their refs. */
import { removeRefById } from '../../cindy-media/ledger';
import { createLogger } from '../../logger';
import type { DbClient } from '../client/DbClient';
const log = createLogger('material-reference-stage');
export interface MaterialStagedRefs { versionId: string; refIds: string[] }
export type MaterialCommitState = 'not-sent' | 'acknowledged' | 'rejected' | 'unknown';
export function isDefiniteMaterialRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /^\[(FORBIDDEN|INVALID_PARAMS|PRECONDITION_FAILED|REFERENCE_SCOPE_REQUIRED|REFERENCE_NOT_FOUND|REFERENCE_MISMATCH|BINDING_CONFLICT|MATERIAL_NOT_FOUND|VERSION_NOT_FOUND|DUPLICATE_CONTENT|CONTEXT_SCOPE_UNKNOWN)\]/.test(message);
}
export async function cleanupMaterialStaging(
  items: readonly MaterialStagedRefs[], state: MaterialCommitState, client: DbClient,
  db: DbClient['drizzle'], assertStable: () => void,
): Promise<void> {
  if (!items.length) return;
  if (state === 'unknown') {
    log.warn('Material staging retained after an unknown business commit', { count: items.length });
    return;
  }
  for (const item of items) {
    try {
      assertStable();
      const version = await client.queryOne<{ id: string }>('SELECT id FROM material_versions WHERE id=?', [item.versionId]);
      assertStable();
      // A committed version wins even if the acknowledgement or a later access check failed.
      if (version) continue;
      for (const id of item.refIds) { assertStable(); await removeRefById(id, db); }
    } catch {
      // No negative durable proof (or owner/DB changed): retaining is safer than deleting a live pin.
      log.warn('Material staging retained because cleanup could not be confirmed', { count: item.refIds.length });
    }
  }
}
