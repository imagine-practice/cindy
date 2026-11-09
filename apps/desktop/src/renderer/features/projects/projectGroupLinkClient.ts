/**
 * 群 ↔ 项目关联的 renderer 客户端。
 *
 * 只拼固定公共意图（`shared/projectGroupLinks.ts`）：`list` 按当前群与项目的成员身份读，
 * `link` / `unlink` 每次带一枚动作级 `requestId` 与显式 `expectedRevision`。同一动作的
 * 同一意图复用同一枚 `requestId`（重试不会变成第二次请求），成功后释放，因此连点或重试
 * 都不会在本地账本里留下第二条关系。
 *
 * 关系的当前状态只认重新读取的列表：回执里的 `current` 只用来判断这次动作的分类
 * （linked / unlinked / unchanged），`commit` 从不冒充当前状态。
 *
 * 群在聊天服务器上的定位由 main 解析出的 `chatApiBaseUrl` 与房间 UUID 组成；旧宿主
 * 不导出端点、本机群与伙伴私聊没有服务器房间，这些情况一律返回 null，由调用方说明原因。
 */
import type { BotGroupSummary } from '../../../shared/botGroupChat';
import type {
  ProjectGroupLink,
  ProjectGroupLinkChange,
  ProjectGroupLinkErrorCode,
  ProjectGroupLinksResponse,
} from '../../../shared/projectGroupLinks';

/** 只含公共协议字段的群定位，不含授权对象或群资料。 */
export interface ProjectGroupLinkGroup { endpoint: string; roomId: string }
export interface ProjectGroupLinkTarget { accountId: string; deviceId: string; projectId: string }
/** main 是否已证明本地提交；`unknown` 表示发出写调用后没拿到确定回执。 */
export type ProjectGroupLinkCommitState = 'not-committed' | 'committed' | 'unknown';

export class ProjectGroupLinkError extends Error {
  constructor(
    readonly code: ProjectGroupLinkErrorCode,
    readonly commitState: ProjectGroupLinkCommitState,
  ) {
    super(`project group link: ${code}`);
    this.name = 'ProjectGroupLinkError';
  }
}

type Bridge = Window['electronAPI']['localDb']['projectGroupLinks'];

function bridge(): Bridge | null {
  return window.electronAPI?.localDb?.projectGroupLinks ?? null;
}

const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ENDPOINT_MAX_LENGTH = 2048;
const PAGE_LIMIT = 100;
const MAX_PAGES = 5;

/** 当前宿主解析出的聊天服务器基址：与 main 一致，去掉尾部斜杠。旧宿主没有这个字段。 */
export function projectGroupLinkEndpoint(): string | null {
  const raw = window.electronAPI?.clientEndpoints?.chatApiBaseUrl;
  if (typeof raw !== 'string') return null;
  const endpoint = raw.trim().replace(/\/+$/u, '');
  return endpoint.length > 0 && endpoint.length <= ENDPOINT_MAX_LENGTH ? endpoint : null;
}

/** 宿主是否提供了关联所需的通道与端点；旧宿主上整块只说明不可用。 */
export function projectGroupLinkAvailable(): boolean {
  const api = bridge();
  return api !== null && typeof api.listProject === 'function' && projectGroupLinkEndpoint() !== null;
}

/**
 * 这个群在聊天服务器上的定位；本机群、伙伴私聊的落地页、缺房间 UUID 或宿主端点时
 * 返回 null——这些群没有可关联的服务器房间。
 */
export function projectGroupLinkGroup(
  group: Pick<BotGroupSummary, 'id' | 'serverBacked' | 'conversationKind'>,
): ProjectGroupLinkGroup | null {
  if (group.serverBacked !== true || group.conversationKind === 'direct') return null;
  const endpoint = projectGroupLinkEndpoint();
  if (!endpoint || !ROOM_ID.test(group.id)) return null;
  return { endpoint, roomId: group.id.toLowerCase() };
}

