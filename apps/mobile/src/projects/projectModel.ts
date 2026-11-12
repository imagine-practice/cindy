/**
 * 手机端项目页的契约投影(2026-11-11《手机端项目页接口契约》v1)。
 *
 * 这里只做三件事,全部是可单测的纯函数:
 * - 把 `projects` 集合的列表摘要 / 详情 blocks 投影成页面能用的视图(形状不对就回落到
 *   `fallbackMarkdown`,绝不让半个字段进页面);
 * - 按契约 §4 生成写动作的 `input`(只带该阶段必需的备注字段,宿主对多余字段判 INVALID_PARAMS);
 * - 把宿主拒绝码翻成可读文案的 key。
 *
 * 权限一律由宿主判定(契约 §5);本文件只做展示与「别把明显不合法的请求发出去」的前置校验。
 */
import { resolveRemoteText, type RemoteCollectionItem, type RemoteResource, type RemoteActionField, type RemoteResourceBlock } from '@cindy/device-link';

export const PROJECT_COLLECTION_ID = 'projects';

/** 契约 §3 的五个 block;未登记的 primitive 只会有 fallbackMarkdown。 */
export const PROJECT_PRIMITIVES = [
  'project-summary',
  'project-progress',
  'project-work-items',
  'project-members',
  'project-group-link',
] as const;

export const PROJECT_STAGES = ['todo', 'doing', 'blocked', 'review', 'done'] as const;
export type ProjectStage = typeof PROJECT_STAGES[number];

/** 契约 §4 的动作 id。 */
export const PROJECT_ACTION = {
  recordProgress: 'project.recordProgress',
  setAssignee: 'project.setAssignee',
  archive: 'project.archive',
  unarchive: 'project.unarchive',
} as const;

export const PROJECT_MAX_NOTE_CHARS = 4000;

export interface ProjectSubject {
  kind: string;
  id: string;
  name: string;
}

export interface ProjectRowView {
  /** 不合法(内部 id / 路径 / 端点)时为 null,由页面换成可读兜底。 */
  title: string | null;
  goal: string | null;
  statusLabel: string | null;
  archived: boolean;
  /** 宿主给的徽标文案(成员数 / 任务数),按契约原样展示。 */
  badges: string[];
  updatedAt: number | null;
}

export interface ProjectSummaryView {
  projectId: string;
  name: string | null;
  goal: string | null;
  owner: ProjectSubject | null;
  archived: boolean;
  updatedAt: number | null;
}

export interface ProjectProgressEventView {
  id: string;
  title: string | null;
  from: ProjectStage | null;
  to: ProjectStage;
  at: number | null;
  actorName: string | null;
  note: string | null;
}

export interface ProjectProgressView {
  counts: Record<ProjectStage, number>;
  events: ProjectProgressEventView[];
}

export interface ProjectWorkItemView {
  sessionId: string;
  title: string;
  objective: string | null;
  status: ProjectStage | null;
  assignee: ProjectSubject | null;
  bindingRevision: number | null;
  /** 追加字段(契约允许):进度版本,带上就当严格并发校验用。 */
  progressRevision: number | null;
  updatedAt: number | null;
}

export interface ProjectMemberView extends ProjectSubject {
  role: string;
}

export interface ProjectGroupLinkView {
  groupName: string;
  status: string | null;
}

export type ProjectSection =
  | { kind: 'summary'; id: string; view: ProjectSummaryView }
  | { kind: 'progress'; id: string; view: ProjectProgressView }
  | { kind: 'work-items'; id: string; view: ProjectWorkItemView[] }
  | { kind: 'members'; id: string; view: ProjectMemberView[] }
  | { kind: 'group-link'; id: string; view: ProjectGroupLinkView }
  /** 未知 primitive,或已知 primitive 的 data 不合法:只渲染宿主给的 fallbackMarkdown。 */
  | { kind: 'fallback'; id: string; primitive: string; markdown: string };

