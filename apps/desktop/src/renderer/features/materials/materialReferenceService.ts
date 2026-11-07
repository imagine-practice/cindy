/** R3-A boundary adapter. Shared R1 types are the wire contract; R3-B UI consumes this strict boundary. */
import { ApiError } from '@/lib/httpClient';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import {
  MATERIAL_REFERENCE_CONTRACT, isMaterialStatus, isMaterialReadState, isMaterialStorageKind,
  isMaterialContextPurpose, type MaterialScope, type MaterialHistoryParams, type MaterialReference,
  type Material, type MaterialVersion, type MaterialContext, type MaterialFileInput,
  type MaterialsListParams, type MaterialsListResult, type MaterialsAddParams, type MaterialsAddResult,
  type MaterialAddVersionParams, type MaterialAddVersionResult, type MaterialRemoveReferenceParams,
  type MaterialRemoveReferenceResult, type MaterialPreviewParams, type MaterialPreview,
  type MaterialRetryReadParams, type MaterialRetryReadResult, type MaterialContextCreateParams,
  type MaterialContextCreateResult, type MaterialContextListParams, type MaterialContextsListResult,
  type MaterialRejectionCode,
} from '../../../shared/materials';

/** Narrow view of the existing window bridge. Responses remain untrusted until decoded. */
export interface MaterialReferenceBridge {
  materials: {
    list(input: MaterialsListParams): Promise<unknown>;
    add(input: MaterialsAddParams): Promise<unknown>;
    addVersion(input: MaterialAddVersionParams): Promise<unknown>;
    removeReference(input: MaterialRemoveReferenceParams): Promise<unknown>;
    preview(input: MaterialPreviewParams): Promise<unknown>;
    retryRead(input: MaterialRetryReadParams): Promise<unknown>;
  };
  materialContexts: {
    create(input: MaterialContextCreateParams): Promise<unknown>;
    list(input: MaterialContextListParams): Promise<unknown>;
  };
}
type Raw = Record<string, unknown>;
function fail(code = 'PRECONDITION_FAILED'): never {
  throw new ApiError(code, 0, 'Material reference contract rejected');
}
function object(value: unknown): Raw {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Raw;
}
function keys(raw: Raw, allowed: string[]): void {
  if (Object.keys(raw).some(key => !allowed.includes(key))) fail('INVALID_PARAMS');
}
function string(value: unknown, max = Infinity): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail();
  return value;
}
function id(value: unknown): string { return string(value, 200); }
function referenceId(value: unknown): string { return string(value, 400); }
function number(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail();
  return value;
}
function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') fail();
  return value;
}
function array<T>(value: unknown, decode: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) fail();
  return value.map(decode);
}
const scopeKeys = ['projectId', 'workItemId', 'bindingRevision'];
function scopeOf(value: unknown): MaterialScope {
  const raw = object(value);
  if (!('projectId' in raw) || !('workItemId' in raw) || !('bindingRevision' in raw)) fail('REFERENCE_SCOPE_REQUIRED');
  const projectId = id(raw.projectId);
  if (raw.workItemId === null && raw.bindingRevision === null) return { projectId, workItemId: null, bindingRevision: null };
  if (typeof raw.workItemId !== 'string' || typeof raw.bindingRevision !== 'number') fail('REFERENCE_SCOPE_REQUIRED');
  return { projectId, workItemId: id(raw.workItemId), bindingRevision: number(raw.bindingRevision) };
}
function sameScope(expected: MaterialScope, actual: MaterialScope): void {
  if (expected.projectId !== actual.projectId || expected.workItemId !== actual.workItemId) fail('REFERENCE_MISMATCH');
  if (expected.bindingRevision !== actual.bindingRevision) fail('BINDING_CONFLICT');
}
function contract(value: unknown): Raw {
  const raw = object(value);
  if (raw.referenceContract !== MATERIAL_REFERENCE_CONTRACT) fail();
  return raw;
}
function versionOf(value: unknown): MaterialVersion {
  const r = object(value);
  if (!isMaterialStorageKind(r.storageKind) || !isMaterialReadState(r.readState)) fail();
  return { id: id(r.id), materialId: id(r.materialId), version: number(r.version, 1), sha256: string(r.sha256),
    sizeBytes: number(r.sizeBytes), mime: string(r.mime), storageKind: r.storageKind, readState: r.readState,
    failureReason: nullableText(r.failureReason), createdAt: string(r.createdAt) };
}
function referenceOf(value: unknown): MaterialReference {
  const r = object(value);
  if (!isMaterialStatus(r.status) || (r.createdByKind !== 'account' && r.createdByKind !== 'bot')) fail();
  const workItemId = r.workItemId === null ? null : id(r.workItemId);
  const bindingRevision = r.bindingRevision === null ? null : number(r.bindingRevision);
  if (workItemId === null && bindingRevision !== null) fail();
  return { id: referenceId(r.id), projectId: id(r.projectId), workItemId, bindingRevision,
    materialId: id(r.materialId), version: number(r.version, 1), status: r.status,
    createdByKind: r.createdByKind, createdById: id(r.createdById), createdAt: string(r.createdAt), updatedAt: string(r.updatedAt) };
}
function referenceIn(scope: MaterialScope, ref: MaterialReference): void {
  sameScope(scope, scopeOf(ref));
}
function materialOf(value: unknown): Material {
  const r = object(value); const reference = referenceOf(r.reference);
  const versions = array(r.versions, versionOf);
  const currentVersion = number(r.currentVersion, 1); const latestVersion = number(r.latestVersion, 1);
  const selected = versions.find(version => version.version === currentVersion);
  if (r.id !== reference.materialId || r.projectId !== reference.projectId || r.workItemId !== reference.workItemId
    || r.status !== reference.status || reference.version !== currentVersion || !selected
    || selected.readState !== r.readState || versions.some(version => version.materialId !== r.id)
    || !versions.some(version => version.version === latestVersion) || latestVersion < currentVersion
    || (r.createdByKind !== 'account' && r.createdByKind !== 'bot')) fail();
  return { id: id(r.id), projectId: id(r.projectId), workItemId: reference.workItemId, status: reference.status,
    name: string(r.name), createdByKind: r.createdByKind, createdById: id(r.createdById), versions,
    currentVersion, latestVersion, readState: selected.readState, reference,
    createdAt: string(r.createdAt), updatedAt: string(r.updatedAt) };
}
function contextOf(value: unknown): MaterialContext {
  const r = object(value);
  if (!isMaterialContextPurpose(r.purpose) || (r.createdByKind !== 'account' && r.createdByKind !== 'bot')) fail();
  return { id: id(r.id), projectId: r.projectId === null ? null : id(r.projectId), workItemId: id(r.workItemId),
    bindingRevision: r.bindingRevision === null ? null : number(r.bindingRevision), purpose: r.purpose,
    refs: array(r.refs, value => { const ref = object(value); if (!isMaterialReadState(ref.readStateAtPin)) fail();
      return { materialId: id(ref.materialId), version: number(ref.version, 1), readStateAtPin: ref.readStateAtPin,
        ...(ref.referenceId !== undefined ? { referenceId: referenceId(ref.referenceId) } : {}) }; }),
    createdByKind: r.createdByKind, createdById: id(r.createdById), createdAt: string(r.createdAt) };
}
function fileOf(value: unknown): MaterialFileInput {
  const r = object(value); keys(r, ['name', 'path', 'sameNameAction']);
  if (r.sameNameAction !== undefined && r.sameNameAction !== 'create-new') fail('INVALID_PARAMS');
  return { name: string(r.name, 260), path: string(r.path),
    ...(r.sameNameAction !== undefined ? { sameNameAction: r.sameNameAction } : {}) };
}
function windowBridge(): MaterialReferenceBridge {
  const bridge = (window as unknown as { electronAPI?: { localDb?: MaterialReferenceBridge } }).electronAPI?.localDb;
  if (!bridge?.materials || !bridge.materialContexts) fail();
  return bridge;
}

