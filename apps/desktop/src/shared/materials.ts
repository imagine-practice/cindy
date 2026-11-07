/** Frozen material-reference contract R1 (2026-11-05). Public values never expose storageRef. */
export type MaterialStatus = 'active' | 'removed';
export type MaterialReadState = 'pending' | 'ready' | 'failed';
export type MaterialStorageKind = 'media' | 'file';
export type MaterialContextPurpose = 'reference' | 'redecompose' | 'recheck';
export type MaterialSubjectKind = 'account' | 'bot';
export const MATERIAL_REFERENCE_CONTRACT = 1 as const;

/** Explicit observed binding token; main must not fill in a missing token. */
export type MaterialScope =
  | { projectId: string; workItemId: null; bindingRevision: null }
  | { projectId: string; workItemId: string; bindingRevision: number };
export interface MaterialHistoryParams {
  projectId: string;
  workItemId: string | null;
  history: true;
}
export interface MaterialFileInput {
  name: string;
  path: string;
  sameNameAction?: 'create-new';
}
export interface MaterialReference {
  id: string;
  projectId: string;
  workItemId: string | null;
  /** Null on project references or unresolved legacy history, never on new task references. */
  bindingRevision: number | null;
  materialId: string;
  version: number;
  status: MaterialStatus;
  createdByKind: MaterialSubjectKind;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}
export interface MaterialVersion {
  id: string;
  materialId: string;
  version: number;
  sha256: string;
  sizeBytes: number;
  mime: string;
  storageKind: MaterialStorageKind;
  readState: MaterialReadState;
  failureReason: string | null;
  createdAt: string;
}
export interface Material {
  id: string;
  projectId: string;
  workItemId: string | null;
  status: MaterialStatus;
  name: string;
  createdByKind: MaterialSubjectKind;
  createdById: string;
  versions: MaterialVersion[];
  /** Selected reference version, not the maximum version in the catalogue. */
  currentVersion: number;
  latestVersion: number;
  readState: MaterialReadState;
  reference: MaterialReference;
  createdAt: string;
  updatedAt: string;
}
export interface MaterialDuplicate { name: string; materialId: string; version: number }
export type MaterialRejectionCode = 'DUPLICATE_CONTENT' | 'UNSUPPORTED_FILE' | 'MEDIA_WRITE_FAILED' | 'MATERIAL_NOT_FOUND';
export interface MaterialRejection { name: string; code: MaterialRejectionCode }
export type MaterialsListParams = MaterialScope | MaterialHistoryParams;
export type MaterialsListResult = { referenceContract: 1; materials: Material[] } &
  ({ scope: MaterialScope; history?: false } | MaterialHistoryParams);
export interface MaterialExistingInput { materialId: string; version: number }
export type MaterialsAddParams = MaterialScope & (
  | { files: MaterialFileInput[]; existing?: never }
  | { existing: MaterialExistingInput[]; files?: never }
);
export interface MaterialsAddResult {
  referenceContract: 1;
  scope: MaterialScope;
  added: MaterialVersion[];
  duplicates: MaterialDuplicate[];
  rejected: MaterialRejection[];
  /** One persisted reference per successful input, including duplicates/restores. Input order retained. */
  references: MaterialReference[];
}
export type MaterialAddVersionParams = MaterialScope & {
  referenceId: string;
  materialId: string;
  file: MaterialFileInput;
  /** Preserve the original explicit same-content version-allocation flag. */
  replaceCurrentReference?: boolean;
};
export interface MaterialAddVersionResult {
  version: MaterialVersion;
  reference: MaterialReference;
  scope: MaterialScope;
  referenceContract: 1;
}
export type MaterialRemoveReferenceParams = MaterialScope & { referenceId: string };
export interface MaterialRemoveReferenceResult {
  ok: true;
  status: 'removed';
  reference: MaterialReference;
  scope: MaterialScope;
  referenceContract: 1;
}
export interface MaterialContextRef {
  materialId: string;
  version: number;
  readStateAtPin: MaterialReadState;
  /** Absent only on immutable pre-R1 snapshots. */
  referenceId?: string;
}
export interface MaterialContext {
  id: string;
  projectId: string | null;
  workItemId: string;
  bindingRevision: number | null;
  purpose: MaterialContextPurpose;
  refs: MaterialContextRef[];
  createdByKind: MaterialSubjectKind;
  createdById: string;
  createdAt: string;
}
export type MaterialContextCreateParams = MaterialScope & {
  workItemId: string;
  purpose: MaterialContextPurpose;
  refs: Array<{ referenceId: string; materialId: string; version: number }>;
};
export interface MaterialContextCreateResult { context: MaterialContext; referenceContract: 1 }
export type MaterialContextListParams = (MaterialScope & { workItemId: string }) |
  (MaterialHistoryParams & { workItemId: string });
