/** R1 view helpers only. Public material values come from shared/materials. */
import type {
  Material,
  MaterialVersion,
  MaterialReadState,
  MaterialContextPurpose,
  MaterialContextRef,
  MaterialFileInput,
} from '../../../shared/materials';
export type {
  Material,
  MaterialVersion,
  MaterialReadState,
  MaterialContextPurpose,
  MaterialContextRef,
  MaterialContext,
  MaterialScope,
  MaterialFileInput,
  MaterialPreview as MaterialPreviewPayload,
  MaterialsAddResult as MaterialAddResult,
  MaterialDuplicate as MaterialDuplicateNotice,
} from '../../../shared/materials';
export type MaterialReferenceService = ReturnType<
  typeof import('./materialReferenceService').createMaterialReferenceService
>;
export type TaskMaterialScope = Extract<
  import('../../../shared/materials').MaterialScope,
  { workItemId: string }
>;
export const NO_LOCAL_PATH = 'NO_LOCAL_PATH';
export const MATERIALS_UNAVAILABLE = 'MATERIALS_UNAVAILABLE';
export const CONFLICT_CANCELLED = 'CONFLICT_CANCELLED';
export function materialErrorCode(error: unknown): string {
  const raw = error as { code?: unknown; message?: unknown } | null;
  return typeof raw?.code === 'string'
    ? raw.code
    : typeof raw?.message === 'string'
      ? (/\[([A-Z_]+)\]/.exec(raw.message)?.[1] ?? 'UNKNOWN')
      : 'UNKNOWN';
}
export function materialSourceIssue(error: unknown): string | null {
  return sourceIssueOf(materialErrorCode(error), error instanceof Error ? error.message : '');
}
export function isScopeInvalidation(error: unknown): boolean {
  return [
    'FORBIDDEN',
    'PROJECT_MISMATCH',
    'PROJECT_NOT_FOUND',
    'NOT_FOUND',
    'SESSION_DELETED',
    'REFERENCE_SCOPE_REQUIRED',
    'BINDING_CONFLICT',
    'REFERENCE_MISMATCH',
    'REFERENCE_NOT_FOUND',
    'PRECONDITION_FAILED',
  ].includes(materialErrorCode(error));
}
export class MaterialWritePendingError extends Error {
  readonly code = 'WRITE_PENDING';
}
export function localFilePathOf(file: File): string {
  try {
    return window.electronAPI.getFilePath(file) ?? '';
  } catch {
    return '';
  }
}
export async function computeFileSha256(file: File): Promise<string | null> {
  if (file.size > 32 * 1024 * 1024 || !globalThis.crypto?.subtle) return null;
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  } catch {
    return null;
  }
}
/** 时间戳展示：ISO 字符串 → 本地时间；缺失或无法解析时如实显示占位。 */
export function formatMaterialTime(value: string | null | undefined): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString();
}

/** The selected reference is authoritative; never infer the maximum catalogue version. */
export function currentVersionNumber(material: Material): number {
  return material.reference.version;
}

export function currentVersionOf(material: Material): MaterialVersion | null {
  const target = currentVersionNumber(material);
  return material.versions.find((version) => version.version === target) ?? null;
}

/** 当前可读状态：服务层的 material 级字段优先，否则回落到当前版本。 */
export function materialReadState(material: Material): MaterialReadState {
  return material.readState;
}

/** 失败原因只在失败态显示；其它状态不得拿它当说明（R2）。 */
export function materialFailureReason(material: Material): string | null {
  if (materialReadState(material) !== 'failed') return null;
  return currentVersionOf(material)?.failureReason ?? null;
}

/**
 * 原文件问题不是普通解析失败：要单独说明并引导重新关联，不能只说「读取失败」，
 * 也不能拿旧内容顶替。返回 null 表示这是普通失败原因（保留服务层原文）。
 */
export function sourceIssueKey(reason: string | null | undefined): string | null {
  switch (reason) {
    case 'SOURCE_MISSING':
      return 'ccAgent.materials.sourceMissing';
    case 'SOURCE_CHANGED':
      return 'ccAgent.materials.sourceChanged';
    default:
      return null;
  }
}