/** A write receipt arrived, but the required read failed. Never automatically replay this write. */
export class MaterialReferenceRefreshError extends ApiError {
  constructor(public readonly receipt: MaterialsAddResult, public readonly cause: unknown) {
    const raw = cause as { code?: unknown; message?: unknown } | null;
    const code = typeof raw?.code === 'string' ? raw.code : typeof raw?.message === 'string'
      ? /\[([A-Z_]+)\]/.exec(raw.message)?.[1] ?? 'UNKNOWN' : 'UNKNOWN';
    super(code, 0, `[${code}] Material reference write received; refresh failed`);
  }
}

/** One immutable scope per mounted consumer. Dispose on route/binding changes and unmount. */
export function createMaterialReferenceService(input: MaterialScope, getBridge = windowBridge) {
  keys(object(input), scopeKeys);
  const scope = Object.freeze(scopeOf(input));
  const owner = getDataOwnerGeneration();
  let disposed = false;
  let verified: MaterialReferenceBridge | null = null;
  let listSequence = 0;
  const active = (): void => { if (disposed || !isDataOwnerGenerationCurrent(owner)) fail('PRECONDITION_FAILED'); };
  const requestScope = (raw: Raw): void => { active(); sameScope(scope, scopeOf(raw)); };
  const writable = (): void => { active(); if (!verified || verified !== getBridge()) fail('PRECONDITION_FAILED'); };
  const call = async <T>(run: () => Promise<unknown>, decode: (value: unknown) => T, mayInvalidate = () => true): Promise<T> => {
    active();
    try { const raw = await run(); active(); return decode(raw); }
    catch (error: unknown) {
      const failure = error as { code?: unknown; message?: unknown } | null;
      const code = typeof failure?.code === 'string' ? failure.code
        : typeof failure?.message === 'string' ? /\[([A-Z_]+)\]/.exec(failure.message)?.[1] : null;
      if (mayInvalidate() && !['SOURCE_MISSING', 'SOURCE_CHANGED', 'DUPLICATE_CONTENT', 'UNSUPPORTED_FILE', 'MEDIA_WRITE_FAILED',
        'MATERIAL_NOT_FOUND', 'VERSION_NOT_FOUND', 'VERSION_NOT_READABLE'].includes(code ?? '')) verified = null;
      active(); throw error;
    }
  };
  const listing = (params: MaterialsListParams): MaterialScope | MaterialHistoryParams => {
    const raw = object(params);
    if (raw.history === true) {
      keys(raw, ['projectId', 'workItemId', 'history']);
      if (raw.projectId !== scope.projectId || raw.workItemId !== scope.workItemId) fail('REFERENCE_MISMATCH');
      return { projectId: scope.projectId, workItemId: scope.workItemId, history: true };
    }
    keys(raw, scopeKeys); requestScope(raw); return { ...scope };
  };
  const list = async (params: MaterialsListParams = scope): Promise<MaterialsListResult> => {
    const request = listing(params); const history = 'history' in request;
    const sequence = history ? null : ++listSequence;
    if (!history) verified = null;
    const bridge = getBridge();
    return call(() => bridge.materials.list(request), value => {
      const r = contract(value); const materials = array(r.materials, materialOf);
      if (history) {
        if (r.history !== true || 'scope' in r || 'bindingRevision' in r || r.projectId !== scope.projectId || r.workItemId !== scope.workItemId) fail('REFERENCE_MISMATCH');
        for (const item of materials) if (item.reference.projectId !== scope.projectId || item.reference.workItemId !== scope.workItemId) fail('REFERENCE_MISMATCH');
        return { referenceContract: 1, ...request, materials };
      }
      if (r.history !== undefined && r.history !== false) fail();
      sameScope(scope, scopeOf(r.scope));
      for (const item of materials) { referenceIn(scope, item.reference); if (item.reference.status !== 'active') fail(); }
      if (sequence !== listSequence) fail('PRECONDITION_FAILED');
      verified = bridge;
      return { referenceContract: 1, scope: { ...scope }, materials };
    }, () => history || sequence === listSequence);
  };
  const scopedReply = (value: unknown): Raw => { const r = contract(value); sameScope(scope, scopeOf(r.scope)); return r; };
  const locator = (params: MaterialPreviewParams): MaterialPreviewParams => {
    const r = object(params);
    if ('contextId' in r) {
      keys(r, ['contextId', 'materialId', 'version']);
      return { contextId: id(r.contextId), materialId: id(r.materialId), version: number(r.version, 1) };
    }
    keys(r, [...scopeKeys, 'referenceId', 'materialId', 'version']); requestScope(r);
    return { ...scope, referenceId: referenceId(r.referenceId), materialId: id(r.materialId), version: number(r.version, 1) };
  };
  return {
    scope,
    dispose(): void { disposed = true; verified = null; listSequence++; },
    list,
    async add(params: MaterialsAddParams): Promise<{ receipt: MaterialsAddResult; current: MaterialsListResult | null }> {
      const r = object(params); keys(r, [...scopeKeys, 'files', 'existing']); requestScope(r); writable();
      if (('files' in r) === ('existing' in r)) fail('INVALID_PARAMS');
      const payload: MaterialsAddParams = 'files' in r ? { ...scope, files: array(r.files, fileOf) }
        : { ...scope, existing: array(r.existing, value => { const e = object(value); keys(e, ['materialId', 'version']); return { materialId: id(e.materialId), version: number(e.version, 1) }; }) };
      const count = payload.files?.length ?? payload.existing!.length;
      // 批次数量不设业务上限（用户裁决：不做限额）；空批次仍然非法。
      if (count < 1) fail('INVALID_PARAMS');
      const receipt = await call(() => getBridge().materials.add(payload), value => {
        const out = scopedReply(value);
        const references = array(out.references, referenceOf);
        for (const ref of references) { referenceIn(scope, ref); if (ref.status !== 'active') fail(); }
        const added = array(out.added, versionOf);
        const duplicates = array(out.duplicates, value => { const d = object(value); return { name: string(d.name), materialId: id(d.materialId), version: number(d.version, 1) }; });
        const rejected = array(out.rejected, value => {
          const e = object(value);
          if (!['DUPLICATE_CONTENT', 'UNSUPPORTED_FILE', 'MEDIA_WRITE_FAILED', 'MATERIAL_NOT_FOUND'].includes(e.code as string)) fail();
          return { name: string(e.name), code: e.code as MaterialRejectionCode };
        });
        if (references.length + rejected.length !== count || [...added, ...duplicates].some(item =>
          !references.some(ref => ref.materialId === item.materialId && ref.version === item.version))) fail();
        return { referenceContract: 1 as const, scope: { ...scope }, added, duplicates, rejected, references };
      });
      // A duplicate is a successful reference write too. Refresh failure remains a failure, not empty success.
      let current: MaterialsListResult | null = null;
      if (receipt.references.length) {
        try { current = await list(scope); }
        catch (error: unknown) { throw new MaterialReferenceRefreshError(receipt, error); }
      }
      return { receipt, current };
    },
    async addVersion(params: MaterialAddVersionParams): Promise<MaterialAddVersionResult> {
      const r = object(params); keys(r, [...scopeKeys, 'referenceId', 'materialId', 'file', 'replaceCurrentReference']); requestScope(r); writable();
      if (r.replaceCurrentReference !== undefined && typeof r.replaceCurrentReference !== 'boolean') fail('INVALID_PARAMS');
      const payload: MaterialAddVersionParams = { ...scope, referenceId: referenceId(r.referenceId), materialId: id(r.materialId), file: fileOf(r.file),
        ...(r.replaceCurrentReference !== undefined ? { replaceCurrentReference: r.replaceCurrentReference as boolean } : {}) };
      return call(() => getBridge().materials.addVersion(payload), value => {
        const out = scopedReply(value); const version = versionOf(out.version); const reference = referenceOf(out.reference); referenceIn(scope, reference);
        if (reference.id !== payload.referenceId || reference.materialId !== payload.materialId || reference.status !== 'active'
          || version.materialId !== payload.materialId || reference.version !== version.version) fail('REFERENCE_MISMATCH');
        return { referenceContract: 1, scope: { ...scope }, version, reference };
      });
    },
    async removeReference(params: MaterialRemoveReferenceParams): Promise<MaterialRemoveReferenceResult> {
      const r = object(params); keys(r, [...scopeKeys, 'referenceId']); requestScope(r); writable();
      const payload = { ...scope, referenceId: referenceId(r.referenceId) };
      return call(() => getBridge().materials.removeReference(payload), value => {
        const out = scopedReply(value); const reference = referenceOf(out.reference); referenceIn(scope, reference);
        if (out.ok !== true || out.status !== 'removed' || reference.id !== payload.referenceId || reference.status !== 'removed') fail();
        return { referenceContract: 1, scope: { ...scope }, ok: true, status: 'removed', reference };
      });
    },
    async preview(params: MaterialPreviewParams): Promise<MaterialPreview> {
      const payload = locator(params);
      return call(() => getBridge().materials.preview(payload), value => {
        const r = contract(value);
        if (!['image', 'text', 'unsupported'].includes(r.kind as string) || r.materialId !== payload.materialId || r.version !== payload.version) fail();
        if (r.url !== undefined && typeof r.url !== 'string') fail(); if (r.text !== undefined && typeof r.text !== 'string') fail();
        return { referenceContract: 1, materialId: id(r.materialId), version: number(r.version, 1), kind: r.kind as MaterialPreview['kind'],
          name: string(r.name), mime: string(r.mime), size: number(r.size),
          ...(r.url !== undefined ? { url: r.url as string } : {}), ...(r.text !== undefined ? { text: r.text as string } : {}) };
      });
    },
    async retryRead(params: MaterialRetryReadParams): Promise<MaterialRetryReadResult> {
      const payload = locator(params); writable();
      return call(() => getBridge().materials.retryRead(payload), value => {
        const r = contract(value); const version = versionOf(r.version);
        if (version.materialId !== payload.materialId || version.version !== payload.version) fail('REFERENCE_MISMATCH');
        return { referenceContract: 1, version };
      });
    },
    async createContext(params: MaterialContextCreateParams): Promise<MaterialContextCreateResult> {
      const r = object(params); keys(r, [...scopeKeys, 'purpose', 'refs']); requestScope(r); writable();
      if (scope.workItemId === null || !isMaterialContextPurpose(r.purpose)) fail('INVALID_PARAMS');
      const refs = array(r.refs, value => { const ref = object(value); keys(ref, ['referenceId', 'materialId', 'version']);
        return { referenceId: referenceId(ref.referenceId), materialId: id(ref.materialId), version: number(ref.version, 1) }; });
      if (!refs.length || refs.length > 200) fail('INVALID_PARAMS');
      const payload: MaterialContextCreateParams = { ...scope, workItemId: scope.workItemId, purpose: r.purpose, refs };
      return call(() => getBridge().materialContexts.create(payload), value => {
        const out = contract(value); const context = contextOf(out.context);
        if (context.projectId !== scope.projectId || context.workItemId !== scope.workItemId || context.bindingRevision !== scope.bindingRevision
          || context.purpose !== payload.purpose || context.refs.length !== refs.length || context.refs.some((ref, i) =>
            ref.referenceId !== refs[i].referenceId || ref.materialId !== refs[i].materialId || ref.version !== refs[i].version)) fail('REFERENCE_MISMATCH');
        return { referenceContract: 1, context };
      });
    },
    async listContexts(params: MaterialContextListParams): Promise<MaterialContextsListResult> {
      const request = listing(params);
      if (request.workItemId === null) fail('INVALID_PARAMS');
      const payload = request as MaterialContextListParams;
      return call(() => getBridge().materialContexts.list(payload), value => {
        const out = contract(value); const contexts = array(out.contexts, contextOf);
        if ('history' in payload) {
          if (out.history !== true || 'scope' in out || 'bindingRevision' in out || out.projectId !== scope.projectId || out.workItemId !== scope.workItemId
            || contexts.some(context => context.workItemId !== scope.workItemId || (context.projectId !== null && context.projectId !== scope.projectId))) fail('REFERENCE_MISMATCH');
          return { referenceContract: 1, ...payload, contexts };
        }
        sameScope(scope, scopeOf(out.scope));
        if (out.history !== undefined && out.history !== false) fail();
        if (contexts.some(context => context.projectId !== scope.projectId || context.workItemId !== scope.workItemId || context.bindingRevision !== scope.bindingRevision)) fail('REFERENCE_MISMATCH');
        return { referenceContract: 1, scope: { ...scope }, contexts };
      });
    },
  };
}
