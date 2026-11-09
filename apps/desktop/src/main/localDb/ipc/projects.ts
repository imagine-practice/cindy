import { BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';

import {
  PROJECTS_CHANGED_CHANNEL,
  PROJECTS_DETAIL_CHANNEL,
  PROJECTS_LIST_CHANNEL,
  PROJECTS_MUTATE_CHANNEL,
  isProjectSubjectKind,
  type ProjectDetail,
  type ProjectDir,
  type ProjectMember,
  type ProjectRecord,
  type ProjectSubject,
  type ProjectSubjectKind,
  type ProjectSubjectRef,
  type ProjectWorkItem,
  type ProjectsAction,
  type ProjectsMutation,
  type ProjectsMutationResult,
} from '../../../shared/projects';
import {
  canPerformProjectAction,
  canViewProject,
  projectAccessErrorCode,
  type ProjectAccessAction,
  type ProjectAccessMember,
  type ProjectAccessProject,
} from '../../../shared/projectAccess';

import { getDbClient, getCurrentDbClientSnapshot } from '../client/current';
import type { DbClient } from '../client/DbClient';
import { createLogger } from '../../logger';
import { requireObject, requireString, throwIpcError } from '../../utils/ipcValidate';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../../security/trustedAppRenderer';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
  tapWindowBroadcast,
  type DataOwnerBroadcastScope,
} from '../../device-link/broadcast-tap';
import { broadcastSessionPatched } from './sessions';

const log = createLogger('projects');

interface ProjectRow {
  id: string;
  name: string;
  goal: string | null;
  ownerId: string;
  status: 'active' | 'archived';
  createdAt: number;
  updatedAt: number;
}

interface MemberRow {
  projectId: string;
  subjectKind: ProjectSubjectKind;
  subjectId: string;
  role: 'owner' | 'member';
  addedAt: number;
}

interface DirRow {
  projectId: string;
  dirKey: string;
  dirPath: string;
}

interface BotRow {
  id: string;
  displayName: string;
  avatar: string;
  avatarColor: string;
}

const PROJECT_ROW_SQL =
  'SELECT id, name, goal, owner_id AS ownerId, status, created_at AS createdAt, updated_at AS updatedAt FROM projects';
const MEMBER_ROW_SQL =
  'SELECT project_id AS projectId, subject_kind AS subjectKind, subject_id AS subjectId, role, added_at AS addedAt FROM project_members';

/**
 * 主体展示名解析：伙伴读 `bot_profiles`，账号主体留给 renderer 用登录资料补全
 * （main 没有账号昵称的权威来源，也不该为了展示去拉账号资料）。
 */
function resolveSubject(
  ref: { kind: ProjectSubjectKind; id: string },
  bots: ReadonlyMap<string, BotRow>,
): ProjectSubject {
  if (ref.kind === 'bot') {
    const bot = bots.get(ref.id);
    return {
      kind: 'bot',
      id: ref.id,
      displayName: bot?.displayName ?? null,
      avatar: bot?.avatar ?? null,
      avatarColor: bot?.avatarColor ?? null,
    };
  }
  return { kind: 'account', id: ref.id, displayName: null, avatar: null, avatarColor: null };
}

function toMember(row: MemberRow, bots: ReadonlyMap<string, BotRow>): ProjectMember {
  return {
    subject: resolveSubject({ kind: row.subjectKind, id: row.subjectId }, bots),
    role: row.role,
    addedAt: new Date(row.addedAt).toISOString(),
  };
}

/** 负责人排最前，其余按加入时间——成员列表的稳定口径。 */
function sortMembers(members: ProjectMember[]): ProjectMember[] {
  return members.slice().sort((a, b) => {
    if (a.role !== b.role) return a.role === 'owner' ? -1 : 1;
    return a.addedAt.localeCompare(b.addedAt);
  });
}

function toRecord(
  row: ProjectRow,
  members: ProjectMember[],
  taskCount: number,
  dirs: ProjectDir[],
): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    ownerId: row.ownerId,
    status: row.status,
    members: sortMembers(members),
    taskCount,
    // 目录按加入时间稳定排序：同一项目的目录顺序不应随查询计划变化。
    dirs,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

