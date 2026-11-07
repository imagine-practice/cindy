import { parseProjectGroupReference, type ProjectGroupReference, type ProjectLocator,
  type WorkItemLocator } from '@cindy/maker-shared/project-group-reference';
import { getCurrentDbClientSnapshot } from '../localDb/client/current';
import { readProjectDetail } from '../localDb/ipc/projects';
import { authorizeGroupTool } from '../maker-ipc/botGroupToolAuthorization';
import { captureEntityProjectAuthority, type EntityProjectRuntime } from './entityProjectAuthority';

/** Main-owned only. Never construct this runtime or caller ID from a card/renderer payload. */
export interface ProjectGroupReferenceResolverRuntime extends EntityProjectRuntime {
  /** Production source: device-link/index#getSelfDeviceId, cached last hello-ack ID.
   * Stable device equality only: non-null does NOT prove online/current-account authority. */
  currentDeviceId(): string | null;
}
export type ResolvedProjectGroupEntity =
  | { kind: 'project'; locator: ProjectLocator; title: string; status: string }
  | { kind: 'work-item'; locator: WorkItemLocator; title: string; status: string };
const CODES = ['INVALID_REFERENCE','HOST_NOT_READY','OWNER_SCOPE_CHANGED','DEVICE_UNAVAILABLE',
  'UNSUPPORTED_CAPABILITY','TASK_UNAVAILABLE','TASK_ACTION_SOURCE_UNAUTHORIZED',
  'TASK_ACTION_AUTHORIZATION_EXPIRED','BOT_SESSION_INACTIVE','NOT_PROJECT_MEMBER',
  'REFERENCE_UNAVAILABLE','BINDING_CONFLICT','GROUP_AUTHORIZATION_REQUIRED',
  'GROUP_AUTHORIZATION_UNAVAILABLE','INTERNAL'] as const;
export type ProjectGroupReferenceResolveCode = typeof CODES[number];
export type ProjectGroupReferenceResolveResult = { ok: true; entity: ResolvedProjectGroupEntity }
  | { ok: false; errorCode: ProjectGroupReferenceResolveCode; message: string };
class Rejected extends Error {
  constructor(readonly code: ProjectGroupReferenceResolveCode) { super('Reference unavailable'); }
}
const deny = (code: ProjectGroupReferenceResolveCode): never => { throw new Rejected(code); };

// No new actor derivation: captureEntityProjectAuthority owns that decision. This raw
// fingerprint binds the final metadata SQL snapshot to its already-authorized caller.
// Group lease capture below is from this real caller row, never reference.source.
const CALLER = `SELECT json_array(c.source,c.status,c.remote_host_id,c.agent_device_id,
  b.bot_id,b.role,b.archived_at,p.status,p.canonical_session_id) AS identity,
  b.bot_id AS botId,b.role
  FROM sessions c LEFT JOIN bot_session_links b ON b.session_id=c.id
  LEFT JOIN bot_profiles p ON p.id=b.bot_id WHERE c.id=?`;
type CallerSnapshot = { identity: string; botId: string | null; role: string | null };
type Snapshot = CallerSnapshot & { projectTitle: string; projectStatus: string;
  sessionId: string | null; sessionProjectId: string | null; bindingRevision: number | null;
  sessionTitle: string | null; sessionStatus: string | null };

/** Local, read-only task-context resolver. No send, relation write, Session creation or follow-up.
 * Ordinary UI account access needs a separate trusted adapter; it must not invent a callerSessionId.
 */
export async function resolveProjectGroupReference(
  reference: ProjectGroupReference, callerSessionId: string, runtime: ProjectGroupReferenceResolverRuntime,
): Promise<ProjectGroupReferenceResolveResult> {
  try {
    const ref = parseProjectGroupReference(reference);
    if (!ref) return deny('INVALID_REFERENCE');
    const owner = getCurrentDbClientSnapshot();
    if (!owner?.userId) return deny('HOST_NOT_READY');
    const deviceId = runtime.currentDeviceId();
    if (!deviceId) return deny('DEVICE_UNAVAILABLE');
    const authority = await captureEntityProjectAuthority(callerSessionId, runtime);
    const current = () => {
      authority.assertCurrent();
      if (getCurrentDbClientSnapshot() !== owner || authority.client !== owner.client) deny('OWNER_SCOPE_CHANGED');
      if (runtime.currentDeviceId() !== deviceId) deny('DEVICE_UNAVAILABLE');
    };
    current();
    if (ref.locator.accountId !== owner.userId || ref.locator.deviceId !== deviceId) return deny('UNSUPPORTED_CAPABILITY');
    const caller = await authority.client.queryOne<CallerSnapshot>(CALLER, [callerSessionId]);
    current();
    if (!caller) return deny('TASK_UNAVAILABLE');
    await authority.refresh();
    current();
    // Keep a synchronous lease guard for the final asynchronous DB read as well.
    const group = caller.role === 'group' && caller.botId
      ? await authorizeGroupTool(callerSessionId, caller.botId, 'owner-action') : null;
    const stable = () => { current(); group?.assertCurrent(); };
    stable();
    await readProjectDetail(ref.locator.projectId, authority.actor, authority.client);
    stable();
    await authority.refresh([ref.locator.projectId]);
    stable();
    // Last read checks membership, caller identity and target binding in ONE SQLite
    // snapshot. No asynchronous operations follow it before returning the minimal view.
    const row = await authority.client.queryOne<Snapshot>(`/* project-group-reference-final */
      WITH caller AS (${CALLER})
      SELECT caller.*,p.name AS projectTitle,p.status AS projectStatus,
        s.id AS sessionId,s.project_id AS sessionProjectId,s.project_binding_revision AS bindingRevision,
        s.title AS sessionTitle,s.status AS sessionStatus
      FROM projects p JOIN project_members m ON m.project_id=p.id
      CROSS JOIN caller LEFT JOIN sessions s ON s.id=?
      WHERE p.id=? AND m.subject_kind=? AND m.subject_id=? AND m.role IN ('owner','member')`,
    [callerSessionId, ref.kind === 'work-item' ? ref.locator.sessionId : null,
      ref.locator.projectId, authority.actor.kind, authority.actor.id]);
    stable();
    if (!row) return deny('REFERENCE_UNAVAILABLE');
    if (row.identity !== caller.identity) return deny('TASK_ACTION_AUTHORIZATION_EXPIRED');
    if (ref.kind === 'project') return { ok: true, entity: {
      kind: 'project', locator: ref.locator, title: row.projectTitle, status: row.projectStatus,
    } };
    if (row.sessionId !== ref.locator.sessionId || row.sessionStatus === 'deleted'
      || row.sessionProjectId !== ref.locator.projectId) return deny('REFERENCE_UNAVAILABLE');
    if (row.bindingRevision !== ref.locator.bindingRevision) return deny('BINDING_CONFLICT');
    return { ok: true, entity: { kind: 'work-item', locator: ref.locator,
      title: row.sessionTitle ?? '', status: row.sessionStatus ?? '' } };
  } catch (error) {
    const supplied = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const bracket = error instanceof Error ? /^\[([A-Z_]+)\]/.exec(error.message)?.[1] : undefined;
    const candidate = typeof supplied === 'string' ? supplied : bracket;
    const code = CODES.find(code => code === candidate) ?? 'INTERNAL';
    return { ok: false, errorCode: code, message: 'Private reference unavailable or access changed.' };
  }
}
