import { randomUUID } from 'node:crypto';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState';
import { getCurrentDbClientSnapshot } from '../localDb/client/current';
import { DB_TRANSPORT_NOT_SENT, DB_TRANSPORT_OUTCOME_UNKNOWN } from '../localDb/client/DbTransport';
import type { BotGroupChatService } from '../maker-ipc/botGroupChatService';
import { authorizeGroupTool } from '../maker-ipc/botGroupToolAuthorization';
import { captureEntityProjectAuthority, type EntityProjectRuntime } from './entityProjectAuthority';
import { normalizeProjectGroupLinkEndpoint, parseProjectGroupLinksIntent, PROJECT_GROUP_LINK_ERROR_CODES,
  type ProjectGroupLinkErrorCode, type ProjectGroupLinksFailure, type ProjectGroupLinksResponse,
  type ProjectGroupLinksResult } from '../../shared/projectGroupLinks';

/** Main-owned capabilities only. Neither this runtime nor callerSessionId is public input. */
export interface ProjectGroupLinksMainRuntime {
  groupService(): Pick<BotGroupChatService, 'groupAuthority'> | null;
  /** device-link/index#getSelfDeviceId: cached last ACK, equality only, never online proof. */
  currentDeviceId(): string | null;
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
    const assertGroup = () => {
      assertCurrent(); group.assertCurrent();
      if (group.facts.ownerId !== owner.userId || group.facts.permission !== permission
        || normalizeProjectGroupLinkEndpoint(group.facts.endpoint) !== intent.group.endpoint
        || group.facts.roomId.toLowerCase() !== intent.group.roomId) deny('GROUP_ACCESS_DENIED');
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
    await refresh(intent.action === 'list' ? [] : [intent.target.projectId]);
    assertGroup();
    const context = { actor, accountId: owner.userId, deviceId, group: intent.group, now: Date.now() };
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
      const rejection = error instanceof Error && /^\[(INVALID_PARAMS|UNSUPPORTED_CAPABILITY|NOT_PROJECT_OWNER|RELATION_NOT_FOUND|REVISION_CONFLICT|REQUEST_CONFLICT|INTERNAL)\] Project group link request rejected$/.test(error.message);
      if (code === DB_TRANSPORT_NOT_SENT || (code !== DB_TRANSPORT_OUTCOME_UNKNOWN
        && (code === undefined || code === 'WORKER_RPC_ERROR') && rejection)) commitState = 'not-committed';
      throw error;
    }
    assertGroup();
    const ids = 'links' in result ? result.links.map(row => row.target.projectId) : [result.current.target.projectId];
    await refresh(ids);
    // One last DB snapshot rechecks exact current membership and task identity. No await
    // follows this query: late local owner/device/input/lease changes fail synchronously.
    const currentId = 'current' in result ? result.current.relationId : null;
    const final = await owner.client.queryOne<{ permitted: string; callerIdentity: string | null;
      current: string | null }>(`/* project-group-links-final */
      SELECT (SELECT json_group_array(m.project_id) FROM project_members m JOIN projects p ON p.id=m.project_id
        WHERE m.subject_kind=? AND m.subject_id=? AND m.role IN (${permission === 'configure' ? "'owner'" : "'owner','member'"})) AS permitted,
      ${'callerSessionId' in source ? ` (SELECT identity FROM (${CALLER}))` : 'NULL'} AS callerIdentity,
      (SELECT json_object('status',l.status,'revision',l.revision,'createdAt',l.created_at,'updatedAt',l.updated_at)
        FROM project_group_links l WHERE l.id=? AND l.resource_account_id=? AND l.resource_device_id=?
          AND l.group_endpoint=? AND l.group_room_id=?) AS current`,
    [actor.kind, actor.id, ...('callerSessionId' in source ? [source.callerSessionId] : []),
      currentId, owner.userId, deviceId, intent.group.endpoint, intent.group.roomId]);
    assertGroup();
    if (!final) return deny('GROUP_ACCESS_DENIED');
    if (caller && final.callerIdentity !== caller.identity) return deny('GROUP_ACCESS_DENIED');
    const permitted: unknown = JSON.parse(final.permitted);
    if (!Array.isArray(permitted) || ids.some(id => !permitted.includes(id))) deny(permission === 'configure' ? 'NOT_PROJECT_OWNER' : 'NOT_PROJECT_MEMBER');
    if ('current' in result) {
      if (!final.current) return deny('RELATION_NOT_FOUND');
      const current: { status: 'active' | 'removed'; revision: number; createdAt: number; updatedAt: number } = JSON.parse(final.current);
      return { ...result, current: { ...result.current, status: current.status, revision: current.revision,
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
