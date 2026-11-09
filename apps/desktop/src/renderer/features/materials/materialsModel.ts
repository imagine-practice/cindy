/**
 * 工作项材料（M2-B）界面侧数据模型与纯逻辑。
 *
 * 契约正本：`docs/plans/2026-11-05-materials-contract-draft.md`（已冻结）。
 * 这里只做三件事：
 *   1. 把契约第 1/3 节的数据结构写成 renderer 侧类型；
 *   2. 把「当前版本 / 当前读取状态 / 同名冲突 / 快照引用可读性」这类判断收成纯函数，
 *      让界面与测试共用同一口径；
 *   3. 把服务层错误码翻成 i18n key（文案在 locale 文件里，不在这里硬编码）。
 *
 * 不在这里做的事：不推断服务器规则、不缓存字节、不伪造 IPC。
 * 版本不可变（R3）、重试只改同一版本（R7）、快照不倒改旧依据（A4/A8）都由服务层保证，
 * 界面只负责把「已绑定的是哪一版」和「现在还能不能读」如实显示出来。
 */

/** 单个版本的读取状态。`pending` 不得被界面说成已读（R2）。 */
export type MaterialReadState = 'pending' | 'ready' | 'failed';

/** 移除只改软状态（R5）：记录仍在，字节不删。 */
export type MaterialStatus = 'active' | 'removed';

export type MaterialContextPurpose = 'reference' | 'redecompose' | 'recheck';

export type MaterialCreatorKind = 'account' | 'bot';

/** 材料字节的两种合法形态（契约 0.1）：媒体入仓，非媒体只引用原文件。 */
export type MaterialStorageKind = 'media' | 'file';

export interface MaterialVersion {
  id: string;
  materialId: string;
  /** 从 1 递增，`(materialId, version)` 唯一。 */
  version: number;
  /** 宿主按真实字节计算的内容指纹。空串表示服务层没给，界面不得自行编造。 */
  sha256: string;
  sizeBytes: number;
  mime: string;
  /**
   * 存储形态（契约 0.1）：`media` 是 cindy-media 受管引用；`file` 只引用用户原文件，
   * 不复制字节。界面只用它做说明——地址一律取 `materials:preview` 的 url，
   * 不解析、不拼接 `storage_ref`（该字段不对外）。
   */
  storageKind: MaterialStorageKind;
  readState: MaterialReadState;
  failureReason: string | null;
  /** ISO 8601 字符串（服务层契约）；不要当数字用。 */
  createdAt: string;
}

export interface Material {
  id: string;
  projectId: string;
  /** null = 项目级材料；工作项面板只展示归属本工作项的材料。 */
  workItemId: string | null;
  /** 用户原始文件名，只作展示。 */
  name: string;
  status: MaterialStatus;
  createdByKind: MaterialCreatorKind;
  createdById: string;
  /** ISO 8601 字符串。 */
  createdAt: string;
  /** ISO 8601 字符串。 */
  updatedAt: string;
  /** 当前引用的版本号；列表接口缺省时由版本表推导。 */
  currentVersion: number;
  /** 当前版本的读取状态；列表接口缺省时由版本表推导。 */
  readState: MaterialReadState;
  versions: MaterialVersion[];
}

export interface MaterialContextRef {
  materialId: string;
  version: number;
  /** 绑定时该版本的读取状态——之后重试成功也不改写它。 */
  readStateAtPin: MaterialReadState;
}

/** 参考快照，不可变；执行与候选验收只记录它的 id。 */
export interface MaterialContext {
  id: string;
  workItemId: string;
  purpose: MaterialContextPurpose;
  refs: MaterialContextRef[];
  createdByKind: MaterialCreatorKind;
  createdById: string;
  /** ISO 8601 字符串。 */
  createdAt: string;
}

export interface MaterialDuplicateNotice {
  name: string;
  materialId: string;
  version: number;
}

export interface MaterialRejection {
  name: string;
  code: string;
}

