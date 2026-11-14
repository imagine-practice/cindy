import { randomUUID } from 'node:crypto';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState';
import { getCurrentDbClientSnapshot } from '../localDb/client/current';
import { DB_TRANSPORT_NOT_SENT, DB_TRANSPORT_OUTCOME_UNKNOWN } from '../localDb/client/DbTransport';
import type { BotGroupChatService } from '../maker-ipc/botGroupChatService';
import { authorizeGroupTool } from '../maker-ipc/botGroupToolAuthorization';
import { captureEntityProjectAuthority, type EntityProjectRuntime } from './entityProjectAuthority';
import { listProjects } from '../localDb/ipc/projects';
import { normalizeProjectGroupLinkEndpoint, parseProjectGroupLinksIntent, PROJECT_GROUP_LINK_ERROR_CODES,
  type ProjectGroupLinkErrorCode, type ProjectGroupLinksFailure, type ProjectGroupLinksResponse,
  type ProjectGroupLinksResult } from '../../shared/projectGroupLinks';

/** Main-owned capabilities only. Neither this runtime nor callerSessionId is public input. */
export interface ProjectGroupLinksMainRuntime {
  groupService(): Pick<BotGroupChatService, 'groupAuthority'> | null;
  /** device-link/index#getSelfDeviceId: cached last ACK, equality only, never online proof. */
  currentDeviceId(): string | null;
  validateWorkDir?(dir:string): Promise<boolean>;
  onChanged?(roomId:string): void;
}

/** Read the explicit local selection. No relation/selection means legacy folder
 * resolution; an invalid explicit selection must throw, never silently fall back. */
export async function readLinkedGroupWorkDir(roomId: string, runtime: ProjectGroupLinksMainRuntime, displayOnly=false) {
  if (!/^[0-9a-f-]{36}$/i.test(roomId)) return null;
  const owner = getCurrentDbClientSnapshot();
  if (!owner?.userId || isAppSessionBoundaryPending()) deny('HOST_NOT_READY');
  const captured = owner!;
  const deviceId = runtime.currentDeviceId();
  const stamp = activeOwnerScopeKey();
  const current = () => {
    if (isAppSessionBoundaryPending() || getCurrentDbClientSnapshot() !== captured || activeOwnerScopeKey() !== stamp
      || getActiveAppSession().dataOwnerId !== captured.userId || runtime.currentDeviceId() !== deviceId) deny('OWNER_SCOPE_CHANGED');
  };
  const query = () => captured.client.query<{id:string;endpoint:string;dirKey:string;dir:string|null;kind:'account'|'bot';ownerId:string;
    linkedKind:string|null;linkedId:string|null;member:number;status:string;revision:number}>(`SELECT l.id,l.group_endpoint AS endpoint,
      l.work_dir_key AS dirKey,d.dir_path AS dir,m.subject_kind AS kind,m.subject_id AS ownerId,
      l.linked_owner_kind AS linkedKind,l.linked_owner_id AS linkedId,p.status,l.revision,
      EXISTS(SELECT 1 FROM project_members x WHERE x.project_id=l.project_id AND x.subject_kind='account' AND x.subject_id=?) AS member
      FROM project_group_links l JOIN projects p ON p.id=l.project_id
      LEFT JOIN project_members m ON m.project_id=l.project_id AND m.role='owner'
      LEFT JOIN project_dirs d ON d.project_id=l.project_id AND d.dir_key=l.work_dir_key
        AND d.remote_host_id IS NULL AND d.agent_device_id IS NULL
      WHERE l.resource_account_id=? AND l.group_room_id=? AND l.work_dir_key IS NOT NULL
        AND l.status='active' AND (? IS NULL OR l.resource_device_id=?)`,
    [captured.userId,captured.userId,roomId,deviceId,deviceId]);
  const rows = await query(); current();
  if (!rows.length) return null;
  if (!deviceId || rows.length !== 1) deny('HOST_NOT_READY');
  const selected = rows[0];
  if (displayOnly) {
    if (selected.status !== 'active' || !selected.member || !selected.dir || selected.kind !== selected.linkedKind || selected.ownerId !== selected.linkedId) deny('GROUP_ACCESS_DENIED');
    // Group list rendering reads only local facts. Actual use below always
    // reauthorizes remotely; a directory label is never an execution grant.
    return {dir:selected.dir!,refresh:async()=>{throw new Error('Display projection is not execution authority');}};
  }
  const service = runtime.groupService();
  if (!service?.groupAuthority) deny('UNSUPPORTED_CAPABILITY');
  let grant = await service!.groupAuthority!.capture(roomId,'read',{subject:{kind:'account',id:captured.userId},assertCurrent:current});
  const validate = () => {
    current();grant.assertCurrent();
    if (runtime.groupService() !== service || grant.facts.endpoint !== selected.endpoint
      || selected.status !== 'active' || !selected.member || !selected.dir || !selected.dirKey.startsWith('local:')
      || selected.kind !== selected.linkedKind || selected.ownerId !== selected.linkedId
      || !grant.projectOwnerJoined?.({kind:selected.kind,id:selected.ownerId})) deny('GROUP_ACCESS_DENIED');
  };
  validate();
  const refresh = async () => {
    validate(); grant = await grant.refresh(); validate();
    const latest = await query(); validate();
    if (JSON.stringify(latest) !== JSON.stringify(rows)) deny('GROUP_ACCESS_DENIED');
  };
  await refresh();
  return {dir:selected.dir!,refresh};
}
export interface ProjectGroupLinksUiRuntime extends ProjectGroupLinksMainRuntime {
  /** Revalidate the real trusted app-renderer event/lifetime; never a renderer boolean. */
  assertTrustedUi(): void;
}
export interface ProjectGroupLinksTaskRuntime extends ProjectGroupLinksMainRuntime, EntityProjectRuntime {}

