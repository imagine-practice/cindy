import type { Session } from '@cindy/maker-core';
import type { DbClient } from '../localDb/client/DbClient';
import { getCurrentDbClientSnapshot } from '../localDb/client/current';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState';
import { botSessionLinks, sessions } from '../localDb/schema';
import { readChannelToolScope } from '../im/shared/channelToolScope';
import { authorizeGroupTool } from '../maker-ipc/botGroupToolAuthorization';
import { teammateTurnPrincipal } from '../maker-ipc/taskActionHost';
import type { ProjectSubjectRef } from '../../shared/projects';

export interface EntityProjectRuntime {
  input(id: string): { key: string; boundary: string; ownerInput: boolean; ownerContinuation?: boolean; automatic?: boolean };
  getSession(id: string): (Pick<Session, 'getCurrentTurnOrigin'> & { readonly instanceId?: string }) | undefined;
}

export class EntityProjectAccessError extends Error {
  constructor(readonly code: string) { super('Entity project read rejected'); }
}
const deny = (code: string): never => { throw new EntityProjectAccessError(code); };

interface Caller {
  source: string; status: string; remoteHostId: string | null; agentDeviceId: string | null;
  botId: string | null; role: string | null; archivedAt: number | null;
  botStatus: string | null; canonicalSessionId: string | null; permitted: string;
}
async function readCaller(client: DbClient, id: string, actor?: ProjectSubjectRef): Promise<Caller | undefined> {
  return client.queryOne<Caller>(`/* entity-project-caller */ SELECT s.source,s.status,
    s.remote_host_id AS remoteHostId,s.agent_device_id AS agentDeviceId,
    b.bot_id AS botId,b.role,b.archived_at AS archivedAt,p.status AS botStatus,
    p.canonical_session_id AS canonicalSessionId,
    (SELECT json_group_array(m.project_id) FROM project_members m JOIN projects x ON x.id=m.project_id
      WHERE m.subject_kind=? AND m.subject_id=?) AS permitted
    FROM sessions s LEFT JOIN bot_session_links b ON b.session_id=s.id
    LEFT JOIN bot_profiles p ON p.id=b.bot_id WHERE s.id=?`, [actor?.kind ?? '', actor?.id ?? '', id]);
}
// Membership is checked separately; a successful write can legitimately remove read access.
const fingerprint = (caller: Caller) => JSON.stringify({ ...caller, permitted: undefined });

/** Capture host facts, never tool arguments. Surface classification is not authorization.
 * Account and DB epochs are independent guards: reusing a DbClient cannot reuse a grant.
 */
export async function captureEntityProjectAuthority(id: string, runtime: EntityProjectRuntime) {
  const owner = getCurrentDbClientSnapshot();
  if (!owner || !owner.userId || isAppSessionBoundaryPending()) return deny('HOST_NOT_READY');
  const app = getActiveAppSession();
  if (app.dataOwnerId !== owner.userId) return deny('OWNER_SCOPE_CHANGED');
  const ownerKey = activeOwnerScopeKey();
  const assertOwner = () => {
    if (isAppSessionBoundaryPending() || getCurrentDbClientSnapshot() !== owner ||
      activeOwnerScopeKey() !== ownerKey || getActiveAppSession().dataOwnerId !== owner.userId) deny('OWNER_SCOPE_CHANGED');
  };
  assertOwner();
  if (!id) return deny('TASK_UNAVAILABLE');
  const caller = await readCaller(owner.client, id);
  assertOwner();
  if (!caller || !['active', 'archived'].includes(caller.status)) return deny('TASK_UNAVAILABLE');
  if (!sessions.source.enumValues.some(source => source === caller.source) || caller.source === 'shared') {
    return deny('TASK_ACTION_SOURCE_UNAUTHORIZED');
  }
  if (caller.remoteHostId || caller.agentDeviceId) return deny('UNSUPPORTED_CAPABILITY');
  const live = runtime.getSession(id);
  if (!live) return deny('TASK_UNAVAILABLE');
  const input = runtime.input(id);
  const origin = live.getCurrentTurnOrigin();
  const lane = readChannelToolScope({ sessionId: id, sessionInstanceId: live.instanceId });
  if (lane && !lane.requesterIsOwner) return deny('TASK_ACTION_SOURCE_UNAUTHORIZED');
  const assertSource = () => {
    assertOwner();
    const next = runtime.input(id);
    if (runtime.getSession(id) !== live || live.getCurrentTurnOrigin() !== origin ||
      next.key !== input.key || next.boundary !== input.boundary || next.ownerInput !== input.ownerInput ||
      next.ownerContinuation !== input.ownerContinuation || next.automatic !== input.automatic ||
      readChannelToolScope({ sessionId: id, sessionInstanceId: live.instanceId }) !== lane) deny('TASK_ACTION_AUTHORIZATION_EXPIRED');
  };
  let actor: ProjectSubjectRef;
  let group: Awaited<ReturnType<typeof authorizeGroupTool>> | null = null;
  if (caller.botId) {
    if (caller.botStatus !== 'active' || caller.archivedAt !== null ||
      !botSessionLinks.role.enumValues.some(role => role === caller.role) || caller.role === 'history' ||
      (caller.role === 'canonical' && caller.canonicalSessionId !== id)) return deny('BOT_SESSION_INACTIVE');
    // read-self never grants project access. Only the existing live owner-action lease
    // can establish owner agency in a group; tools/chat lanes cannot upgrade themselves.
    group = caller.role === 'group' ? await authorizeGroupTool(id, caller.botId, 'owner-action') : null;
    assertSource();
    const principal = teammateTurnPrincipal({ groupOwner: group !== null, laneRequesterIsOwner: lane?.requesterIsOwner,
      ownerInput: input.ownerInput, ownerContinuation: input.ownerContinuation,
      scheduleId: origin?.kind === 'scheduler' ? origin.scheduleId : undefined });
    actor = principal === 'owner' ? { kind: 'account', id: owner.userId } : { kind: 'bot', id: caller.botId };
  } else {
    if (caller.source === 'bot') return deny('BOT_SESSION_INACTIVE');
    // Ordinary owner/profile tasks (including plugin tasks) keep the same account
    // principal as native task tools. No new permission tier is inferred from a surface.
    actor = { kind: 'account', id: owner.userId };
  }
  const refresh = async (projectIds: readonly string[] = []) => {
    assertSource();
    await group?.refresh();
    assertSource();
    // One final SQL snapshot validates caller AND all returned projects. No title,
    // count or body is released after a revoked membership or deleted caller.
    const current = await readCaller(owner.client, id, actor);
    assertSource();
    if (!current || fingerprint(current) !== fingerprint(caller)) return deny('TASK_ACTION_AUTHORIZATION_EXPIRED');
    const permitted: unknown = JSON.parse(current.permitted);
    if (!Array.isArray(permitted) || projectIds.some(projectId => !permitted.includes(projectId))) return deny('NOT_PROJECT_MEMBER');
    group?.assertCurrent();
  };
  await refresh();
  return { client: owner.client, actor, refresh, assertCurrent: () => { assertSource(); group?.assertCurrent(); } };
}
