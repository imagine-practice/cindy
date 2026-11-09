/**
 * 工作项材料（M2-B）renderer 侧适配层。
 *
 * 通道与形状按已冻结契约（`docs/plans/2026-11-05-materials-contract-draft.md` §3）：
 *   `local-db:materials:{list,add,add-version,remove-reference,retry-read,preview}`
 *   `local-db:material-contexts:{create,list}`
 *
 * 主进程实现由 M2-A 提供，所以这里**不伪造任何 IPC**：
 *   - 通道不存在时抛出 `MATERIALS_UNAVAILABLE`，界面显示「当前版本还不支持材料」而不是
 *     假数据或永远转圈的加载态；
 *   - preload 的类型声明也不在本片写域内，因此用下面的 `MaterialsBridge` 窄接口去对
 *     `window.electronAPI.localDb` 取投影。合并时把这里换成 M2-A 的官方类型即可，
 *     调用方（面板 / 快照区）不用改。
 *   - 错误码解析不走 `shared/ipc-errors.ts` 的注册表：那是 M2-A 的写域，材料错误码要等
 *     它合并后才进白名单。这里直接按 `[CODE] message` 解析，合并前后都能工作。
 */
import { ApiError } from '@/lib/httpClient';
import {
  MATERIALS_UNAVAILABLE,
  isMaterialContextPurpose,
  isMaterialErrorCode,
  isMaterialReadState,
  isMaterialStatus,
  isMaterialStorageKind,
  sourceIssueOf,
  type Material,
  type MaterialAddResult,
  type MaterialContext,
  type MaterialContextPurpose,
  type MaterialContextRef,
  type MaterialCreatorKind,
  type MaterialFileInput,
  type MaterialPreviewPayload,
  type MaterialReadState,
  type MaterialStorageKind,
  type MaterialVersion,
} from './materialsModel';

/** 契约 §3 的 renderer 侧投影（preload 由 M2-A 接线）。 */
interface MaterialsBridge {
  list(input: { projectId: string; workItemId?: string }): Promise<unknown>;
  add(input: {
    projectId: string;
    workItemId?: string;
    files: MaterialFileInput[];
  }): Promise<unknown>;
  addVersion(input: {
    materialId: string;
    file: MaterialFileInput;
    replaceCurrentReference?: boolean;
  }): Promise<unknown>;
  removeReference(input: { materialId: string }): Promise<unknown>;
  retryRead(input: { materialId: string; version: number }): Promise<unknown>;
  preview(input: { materialId: string; version: number }): Promise<unknown>;
}

interface MaterialContextsBridge {
  create(input: {
    workItemId: string;
    purpose: MaterialContextPurpose;
    refs: { materialId: string; version: number }[];
  }): Promise<unknown>;
  list(input: { workItemId: string }): Promise<unknown>;
}

interface LocalDbWithMaterials {
  materials?: Partial<MaterialsBridge> & { 'add-version'?: MaterialsBridge['addVersion'] };
  materialContexts?: Partial<MaterialContextsBridge>;
}

function localDb(): LocalDbWithMaterials | null {
  const api = (window as unknown as { electronAPI?: { localDb?: LocalDbWithMaterials } })
    .electronAPI;
  return api?.localDb ?? null;
}

function requireMaterials(): MaterialsBridge {
  const bridge = localDb()?.materials;
  if (!bridge?.list || !bridge.add || !bridge.removeReference || !bridge.retryRead) {
    throw new ApiError(
      MATERIALS_UNAVAILABLE,
      0,
      'materials IPC bridge is not available in this build',
    );
  }
  const addVersion = bridge.addVersion ?? bridge['add-version'];
  if (!addVersion || !bridge.preview) {
    throw new ApiError(
      MATERIALS_UNAVAILABLE,
      0,
      'materials IPC bridge is not available in this build',
    );
  }
  return { ...(bridge as MaterialsBridge), addVersion };
}

function requireContexts(): MaterialContextsBridge {
  const bridge = localDb()?.materialContexts;
  if (!bridge?.create || !bridge.list) {
    throw new ApiError(
      MATERIALS_UNAVAILABLE,
      0,
      'material-contexts IPC bridge is not available in this build',
    );
  }
  return bridge as MaterialContextsBridge;
}

// ── normalization ───────────────────────────────────────────────────────────
//
// 契约给的是列语义（snake_case），preload 可能投影成 camelCase。两边都认，
// 免得为了字段命名在合并时再改一轮界面。

type Raw = Record<string, unknown>;

function asRaw(value: unknown): Raw | null {
  return value && typeof value === 'object' ? (value as Raw) : null;
}

function pick<T>(raw: Raw, camel: string, snake: string): T | undefined {
  if (raw[camel] !== undefined) return raw[camel] as T;
  if (raw[snake] !== undefined) return raw[snake] as T;
  return undefined;
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 服务层的时间字段是 ISO 字符串（契约 §1）。兼容历史上可能出现的毫秒数，
 * 但不把字符串当数字解析——那会静默变成 0 并显示成 1970 年。
 */
function toIsoString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return '';
}

