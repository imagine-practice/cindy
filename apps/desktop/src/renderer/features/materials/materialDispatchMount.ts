/**
 * Renderer-side material dispatch selection for the composer.
 *
 * It holds at most ONE mount per task, and only a durable selector + display snapshot.
 * Nothing here prepares bytes, authorizes consumption or decides outcome: preparation and
 * the pending attempt live in Main (`materialExecutionInput` / `materialConsumption`), and
 * the post-send state always comes from a real ledger read (`local-db:material-dispatch:status`).
 */
import type {
  MaterialContextPurpose,
  MaterialContextsListResult,
  MaterialReadState,
} from '../../../shared/materials';
import type {
  MaterialDispatchConsumer,
  MaterialDispatchOutcome,
  MaterialDispatchRevisionState,
  MaterialDispatchSelector,
  MaterialDispatchStatusItem,
} from '../../../shared/materialDispatch';
import { createMaterialReferenceService } from './materialReferenceService';
import { isScopeInvalidation } from './materialReferenceView';
import { readMaterialTaskScope } from './materialScopeRead';

export interface MaterialDispatchMountRef {
  name: string;
  version: number;
  readState: MaterialReadState;
}

export interface MaterialDispatchMount {
  sessionId: string;
  selector: MaterialDispatchSelector;
  /** First intent for this message key. Main rejects any other value for a new send. */
  expectedRevision: 0;
  purpose: MaterialContextPurpose;
  bindingRevision: number;
  /** Exact pinned refs read from Main, used to detect drift before sending. */
  refsKey: string;
  refs: MaterialDispatchMountRef[];
  mountedAt: string;
}

export type MaterialDispatchSendRejection =
  | 'context-missing'
  | 'binding-changed'
  | 'purpose-changed'
  | 'refs-changed'
  | 'version-unreadable'
  | 'intent-stale'
  | 'already-sent';

export const MATERIAL_DISPATCH_REJECTIONS: readonly MaterialDispatchSendRejection[] = [
  'context-missing',
  'binding-changed',
  'purpose-changed',
  'refs-changed',
  'version-unreadable',
  'intent-stale',
  'already-sent',
];

export type MaterialDispatchStateI18nKey =
  | 'ccAgent.materials.dispatch.stateQueued'
  | 'ccAgent.materials.dispatch.stateAttached'
  | 'ccAgent.materials.dispatch.stateSuperseded'
  | 'ccAgent.materials.dispatch.stateCancelled';

/** Four ledger states only. `attached` is not consumption and never reads as "used". */
export function materialDispatchStateKey(
  state: MaterialDispatchRevisionState,
): MaterialDispatchStateI18nKey {
  switch (state) {
    case 'attached':
      return 'ccAgent.materials.dispatch.stateAttached';
    case 'superseded':
      return 'ccAgent.materials.dispatch.stateSuperseded';
    case 'cancelled':
      return 'ccAgent.materials.dispatch.stateCancelled';
    case 'queued':
    default:
      return 'ccAgent.materials.dispatch.stateQueued';
  }
}

export type MaterialDispatchConsumptionI18nKey =
  | 'ccAgent.materials.dispatch.consumptionPending'
  | 'ccAgent.materials.dispatch.consumptionConfirmed'
  | 'ccAgent.materials.dispatch.consumptionNotConsumed'
  | 'ccAgent.materials.dispatch.consumptionUnknown';

/** Consumption is a separate line from the revision state: pending never reads as used and
 * unknown only asks for reconciliation (never an automatic resend). */
export function materialDispatchConsumptionKey(
  consumer: MaterialDispatchConsumer,
  outcome: MaterialDispatchOutcome,
): MaterialDispatchConsumptionI18nKey {
  void consumer;
  switch (outcome) {
    case 'confirmed':
      return 'ccAgent.materials.dispatch.consumptionConfirmed';
    case 'not-consumed':
      return 'ccAgent.materials.dispatch.consumptionNotConsumed';
    case 'unknown':
      return 'ccAgent.materials.dispatch.consumptionUnknown';
    case 'pending':
    default:
      return 'ccAgent.materials.dispatch.consumptionPending';
  }
}