export interface ProjectDetailView {
  sections: ProjectSection[];
  workItems: ProjectWorkItemView[];
  members: ProjectMemberView[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function bounded(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stage(value: unknown): ProjectStage | null {
  return typeof value === 'string' && (PROJECT_STAGES as readonly string[]).includes(value)
    ? value as ProjectStage
    : null;
}

const INTERNAL_ID_PREFIX = /^(?:account|bot|bot-group|local)(?:-[a-z0-9]+)?:/i;
const BARE_OPAQUE_ID = /^[a-z]+_[0-9a-f]{16,}$/i;
const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 绝对路径:POSIX、带盘符的 Windows、以及 `~/...`。 */
const ABSOLUTE_PATH = /^(?:\/|~[\\/]|[a-z]:[\\/])/i;
/** 服务端点与 Matrix 房间/别名的明文形态(契约 §2/§3 禁止出现在任何展示文案里)。 */
const ENDPOINT_OR_ROOM = /:\/\/|chat\.cindy\.app/i;
const MATRIX_ROOM_ID = /^[!#$][^:\s]{1,200}:/;

/**
 * 契约 §2/§3:不得把 `account:` / `bot:` / `local-v1:` 原始 id、绝对路径、服务端点或
 * roomId 明文当用户可见文案。宿主应当已经过滤;手机端在这里再兜一层(不依赖对端),
 * 不合法的取值一律返回 null,由页面换成「某位成员」「未填写目标」之类的可读兜底。
 */
export function readableRemoteText(value: unknown, max = 200): string | null {
  const text = bounded(value, max);
  if (!text) return null;
  if (INTERNAL_ID_PREFIX.test(text) || BARE_OPAQUE_ID.test(text) || UUID_ONLY.test(text)) return null;
  if (ABSOLUTE_PATH.test(text) || ENDPOINT_OR_ROOM.test(text) || MATRIX_ROOM_ID.test(text)) return null;
  return text;
}

/** 成员 / 负责人 / 处理人 / 操作者名字。 */
export function readableSubjectName(value: unknown): string | null {
  return readableRemoteText(value, 200);
}

function subject(value: unknown): ProjectSubject | null {
  const raw = record(value);
  if (!raw) return null;
  const kind = bounded(raw.kind, 40);
  const id = bounded(raw.id, 200);
  if (!kind || !id) return null;
  return { kind, id, name: readableSubjectName(raw.name) ?? '' };
}

// ---------------------------------------------------------------- 列表摘要

/** 契约 §2:列表只读 title / subtitle / status / badges / timestamp。 */
export function projectRowView(item: RemoteCollectionItem, locale: string): ProjectRowView {
  const display = item.display;
  const statusLabel = display.status ? resolveRemoteText(display.status.label, locale) || null : null;
  const badges = (display.badges ?? []).flatMap((badge) => {
    const label = badge.label ? resolveRemoteText(badge.label, locale) : '';
    return label ? [label] : [];
  });
  return {
    title: readableRemoteText(resolveRemoteText(display.title, locale), 512),
    goal: display.subtitle ? readableRemoteText(resolveRemoteText(display.subtitle, locale), 4_096) : null,
    statusLabel,
    // 契约 §2:进行中 = positive,已归档 = neutral。
    archived: display.status?.tone === 'neutral',
    badges: badges.slice(0, 4),
    updatedAt: finite(display.timestamp),
  };
}

// ---------------------------------------------------------------- 详情 blocks

function summaryView(data: Record<string, unknown>): ProjectSummaryView | null {
  const projectId = bounded(data.projectId, 200);
  if (!projectId) return null;
  const rawStatus = data.status;
  const statusText = typeof rawStatus === 'string'
    ? rawStatus
    : bounded(record(rawStatus)?.value, 40);
  return {
    projectId,
    name: readableRemoteText(data.name, 512),
    goal: readableRemoteText(data.goal, 20_000),
    owner: subject(data.owner),
    archived: statusText === 'archived',
    updatedAt: finite(data.updatedAt),
  };
}

function progressView(data: Record<string, unknown>): ProjectProgressView | null {
  const counts = record(data.counts);
  if (!counts) return null;
  const normalized = Object.fromEntries(PROJECT_STAGES.map((key) => [key, finite(counts[key]) ?? 0])) as Record<ProjectStage, number>;
  const rawEvents = Array.isArray(data.events) ? data.events : [];
  const events = rawEvents.slice(0, 20).flatMap<ProjectProgressEventView>((value) => {
    const event = record(value);
    const to = stage(event?.to);
    const id = bounded(event?.id, 200) ?? (typeof event?.id === 'number' && Number.isFinite(event.id) ? String(event.id) : null);
    if (!event || !to || !id) return [];
    return [{
      id,
      title: bounded(event.title, 512),
      from: stage(event.from),
      to,
      at: finite(event.at),
      actorName: readableSubjectName(event.actorName),
      note: bounded(event.note, 4_000),
    }];
  });
  return { counts: normalized, events };
}

function workItemsView(data: Record<string, unknown>): ProjectWorkItemView[] | null {
  if (!Array.isArray(data.items)) return null;
  return data.items.slice(0, 200).flatMap<ProjectWorkItemView>((value) => {
    const item = record(value);
    const sessionId = bounded(item?.sessionId, 200);
    const title = bounded(item?.title, 512);
    if (!item || !sessionId || !title) return [];
    return [{
      sessionId,
      title,
      objective: bounded(item.taskObjective, 20_000),
      status: stage(item.status),
      assignee: subject(item.assignee),
      bindingRevision: finite(item.bindingRevision),
      progressRevision: finite(item.progressRevision),
      updatedAt: finite(item.updatedAt),
    }];
  });
}

function membersView(data: Record<string, unknown>): ProjectMemberView[] | null {
  if (!Array.isArray(data.members)) return null;
  return data.members.slice(0, 100).flatMap<ProjectMemberView>((value) => {
    const member = record(value);
    const kind = bounded(member?.kind, 40);
    const id = bounded(member?.id, 200);
    const role = bounded(member?.role, 40);
    if (!member || !kind || !id || !role) return [];
    return [{ kind, id, role, name: readableSubjectName(member.name) ?? '' }];
  });
}

function groupLinkView(data: Record<string, unknown>): ProjectGroupLinkView | null {
  const groupName = readableRemoteText(data.groupName, 512);
  if (!groupName) return null;
  return { groupName, status: bounded(data.status, 40) };
}

/**
 * 按宿主返回的顺序投影详情。data 不合法的已知 primitive 也走 fallbackMarkdown,
 * 页面因此永远拿到「要么完整字段,要么宿主自己写的回落文本」。
 */
export function projectDetailView(resource: RemoteResource, locale: string): ProjectDetailView {
  const sections: ProjectSection[] = [];
  const workItems: ProjectWorkItemView[] = [];
  const members: ProjectMemberView[] = [];
  for (const block of (resource.blocks ?? []) as RemoteResourceBlock[]) {
    const data = record(block.data);
    const fallback = (): ProjectSection => ({ kind: 'fallback', id: block.id, primitive: block.primitive, markdown: block.fallbackMarkdown });
    if (!data) { sections.push(fallback()); continue; }
    if (block.primitive === 'project-summary') {
      const view = summaryView(data);
      sections.push(view ? { kind: 'summary', id: block.id, view } : fallback());
    } else if (block.primitive === 'project-progress') {
      const view = progressView(data);
      sections.push(view ? { kind: 'progress', id: block.id, view } : fallback());
    } else if (block.primitive === 'project-work-items') {
      const view = workItemsView(data);
      if (view) { workItems.push(...view); sections.push({ kind: 'work-items', id: block.id, view }); }
      else sections.push(fallback());
    } else if (block.primitive === 'project-members') {
      const view = membersView(data);
      if (view) { members.push(...view); sections.push({ kind: 'members', id: block.id, view }); }
      else sections.push(fallback());
    } else if (block.primitive === 'project-group-link') {
      const view = groupLinkView(data);
      sections.push(view ? { kind: 'group-link', id: block.id, view } : fallback());
    } else {
      sections.push(fallback());
    }
  }
  return { sections, workItems, members };
}

// ---------------------------------------------------------------- 进度写入

/** 与宿主 workItemProgressTx 冻结的同一张转移图;宿主仍会再判一次。 */
const TRANSITIONS: Record<ProjectStage, readonly ProjectStage[]> = {
  todo: ['doing', 'blocked', 'done'],
  doing: ['todo', 'blocked', 'review', 'done'],
  blocked: ['todo', 'doing'],
  review: ['doing', 'blocked', 'done'],
  done: ['doing'],
};

export function canRecordStage(from: ProjectStage | null, to: ProjectStage): boolean {
  if (from === null || from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export interface ProgressRequirements {
  reason: boolean;
  unblockCondition: boolean;
  resolution: boolean;
  completionNote: boolean;
}

/** 契约 §4「按 to 条件必填」:与宿主同一组规则,仅用于表单提示与前置校验。 */
export function progressRequirements(from: ProjectStage | null, to: ProjectStage): ProgressRequirements {
  return {
    reason: to === 'blocked',
    unblockCondition: to === 'blocked',
    resolution: from === 'blocked' && to !== 'blocked',
    completionNote: to === 'done',
  };
}

export interface ProgressDraft {
  sessionId: string;
  to: ProjectStage;
  reason: string;
  unblockCondition: string;
  resolution: string;
  completionNote: string;
}

export function emptyProgressDraft(sessionId: string, from: ProjectStage | null): ProgressDraft {
  return { sessionId, to: from ?? 'doing', reason: '', unblockCondition: '', resolution: '', completionNote: '' };
}

export type ProgressFieldId = keyof ProgressRequirements | 'sessionId';

/** 缺哪些必填项(表单在提交前点亮对应字段,不把注定被拒的请求发出去)。 */
export function progressMissingFields(draft: ProgressDraft, from: ProjectStage | null): ProgressFieldId[] {
  const required = progressRequirements(from, draft.to);
  const missing: ProgressFieldId[] = [];
  if (!draft.sessionId) missing.push('sessionId');
  for (const key of ['reason', 'unblockCondition', 'resolution', 'completionNote'] as const) {
    if (required[key] && !draft[key].trim()) missing.push(key);
  }
  return missing;
}

function clip(value: string): string {
  return value.trim().slice(0, PROJECT_MAX_NOTE_CHARS);
}

/**
 * 契约 §4 的 `project.recordProgress` 输入。只带本阶段合法的字段:宿主对多余字段一律
 * INVALID_PARAMS(例如非 blocked 阶段带 reason)。
 *
 * 宿主给了版本号就带上(严格并发,避免把别人刚写的进度覆盖掉);没给就让宿主按当前
 * 权威读推导。
 */
export function progressInput(draft: ProgressDraft, item: ProjectWorkItemView | null): Record<string, unknown> {
  const from = item?.status ?? null;
  const required = progressRequirements(from, draft.to);
  return {
    sessionId: draft.sessionId,
    to: draft.to,
    ...(item?.progressRevision !== null && item?.progressRevision !== undefined
      ? { expectedRevision: item.progressRevision } : {}),
    ...(item?.bindingRevision !== null && item?.bindingRevision !== undefined
      ? { expectedBindingRevision: item.bindingRevision } : {}),
    ...(required.reason || required.unblockCondition ? {
      reason: clip(draft.reason),
      unblockCondition: clip(draft.unblockCondition),
    } : {}),
    ...(required.resolution ? { resolution: clip(draft.resolution) } : {}),
    ...(required.completionNote ? { completionNote: clip(draft.completionNote) } : {}),
  };
}

/** `project.setAssignee`:成员用 `{kind,id}`,「未分配」用 `null`(与宿主 setAssignee 一致)。 */
export function assigneeInput(sessionId: string, assignee: ProjectSubject | null): Record<string, unknown> {
  return {
    sessionId,
    assignee: assignee ? { kind: assignee.kind, id: assignee.id } : null,
  };
}

/** 字段在表单里是否可选(宿主声明的 fields 只做展示;手机按契约固定渲染)。 */
export function actionField(action: { fields?: RemoteActionField[] } | null, id: string): RemoteActionField | null {
  return action?.fields?.find((field) => field.id === id) ?? null;
}

// ---------------------------------------------------------------- 拒绝原因

const KNOWN_ERROR_CODES = [
  'NOT_PROJECT_OWNER',
  'NOT_PROJECT_MEMBER',
  'PRECONDITION_FAILED',
  'REVISION_CONFLICT',
  'ILLEGAL_TRANSITION',
  'INVALID_PARAMS',
  'NOT_FOUND',
  'UNAVAILABLE',
] as const;

/** 宿主拒绝码 → `projects.errors.<CODE>`;未登记的码返回 null,由页面走通用远端错误文案。 */
export function projectErrorKey(error: unknown): string | null {
  const message = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : '';
  if (!message) return null;
  for (const code of KNOWN_ERROR_CODES) {
    if (new RegExp(`(^|[^A-Z_])${code}([^A-Z_]|$)`).test(message)) return `projects.errors.${code}`;
  }
  return null;
}