export type MaterialContextsListResult = { contexts: MaterialContext[]; referenceContract: 1 } &
  ({ scope: MaterialScope; history?: false } | (MaterialHistoryParams & { workItemId: string }));
export type MaterialPreviewParams =
  | (MaterialScope & { referenceId: string; materialId: string; version: number; contextId?: never })
  | { contextId: string; materialId: string; version: number; referenceId?: never;
      projectId?: never; workItemId?: never; bindingRevision?: never };
export interface MaterialPreview {
  kind: 'image' | 'text' | 'unsupported';
  url?: string;
  text?: string;
  name: string;
  mime: string;
  size: number;
  materialId: string;
  version: number;
  referenceContract: 1;
}
export type MaterialRetryReadParams = MaterialPreviewParams;
export interface MaterialRetryReadResult { version: MaterialVersion; referenceContract: 1 }

export const MATERIALS_LIST_CHANNEL = 'local-db:materials:list';
export const MATERIALS_ADD_CHANNEL = 'local-db:materials:add';
export const MATERIALS_ADD_VERSION_CHANNEL = 'local-db:materials:add-version';
export const MATERIALS_REMOVE_REFERENCE_CHANNEL = 'local-db:materials:remove-reference';
export const MATERIALS_RETRY_READ_CHANNEL = 'local-db:materials:retry-read';
export const MATERIALS_PREVIEW_CHANNEL = 'local-db:materials:preview';
export const MATERIAL_CONTEXTS_CREATE_CHANNEL = 'local-db:material-contexts:create';
export const MATERIAL_CONTEXTS_LIST_CHANNEL = 'local-db:material-contexts:list';
export const MATERIAL_ERROR_CODES = [
  'MATERIAL_NOT_FOUND', 'VERSION_NOT_FOUND', 'VERSION_NOT_READABLE', 'DUPLICATE_CONTENT',
  'UNSUPPORTED_FILE', 'MEDIA_WRITE_FAILED', 'SOURCE_MISSING', 'SOURCE_CHANGED', 'PROJECT_NOT_FOUND',
  'REFERENCE_SCOPE_REQUIRED', 'REFERENCE_NOT_FOUND', 'REFERENCE_MISMATCH', 'BINDING_CONFLICT',
  'CONTEXT_SCOPE_UNKNOWN', 'FORBIDDEN', 'INVALID_PARAMS', 'PRECONDITION_FAILED',
] as const;
export type MaterialErrorCode = (typeof MATERIAL_ERROR_CODES)[number];
export const MATERIAL_SOURCE_FAILURE_REASONS = ['SOURCE_MISSING', 'SOURCE_CHANGED'] as const;
export const MATERIAL_NAME_MAX_LENGTH = 260;
/**
 * 材料批次与快照引用数都不设业务上限（用户裁决：不做限额）。
 * 字段长度类常量属输入合法性校验，继续保留。
 */
export const MATERIAL_STATUSES: readonly MaterialStatus[] = ['active', 'removed'];
export const MATERIAL_STORAGE_KINDS: readonly MaterialStorageKind[] = ['media', 'file'];
export const MATERIAL_READ_STATES: readonly MaterialReadState[] = ['pending', 'ready', 'failed'];
export const MATERIAL_CONTEXT_PURPOSES: readonly MaterialContextPurpose[] = ['reference', 'redecompose', 'recheck'];
export function isMaterialStatus(value: unknown): value is MaterialStatus {
  return value === 'active' || value === 'removed';
}
export function isMaterialStorageKind(value: unknown): value is MaterialStorageKind {
  return value === 'media' || value === 'file';
}
export function isMaterialReadState(value: unknown): value is MaterialReadState {
  return value === 'pending' || value === 'ready' || value === 'failed';
}
export function isMaterialContextPurpose(value: unknown): value is MaterialContextPurpose {
  return value === 'reference' || value === 'redecompose' || value === 'recheck';
}

/** Local-host opaque material grant only; not a generic URL or file reader. */
export const MATERIALS_READ_PREVIEW_BYTES_CHANNEL = 'local-db:materials:read-preview-bytes';
export interface MaterialPreviewBytesParams { url: string }
export interface MaterialPreviewBytesResult { bytes: Uint8Array; mime: 'application/pdf' }