async function readBots(client: DbClient): Promise<Map<string, BotRow>> {
  const rows = await client.query<BotRow>(
    'SELECT id, display_name AS displayName, avatar, avatar_color AS avatarColor FROM bot_profiles',
  );
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * 访问判定的主体来源（M3-A）。
 *
 * 默认是**当前登录账号**；伙伴侧工具调用可以显式传调用方身份 `{kind:'bot', id}`。
 * 显式传入时只认传入的那一个身份，绝不回落到当前账号；`null` = 「没有身份」，一律拒绝。
 *
 * IPC 入参（renderer 传来的对象）**不参与**身份判定：字符串身份在 renderer 可以随便伪造，
 * 身份只能由 main 决定。
 */
export type ProjectAccessActor = ProjectSubjectRef | null | undefined;

export function resolveProjectActor(actor?: ProjectAccessActor, client?: DbClient): ProjectSubjectRef | null {
  if (actor === null) return null;
  if (actor) {
    const usable =
      (actor.kind === 'account' || actor.kind === 'bot') &&
      typeof actor.id === 'string' &&
      actor.id.length > 0;
    return usable ? { kind: actor.kind, id: actor.id } : null;
  }
  // The active Profile client is authoritative in both worker and inproc mode.
  // The legacy inproc DB user can be null while the local-v1 worker is ready.
  const owner = getCurrentDbClientSnapshot();
  if (!owner?.userId || (client && owner.client !== client)) return null;
  return { kind: 'account', id: owner.userId };
}

function toAccessMembers(members: readonly ProjectMember[]): ProjectAccessMember[] {
  return members.map((member) => ({
    kind: member.subject.kind,
    id: member.subject.id,
    role: member.role,
  }));
}

/**
 * 读一个项目的判定快照（`owner_id` + 成员行）。项目不存在返回 `null`——存在性与
 * 「无权看」必须由调用方分开处理，不要用访问错误掩盖 `NOT_FOUND`。
 */
export async function readProjectAccess(
  projectId: string,
  client: DbClient = getDbClient(),
): Promise<ProjectAccessProject | null> {
  const row = await client.queryOne<{ ownerId: string }>(
    'SELECT owner_id AS ownerId FROM projects WHERE id = ?',
    [projectId],
  );
  if (!row) return null;
  const members = await client.query<{
    subjectKind: ProjectSubjectKind;
    subjectId: string;
    role: 'owner' | 'member';
  }>(
    'SELECT subject_kind AS subjectKind, subject_id AS subjectId, role FROM project_members WHERE project_id = ?',
    [projectId],
  );
  return {
    ownerId: row.ownerId,
    members: members.map((member) => ({
      kind: member.subjectKind,
      id: member.subjectId,
      role: member.role,
    })),
  };
}

/**
 * 写路径的访问闸门：项目必须存在，且主体对该动作有权限。
 *
 * 报错码由 `projectAccessErrorCode` 统一给出：成员级动作 → `NOT_PROJECT_MEMBER`，
 * 负责人级动作 → `NOT_PROJECT_OWNER`。
 */
export async function requireProjectAction(
  action: ProjectAccessAction,
  projectId: string,
  subject: ProjectSubjectRef | null,
  client: DbClient = getDbClient(),
): Promise<void> {
  const project = await readProjectAccess(projectId, client);
  if (!project) throwIpcError('NOT_FOUND', 'Project not found');
  if (canPerformProjectAction(action, project, subject)) return;
  throwIpcError(
    projectAccessErrorCode(action),
    projectAccessErrorCode(action) === 'NOT_PROJECT_OWNER'
      ? 'Only the project owner can do that'
      : 'Not a member of this project',
  );
}

async function readSessionProjectId(
  sessionId: string,
  client: DbClient,
): Promise<string | null> {
  const row = await client.queryOne<{ projectId: string | null }>(
    'SELECT project_id AS projectId FROM sessions WHERE id = ?',
    [sessionId],
  );
  return row?.projectId ?? null;
}

/** 项目读投影的未过滤版本，供带访问判定的公开入口复用。 */
async function readProjectRecords(client: DbClient): Promise<ProjectRecord[]> {
  const scope = captureDataOwnerBroadcastScope();
  const rows = await client.query<ProjectRow>(
    `${PROJECT_ROW_SQL} ORDER BY (status = 'active') DESC, updated_at DESC, name ASC`,
  );
  const memberRows = await client.query<MemberRow>(MEMBER_ROW_SQL);
  // 0154 之前的库没有 project_dirs：读投影降级为空目录，不让整个项目列表报错。
  let dirRows: DirRow[] = [];
  try {
    dirRows = await client.query<DirRow>(
      'SELECT project_id AS projectId, dir_key AS dirKey, dir_path AS dirPath FROM project_dirs ORDER BY created_at ASC, dir_key ASC',
    );
  } catch {
    dirRows = [];
  }
  const taskCounts = await client.query<{ projectId: string; taskCount: number }>(
    "SELECT project_id AS projectId, COUNT(*) AS taskCount FROM sessions WHERE project_id IS NOT NULL AND status <> 'deleted' GROUP BY project_id",
  );
  const bots = await readBots(client);
  if (!isDataOwnerBroadcastScopeCurrent(scope)) throwIpcError('NOT_FOUND', 'Owner changed');

  const membersByProject = new Map<string, ProjectMember[]>();
  for (const row of memberRows) {
    const list = membersByProject.get(row.projectId) ?? [];
    list.push(toMember(row, bots));
    membersByProject.set(row.projectId, list);
  }
  const dirsByProject = new Map<string, ProjectDir[]>();
  for (const row of dirRows) {
    const list = dirsByProject.get(row.projectId) ?? [];
    list.push({ dirKey: row.dirKey, dirPath: row.dirPath });
    dirsByProject.set(row.projectId, list);
  }
  const countByProject = new Map(taskCounts.map((row) => [row.projectId, row.taskCount]));
  return rows.map((row) =>
    toRecord(
      row,
      membersByProject.get(row.id) ?? [],
      countByProject.get(row.id) ?? 0,
      dirsByProject.get(row.id) ?? [],
    ),
  );
}

/**
 * 撤权在途收口：读出「此刻仍是该主体成员」的项目 id。
 *
 * 读路径的判定分两段，缺一不可：
 *   1. 发起读取前的判定只决定「这次读取值不值得做」；
 *   2. **最后一次异步查询之后、组装响应之前**必须再问一次「现在还是成员吗」。
 * 只做第 1 段时，成员行正好在异步查询期间被删除，已经复制到内存的项目名 / 目标 /
 * 任务数 / 工作项标题仍会被交出去。判定用 `(subject_kind, subject_id)` 精确匹配：
 * 只看 id 会把同命名空间里的另一个主体当成成员。
 */
async function readLiveMembershipProjectIds(
  subject: ProjectSubjectRef,
  client: DbClient,
  projectId?: string,
): Promise<Set<string>> {
  const rows =
    projectId === undefined
      ? await client.query<{ projectId: string }>(
          'SELECT project_id AS projectId FROM project_members WHERE subject_kind = ? AND subject_id = ?',
          [subject.kind, subject.id],
        )
      : await client.query<{ projectId: string }>(
          'SELECT project_id AS projectId FROM project_members WHERE subject_kind = ? AND subject_id = ? AND project_id = ?',
          [subject.kind, subject.id, projectId],
        );
  return new Set(rows.map((row) => row.projectId));
}

/** 复核主体身份没在读取期间被换掉：默认身份跟着当前 Profile，换人后旧结果作废。 */
function isSameSubjectRef(
  left: ProjectSubjectRef | null,
  right: ProjectSubjectRef | null,
): boolean {
  return !!left && !!right && left.kind === right.kind && left.id === right.id;
}

/**
 * 项目列表。**非成员的项目不出现**（而不是出现在列表里但点进去报错）：
 * 列表本身就是内容泄露面（名称、目标、成员数）。
 */
export async function listProjects(
  actor?: ProjectAccessActor,
  client: DbClient = getDbClient(),
): Promise<ProjectRecord[]> {
  const subject = resolveProjectActor(actor, client);
  // 没有身份就直接空集合：不读任何项目行，名称 / 目标也不进内存。
  if (!subject) return [];
  const scope = captureDataOwnerBroadcastScope();
  const records = await readProjectRecords(client);
  const visible = records.filter((record) =>
    canViewProject(toAccessMembers(record.members), subject),
  );
  // 没有可见行时没有内容可交出去，不必再为复核多读一次。
  if (visible.length === 0) return [];
  // 撤权在途收口：最后一次异步查询，之后只剩过滤与返回。
  const stillMember = await readLiveMembershipProjectIds(subject, client);
  if (!isDataOwnerBroadcastScopeCurrent(scope)) throwIpcError('NOT_FOUND', 'Owner changed');
  // 主体在读取期间被换掉（账号切换 / 客户端易主）时整批作废，不返回旧主体的结果。
  if (!isSameSubjectRef(resolveProjectActor(actor, client), subject)) return [];
  return visible.filter((record) => stillMember.has(record.id));
}

export async function readProjectDetail(
  projectId: string,
  actor?: ProjectAccessActor,
  client: DbClient = getDbClient(),
): Promise<ProjectDetail> {
  const scope = captureDataOwnerBroadcastScope();
  const subject = resolveProjectActor(actor, client);
  const project = (await readProjectRecords(client)).find((row) => row.id === projectId);
  if (!project) throwIpcError('NOT_FOUND', 'Project not found');
  // 详情 + 工作项是一次读：没有「看得见项目名但读不到任务」的中间态。
  if (!subject || !canViewProject(toAccessMembers(project.members), subject)) {
    throwIpcError('NOT_PROJECT_MEMBER', 'Not a member of this project');
  }
  const bots = await readBots(client);
  const rows = await client.query<{
    sessionId: string;
    title: string;
    status: string;
    assigneeKind: ProjectSubjectKind | null;
    assigneeId: string | null;
    updatedAt: number;
  }>(
    `SELECT id AS sessionId, title, status, assignee_kind AS assigneeKind, assignee_id AS assigneeId, updated_at AS updatedAt
       FROM sessions
      WHERE project_id = ? AND status <> 'deleted'
      ORDER BY updated_at DESC, id ASC`,
    [projectId],
  );
  // 撤权在途收口：工作项查询是最后一次内容读取，之后必须复核「此刻仍是成员」与
  // owner epoch，再组装响应。成员行在查询期间被删除时走既有拒绝路径，不返回标题。
  const stillMember = await readLiveMembershipProjectIds(subject, client, projectId);
  if (!isDataOwnerBroadcastScopeCurrent(scope)) throwIpcError('NOT_FOUND', 'Owner changed');
  if (!isSameSubjectRef(resolveProjectActor(actor, client), subject)) {
    throwIpcError('NOT_PROJECT_MEMBER', 'Not a member of this project');
  }
  if (!stillMember.has(projectId)) throwIpcError('NOT_PROJECT_MEMBER', 'Not a member of this project');
  const workItems: ProjectWorkItem[] = rows.map((row) => ({
    sessionId: row.sessionId,
    title: row.title,
    status: row.status,
    // 未分配就是 null；绝不回落到负责人。
    assignee:
      row.assigneeKind && isProjectSubjectKind(row.assigneeKind) && row.assigneeId
        ? resolveSubject({ kind: row.assigneeKind, id: row.assigneeId }, bots)
        : null,
    updatedAt: new Date(row.updatedAt).toISOString(),
  }));
  return { project, workItems };
}

/** 新建任务时校验绑定目标；创建路径不走项目事务，但仍要保证不写悬挂绑定。 */
export async function assertProjectBindable(
  projectId: string,
  actor?: ProjectAccessActor,
  client: DbClient = getDbClient(),
): Promise<void> {
  // 建任务也要判成员（P2）：非成员不能把任务塞进别人的项目。
  // 项目不存在在这里同样是 `NOT_FOUND`，与原来的存在性语义一致。
  await requireProjectAction('manageWorkItems', projectId, resolveProjectActor(actor, client), client);
  const row = await client.queryOne<{ status: string }>(
    'SELECT status FROM projects WHERE id = ?',
    [projectId],
  );
  if (!row) throwIpcError('NOT_FOUND', 'Project not found');
  if (row.status === 'archived') throwIpcError('PRECONDITION_FAILED', 'Project is archived');
}

function requireSubjectRef(raw: unknown, label: string): ProjectSubjectRef {
  const body = requireObject(raw, label);
  const kind = requireString(body.kind, `${label}.kind`);
  if (!isProjectSubjectKind(kind)) throwIpcError('INVALID_PARAMS', `invalid ${label}.kind`);
  return { kind, id: requireString(body.id, `${label}.id`) };
}

function requireOptionalString(raw: unknown, label: string): string | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return '';
  if (typeof raw !== 'string') throwIpcError('INVALID_PARAMS', `${label} must be a string`);
  return raw;
}