function readStateOf(value: unknown, fallback: MaterialReadState): MaterialReadState {
  return isMaterialReadState(value) ? value : fallback;
}

function creatorKindOf(value: unknown): MaterialCreatorKind {
  return value === 'bot' ? 'bot' : 'account';
}

function normalizeVersion(input: unknown): MaterialVersion {
  const raw = asRaw(input) ?? {};
  return {
    id: toStringValue(raw.id),
    materialId: toStringValue(pick(raw, 'materialId', 'material_id')),
    version: toNumber(raw.version),
    sha256: toStringValue(raw.sha256),
    sizeBytes: toNumber(pick(raw, 'sizeBytes', 'size_bytes')),
    mime: toStringValue(raw.mime),
    // `storage_ref` 不对外；界面只按形态做说明，地址一律走 preview 通道。
    storageKind: isMaterialStorageKind(pick(raw, 'storageKind', 'storage_kind'))
      ? (pick<MaterialStorageKind>(raw, 'storageKind', 'storage_kind') as MaterialStorageKind)
      : 'media',
    readState: readStateOf(pick(raw, 'readState', 'read_state'), 'pending'),
    failureReason:
      (pick<string | null>(raw, 'failureReason', 'failure_reason') as string | null | undefined) ??
      null,
    createdAt: toIsoString(pick(raw, 'createdAt', 'created_at')),
  };
}

function normalizeMaterial(input: unknown): Material {
  const raw = asRaw(input) ?? {};
  const versions = Array.isArray(raw.versions)
    ? raw.versions.map(normalizeVersion).sort((a, b) => a.version - b.version)
    : [];
  const explicitCurrent = toNumber(pick(raw, 'currentVersion', 'current_version'));
  const currentVersion =
    explicitCurrent > 0 ? explicitCurrent : (versions[versions.length - 1]?.version ?? 0);
  const current = versions.find((version) => version.version === currentVersion) ?? null;
  return {
    id: toStringValue(raw.id),
    projectId: toStringValue(pick(raw, 'projectId', 'project_id')),
    workItemId: (pick<string | null>(raw, 'workItemId', 'work_item_id') as string | null) ?? null,
    name: toStringValue(raw.name),
    status: isMaterialStatus(raw.status) ? raw.status : 'active',
    createdByKind: creatorKindOf(pick(raw, 'createdByKind', 'created_by_kind')),
    createdById: toStringValue(pick(raw, 'createdById', 'created_by_id')),
    createdAt: toIsoString(pick(raw, 'createdAt', 'created_at')),
    updatedAt: toIsoString(pick(raw, 'updatedAt', 'updated_at')),
    currentVersion,
    readState: readStateOf(pick(raw, 'readState', 'read_state'), current?.readState ?? 'pending'),
    versions,
  };
}

function normalizeContextRef(input: unknown): MaterialContextRef {
  const raw = asRaw(input) ?? {};
  return {
    materialId: toStringValue(pick(raw, 'materialId', 'material_id')),
    version: toNumber(raw.version),
    readStateAtPin: readStateOf(pick(raw, 'readStateAtPin', 'read_state_at_pin'), 'pending'),
  };
}

function normalizeContext(input: unknown): MaterialContext {
  const raw = asRaw(input) ?? {};
  const refs = Array.isArray(pick(raw, 'refs', 'refs_json'))
    ? (pick<unknown[]>(raw, 'refs', 'refs_json') as unknown[]).map(normalizeContextRef)
    : typeof pick(raw, 'refsJson', 'refs_json') === 'string'
      ? parseRefs(pick<string>(raw, 'refsJson', 'refs_json') ?? '')
      : [];
  const purpose = pick(raw, 'purpose', 'purpose');
  return {
    id: toStringValue(raw.id),
    workItemId: toStringValue(pick(raw, 'workItemId', 'work_item_id')),
    purpose: isMaterialContextPurpose(purpose) ? purpose : 'reference',
    refs,
    createdByKind: creatorKindOf(pick(raw, 'createdByKind', 'created_by_kind')),
    createdById: toStringValue(pick(raw, 'createdById', 'created_by_id')),
    createdAt: toIsoString(pick(raw, 'createdAt', 'created_at')),
  };
}

function parseRefs(value: string): MaterialContextRef[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(normalizeContextRef) : [];
  } catch {
    return [];
  }
}

function normalizePreview(input: unknown, materialId: string): MaterialPreviewPayload {
  const raw = asRaw(input) ?? {};
  const kind = raw.kind === 'image' || raw.kind === 'text' ? raw.kind : 'unsupported';
  return {
    kind,
    ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
    ...(typeof raw.text === 'string' ? { text: raw.text } : {}),
    name: toStringValue(raw.name) || materialId,
    mime: toStringValue(raw.mime),
    size: toNumber(raw.size ?? raw.sizeBytes ?? raw.size_bytes),
  };
}