/** 快照引用等紧凑位置用的短说明。 */
export function sourceIssueShortKey(reason: string | null | undefined): string | null {
  switch (reason) {
    case 'SOURCE_MISSING':
      return 'ccAgent.materials.sourceMissingShort';
    case 'SOURCE_CHANGED':
      return 'ccAgent.materials.sourceChangedShort';
    default:
      return null;
  }
}

/** 从错误码或错误正文里认出原文件问题（预览/重试可能以 VERSION_NOT_READABLE 抛出）。 */
export function sourceIssueOf(
  code: string | null | undefined,
  message: string | null | undefined,
): string | null {
  if (code === 'SOURCE_MISSING' || code === 'SOURCE_CHANGED') return code;
  const text = message ?? '';
  if (text.includes('SOURCE_CHANGED')) return 'SOURCE_CHANGED';
  if (text.includes('SOURCE_MISSING')) return 'SOURCE_MISSING';
  return null;
}

export function readStateLabelKey(state: MaterialReadState): string {
  return `ccAgent.materials.readState.${state}`;
}

export function purposeLabelKey(purpose: MaterialContextPurpose): string {
  return `ccAgent.materials.snapshot.purpose.${purpose}`;
}

export function materialErrorKey(code: string | null | undefined): string {
  switch (code) {
    case 'FORBIDDEN':
    case 'PROJECT_MISMATCH':
    case 'NOT_FOUND':
    case 'SESSION_DELETED':
      return 'ccAgent.materials.error.accessChanged';
    case 'PRECONDITION_FAILED':
      return 'ccAgent.materials.error.referenceHost';
    case 'REFERENCE_SCOPE_REQUIRED':
    case 'BINDING_CONFLICT':
    case 'REFERENCE_MISMATCH':
    case 'REFERENCE_NOT_FOUND':
      return 'ccAgent.materials.error.scopeChanged';
    case 'CONTEXT_SCOPE_UNKNOWN':
      return 'ccAgent.materials.error.contextScopeUnknown';
    case 'INVALID_PARAMS':
      return 'ccAgent.materials.error.invalidParams';
    case 'MATERIAL_NOT_FOUND':
      return 'ccAgent.materials.error.notFound';
    case 'VERSION_NOT_FOUND':
      return 'ccAgent.materials.error.versionNotFound';
    case 'VERSION_NOT_READABLE':
      return 'ccAgent.materials.error.notReadable';
    case 'DUPLICATE_CONTENT':
      return 'ccAgent.materials.error.duplicateContent';
    case 'UNSUPPORTED_FILE':
      return 'ccAgent.materials.error.unsupportedFile';
    case 'MEDIA_WRITE_FAILED':
      return 'ccAgent.materials.error.mediaWriteFailed';
    case 'SOURCE_MISSING':
      return 'ccAgent.materials.error.sourceMissing';
    case 'SOURCE_CHANGED':
      return 'ccAgent.materials.error.sourceChanged';
    case 'PROJECT_NOT_FOUND':
      return 'ccAgent.materials.error.projectNotFound';
    case NO_LOCAL_PATH:
      return 'ccAgent.materials.error.noLocalPath';
    case MATERIALS_UNAVAILABLE:
      return 'ccAgent.materials.error.unavailable';
    case CONFLICT_CANCELLED:
      return 'ccAgent.materials.error.conflictCancelled';
    default:
      return 'ccAgent.materials.error.generic';
  }
}

/** 版本历史永远从新到旧；同版本号只保留一条，避免服务层重复投影造成重复行。 */
export function versionHistory(material: Material): MaterialVersion[] {
  const seen = new Set<number>();
  const list: MaterialVersion[] = [];
  for (const version of [...material.versions].sort((a, b) => b.version - a.version)) {
    if (seen.has(version.version)) continue;
    seen.add(version.version);
    list.push(version);
  }
  return list;
}

export interface SplitMaterials {
  active: Material[];
  removed: Material[];
}

/** 已移除引用仍然可见（可追溯），但和当前引用分开显示，避免误以为还在生效。 */
export function splitMaterials(materials: readonly Material[]): SplitMaterials {
  const active: Material[] = [];
  const removed: Material[] = [];
  for (const material of materials) {
    (material.reference.status === 'removed' ? removed : active).push(material);
  }
  const byName = (a: Material, b: Material): number =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  active.sort(byName);
  removed.sort(byName);
  return { active, removed };
}

