/** Local group/project link protocol. No group grant, title or execution in public values. */
import { parseClientEndpointManifest } from '../../../../packages/maker-shared/src/clientEndpointSchema';

export interface ProjectGroupLinkGroup { endpoint: string; roomId: string }
export interface ProjectGroupLinkTarget { accountId: string; deviceId: string; projectId: string }
export type ProjectGroupLinkStatus = 'active' | 'removed';
export interface ProjectGroupLink {
  relationId: string;
  group: ProjectGroupLinkGroup;
  target: ProjectGroupLinkTarget;
  status: ProjectGroupLinkStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectGroupLinksListIntent {
  action: 'list'; group: ProjectGroupLinkGroup;
  includeRemoved?: boolean; cursor?: string; limit?: number;
}
/**
 * 按项目读本机关联（项目侧「已关联群」与「同步到群」的目标列表）。
 *
 * 与按群 `list` 的分工：`list` 问「这个群关联了哪些项目」，需要群配置/读取权限并有分页；
 * 这里问「这个项目被本机哪些群关联」，范围由当前账号 + 本机设备 + 项目成员资格决定，
 * 只读、无 requestId、无游标。它不是授权凭据：发送仍由群通道自己鉴权。
 */
export interface ProjectGroupLinksListProjectIntent { action: 'list-project'; projectId: string }
export interface ProjectGroupLinkIntent {
  action: 'link'; requestId: string; group: ProjectGroupLinkGroup;
  target: ProjectGroupLinkTarget; expectedRevision: number;
}
export interface ProjectGroupUnlinkIntent {
  action: 'unlink'; requestId: string; group: ProjectGroupLinkGroup;
  target: ProjectGroupLinkTarget; relationId: string; expectedRevision: number;
}
export type ProjectGroupLinksIntent = ProjectGroupLinksListIntent | ProjectGroupLinksListProjectIntent
  | ProjectGroupLinkIntent | ProjectGroupUnlinkIntent;
export interface ProjectGroupLinksListResult {
  ok: true; contractRevision: 1; links: ProjectGroupLink[]; nextCursor: string | null;
}
/** `truncated` 为真表示结果被上限截断，调用方不得把这份列表当成「全部关联」。 */
export interface ProjectGroupLinksProjectListResult {
  ok: true; contractRevision: 1; links: ProjectGroupLink[]; truncated: boolean;
}
export type ProjectGroupLinkChange = 'linked' | 'unlinked' | 'unchanged';
export interface ProjectGroupLinkMutationResult {
  ok: true; contractRevision: 1; requestId: string; replayed: boolean; change: ProjectGroupLinkChange;
  commit: { relationId: string; revision: number; statusAtCommit: ProjectGroupLinkStatus };
  /** Current authorized row, never the old receipt's status projected as current. */
  current: ProjectGroupLink;
}
export type ProjectGroupLinksResult = ProjectGroupLinksListResult | ProjectGroupLinksProjectListResult
  | ProjectGroupLinkMutationResult;
export const PROJECT_GROUP_LINK_ERROR_CODES = [
  'INVALID_PARAMS','UNSUPPORTED_CAPABILITY','HOST_NOT_READY','OWNER_SCOPE_CHANGED',
  'GROUP_ACCESS_DENIED','GROUP_CONFIGURATION_REQUIRED','GROUP_AUTHORIZATION_UNAVAILABLE',
  'NOT_PROJECT_MEMBER','NOT_PROJECT_OWNER','RELATION_NOT_FOUND','REVISION_CONFLICT','REQUEST_CONFLICT','INTERNAL',
] as const;
export type ProjectGroupLinkErrorCode = typeof PROJECT_GROUP_LINK_ERROR_CODES[number];
export interface ProjectGroupLinksFailure {
  ok: false; errorCode: ProjectGroupLinkErrorCode; message: string;
  commitState: 'not-committed' | 'committed' | 'unknown';
}
export type ProjectGroupLinksResponse = ProjectGroupLinksResult | ProjectGroupLinksFailure;

function record(v: unknown, required: string[], optional: string[] = []): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r=v as Record<string,unknown>;
  return required.every(k=>Object.prototype.hasOwnProperty.call(r,k))
    && Object.keys(r).every(k=>required.includes(k)||optional.includes(k)) ? r : null;
}
function id(v: unknown, max=200): v is string {
  return typeof v==='string' && v.length>0 && v.length<=max && !/\s/u.test(v)
    && !Array.from(v).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127);
}
/** Same endpoint normalization as existing configuration; no lowercasing of URL paths. */
export function normalizeProjectGroupLinkEndpoint(value: unknown): string | null {
  if(typeof value!=='string'||value.length>2048||Array.from(value).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))return null;
  const parsed=parseClientEndpointManifest(JSON.stringify({schemaVersion:1,chatApiBaseUrl:value}),{allowHttp:true});
  if(!parsed.ok||!parsed.endpoints.chatApiBaseUrl)return null;
  const endpoint=parsed.endpoints.chatApiBaseUrl,url=new URL(endpoint);
  return url.search||url.hash?null:endpoint;
}
/** Public intent parser: rejects actor/grant/canManage and all other non-protocol fields. */
export function parseProjectGroupLinksIntent(value: unknown): ProjectGroupLinksIntent | null {
  try {
    if(!value||typeof value!=='object'||Array.isArray(value))return null;
    const action=(value as Record<string,unknown>).action;
    const v=action==='list'?record(value,['action','group'],['includeRemoved','cursor','limit']):
      action==='list-project'?record(value,['action','projectId']):
      action==='link'?record(value,['action','requestId','group','target','expectedRevision']):
      action==='unlink'?record(value,['action','requestId','group','target','expectedRevision','relationId']):null;
    if(!v)return null;
    // 项目范围读取没有群定位：只有 projectId，其余字段一律拒绝。
    if(action==='list-project')return id(v.projectId)?{action,projectId:v.projectId}:null;
    const g=record(v.group,['endpoint','roomId']);
    if(!g||typeof g.roomId!=='string'||g.roomId.length!==36||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(g.roomId))return null;
    const endpoint=normalizeProjectGroupLinkEndpoint(g.endpoint);
    if(!endpoint)return null;
    const group={endpoint,roomId:g.roomId.toLowerCase()};
    if(action==='list') {
      if(v.includeRemoved!==undefined&&typeof v.includeRemoved!=='boolean')return null;
      if(v.cursor!==undefined&&(typeof v.cursor!=='string'||!v.cursor.length||v.cursor.length>32768))return null;
      if(v.limit!==undefined&&(typeof v.limit!=='number'||!Number.isInteger(v.limit)||v.limit<1||v.limit>100))return null;
      return {action,group,includeRemoved:v.includeRemoved===true,limit:v.limit===undefined?50:v.limit as number,
        ...(v.cursor===undefined?{}:{cursor:v.cursor as string})};
    }
    const t=record(v.target,['accountId','deviceId','projectId']);
    if(!t||!id(t.accountId)||!id(t.deviceId,500)||!id(t.projectId)||!id(v.requestId)
      ||typeof v.expectedRevision!=='number'||!Number.isSafeInteger(v.expectedRevision)||v.expectedRevision<0)return null;
    const target={accountId:t.accountId,deviceId:t.deviceId,projectId:t.projectId};
    const common={requestId:v.requestId,group,target,expectedRevision:v.expectedRevision};
    if(action==='link')return {action,...common};
    return action==='unlink'&&id(v.relationId)?{action,...common,relationId:v.relationId}:null;
  } catch { return null; }
}