/**
 * 目录键只做形状校验：前缀决定作用域（local / remote / device），规范化与派生
 * 由调用方用 `projectKeys` 完成，IPC 不发明第二套路径口径。
 */
function requireDirKey(value: unknown): string {
  const key = requireString(value, 'dirKey');
  if (!/^(local:|remote:|device:)/.test(key)) throwIpcError('INVALID_PARAMS', 'invalid dirKey');
  return key;
}

function requireDirs(value: unknown): Array<{ dirKey: string; dirPath: string }> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throwIpcError('INVALID_PARAMS', 'input.dirs must be an array');
  return value.map((item, index) => {
    const body = requireObject(item, `input.dirs[${index}]`);
    return { dirKey: requireDirKey(body.dirKey), dirPath: requireString(body.dirPath, `input.dirs[${index}].dirPath`) };
  });
}

/** 把未经校验的 IPC 入参收敛成事务参数：id / 时间戳在这里注入，事务保持确定性。 */
type ProjectMutationIntent = ProjectsAction & { now: number; newId?: string };

function toMutation(raw: unknown, now: number): ProjectMutationIntent {
  const body = requireObject(raw, 'mutation');
  const action = requireString(body.action, 'action');
  switch (action) {
    case 'create': {
      const input = requireObject(body.input, 'input');
      const membersRaw = input.members;
      if (membersRaw !== undefined && membersRaw !== null && !Array.isArray(membersRaw)) {
        throwIpcError('INVALID_PARAMS', 'input.members must be an array');
      }
      const owner =
        input.owner === undefined || input.owner === null
          ? { kind: 'account' as const, id: requireCurrentAccountId() }
          : requireSubjectRef(input.owner, 'input.owner');
      return {
        action: 'create',
        newId: randomUUID(),
        now,
        input: {
          name: requireString(input.name, 'input.name'),
          goal: requireOptionalString(input.goal, 'input.goal') ?? null,
          owner,
          members: Array.isArray(membersRaw)
            ? membersRaw.map((member, index) => requireSubjectRef(member, `input.members[${index}]`))
            : [],
          dirs: requireDirs(input.dirs),
        },
      };
    }
    case 'update': {
      const status = body.status;
      if (status !== undefined && status !== 'active' && status !== 'archived') {
        throwIpcError('INVALID_PARAMS', 'invalid status');
      }
      return {
        action: 'update',
        projectId: requireString(body.projectId, 'projectId'),
        now,
        ...(body.name === undefined ? {} : { name: requireString(body.name, 'name') }),
        ...(body.goal === undefined
          ? {}
          : { goal: requireOptionalString(body.goal, 'goal') || null }),
        ...(status === undefined ? {} : { status }),
      };
    }
    case 'addMember':
      return {
        action: 'addMember',
        projectId: requireString(body.projectId, 'projectId'),
        subject: requireSubjectRef(body.subject, 'subject'),
        now,
      };
    case 'removeMember':
      return {
        action: 'removeMember',
        projectId: requireString(body.projectId, 'projectId'),
        subject: requireSubjectRef(body.subject, 'subject'),
        now,
      };
    case 'addDir':
      return {
        action: 'addDir',
        projectId: requireString(body.projectId, 'projectId'),
        dirKey: requireDirKey(body.dirKey),
        dirPath: requireString(body.dirPath, 'dirPath'),
        now,
      };
    case 'removeDir':
      return {
        action: 'removeDir',
        projectId: requireString(body.projectId, 'projectId'),
        dirKey: requireDirKey(body.dirKey),
        now,
      };
    case 'transferOwner':
      return {
        action: 'transferOwner',
        projectId: requireString(body.projectId, 'projectId'),
        subject: requireSubjectRef(body.subject, 'subject'),
        now,
      };
    case 'bindSession':
      return {
        action: 'bindSession',
        sessionId: requireString(body.sessionId, 'sessionId'),
        projectId:
          body.projectId === null || body.projectId === undefined
            ? null
            : requireString(body.projectId, 'projectId'),
        now,
      };
    case 'setAssignee':
      return {
        action: 'setAssignee',
        sessionId: requireString(body.sessionId, 'sessionId'),
        assignee:
          body.assignee === null || body.assignee === undefined
            ? null
            : requireSubjectRef(body.assignee, 'assignee'),
        now,
      };
    case 'delete':
      // 二次确认是界面责任；main 只做身份与存在性闸门，不接受任何客户端「已确认」标记。
      return { action: 'delete', projectId: requireString(body.projectId, 'projectId'), now };
    default:
      return throwIpcError('INVALID_PARAMS', `unknown project action: ${action}`);
  }
}