class Rejected extends Error {
  constructor(readonly code: ProjectGroupLinkErrorCode) { super('Project group link unavailable'); }
}
const deny = (code: ProjectGroupLinkErrorCode): never => { throw new Rejected(code); };
const CALLER = `SELECT json_array(s.source,s.status,s.remote_host_id,s.agent_device_id,
  b.bot_id,b.role,b.archived_at,p.status,p.canonical_session_id) AS identity,b.bot_id AS botId,b.role
  FROM sessions s LEFT JOIN bot_session_links b ON b.session_id=s.id
  LEFT JOIN bot_profiles p ON p.id=b.bot_id WHERE s.id=?`;
type Caller = { identity: string; botId: string | null; role: string | null };

/** Native account entry. The integrator must bind assertTrustedUi to its genuine event guard. */
export function coordinateProjectGroupLinksFromUi(raw: unknown, runtime: ProjectGroupLinksUiRuntime): Promise<ProjectGroupLinksResponse> {
  return coordinate(raw, runtime, { assertTrustedUi: () => runtime.assertTrustedUi() });
}
/** Formal task entry; no account fallback and no synthetic Session for UI callers. */
export function coordinateProjectGroupLinksFromTask(raw: unknown, callerSessionId: string, runtime: ProjectGroupLinksTaskRuntime): Promise<ProjectGroupLinksResponse> {
  return coordinate(raw, runtime, { callerSessionId, runtime });
}

/** Only the acknowledged DB result proves a commit. Remote group checks and SQLite cannot
 * be atomic: a late denial suppresses metadata but preserves the actual commit classification.
 */