export interface MaterialAddResult {
  added: MaterialVersion[];
  duplicates: MaterialDuplicateNotice[];
  rejected: MaterialRejection[];
}

export interface MaterialPreviewPayload {
  kind: 'image' | 'text' | 'unsupported';
  url?: string;
  text?: string;
  name: string;
  mime: string;
  size: number;
}

export interface MaterialFileInput {
  name: string;
  path: string;
  /** Only an explicit same-name conflict choice authorizes a separate material. */
  sameNameAction?: 'create-new';
}

/** 界面自己判定的失败原因：没有可交给服务层的本机路径（如剪贴板位图）。 */
export const NO_LOCAL_PATH = 'NO_LOCAL_PATH';
/** 通道还没在当前构建里出现（M2-A 未合并时）。 */
export const MATERIALS_UNAVAILABLE = 'MATERIALS_UNAVAILABLE';
/** 同名冲突时用户取消：文件不落库（R4「未选择不提交」）。 */
export const CONFLICT_CANCELLED = 'CONFLICT_CANCELLED';

export const MATERIAL_ERROR_CODES = [
  'MATERIAL_NOT_FOUND',
  'VERSION_NOT_FOUND',
  'VERSION_NOT_READABLE',
  'DUPLICATE_CONTENT',
  'UNSUPPORTED_FILE',
  'MEDIA_WRITE_FAILED',
  'SOURCE_MISSING',
  'SOURCE_CHANGED',
  'PROJECT_NOT_FOUND',
  NO_LOCAL_PATH,
  MATERIALS_UNAVAILABLE,
  CONFLICT_CANCELLED,
] as const;

export type MaterialErrorCode = (typeof MATERIAL_ERROR_CODES)[number];

const READ_STATES: readonly MaterialReadState[] = ['pending', 'ready', 'failed'];

export function isMaterialReadState(value: unknown): value is MaterialReadState {
  return typeof value === 'string' && (READ_STATES as readonly string[]).includes(value);
}

export function isMaterialStatus(value: unknown): value is MaterialStatus {
  return value === 'active' || value === 'removed';
}

export function isMaterialContextPurpose(value: unknown): value is MaterialContextPurpose {
  return value === 'reference' || value === 'redecompose' || value === 'recheck';
}

export function isMaterialStorageKind(value: unknown): value is MaterialStorageKind {
  return value === 'media' || value === 'file';
}

export function isMaterialErrorCode(value: unknown): value is MaterialErrorCode {
  return typeof value === 'string' && (MATERIAL_ERROR_CODES as readonly string[]).includes(value);
}

/** 时间戳展示：ISO 字符串 → 本地时间；缺失或无法解析时如实显示占位。 */
export function formatMaterialTime(value: string | null | undefined): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString();
}

/** 当前引用的版本号：优先用服务层给的 `currentVersion`，缺失时取最大版本号。 */
export function currentVersionNumber(material: Material): number {
  if (Number.isFinite(material.currentVersion) && material.currentVersion > 0) {
    return material.currentVersion;
  }
  let max = 0;
  for (const version of material.versions) {
    if (version.version > max) max = version.version;
  }
  return max;
}

export function currentVersionOf(material: Material): MaterialVersion | null {
  const target = currentVersionNumber(material);
  return material.versions.find((version) => version.version === target) ?? null;
}

/** 当前可读状态：服务层的 material 级字段优先，否则回落到当前版本。 */
export function materialReadState(material: Material): MaterialReadState {
  if (isMaterialReadState(material.readState)) return material.readState;
  return currentVersionOf(material)?.readState ?? 'pending';
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
    (material.status === 'removed' ? removed : active).push(material);
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

export function versionOptions(material: Material): { value: string; label: string; disabled: boolean }[] {
  return versionHistory(material).map((version) => ({
    value: String(version.version),
    label: `v${version.version}`,
    disabled: false,
  }));
}

export type ContextRefAvailability = 'bound' | 'materialRemoved' | 'materialMissing' | 'versionMissing';

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