function requireCurrentAccountId(): string {
  const subject = resolveProjectActor();
  if (!subject || subject.kind !== 'account') throwIpcError('PRECONDITION_FAILED', 'No current Profile owner');
  return subject.id;
}

/** Main-only envelope, built from host identity rather than renderer identity fields. */
type ProjectMutationEnvelope = ProjectsMutation & { actor: ProjectSubjectRef };

/** Main-only lifecycle hooks, never accepted through raw IPC/tool input. */
export interface ProjectMutationGuard {
  beforeDispatch(): Promise<void>;
  dispatching(): void;
  notificationFailed(): void;
}

export async function mutateProjects(
  raw: unknown,
  actor?: ProjectAccessActor,
  client: DbClient = getDbClient(),
  guard?: ProjectMutationGuard,
): Promise<ProjectsMutationResult> {
  const scope = captureDataOwnerBroadcastScope();
  const subject = resolveProjectActor(actor, client);
  if (!subject) throwIpcError('PRECONDITION_FAILED', 'No trusted project actor');
  const mutation = toMutation(raw, Date.now());
  await assertProjectMutationAllowed(mutation, subject, client);
  const envelope: ProjectMutationEnvelope = { ...mutation, actor: subject };
  if (guard) await guard.beforeDispatch();
  guard?.dispatching();
  const result = await client.tx('projects.execute', envelope);
  if (!isDataOwnerBroadcastScopeCurrent(scope)) throwIpcError('NOT_FOUND', 'Owner changed');
  if (result.sessionId) {
    const row = await client.queryOne<{
      projectId: string | null;
      assigneeKind: ProjectSubjectKind | null;
      assigneeId: string | null;
    }>(
      'SELECT project_id AS projectId, assignee_kind AS assigneeKind, assignee_id AS assigneeId FROM sessions WHERE id = ?',
      [result.sessionId],
    );
    broadcastSessionPatched(
      result.sessionId,
      {
        projectId: row?.projectId ?? null,
        assigneeKind: row?.assigneeKind ?? null,
        assigneeId: row?.assigneeId ?? null,
      },
      scope,
    );
  }
  broadcastProjectsChanged(scope, guard?.notificationFailed);
  // 删项目会解绑任务：逐个补丁让侧栏与其他窗口立即回到「无项目」分组。
  for (const sessionId of result.unboundSessionIds ?? []) {
    if (!isDataOwnerBroadcastScopeCurrent(scope)) break;
    broadcastSessionPatched(
      sessionId,
      { projectId: null, assigneeKind: null, assigneeId: null },
      scope,
    );
  }
  return result;
}