async function coordinate(raw: unknown, runtime: ProjectGroupLinksMainRuntime,
  source: { assertTrustedUi(): void } | { callerSessionId: string; runtime: EntityProjectRuntime },
): Promise<ProjectGroupLinksResponse> {
  let commitState: ProjectGroupLinksFailure['commitState'] = 'not-committed';
  try {
    const intent = parseProjectGroupLinksIntent(raw);
    if (!intent) return deny('INVALID_PARAMS');
    // 按项目查询是独立只读入口（无群定位、无写账本），不进这条群授权协调链。
    if (intent.action === 'list-project') return deny('UNSUPPORTED_CAPABILITY');
    const ownerInGroup = intent.policy === 'owner-in-group';
    const needsProjectOwner = ownerInGroup && (intent.action === 'link' || (intent.action === 'set-work' && intent.dirKey !== null));
    const clearing = ownerInGroup && (intent.action === 'unlink' || (intent.action === 'set-work' && intent.dirKey === null));
    const owner = getCurrentDbClientSnapshot();
    if (!owner?.userId || isAppSessionBoundaryPending()) return deny('HOST_NOT_READY');
    const ownerKey = activeOwnerScopeKey();
    const deviceId = runtime.currentDeviceId();
    if (!deviceId) return deny('UNSUPPORTED_CAPABILITY');
    const service = runtime.groupService();
    const groupService = service?.groupAuthority;
    if (!groupService) return deny('UNSUPPORTED_CAPABILITY');
    const core = 'callerSessionId' in source
      ? await captureEntityProjectAuthority(source.callerSessionId, source.runtime) : null;
    const actor = core?.actor ?? { kind: 'account' as const, id: owner.userId };
    const assertLocal = () => {
      if (isAppSessionBoundaryPending() || getCurrentDbClientSnapshot() !== owner || activeOwnerScopeKey() !== ownerKey
        || getActiveAppSession().dataOwnerId !== owner.userId || (core && core.client !== owner.client)) deny('OWNER_SCOPE_CHANGED');
      if (runtime.currentDeviceId() !== deviceId) deny('UNSUPPORTED_CAPABILITY');
      if (runtime.groupService() !== service || service.groupAuthority !== groupService) deny('GROUP_AUTHORIZATION_UNAVAILABLE');
      if ('assertTrustedUi' in source) source.assertTrustedUi();
      core?.assertCurrent();
    };
    assertLocal();
    if (intent.action !== 'list' && (intent.target.accountId !== owner.userId || intent.target.deviceId !== deviceId)) deny('UNSUPPORTED_CAPABILITY');
    const caller = 'callerSessionId' in source
      ? await owner.client.queryOne<Caller>(CALLER, [source.callerSessionId]) : null;
    assertLocal();
    if ('callerSessionId' in source && !caller) deny('GROUP_ACCESS_DENIED');
    // Extra synchronous source lease fence covers the final asynchronous SQL read.
    const lease = caller?.role === 'group' && caller.botId && 'callerSessionId' in source
      ? await authorizeGroupTool(source.callerSessionId, caller.botId, 'owner-action') : null;
    const assertCurrent = () => { assertLocal(); lease?.assertCurrent(); };
    assertCurrent();
    const permission = intent.action === 'list' && !intent.includeRemoved ? 'read' : 'configure';
    let group = await groupService.capture(intent.group.roomId, permission, { subject: actor, assertCurrent });
    const projectOwner = needsProjectOwner
      ? await owner.client.queryOne<{kind:'account'|'bot';id:string}>(
        "SELECT subject_kind AS kind,subject_id AS id FROM project_members WHERE project_id=? AND role='owner'",
        [intent.target.projectId]) : undefined;
    const assertGroup = () => {
      assertCurrent(); group.assertCurrent();
      if (group.facts.ownerId !== owner.userId || group.facts.permission !== permission
        || normalizeProjectGroupLinkEndpoint(group.facts.endpoint) !== intent.group.endpoint
        || group.facts.roomId.toLowerCase() !== intent.group.roomId) deny('GROUP_ACCESS_DENIED');
      if (ownerInGroup && typeof group.projectOwnerJoined !== 'function') deny('UNSUPPORTED_CAPABILITY');
      if (needsProjectOwner
        && (!projectOwner || !group.projectOwnerJoined!(projectOwner))) deny('GROUP_ACCESS_DENIED');
    };
    assertGroup();
    const refresh = async (ids: readonly string[] = []) => {
      assertCurrent();
      await core?.refresh(ids);
      assertCurrent();
      await lease?.refresh();
      assertCurrent();
      group = await group.refresh(); // A invalidates the prior object, including on failure.
      assertGroup();
    };
    await refresh(intent.action === 'list' || clearing ? [] : [intent.target.projectId]);
    assertGroup();
    let workDirPath: string | undefined;
    if (intent.action === 'set-work' && intent.dirKey !== null) {
      const directory = await owner.client.queryOne<{path:string}>(
        'SELECT dir_path AS path FROM project_dirs WHERE project_id=? AND dir_key=? AND remote_host_id IS NULL AND agent_device_id IS NULL',
        [intent.target.projectId,intent.dirKey]);
      assertGroup();
      if (!directory || !runtime.validateWorkDir) deny('UNSUPPORTED_CAPABILITY');
      if (!await runtime.validateWorkDir!(directory!.path)) deny('INVALID_PARAMS');
      assertGroup();workDirPath=directory!.path;
    }
    const context = { actor, accountId: owner.userId, deviceId, group: intent.group, now: Date.now(),
      ...(ownerInGroup ? { authorization: { policy: 'owner-in-group' as const,
        ...(projectOwner ? { projectOwner } : {}), ...(workDirPath ? {workDirPath}: {}) } } : {}) };
    const args = { intent, context, ...(intent.action === 'link' ? { newRelationId: randomUUID() } : {}) };
    let result: ProjectGroupLinksResult;
    try {
      if (intent.action !== 'list') commitState = 'unknown';
      result = await owner.client.tx<ProjectGroupLinksResult>('projectGroupLinks.execute', args);
      if (intent.action !== 'list') commitState = 'committed';
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      // Exact frozen B rollback response, or a transport's explicit not-sent outcome.
      // An unknown ACK always wins over message text; arbitrary exceptions remain unknown.
      const rejection = error instanceof Error && /^\[(INVALID_PARAMS|UNSUPPORTED_CAPABILITY|NOT_PROJECT_OWNER|NOT_PROJECT_MEMBER|RELATION_NOT_FOUND|REVISION_CONFLICT|REQUEST_CONFLICT|INTERNAL)\] Project group link request rejected$/.test(error.message);
      if (code === DB_TRANSPORT_NOT_SENT || (code !== DB_TRANSPORT_OUTCOME_UNKNOWN
        && (code === undefined || code === 'WORKER_RPC_ERROR') && rejection)) commitState = 'not-committed';
      throw error;
    }
    assertGroup();
    const visibleProjects = ownerInGroup && intent.action === 'list'
      ? await listProjects(actor, owner.client) : [];
    assertGroup();
    const ids = [...new Set([...('links' in result ? result.links.map(row => row.target.projectId) : [result.current.target.projectId]),
      ...visibleProjects.map(project => project.id)])];
    await refresh(clearing || (ownerInGroup && intent.action === 'list') ? visibleProjects.map(project=>project.id) : ids);
    // One last DB snapshot rechecks exact current membership and task identity. No await
    // follows this query: late local owner/device/input/lease changes fail synchronously.
    const currentId = 'current' in result ? result.current.relationId : null;
    const final = await owner.client.queryOne<{ permitted: string; callerIdentity: string | null;
      current: string | null; projectOwners: string }>(`/* project-group-links-final */
      SELECT (SELECT json_group_array(m.project_id) FROM project_members m JOIN projects p ON p.id=m.project_id
        WHERE m.subject_kind=? AND m.subject_id=? AND m.role IN (${permission === 'configure' && !ownerInGroup ? "'owner'" : "'owner','member'"})) AS permitted,
      ${'callerSessionId' in source ? ` (SELECT identity FROM (${CALLER}))` : 'NULL'} AS callerIdentity,
      (SELECT json_group_array(json_object('projectId',project_id,'kind',subject_kind,'id',subject_id))
        FROM project_members WHERE role='owner') AS projectOwners,
      (SELECT json_object('status',l.status,'revision',l.revision,'createdAt',l.created_at,'updatedAt',l.updated_at
        ${ownerInGroup ? ", 'workDirKey',l.work_dir_key,'linkedOwner',CASE WHEN l.linked_owner_kind IS NULL THEN NULL ELSE json_object('kind',l.linked_owner_kind,'id',l.linked_owner_id) END" : ''})
        FROM project_group_links l WHERE l.id=? AND l.resource_account_id=? AND l.resource_device_id=?
          AND l.group_endpoint=? AND l.group_room_id=?) AS current`,
    [actor.kind, actor.id, ...('callerSessionId' in source ? [source.callerSessionId] : []),
      currentId, owner.userId, deviceId, intent.group.endpoint, intent.group.roomId]);
    assertGroup();
    if (!final) return deny('GROUP_ACCESS_DENIED');
    if (caller && final.callerIdentity !== caller.identity) return deny('GROUP_ACCESS_DENIED');
    const permitted: unknown = JSON.parse(final.permitted);
    const checkedIds = ownerInGroup && intent.action === 'list' ? visibleProjects.map(project=>project.id) : ids;
    if (!Array.isArray(permitted) || (!clearing && checkedIds.some(id => !permitted.includes(id))))
      deny(permission === 'configure' && !ownerInGroup ? 'NOT_PROJECT_OWNER' : 'NOT_PROJECT_MEMBER');
    const currentOwners = (ownerInGroup ? JSON.parse(final.projectOwners) : []) as {projectId:string;kind:'account'|'bot';id:string}[];
    if (needsProjectOwner && !currentOwners.some(row => row.projectId === intent.target.projectId
      && row.kind === projectOwner?.kind && row.id === projectOwner?.id)) deny('NOT_PROJECT_OWNER');
    if (ownerInGroup && intent.action === 'list' && 'links' in result) {
      const eligible = (projectId: string) => {
        const current = currentOwners.find(row => row.projectId === projectId);
        return !!current && group.projectOwnerJoined!(current);
      };
      return { ...result, links: result.links.map(row => {
        if (!Array.isArray(permitted) || !permitted.includes(row.target.projectId)) {
          const {linkedOwner: _owner,workDirKey: _directory,...opaque}=row;
          return {...opaque,available:false};
        }
        const current = currentOwners.find(owner => owner.projectId === row.target.projectId);
        return {...row, available: eligible(row.target.projectId) && current?.kind === row.linkedOwner?.kind
          && current?.id === row.linkedOwner?.id};
      }),
        eligibleProjects: visibleProjects.filter(project => project.status === 'active' && eligible(project.id)) };
    }
    if ('current' in result) {
      if (!final.current) return deny('RELATION_NOT_FOUND');
      const current: { status: 'active' | 'removed'; revision: number; createdAt: number; updatedAt: number;
        workDirKey?:string|null;linkedOwner?:{kind:'account'|'bot';id:string}|null } = JSON.parse(final.current);
      if (!result.replayed) runtime.onChanged?.(intent.group.roomId);
      return { ...result, current: { ...result.current, ...current,
        createdAt: new Date(current.createdAt).toISOString(), updatedAt: new Date(current.updatedAt).toISOString() } };
    }
    return result;
  } catch (error) {
    const supplied = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const message = error instanceof Error ? error.message : '';
    const candidate = typeof supplied === 'string' && PROJECT_GROUP_LINK_ERROR_CODES.some(c => c === supplied)
      ? supplied : /^\[([A-Z_]+)\]/.exec(message)?.[1] ?? message;
    const errorCode = PROJECT_GROUP_LINK_ERROR_CODES.find(c => c === candidate)
      ?? (/GROUP_|TASK_ACTION_|BOT_SESSION_|TASK_UNAVAILABLE/.test(String(supplied ?? message)) ? 'GROUP_AUTHORIZATION_UNAVAILABLE' : 'INTERNAL');
    return { ok: false, errorCode, message: 'Project group link unavailable or access changed.', commitState };
  }
}
