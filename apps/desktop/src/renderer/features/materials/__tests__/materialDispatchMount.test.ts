/**
 * Renderer material mount + pre-send validation + ledger status projection.
 *
 * M3: a stale mount (context removed, binding changed, pinned refs/versions changed) must be
 * rejected with a stated reason before the send, so no half message is created.
 * M4/M5/M6: the four ledger states stay separate from consumption, `pending` never reads as
 * used and `unknown` only asks for reconciliation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Material, MaterialContext } from '../../../../shared/materials';
import type { MaterialDispatchStatusItem } from '../../../../shared/materialDispatch';

const listContexts = vi.fn<() => Promise<{ contexts: MaterialContext[]; referenceContract: 1 }>>();
const list = vi.fn<() => Promise<{ materials: Material[]; referenceContract: 1 }>>();

const readScope = vi.fn(async () => ({
  scope: { projectId: 'p', workItemId: SESSION, bindingRevision: 3 },
  title: 'task',
  canWrite: true,
}));

vi.mock('../materialScopeRead', () => ({
  readMaterialTaskScope: (...args: unknown[]) => readScope(...(args as [])),
}));

vi.mock('../materialReferenceService', () => ({
  createMaterialReferenceService: () => ({
    listContexts,
    list,
    dispose: vi.fn(),
    scope: {},
  }),
}));

import {
  clearMaterialDispatchMount,
  getMaterialDispatchMount,
  materialDispatchConsumptionKey,
  materialDispatchRefsKey,
  materialDispatchStateKey,
  mountMaterialDispatch,
  readMaterialDispatchStatus,
  resetMaterialDispatchMounts,
  validateMaterialDispatchMount,
  type MaterialDispatchMount,
} from '../materialDispatchMount';

const SESSION = 'task-1';
const SCOPE = { projectId: 'p', workItemId: SESSION, bindingRevision: 3 };

function context(patch: Partial<MaterialContext> = {}): MaterialContext {
  return {
    id: 'c',
    projectId: 'p',
    workItemId: SESSION,
    bindingRevision: 3,
    purpose: 'reference',
    refs: [{ referenceId: 'r', materialId: 'm', version: 2, readStateAtPin: 'ready' }],
    createdByKind: 'account',
    createdById: 'owner',
    createdAt: '2026-11-06T00:00:00.000Z',
    ...patch,
  };
}

function material(readState: 'ready' | 'failed' = 'ready'): Material {
  return {
    id: 'm',
    projectId: 'p',
    workItemId: SESSION,
    status: 'active',
    name: 'notes.txt',
    createdByKind: 'account',
    createdById: 'owner',
    versions: [
      {
        id: 'v2',
        materialId: 'm',
        version: 2,
        sha256: 'a'.repeat(64),
        sizeBytes: 10,
        mime: 'text/plain',
        storageKind: 'file',
        readState,
        failureReason: null,
        createdAt: '2026-11-06T00:00:00.000Z',
      },
    ],
    currentVersion: 2,
    latestVersion: 2,
    readState,
    reference: {
      id: 'r',
      projectId: 'p',
      workItemId: SESSION,
      bindingRevision: 3,
      materialId: 'm',
      version: 2,
      status: 'active',
      createdByKind: 'account',
      createdById: 'owner',
      createdAt: '2026-11-06T00:00:00.000Z',
      updatedAt: '2026-11-06T00:00:00.000Z',
    },
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
  };
}

function mountOf(source = context()): MaterialDispatchMount {
  return {
    sessionId: SESSION,
    selector: {
      contextId: source.id,
      projectId: 'p',
      workItemId: SESSION,
      bindingRevision: 3,
      purpose: 'reference',
    },
    expectedRevision: 0,
    purpose: 'reference',
    bindingRevision: 3,
    refsKey: materialDispatchRefsKey(source.refs),
    refs: [{ name: 'notes.txt', version: 2, readState: 'ready' }],
    mountedAt: '2026-11-06T00:00:00.000Z',
  };
}

beforeEach(() => {
  resetMaterialDispatchMounts();
  listContexts.mockReset();
  list.mockReset();
  readScope.mockReset();
  readScope.mockResolvedValue({
    scope: { projectId: 'p', workItemId: SESSION, bindingRevision: 3 },
    title: 'task',
    canWrite: true,
  });
  listContexts.mockResolvedValue({ contexts: [context()], referenceContract: 1 });
  list.mockResolvedValue({ materials: [material()], referenceContract: 1 });
});

describe('one material context per task', () => {
  it('mounting another context replaces the previous one', () => {
    const first = mountOf();
    mountMaterialDispatch(first);
    expect(getMaterialDispatchMount(SESSION)).toBe(first);
    const second = { ...mountOf(), selector: { ...first.selector, contextId: 'c2' } };
    mountMaterialDispatch(second);
    expect(getMaterialDispatchMount(SESSION)?.selector.contextId).toBe('c2');
    clearMaterialDispatchMount(SESSION);
    expect(getMaterialDispatchMount(SESSION)).toBeNull();
  });
});

describe('pre-send validation reads Main again', () => {
  it('accepts an unchanged pinned context', async () => {
    await expect(validateMaterialDispatchMount(mountOf())).resolves.toEqual({ ok: true });
  });

  it('M3: refuses a removed context', async () => {
    listContexts.mockResolvedValue({ contexts: [], referenceContract: 1 });
    await expect(validateMaterialDispatchMount(mountOf())).resolves.toEqual({
      ok: false,
      reason: 'context-missing',
    });
  });

  it('M3: refuses a task that was re-bound after mounting', async () => {
    readScope.mockResolvedValue({
      scope: { projectId: 'p', workItemId: SESSION, bindingRevision: 4 },
      title: 'task',
      canWrite: true,
    });
    await expect(validateMaterialDispatchMount(mountOf())).resolves.toEqual({
      ok: false,
      reason: 'binding-changed',
    });
  });

  it('M3: refuses a changed binding revision', async () => {
    listContexts.mockResolvedValue({
      contexts: [context({ bindingRevision: 4 })],
      referenceContract: 1,
    });
    await expect(validateMaterialDispatchMount(mountOf())).resolves.toEqual({
      ok: false,
      reason: 'binding-changed',
    });
  });

  it('M3: refuses changed pinned references', async () => {
    listContexts.mockResolvedValue({
      contexts: [
        context({ refs: [{ referenceId: 'r', materialId: 'm', version: 3, readStateAtPin: 'ready' }] }),
      ],
      referenceContract: 1,
    });
    await expect(validateMaterialDispatchMount(mountOf())).resolves.toEqual({
      ok: false,
      reason: 'refs-changed',
    });
  });

  it('M3: refuses an unreadable pinned version', async () => {
    list.mockResolvedValue({ materials: [material('failed')], referenceContract: 1 });
    await expect(validateMaterialDispatchMount(mountOf())).resolves.toEqual({
      ok: false,
      reason: 'version-unreadable',
    });
  });

  it('M3: refuses a removed reference', async () => {
    const removed = material();
    list.mockResolvedValue({
      materials: [{ ...removed, reference: { ...removed.reference, status: 'removed' } }],
      referenceContract: 1,
    });
    await expect(validateMaterialDispatchMount(mountOf())).resolves.toEqual({
      ok: false,
      reason: 'refs-changed',
    });
  });
});

describe('post-send status is a real read', () => {
  const item = (patch: Partial<MaterialDispatchStatusItem>): MaterialDispatchStatusItem => ({
    clientId: 'client-1',
    revision: 1,
    state: 'attached',
    consumption: null,
    readiness: 'ready',
    referenceCount: 1,
    ...patch,
  });

  it('M5/M6: keeps the four states and consumption outcomes separate', async () => {
    const rows = [
      item({ state: 'queued', consumption: null }),
      item({ clientId: 'client-2', state: 'attached', consumption: { consumer: 'provider', outcome: 'pending' } }),
      item({ clientId: 'client-3', state: 'superseded' }),
      item({ clientId: 'client-4', state: 'cancelled' }),
      item({ clientId: 'client-5', state: 'attached', consumption: { consumer: 'provider', outcome: 'unknown' } }),
    ];
    const read = await readMaterialDispatchStatus(SESSION, () => ({
      status: async () => ({ referenceContract: 1, sessionId: SESSION, messages: rows }),
    }));
    expect(read).toEqual(rows);
    expect(read.map((entry) => materialDispatchStateKey(entry.state))).toEqual([
      'ccAgent.materials.dispatch.stateQueued',
      'ccAgent.materials.dispatch.stateAttached',
      'ccAgent.materials.dispatch.stateSuperseded',
      'ccAgent.materials.dispatch.stateCancelled',
      'ccAgent.materials.dispatch.stateAttached',
    ]);
    expect(materialDispatchConsumptionKey('provider', 'pending')).toBe(
      'ccAgent.materials.dispatch.consumptionPending',
    );
    expect(materialDispatchConsumptionKey('provider', 'unknown')).toBe(
      'ccAgent.materials.dispatch.consumptionUnknown',
    );
    expect(materialDispatchConsumptionKey('provider', 'confirmed')).toBe(
      'ccAgent.materials.dispatch.consumptionConfirmed',
    );
    expect(materialDispatchConsumptionKey('vision', 'not-consumed')).toBe(
      'ccAgent.materials.dispatch.consumptionNotConsumed',
    );
  });

  it('M7: a malformed or unavailable read is an error, never a guessed state', async () => {
    await expect(
      readMaterialDispatchStatus(SESSION, () => ({
        status: async () => ({ referenceContract: 1, sessionId: SESSION, messages: [{ clientId: 'x' }] }),
      })),
    ).rejects.toThrow('Material dispatch status is malformed');
    await expect(
      readMaterialDispatchStatus(SESSION, () => ({
        status: async () => {
          throw new Error('[PRECONDITION_FAILED] Material dispatch read has no owner');
        },
      })),
    ).rejects.toThrow('[PRECONDITION_FAILED]');
  });
});
