import { ipcMain } from 'electron';
import { coordinateProjectGroupLinksFromUi, type ProjectGroupLinksMainRuntime } from '../../mcp-integrations/projectGroupLinksCoordinator';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending } from '../../appSessionState';
import { getCurrentDbClientSnapshot } from '../client/current';
import {
  PROJECT_GROUP_LINK_ERROR_CODES,
  parseProjectGroupLinksIntent,
  type ProjectGroupLinkErrorCode,
  type ProjectGroupLinksFailure,
  type ProjectGroupLinksProjectListResult,
  type ProjectGroupLinksResponse,
} from '../../../shared/projectGroupLinks';

let host: ProjectGroupLinksMainRuntime | null = null;
/** Installed only by the main maker lifecycle, never from IPC payloads. */
export function configureProjectGroupLinksHost(runtime: ProjectGroupLinksMainRuntime): void { host = runtime; }

class Rejected extends Error {
  constructor(readonly code: ProjectGroupLinkErrorCode) { super('Project group link project read unavailable'); }
}
const deny = (code: ProjectGroupLinkErrorCode): never => { throw new Rejected(code); };

/**
 * 按项目读本机关联群（`local-db:project-group-links:list-project`）。
 *
 * 这条通道**只读**：不写关系、不写 `requestId` 账本、没有 commitState 语义，
 * 因此不需要动作级幂等键。它不是群权限证明——返回的 group locator 只说明本机记录过
 * 这条关系；真正发送时群通道会再鉴权一次。
 *
 * 授权口径与关联写入一致：当前 DB Data Owner 的账号 + 本机设备 + 项目成员资格。
 * 事务内认证一次（同一快照先证成员资格再出行），事务后再用最后一次 SQL 复核，
 * 它之后没有任何 await，期间的换账号 / 换窗口只能让这次结果失败，不能让它变旧。
 */
export async function readProjectGroupLinksByProject(raw: unknown): Promise<ProjectGroupLinksProjectListResult | ProjectGroupLinksFailure> {
  try {
    const intent = parseProjectGroupLinksIntent(raw);
    if (!intent || intent.action !== 'list-project') return deny('INVALID_PARAMS');
    const owner = getCurrentDbClientSnapshot();
    if (!owner?.userId || isAppSessionBoundaryPending()) return deny('HOST_NOT_READY');
    const ownerKey = activeOwnerScopeKey();
    const deviceId = host?.currentDeviceId() ?? null;
    if (!deviceId) return deny('UNSUPPORTED_CAPABILITY');
    if (getActiveAppSession().dataOwnerId !== owner.userId) return deny('OWNER_SCOPE_CHANGED');
    const actor = { kind: 'account' as const, id: owner.userId };
    const assertCurrent = () => {
      if (isAppSessionBoundaryPending() || getCurrentDbClientSnapshot() !== owner
        || activeOwnerScopeKey() !== ownerKey
        || getActiveAppSession().dataOwnerId !== owner.userId) deny('OWNER_SCOPE_CHANGED');
    };
    const result = await owner.client.tx<ProjectGroupLinksProjectListResult>('projectGroupLinks.listProject', {
      request: { projectId: intent.projectId },
      context: { actor, accountId: owner.userId, deviceId },
    });
    assertCurrent();
    // 最后一次读取复核此刻仍是成员；之后只有同步核验与返回。
    const final = await owner.client.queryOne<{ permitted: number }>(
      `SELECT COUNT(*) AS permitted FROM project_members m JOIN projects p ON p.id = m.project_id
        WHERE m.project_id = ? AND m.subject_kind = ? AND m.subject_id = ?`,
      [intent.projectId, actor.kind, actor.id],
    );
    assertCurrent();
    if (!final || final.permitted <= 0) return deny('NOT_PROJECT_MEMBER');
    // 关系行本身不带项目名/群名；locator 与 target 是公共协议字段，无授权对象或凭证。
    return result;
  } catch (error) {
    const supplied = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const message = error instanceof Error ? error.message : '';
    const candidate = typeof supplied === 'string' && PROJECT_GROUP_LINK_ERROR_CODES.some(code => code === supplied)
      ? supplied : /^\[([A-Z_]+)\]/.exec(message)?.[1];
    const errorCode = PROJECT_GROUP_LINK_ERROR_CODES.find(code => code === candidate) ?? 'INTERNAL';
    return { ok: false, errorCode, message: 'Project group links could not be read.', commitState: 'not-committed' };
  }
}

export function registerProjectGroupLinksIpc(): void {
  for (const action of ['list', 'link', 'unlink'] as const) {
    ipcMain.handle(`local-db:project-group-links:${action}`, async (event, raw: unknown): Promise<ProjectGroupLinksResponse> => {
      assertTrustedAppRendererEvent(event);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('action' in raw) || raw.action !== action) {
        return { ok: false, errorCode: 'INVALID_PARAMS', message: 'Project group link request rejected', commitState: 'not-committed' };
      }
      const captured = host;
      if (!captured) return { ok: false, errorCode: 'HOST_NOT_READY', message: 'Project group link host unavailable', commitState: 'not-committed' };
      return coordinateProjectGroupLinksFromUi(raw, {
        groupService: () => captured.groupService(), currentDeviceId: () => captured.currentDeviceId(),
        assertTrustedUi: () => {
          assertTrustedAppRendererEvent(event);
          if (host !== captured || event.sender.isDestroyed()) throw new Error('OWNER_SCOPE_CHANGED');
        },
      });
    });
  }
  // 只读的按项目查询：无动作幂等键，失败一律 not-committed。
  ipcMain.handle('local-db:project-group-links:list-project', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    return readProjectGroupLinksByProject(raw);
  });
}