/**
 * 写路径的访问闸门（M3-A）。
 *
 * 动作 → 所需角色见 `shared/projectAccess`：成员可建任务 / 绑项目 / 设处理人，
 * 改成员、转交负责人、改项目元数据只有负责人可做。事务层继续管不变式（负责人唯一、
 * 处理人必须是成员等），两层职责不重叠。
 */
async function assertProjectMutationAllowed(
  mutation: ProjectMutationIntent,
  subject: ProjectSubjectRef | null,
  client: DbClient,
): Promise<void> {
  switch (mutation.action) {
    case 'create':
      // 新项目没有既有成员可判：负责人跟着项目一起落库（缺省是当前账号），
      // 但仍然要求调用方有身份，否则会出现「匿名建的项目谁都看不见」。
      if (!subject) throwIpcError('PRECONDITION_FAILED', 'No signed-in account');
      return;
    case 'update':
      await requireProjectAction('updateProject', mutation.projectId, subject, client);
      return;
    case 'addMember':
      await requireProjectAction('addMember', mutation.projectId, subject, client);
      return;
    case 'removeMember':
      await requireProjectAction('removeMember', mutation.projectId, subject, client);
      return;
    case 'transferOwner': {
      // 账号成员可以把负责人接管给自己（伙伴不会点界面）；把负责人推给别人仍然只有
      // 现任负责人能做。两条路径都在事务层再判一次，这里只是把错误码说清楚。
      const selfTakeover =
        !!subject &&
        subject.kind === 'account' &&
        mutation.subject.kind === 'account' &&
        mutation.subject.id === subject.id;
      await requireProjectAction(
        selfTakeover ? 'claimOwnership' : 'transferOwner',
        mutation.projectId,
        subject,
        client,
      );
      return;
    }
    case 'addDir':
    case 'removeDir':
      // 目录决定此后新任务的默认归属，是项目级设置：负责人专属。
      await requireProjectAction('manageDirs', mutation.projectId, subject, client);
      return;
    case 'delete':
      // 真删除只能由负责人发起：驱动码按「所需角色」给，不行的是 NOT_PROJECT_OWNER。
      await requireProjectAction('deleteProject', mutation.projectId, subject, client);
      return;
    case 'bindSession': {
      // 解绑也要判：否则非成员可以把别人的任务从项目里摘出去。
      const currentProjectId = await readSessionProjectId(mutation.sessionId, client);
      if (currentProjectId) {
        await requireProjectAction('manageWorkItems', currentProjectId, subject, client);
      }
      if (mutation.projectId && mutation.projectId !== currentProjectId) {
        await requireProjectAction('manageWorkItems', mutation.projectId, subject, client);
      }
      return;
    }
    case 'setAssignee': {
      const currentProjectId = await readSessionProjectId(mutation.sessionId, client);
      // 未绑定项目的历史任务没有项目边界，交给事务层的规则处理。
      if (currentProjectId) {
        await requireProjectAction('manageWorkItems', currentProjectId, subject, client);
      }
      return;
    }
  }
}