/** 当前电脑在 device-link 里的自身标识；缺失时无法形成本机关联目标。 */
export async function projectGroupLinkDeviceId(): Promise<string | null> {
  try {
    const value = await window.electronAPI?.getDeviceId?.();
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

const actionIds = new Map<string, string>();

function newRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `pgl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function actionKey(action: string, intent: string): string {
  return `${action}\u0000${intent}`;
}

/** 同一动作的同一意图复用同一枚 requestId：重试不会变成第二次请求。 */
export function projectGroupLinkRequestId(action: string, intent: string): string {
  const key = actionKey(action, intent);
  const existing = actionIds.get(key);
  if (existing) return existing;
  const created = newRequestId();
  actionIds.set(key, created);
  return created;
}

/** 提交成功后释放这一枚 requestId，下一次动作是新的请求。 */
export function releaseProjectGroupLinkRequestId(action: string, intent: string): void {
  actionIds.delete(actionKey(action, intent));
}

/** 仅测试：清掉跨用例残留的动作标识。 */
export function resetProjectGroupLinkRequestIds(): void {
  actionIds.clear();
}

function asFailure(response: ProjectGroupLinksResponse): ProjectGroupLinkError | null {
  return response.ok ? null : new ProjectGroupLinkError(response.errorCode, response.commitState);
}

export interface ProjectGroupLinkRows {
  /** 当前真实关系（`status: 'active'`），渲染以它为准。 */
  active: ProjectGroupLink[];
  /** 每个项目当前行的 revision（含已解除的行），作为 `link` 的 expectedRevision 基线。 */
  revisions: Map<string, number>;
}

/**
 * 读取这个群的关系。`includeRemoved` 会带回已解除的行，用来算重新关联时需要的
 * `expectedRevision`；它需要群配置权限，调用方要允许退回只看当前关系。
 */
export async function readProjectGroupLinks(
  group: ProjectGroupLinkGroup,
  options: { includeRemoved?: boolean } = {},
): Promise<ProjectGroupLinkRows> {
  const api = bridge();
  if (!api) throw new ProjectGroupLinkError('UNSUPPORTED_CAPABILITY', 'not-committed');
  const rows: ProjectGroupLink[] = [];
  let cursor: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await api.list({
        action: 'list', group, limit: PAGE_LIMIT,
        ...(options.includeRemoved ? { includeRemoved: true } : {}),
        ...(cursor === undefined ? {} : { cursor }),
      });
      const failure = asFailure(response);
      if (failure) throw failure;
      if (!('links' in response) || !('nextCursor' in response)) throw new ProjectGroupLinkError('INTERNAL', 'not-committed');
      rows.push(...response.links);
      cursor = response.nextCursor ?? undefined;
      if (cursor === undefined) break;
    }
  } catch (error) {
    throw error instanceof ProjectGroupLinkError ? error : new ProjectGroupLinkError('INTERNAL', 'not-committed');
  }
  const revisions = new Map<string, number>();
  for (const row of rows) revisions.set(row.target.projectId, row.revision);
  return { active: rows.filter(row => row.status === 'active'), revisions };
}

/** 按项目读到的本机关联（只含 `status: 'active'` 的行）。 */
export interface ProjectGroupLinksByProject {
  links: ProjectGroupLink[];
  /** 结果被宿主上限截断：不得当成「全部关联」。 */
  truncated: boolean;
}

/**
 * 按项目读这个项目被本机哪些群关联。
 *
 * 与按群 `list` 的区别：这是一次只读查询，不需要群配置权限、不需要 `requestId`，
 * 也没有游标；范围由 main 用「当前账号 + 本机设备 + 项目成员资格」封闭。
 * 返回的 locator 只是记录，不是发消息的授权——发送时群通道会自己再鉴权。
 */
export async function readProjectGroupLinksByProject(projectId: string): Promise<ProjectGroupLinksByProject> {
  const api = bridge();
  // 旧宿主没有这条通道：按「不支持」处理，不冒充「没有关联群」。
  if (!api || typeof api.listProject !== 'function') throw new ProjectGroupLinkError('UNSUPPORTED_CAPABILITY', 'not-committed');
  let response: Awaited<ReturnType<typeof api.listProject>>;
  try {
    response = await api.listProject({ action: 'list-project', projectId });
  } catch {
    throw new ProjectGroupLinkError('INTERNAL', 'not-committed');
  }
  const failure = asFailure(response);
  if (failure) throw failure;
  if (!('links' in response) || typeof response.truncated !== 'boolean') {
    throw new ProjectGroupLinkError('INTERNAL', 'not-committed');
  }
  // 只认这个项目的 active 行：别的项目或已解除的关系都不进本页。
  const links = response.links.filter(row => row.status === 'active' && row.target.projectId === projectId);
  return { links, truncated: response.truncated };
}

export interface LinkProjectToGroupInput extends ProjectGroupLinkTarget {
  group: ProjectGroupLinkGroup;
  expectedRevision: number;
}

export async function linkProjectToGroup(input: LinkProjectToGroupInput): Promise<ProjectGroupLinkChange> {
  const api = bridge();
  if (!api) throw new ProjectGroupLinkError('UNSUPPORTED_CAPABILITY', 'not-committed');
  const intent = [input.group.endpoint, input.group.roomId, input.accountId, input.deviceId,
    input.projectId, String(input.expectedRevision)].join('|');
  const requestId = projectGroupLinkRequestId('link', intent);
  let response: ProjectGroupLinksResponse;
  try {
    response = await api.link({
      action: 'link', requestId, group: input.group, expectedRevision: input.expectedRevision,
      target: { accountId: input.accountId, deviceId: input.deviceId, projectId: input.projectId },
    });
  } catch {
    throw new ProjectGroupLinkError('INTERNAL', 'unknown');
  }
  const failure = asFailure(response);
  if (failure) throw failure;
  if (!('current' in response)) throw new ProjectGroupLinkError('INTERNAL', 'unknown');
  releaseProjectGroupLinkRequestId('link', intent);
  return response.change;
}

export interface UnlinkProjectFromGroupInput extends ProjectGroupLinkTarget {
  group: ProjectGroupLinkGroup;
  relationId: string;
  expectedRevision: number;
}

export async function unlinkProjectFromGroup(input: UnlinkProjectFromGroupInput): Promise<ProjectGroupLinkChange> {
  const api = bridge();
  if (!api) throw new ProjectGroupLinkError('UNSUPPORTED_CAPABILITY', 'not-committed');
  const intent = [input.group.endpoint, input.group.roomId, input.accountId, input.deviceId,
    input.projectId, input.relationId, String(input.expectedRevision)].join('|');
  const requestId = projectGroupLinkRequestId('unlink', intent);
  let response: ProjectGroupLinksResponse;
  try {
    response = await api.unlink({
      action: 'unlink', requestId, relationId: input.relationId, group: input.group,
      expectedRevision: input.expectedRevision,
      target: { accountId: input.accountId, deviceId: input.deviceId, projectId: input.projectId },
    });
  } catch {
    throw new ProjectGroupLinkError('INTERNAL', 'unknown');
  }
  const failure = asFailure(response);
  if (failure) throw failure;
  if (!('current' in response)) throw new ProjectGroupLinkError('INTERNAL', 'unknown');
  releaseProjectGroupLinkRequestId('unlink', intent);
  return response.change;
}

/** 固定错误码 → 用户能照做的说法；未登记的错误码统一走通用一句。 */
export function projectGroupLinkErrorKey(code: ProjectGroupLinkErrorCode): string {
  switch (code) {
    case 'NOT_PROJECT_OWNER': return 'projectGroupLinks.errors.notProjectOwner';
    case 'NOT_PROJECT_MEMBER': return 'projectGroupLinks.errors.notProjectMember';
    case 'GROUP_ACCESS_DENIED': return 'projectGroupLinks.errors.groupAccessDenied';
    case 'GROUP_CONFIGURATION_REQUIRED': return 'projectGroupLinks.errors.groupConfigurationRequired';
    case 'GROUP_AUTHORIZATION_UNAVAILABLE': return 'projectGroupLinks.errors.groupAuthorizationUnavailable';
    case 'REVISION_CONFLICT': return 'projectGroupLinks.errors.revisionConflict';
    case 'REQUEST_CONFLICT': return 'projectGroupLinks.errors.requestConflict';
    case 'RELATION_NOT_FOUND': return 'projectGroupLinks.errors.relationNotFound';
    case 'HOST_NOT_READY': return 'projectGroupLinks.errors.hostNotReady';
    case 'UNSUPPORTED_CAPABILITY': return 'projectGroupLinks.errors.unsupported';
    case 'OWNER_SCOPE_CHANGED': return 'projectGroupLinks.errors.ownerScopeChanged';
    default: return 'projectGroupLinks.errors.failed';
  }
}