/** One mount per task. Replacing it is the only way to switch context (never two at once). */
const mounts = new Map<string, MaterialDispatchMount>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeMaterialDispatchMount(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMaterialDispatchMount(sessionId: string): MaterialDispatchMount | null {
  return mounts.get(sessionId) ?? null;
}

export function mountMaterialDispatch(mount: MaterialDispatchMount): void {
  mounts.set(mount.sessionId, mount);
  emit();
}

export function clearMaterialDispatchMount(sessionId: string): void {
  if (!mounts.delete(sessionId)) return;
  emit();
}

/** Test/route reset only: never called by product code while a mount is still pending. */
export function resetMaterialDispatchMounts(): void {
  if (mounts.size === 0) return;
  mounts.clear();
  emit();
}

export function materialDispatchRefsKey(
  refs: MaterialContextsListResult['contexts'][number]['refs'],
): string {
  return JSON.stringify(
    refs.map((ref) => [
      ref.referenceId ?? null,
      ref.materialId,
      ref.version,
      ref.readStateAtPin,
    ]),
  );
}

/** Build a mount from a context that the page just read. No byte work, no preparation. */
export function mountFromContext(
  sessionId: string,
  context: MaterialContextsListResult['contexts'][number],
  refs: MaterialDispatchMountRef[],
): MaterialDispatchMount {
  return {
    sessionId,
    selector: {
      contextId: context.id,
      projectId: context.projectId ?? '',
      workItemId: context.workItemId,
      bindingRevision: context.bindingRevision ?? -1,
      purpose: context.purpose,
    },
    expectedRevision: 0,
    purpose: context.purpose,
    bindingRevision: context.bindingRevision ?? -1,
    refsKey: materialDispatchRefsKey(context.refs),
    refs,
    mountedAt: new Date().toISOString(),
  };
}

/** The exact envelope a send carries for the current mount.
 *
 * Callers must build it from the mount they read at send time, never from a cached copy:
 * after the mount is replaced with context B, the send must carry B's selector and B's own
 * first-intent revision, so the previous context A is not dispatched a second time.
 */
export function materialDispatchSendIntent(mount: MaterialDispatchMount): {
  selector: MaterialDispatchSelector;
  expectedRevision: number;
} {
  return { selector: mount.selector, expectedRevision: mount.expectedRevision };
}

export type MaterialDispatchValidation =
  | { ok: true }
  | { ok: false; reason: MaterialDispatchSendRejection };

/**
 * Pre-send check against real reads. This is not the authorization boundary (Main re-reads
 * the same snapshot before attaching and consuming); it only prevents a send that is already
 * known to be stale, so no half message is created and the reason can be stated up front.
 */
export async function validateMaterialDispatchMount(
  mount: MaterialDispatchMount,
): Promise<MaterialDispatchValidation> {
  const { selector } = mount;
  if (!selector.projectId) return { ok: false, reason: 'context-missing' };
  // Current task binding first: the snapshot is only valid for the epoch it was pinned at.
  try {
    const current = await readMaterialTaskScope(selector.projectId, selector.workItemId);
    if (current.scope.bindingRevision !== selector.bindingRevision) {
      return { ok: false, reason: 'binding-changed' };
    }
  } catch (error: unknown) {
    const code = (error as { code?: unknown } | null)?.code;
    return { ok: false, reason: code === 'PROJECT_NOT_FOUND' ? 'context-missing' : 'binding-changed' };
  }
  const service = createMaterialReferenceService({
    projectId: selector.projectId,
    workItemId: selector.workItemId,
    bindingRevision: selector.bindingRevision,
  });
  try {
    const contexts = await service.listContexts({
      projectId: selector.projectId,
      workItemId: selector.workItemId,
      bindingRevision: selector.bindingRevision,
    });
    const context = contexts.contexts.find((item) => item.id === selector.contextId);
    if (!context) return { ok: false, reason: 'context-missing' };
    if (
      context.projectId !== selector.projectId ||
      context.workItemId !== selector.workItemId ||
      context.bindingRevision !== selector.bindingRevision
    ) {
      return { ok: false, reason: 'binding-changed' };
    }
    if (context.purpose !== selector.purpose) return { ok: false, reason: 'purpose-changed' };
    if (materialDispatchRefsKey(context.refs) !== mount.refsKey) {
      return { ok: false, reason: 'refs-changed' };
    }
    const current = await service.list();
    for (const ref of context.refs) {
      const material = current.materials.find(
        (item) =>
          item.id === ref.materialId &&
          item.reference.id === ref.referenceId &&
          item.reference.status === 'active',
      );
      if (!material) return { ok: false, reason: 'refs-changed' };
      const version = material.versions.find((item) => item.version === ref.version);
      if (!version) return { ok: false, reason: 'refs-changed' };
      if (version.readState !== 'ready') return { ok: false, reason: 'version-unreadable' };
    }
    return { ok: true };
  } catch (error: unknown) {
    if (isScopeInvalidation(error)) return { ok: false, reason: 'binding-changed' };
    throw error;
  } finally {
    service.dispose();
  }
}

interface MaterialDispatchBridge {
  status(params: { sessionId: string }): Promise<unknown>;
}

function defaultBridge(): MaterialDispatchBridge {
  const bridge = (
    window as unknown as { electronAPI?: { localDb?: { materialDispatch?: MaterialDispatchBridge } } }
  ).electronAPI?.localDb?.materialDispatch;
  if (!bridge || typeof bridge.status !== 'function') {
    throw new Error('[MATERIALS_UNAVAILABLE] Material dispatch status is unavailable');
  }
  return bridge;
}

const STATES: readonly MaterialDispatchRevisionState[] = [
  'queued',
  'attached',
  'superseded',
  'cancelled',
];
const OUTCOMES: readonly MaterialDispatchOutcome[] = [
  'pending',
  'confirmed',
  'not-consumed',
  'unknown',
];
const READINESS: readonly ('ready' | 'partial' | 'not-prepared')[] = [
  'ready',
  'partial',
  'not-prepared',
];

/** Real ledger read. A failed read surfaces as an error; it is never rendered as a state. */
export async function readMaterialDispatchStatus(
  sessionId: string,
  getBridge: () => MaterialDispatchBridge = defaultBridge,
): Promise<MaterialDispatchStatusItem[]> {
  const raw = (await getBridge().status({ sessionId })) as {
    referenceContract?: unknown;
    sessionId?: unknown;
    messages?: unknown;
  } | null;
  if (
    !raw ||
    typeof raw !== 'object' ||
    raw.referenceContract !== 1 ||
    raw.sessionId !== sessionId ||
    !Array.isArray(raw.messages)
  ) {
    throw new Error('[PRECONDITION_FAILED] Material dispatch status is not readable');
  }
  return raw.messages.map((value) => {
    const item = value as Record<string, unknown>;
    const consumption = item.consumption as
      | { consumer?: unknown; outcome?: unknown }
      | null
      | undefined;
    if (
      typeof item.clientId !== 'string' ||
      typeof item.revision !== 'number' ||
      !STATES.includes(item.state as MaterialDispatchRevisionState) ||
      typeof item.referenceCount !== 'number'
    ) {
      throw new Error('[PRECONDITION_FAILED] Material dispatch status is malformed');
    }
    if (consumption != null) {
      if (
        (consumption.consumer !== 'vision' && consumption.consumer !== 'provider') ||
        !OUTCOMES.includes(consumption.outcome as MaterialDispatchOutcome)
      ) {
        throw new Error('[PRECONDITION_FAILED] Material dispatch outcome is malformed');
      }
    }
    if (item.readiness != null && !READINESS.includes(item.readiness as never)) {
      throw new Error('[PRECONDITION_FAILED] Material dispatch readiness is malformed');
    }
    return {
      clientId: item.clientId,
      revision: item.revision,
      state: item.state as MaterialDispatchRevisionState,
      consumption: consumption
        ? {
            consumer: consumption.consumer as MaterialDispatchConsumer,
            outcome: consumption.outcome as MaterialDispatchOutcome,
          }
        : null,
      readiness:
        item.readiness == null ? null : (item.readiness as MaterialDispatchStatusItem['readiness']),
      referenceCount: item.referenceCount,
    } satisfies MaterialDispatchStatusItem;
  });
}