export interface PendingMaterialFile extends MaterialFileInput {
  /** 本地算出的内容指纹；拿不到（超大文件 / 无 Web Crypto）时为 null。 */
  sha256: string | null;
}

export interface NameConflict {
  /** 待添加文件在批次里的下标。 */
  index: number;
  file: PendingMaterialFile;
  /** 同名且内容不同的现有材料。 */
  material: Material;
}

/**
 * 同名不同内容必须由用户显式选择（R4）。
 *
 * 判据只看「当前引用」的材料：已移除的材料不拦，用户重新添加同名文件应当能直接加回来。
 * 指纹相同不拦——那是同内容沿用（R3），交给服务层的 `duplicates` 提示。
 * 指纹算不出来时按冲突处理：宁可多问一次，也不静默落一个新 material。
 */
export function findNameConflicts(
  materials: readonly Material[],
  files: readonly PendingMaterialFile[],
): NameConflict[] {
  const activeByName = new Map<string, Material>();
  for (const material of materials) {
    if (material.status === 'removed') continue;
    const existing = activeByName.get(material.name);
    // 极端情况下服务层允许同名材料并存（用户显式新建的），取最近更新的那个作为对照。
    if (!existing || Date.parse(material.updatedAt) > Date.parse(existing.updatedAt)) {
      activeByName.set(material.name, material);
    }
  }
  const conflicts: NameConflict[] = [];
  files.forEach((file, index) => {
    const material = activeByName.get(file.name);
    if (!material) return;
    if (file.sha256 && currentVersionOf(material)?.sha256 === file.sha256) return;
    conflicts.push({ index, file, material });
  });
  return conflicts;
}

export type ContextRefAvailability =
  'bound' | 'materialRemoved' | 'materialMissing' | 'versionMissing';

export interface ContextRefView {
  ref: MaterialContextRef;
  material: Material | null;
  version: MaterialVersion | null;
  /** 绑定时材料还在、版本还在；否则说明为什么看不到它。 */
  availability: ContextRefAvailability;
  /** 该版本现在的读取状态；版本已不可见时为 null。 */
  currentReadState: MaterialReadState | null;
  /** 当前版本的失败原因，用于区分「原文件已改/已删」与普通解析失败。 */
  currentFailureReason: string | null;
  /** 原文件问题对应的短文案 key；普通失败为 null。 */
  currentIssueKey: string | null;
}

/**
 * 把快照引用接到当前材料表上。
 *
 * 这里刻意不把「当前读取状态」写成绑定状态：`readStateAtPin` 是历史事实，
 * 旧快照不会因为后来重试成功或材料被移除而改写（A4/A5/A8）。
 */
export function contextRefViews(
  refs: readonly MaterialContextRef[],
  materials: readonly Material[],
): ContextRefView[] {
  const byId = new Map(materials.map((material) => [material.id, material]));
  return refs.map((ref) => {
    const material = byId.get(ref.materialId) ?? null;
    if (!material) {
      return {
        ref,
        material: null,
        version: null,
        availability: 'materialMissing',
        currentReadState: null,
        currentFailureReason: null,
        currentIssueKey: null,
      };
    }
    const version = material.versions.find((item) => item.version === ref.version) ?? null;
    if (!version) {
      return {
        ref,
        material,
        version: null,
        availability: material.status === 'removed' ? 'materialRemoved' : 'versionMissing',
        currentReadState: null,
        currentFailureReason: null,
        currentIssueKey: null,
      };
    }
    return {
      ref,
      material,
      version,
      availability: material.status === 'removed' ? 'materialRemoved' : 'bound',
      currentReadState: version.readState,
      currentFailureReason: version.readState === 'failed' ? version.failureReason : null,
      currentIssueKey:
        version.readState === 'failed' ? sourceIssueShortKey(version.failureReason) : null,
    };
  });
}

/** 只把仍在当前引用里的材料算作「可绑定」；已移除的旧材料仍能在旧快照里被读到。 */
export function bindableMaterials(materials: readonly Material[]): Material[] {
  return splitMaterials(materials).active;
}