function broadcastProjectsChanged(scope: DataOwnerBroadcastScope, notificationFailed?: () => void): void {
  if (!isDataOwnerBroadcastScopeCurrent(scope)) return;
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (isTrustedAppRendererWindow(window)) {
        window.webContents.send(PROJECTS_CHANGED_CHANNEL, {}, scope.ownerStamp);
      }
    } catch {
      log.warn('project renderer broadcast failed');
      notificationFailed?.();
    }
  }
  // A closed renderer must not turn an already committed write into a failed request.
  try {
    tapWindowBroadcast(PROJECTS_CHANGED_CHANNEL, {}, scope.ownerStamp);
  } catch {
    log.warn('project device-link broadcast failed');
    notificationFailed?.();
  }
}

export function registerProjectsIpc(): void {
  ipcMain.handle(PROJECTS_LIST_CHANNEL, async (event) => {
    assertTrustedAppRendererEvent(event);
    return listProjects();
  });
  ipcMain.handle(PROJECTS_DETAIL_CHANNEL, async (event, projectId: unknown) => {
    assertTrustedAppRendererEvent(event);
    return readProjectDetail(requireString(projectId, 'projectId'));
  });
  ipcMain.handle(PROJECTS_MUTATE_CHANNEL, async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    return mutateProjects(raw);
  });
}