function normalizeAddResult(input: unknown): MaterialAddResult {
  const raw = asRaw(input) ?? {};
  const added = Array.isArray(raw.added) ? raw.added.map(normalizeVersion) : [];
  const duplicates = Array.isArray(raw.duplicates)
    ? raw.duplicates.map((item) => {
        const entry = asRaw(item) ?? {};
        return {
          name: toStringValue(entry.name),
          materialId: toStringValue(pick(entry, 'materialId', 'material_id')),
          version: toNumber(entry.version),
        };
      })
    : [];
  const rejected = Array.isArray(raw.rejected)
    ? raw.rejected.map((item) => {
        const entry = asRaw(item) ?? {};
        return { name: toStringValue(entry.name), code: toStringValue(entry.code) };
      })
    : [];
  return { added, duplicates, rejected };
}

// ── ipc ─────────────────────────────────────────────────────────────────────

async function wrap<T>(run: () => Promise<unknown>, convert: (value: unknown) => T): Promise<T> {
  try {
    return convert(await run());
  } catch (error: unknown) {
    const code = materialErrorCode(error);
    if (code) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ApiError(code, 0, message);
    }
    if (error instanceof Error) throw new ApiError('UNKNOWN', 0, error.message);
    throw new ApiError('UNKNOWN', 0, String(error));
  }
}

/** 原文件问题（已修改/已不存在）：可能是独立错误码，也可能藏在 VERSION_NOT_READABLE 正文里。 */
export function materialSourceIssue(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return sourceIssueOf(materialErrorCode(error), message);
}

/** 从 IPC 异常里取材料错误码；白名单之外的码一律返回 null，交由调用方给通用文案。 */
export function materialErrorCode(error: unknown): string | null {
  const direct = (error as { code?: unknown } | null)?.code;
  if (isMaterialErrorCode(direct)) return direct;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const match = /\[([A-Z0-9_]+)\]/.exec(message);
  const code = match?.[1] ?? null;
  return code && (isMaterialErrorCode(code) || code === 'UNKNOWN') ? code : null;
}

export async function listMaterials(
  projectId: string,
  workItemId: string,
): Promise<Material[]> {
  return wrap(
    () => requireMaterials().list({ projectId, workItemId }),
    (value) => {
      const raw = asRaw(value);
      const list = Array.isArray(raw?.materials) ? (raw.materials as unknown[]) : [];
      return list.map(normalizeMaterial);
    },
  );
}

export async function addMaterials(
  projectId: string,
  workItemId: string,
  files: MaterialFileInput[],
): Promise<MaterialAddResult> {
  // Preserve explicit per-file sameNameAction; ordinary adds must not acquire a default.
  return wrap(
    () => requireMaterials().add({ projectId, workItemId, files }),
    normalizeAddResult,
  );
}

export async function addMaterialVersion(
  materialId: string,
  file: MaterialFileInput,
): Promise<MaterialVersion> {
  return wrap(
    () =>
      requireMaterials().addVersion({
        materialId,
        file,
        // 显式选择补版本：按共享契约，即使内容相同也允许新增版本；旧快照不变。
        replaceCurrentReference: true,
      }),
    (value) => normalizeVersion(asRaw(value)?.version ?? value),
  );
}

export async function removeMaterialReference(materialId: string): Promise<void> {
  await wrap(
    () => requireMaterials().removeReference({ materialId }),
    () => undefined,
  );
}

export async function retryMaterialRead(materialId: string, version: number): Promise<MaterialVersion> {
  return wrap(
    () => requireMaterials().retryRead({ materialId, version }),
    (value) => normalizeVersion(asRaw(value)?.version ?? value),
  );
}

export async function previewMaterial(
  materialId: string,
  version: number,
): Promise<MaterialPreviewPayload> {
  return wrap(
    () => requireMaterials().preview({ materialId, version }),
    (value) => normalizePreview(value, materialId),
  );
}

export async function listMaterialContexts(workItemId: string): Promise<MaterialContext[]> {
  return wrap(
    () => requireContexts().list({ workItemId }),
    (value) => {
      const raw = asRaw(value);
      const list = Array.isArray(raw?.contexts) ? (raw.contexts as unknown[]) : [];
      return list
        .map(normalizeContext)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    },
  );
}

export async function createMaterialContext(
  workItemId: string,
  purpose: MaterialContextPurpose,
  refs: { materialId: string; version: number }[],
): Promise<MaterialContext> {
  return wrap(
    () => requireContexts().create({ workItemId, purpose, refs }),
    (value) => normalizeContext(asRaw(value)?.context ?? value),
  );
}

// ── 本机文件 ─────────────────────────────────────────────────────────────────

/** 超过这个体积就不在 renderer 里算指纹，直接交给服务层判重。 */
const MAX_HASH_BYTES = 256 * 1024 * 1024;

/** 拾取/拖入/粘贴得到的文件在磁盘上的真实路径；纯剪贴板位图没有。 */
export function localFilePathOf(file: File): string {
  try {
    return window.electronAPI.getFilePath(file) ?? '';
  } catch {
    return '';
  }
}

/** 本地内容指纹，仅用于「同名不同内容」的交互判定；权威指纹由宿主计算（R1/R2）。 */
export async function computeFileSha256(file: File): Promise<string | null> {
  if (!Number.isFinite(file.size) || file.size > MAX_HASH_BYTES) return null;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const buffer = await file.arrayBuffer();
    const digest = await subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}
