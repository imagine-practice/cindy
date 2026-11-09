/**
 * Value: real R3-A service -> controlled window.electronAPI.localDb bridge, exact eight-channel payloads.
 * Rule: frozen material-reference R1 contract, explicit B1 scope and contract-1 read-before-write.
 * Gap: old model/panel tests use materialId-only protocol and cannot observe reference/scope preservation.
 * Minimal input: t1 and t3 reference mA/v1; host then reports t1/v2 while t3 remains v1.
 * Tier: unit, in-memory bridge responses only. No SQLite, uploads, real permissions or model reads.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMaterialReferenceService } from '../materialReferenceService';
import type { Material, MaterialScope, MaterialReference, MaterialVersion, MaterialContext,
  MaterialsAddParams, MaterialAddVersionParams, MaterialsListParams } from '../../../../shared/materials';

const env = vi.hoisted(() => ({ owner: 1 }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => env.owner,
  isDataOwnerGenerationCurrent: (owner: number) => owner === env.owner }));
const bridge = { materials: { list: vi.fn(), add: vi.fn(), addVersion: vi.fn(), removeReference: vi.fn(), preview: vi.fn(), retryRead: vi.fn() },
  materialContexts: { create: vi.fn(), list: vi.fn() } };
const t1: MaterialScope = { projectId: 'p', workItemId: 't1', bindingRevision: 7 };
const t3: MaterialScope = { projectId: 'p', workItemId: 't3', bindingRevision: 9 };
const file = { name: 'A.pdf', path: '/picked/A.pdf' };
const time = '2026-11-05T10:00:00.000Z';
function version(n = 1): MaterialVersion { return { id: `mv${n}`, materialId: 'mA', version: n,
  sha256: `sha${n}`, sizeBytes: 10, mime: 'application/pdf', storageKind: 'file', readState: n === 1 ? 'failed' : 'ready',
  failureReason: n === 1 ? 'SOURCE_MISSING' : null, createdAt: time }; }
function reference(scope = t1, n = 1): MaterialReference { return { ...scope, id: `ref-${scope.workItemId ?? 'project'}`,
  materialId: 'mA', version: n, status: 'active', createdByKind: 'account', createdById: 'creator', createdAt: time, updatedAt: time }; }
function material(ref = reference(), latest = ref.version): Material { return { id: 'mA', projectId: ref.projectId,
  workItemId: ref.workItemId, status: ref.status, name: 'A.pdf', createdByKind: 'account', createdById: 'creator',
  versions: Array.from({ length: latest }, (_, i) => version(i + 1)), currentVersion: ref.version, latestVersion: latest,
  readState: version(ref.version).readState, reference: ref, createdAt: time, updatedAt: time }; }
function list(scope: MaterialScope, materials: Material[] = []) { return { referenceContract: 1, scope, materials }; }
function context(scope = t3): MaterialContext { return { id: 'c1', projectId: scope.projectId, workItemId: scope.workItemId!,
  bindingRevision: scope.bindingRevision, purpose: 'reference', refs: [{ referenceId: reference(scope).id, materialId: 'mA', version: 1, readStateAtPin: 'failed' }],
  createdByKind: 'account', createdById: 'creator', createdAt: time }; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
beforeEach(() => {
  vi.resetAllMocks(); env.owner = 1;
  vi.stubGlobal('window', { electronAPI: { localDb: bridge } });
  bridge.materials.list.mockImplementation(async (params: MaterialsListParams) => list(params as MaterialScope));
});
afterEach(() => vi.unstubAllGlobals());

it('preserves independent t1/t3 references from controlled responses, refreshes duplicate success and never substitutes latest for selected', async () => {
  const rows = new Map<string, MaterialReference>(); let latest = 1;
  bridge.materials.list.mockImplementation(async (scope: MaterialScope) =>
    list(scope, rows.has(scope.workItemId!) ? [material(rows.get(scope.workItemId!)!, latest)] : []));
  bridge.materials.add.mockImplementation(async (params: MaterialsAddParams) => {
    const ref = reference(params); rows.set(params.workItemId!, ref);
    return { referenceContract: 1, scope: { projectId: params.projectId, workItemId: params.workItemId, bindingRevision: params.bindingRevision }, added: params.workItemId === 't1' ? [version()] : [],
      duplicates: params.workItemId === 't3' ? [{ name: 'A.pdf', materialId: 'mA', version: 1 }] : [], rejected: [], references: [ref] };
  });
  const a = createMaterialReferenceService(t1); const b = createMaterialReferenceService(t3);
  await a.list(); await b.list();
  const first = await a.add({ ...t1, files: [file] }); const duplicate = await b.add({ ...t3, files: [file] });
  expect(first.receipt.references[0].id).not.toBe(duplicate.receipt.references[0].id);
  expect(duplicate.current?.materials[0].reference).toEqual(reference(t3));
  expect(bridge.materials.list.mock.calls).toEqual([[t1], [t3], [t1], [t3]]);
  bridge.materials.addVersion.mockImplementation(async (params: MaterialAddVersionParams) => {
    latest = 2; const ref = reference(t1, 2); rows.set('t1', ref);
    return { referenceContract: 1, scope: t1, version: version(2), reference: ref };
  });
  await a.addVersion({ ...t1, referenceId: 'ref-t1', materialId: 'mA', file, replaceCurrentReference: true });
  const unchanged = await b.list();
  expect(unchanged.materials[0]).toMatchObject({ currentVersion: 1, latestVersion: 2, readState: 'failed', reference: { id: 'ref-t3', version: 1 } });
  bridge.materials.preview.mockResolvedValue({ referenceContract: 1, materialId: 'mA', version: 1,
    kind: 'unsupported', url: 'xdt-file://scoped-v1', name: 'A.pdf', mime: 'application/pdf', size: 10 });
  expect(await b.preview({ ...t3, referenceId: 'ref-t3', materialId: 'mA', version: 1 })).toMatchObject({ version: 1, url: 'xdt-file://scoped-v1' });
  expect(bridge.materials.preview).toHaveBeenCalledWith({ ...t3, referenceId: 'ref-t3', materialId: 'mA', version: 1 });
  bridge.materials.removeReference.mockImplementation(async () => { rows.delete('t1');
    return { referenceContract: 1, scope: t1, ok: true, status: 'removed', reference: { ...reference(t1, 2), status: 'removed' } }; });
  await a.removeReference({ ...t1, referenceId: 'ref-t1' });
  expect((await a.list()).materials).toEqual([]); expect((await b.list()).materials[0].currentVersion).toBe(1);
  expect(bridge.materials.removeReference).toHaveBeenCalledExactlyOnceWith({ ...t1, referenceId: 'ref-t1' });
});

it('keeps history and unknown binding metadata distinct and does not grant write capability from history', async () => {
  const history = { projectId: 'p', workItemId: 't3', history: true as const };
  const legacy = { ...reference(t3), bindingRevision: null, status: 'removed' as const };
  bridge.materials.list.mockResolvedValue({ referenceContract: 1, ...history, materials: [material(legacy, 2)] });
  const service = createMaterialReferenceService(t3); const reply = await service.list(history);
  expect(reply).toMatchObject({ history: true, materials: [{ reference: { bindingRevision: null }, currentVersion: 1, latestVersion: 2 }] });
  expect(reply).not.toHaveProperty('scope'); expect(bridge.materials.list).toHaveBeenCalledWith(history);
  await expect(service.add({ ...t3, files: [file] })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(bridge.materials.add).not.toHaveBeenCalled();
});

it('passes existing version selection distinctly from files and reloads reference-only success', async () => {
  const service = createMaterialReferenceService(t3); await service.list();
  bridge.materials.add.mockResolvedValue({ referenceContract: 1, scope: t3, added: [], duplicates: [], rejected: [], references: [reference(t3, 2)] });
  await service.add({ ...t3, existing: [{ materialId: 'mA', version: 2 }] });
  expect(bridge.materials.add).toHaveBeenCalledExactlyOnceWith({ ...t3, existing: [{ materialId: 'mA', version: 2 }] });
  expect(bridge.materials.list).toHaveBeenCalledTimes(2);
  await expect(service.add({ ...t3, files: [file], existing: [{ materialId: 'mA', version: 1 }] } as unknown as MaterialsAddParams)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
});

it('uses reference-scoped context create/list and immutable context locators for preview/retry', async () => {
  const service = createMaterialReferenceService(t3); await service.list();
  const selected = { referenceId: 'ref-t3', materialId: 'mA', version: 2 };
  const ctx = { ...context(), refs: [{ ...selected, readStateAtPin: 'ready' }] };
  bridge.materialContexts.create.mockResolvedValue({ referenceContract: 1, context: ctx });
  await service.createContext({ ...t3, purpose: 'reference', refs: [selected] });
  expect(bridge.materialContexts.create).toHaveBeenCalledExactlyOnceWith({ ...t3, purpose: 'reference', refs: [selected] });
  bridge.materialContexts.list.mockResolvedValue({ referenceContract: 1, scope: t3, contexts: [ctx] });
  expect((await service.listContexts(t3 as MaterialScope & { workItemId: string })).contexts[0].refs[0].version).toBe(2);
  const history = { projectId: 'p', workItemId: 't3', history: true as const };
  const old = { ...context(), projectId: null, bindingRevision: null, refs: [{ materialId: 'mA', version: 1, readStateAtPin: 'failed' }] };
  bridge.materialContexts.list.mockResolvedValue({ referenceContract: 1, ...history, contexts: [old] });
  expect((await service.listContexts(history)).contexts[0]).toEqual(old);
  expect(bridge.materialContexts.list.mock.calls).toEqual([[t3], [history]]);
  bridge.materials.preview.mockResolvedValue({ referenceContract: 1, materialId: 'mA', version: 1, kind: 'text', text: 'pinned v1', name: 'A', mime: 'text/plain', size: 9 });
  const locator = { contextId: 'c-old', materialId: 'mA', version: 1 };
  expect((await service.preview(locator)).text).toBe('pinned v1');
  bridge.materials.retryRead.mockResolvedValue({ referenceContract: 1, version: { ...version(), readState: 'ready', failureReason: null } });
  expect((await service.retryRead(locator)).version.version).toBe(1);
  expect(bridge.materials.preview).toHaveBeenCalledExactlyOnceWith(locator);
  expect(bridge.materials.retryRead).toHaveBeenCalledExactlyOnceWith(locator);
  await service.retryRead({ ...t3, referenceId: 'ref-t3', materialId: 'mA', version: 1 });
  expect(bridge.materials.retryRead).toHaveBeenLastCalledWith({ ...t3, referenceId: 'ref-t3', materialId: 'mA', version: 1 });
});

it.each([undefined, null, 0, 2])('refuses an old/mismatched host contract %s before writes', async marker => {
  bridge.materials.list.mockResolvedValue({ referenceContract: marker, scope: t3, materials: [] });
  const service = createMaterialReferenceService(t3);
  await expect(service.list()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  await expect(service.removeReference({ ...t3, referenceId: 'ref-t3' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(bridge.materials.removeReference).not.toHaveBeenCalled();
});

it('requires an explicit task token and accepts project null/null without inventing task token zero', async () => {
  expect(() => createMaterialReferenceService({ projectId: 'p', workItemId: 't3' } as MaterialScope)).toThrow();
  expect(() => createMaterialReferenceService({ ...t3, bindingRevision: null } as unknown as MaterialScope)).toThrow();
  const scope: MaterialScope = { projectId: 'p', workItemId: null, bindingRevision: null };
  const service = createMaterialReferenceService(scope); const reply = await service.list();
  expect('scope' in reply && reply.scope).toEqual(scope);
});

it('accepts a 400-character reference ID and rejects a 201-character material ID and a 401-character reference ID', async () => {
  const service = createMaterialReferenceService(t3); await service.list(); const refId = 'r'.repeat(400);
  bridge.materials.removeReference.mockResolvedValue({ referenceContract: 1, scope: t3, ok: true, status: 'removed', reference: { ...reference(t3), id: refId, status: 'removed' } });
  await service.removeReference({ ...t3, referenceId: refId });
  expect(bridge.materials.removeReference).toHaveBeenCalledExactlyOnceWith({ ...t3, referenceId: refId });
  await expect(service.preview({ ...t3, referenceId: refId, materialId: 'm'.repeat(201), version: 1 })).rejects.toThrow();
  await expect(service.removeReference({ ...t3, referenceId: 'r'.repeat(401) })).rejects.toThrow();
  expect(bridge.materials.preview).not.toHaveBeenCalled();
});

it.each(['missing', 'project', 'binding', 'history'])('rejects %s scope replies instead of normalizing an empty success', async issue => {
  bridge.materials.list.mockResolvedValue({ referenceContract: 1, materials: [],
    ...(issue === 'missing' ? {} : { scope: { ...t3, ...(issue === 'project' ? { projectId: 'q' } : issue === 'binding' ? { bindingRevision: 8 } : {}) } }),
    ...(issue === 'history' ? { history: true } : {}) });
  await expect(createMaterialReferenceService(t3).list()).rejects.toThrow();
});

it('rejects malformed material projection without deriving selected/latest version and strips all raw storage references', async () => {
  const service = createMaterialReferenceService(t3); const raw = material(reference(t3), 2);
  bridge.materials.list.mockResolvedValue(list(t3, [{ ...raw, currentVersion: undefined } as unknown as Material]));
  await expect(service.list()).rejects.toThrow();
  bridge.materials.list.mockResolvedValue(list(t3, [{ ...raw, storageRef: '/private/entity',
    reference: { ...raw.reference, storageRef: '/private/ref' }, versions: raw.versions.map(v => ({ ...v, storageRef: '/private/version' })) } as Material]));
  const reply = await service.list(); expect(reply.materials[0].currentVersion).toBe(1);
  expect(JSON.stringify(reply)).not.toContain('private'); expect(JSON.stringify(reply)).not.toContain('storageRef');
});

it('refreshes after added/duplicate success and propagates refresh failure without empty success', async () => {
  const service = createMaterialReferenceService(t3); await service.list();
  bridge.materials.add.mockResolvedValue({ referenceContract: 1, scope: t3, added: [], duplicates: [{ name: 'A.pdf', materialId: 'mA', version: 1 }], rejected: [], references: [reference(t3)] });
  bridge.materials.list.mockRejectedValue(new Error('[FORBIDDEN] refresh denied'));
  await expect(service.add({ ...t3, files: [file] })).rejects.toThrow('FORBIDDEN');
  expect(bridge.materials.list).toHaveBeenLastCalledWith(t3);
});

it.each(['throw', 'rejected'])('retains explicit create-new after %s and never adds confirmation to ordinary input', async failure => {
  const service = createMaterialReferenceService(t3); await service.list();
  const success = { referenceContract: 1, scope: t3, added: [version()], duplicates: [], rejected: [], references: [reference(t3)] };
  bridge.materials.add.mockResolvedValue(success);
  if (failure === 'throw') bridge.materials.add.mockRejectedValueOnce(new Error('[SOURCE_MISSING] missing'));
  else bridge.materials.add.mockResolvedValueOnce({ referenceContract: 1, scope: t3, added: [], duplicates: [],
    references: [], rejected: [{ name: 'A.pdf', code: 'MEDIA_WRITE_FAILED' }] });
  const input = { ...t3, files: [{ ...file, sameNameAction: 'create-new' as const }] };
  if (failure === 'throw') await expect(service.add(input)).rejects.toThrow('SOURCE_MISSING');
  else expect((await service.add(input)).receipt.rejected[0].code).toBe('MEDIA_WRITE_FAILED');
  expect(bridge.materials.list).toHaveBeenCalledTimes(1);
  await service.add(input);
  expect(bridge.materials.add.mock.calls[0]).toEqual(bridge.materials.add.mock.calls[1]);
  expect(bridge.materials.add.mock.calls[1][0].files[0].sameNameAction).toBe('create-new');
  await service.add({ ...t3, files: [file] });
  expect(bridge.materials.add.mock.calls[2][0].files[0]).toEqual(file);
});

it.each(['resolve', 'reject'])('does not let an obsolete list %s revoke newer verified write capability', async completion => {
  const old = deferred<unknown>(); const service = createMaterialReferenceService(t3);
  bridge.materials.list.mockReturnValueOnce(old.promise).mockResolvedValue(list(t3));
  const pending = service.list(); await service.list();
  if (completion === 'resolve') old.resolve(list(t3)); else old.reject(new Error('[FORBIDDEN] obsolete request'));
  await expect(pending).rejects.toThrow();
  bridge.materials.add.mockResolvedValue({ referenceContract: 1, scope: t3, added: [], duplicates: [], references: [],
    rejected: [{ name: 'A.pdf', code: 'MEDIA_WRITE_FAILED' }] });
  expect((await service.add({ ...t3, files: [file] })).receipt.rejected).toHaveLength(1);
  expect(bridge.materials.add).toHaveBeenCalledTimes(1);
});

it('captures an immutable scope instead of following later caller mutations', async () => {
  const input = { ...t3 }; const service = createMaterialReferenceService(input);
  input.projectId = 'other-project';
  await service.list(); expect(bridge.materials.list).toHaveBeenCalledExactlyOnceWith(t3);
});

it('rejects a write reply without its required references or with a foreign scope', async () => {
  const service = createMaterialReferenceService(t3); await service.list();
  bridge.materials.add.mockResolvedValue({ referenceContract: 1, scope: t3, added: [version()], duplicates: [], rejected: [] });
  await expect(service.add({ ...t3, files: [file] })).rejects.toThrow();
  await service.list();
  bridge.materials.add.mockResolvedValue({ referenceContract: 1, scope: t1, added: [version()], duplicates: [], rejected: [], references: [reference(t1)] });
  await expect(service.add({ ...t3, files: [file] })).rejects.toThrow();
});

it('rejects a preview reply that silently substitutes a different version', async () => {
  const service = createMaterialReferenceService(t3);
  bridge.materials.preview.mockResolvedValue({ referenceContract: 1, materialId: 'mA', version: 2, kind: 'text', text: 'wrong v2', name: 'A', mime: 'text/plain', size: 1 });
  await expect(service.preview({ ...t3, referenceId: 'ref-t3', materialId: 'mA', version: 1 })).rejects.toThrow();
});

it('retains the reference, material and addVersion operation when retrying a recoverable error', async () => {
  const service = createMaterialReferenceService(t3); await service.list();
  bridge.materials.addVersion.mockRejectedValueOnce(new Error('[SOURCE_CHANGED] changed')).mockResolvedValue({ referenceContract: 1, scope: t3,
    version: version(2), reference: reference(t3, 2) });
  const input = { ...t3, referenceId: 'ref-t3', materialId: 'mA', file, replaceCurrentReference: true };
  await expect(service.addVersion(input)).rejects.toThrow('SOURCE_CHANGED'); await service.addVersion(input);
  expect(bridge.materials.addVersion.mock.calls).toEqual([[input], [input]]); expect(bridge.materials.add).not.toHaveBeenCalled();
});

it.each(['dispose', 'owner'])('rejects late add success after %s invalidates the scope and never reloads it', async reason => {
  const pending = deferred<unknown>(); const service = createMaterialReferenceService(t3); await service.list();
  bridge.materials.add.mockReturnValue(pending.promise);
  const result = service.add({ ...t3, files: [file] });
  if (reason === 'dispose') service.dispose(); else env.owner++;
  pending.resolve({ referenceContract: 1, scope: t3, added: [version()], duplicates: [], rejected: [], references: [reference(t3)] });
  await expect(result).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(bridge.materials.list).toHaveBeenCalledTimes(1);
});

it('rejects a late old list after a newer one, and rejects host failures without changing them to empty arrays', async () => {
  const old = deferred<unknown>(); const service = createMaterialReferenceService(t3);
  bridge.materials.list.mockReturnValueOnce(old.promise).mockResolvedValueOnce(list(t3));
  const first = service.list(); await service.list(); old.resolve(list(t3, [material(reference(t3))]));
  await expect(first).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  bridge.materials.list.mockRejectedValue(new Error('[BINDING_CONFLICT] host rejected'));
  await expect(service.list()).rejects.toThrow('BINDING_CONFLICT');
});

it('forbids mixed locator forms and entity-only removal without calling a bridge write', async () => {
  const service = createMaterialReferenceService(t3); await service.list();
  await expect(service.preview({ ...t3, contextId: 'c1', referenceId: 'ref-t3', materialId: 'mA', version: 1 } as never)).rejects.toThrow();
  await expect(service.removeReference({ materialId: 'mA' } as never)).rejects.toThrow();
  expect(bridge.materials.preview).not.toHaveBeenCalled(); expect(bridge.materials.removeReference).not.toHaveBeenCalled();
});
