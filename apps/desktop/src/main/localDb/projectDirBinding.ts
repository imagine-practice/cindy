/**
 * 项目目录的默认归属（项目内核 M1.1）。
 *
 * 规则：目录被某个项目认领后，**在这个目录里新建的任务默认归入该项目**——
 * 但只有一条附加条件：调用方必须是该项目的成员。目录只是「默认值来源」，
 * 不构成访问授权；非成员在同一个目录里建任务，仍然得到一个不归属任何项目的任务，
 * 绝不会因为目录被认领而拿到项目权限。
 *
 * 目录键与侧栏分组同源（`shared/projectKeys`）：本地是 `local:<path>`，SSH 远端是
 * `remote:<host>:<path>`，同账号另一台设备是 `device:<id>:<path>`。三类目录各自
 * 独立，同一个路径在不同机器上不是同一个目录。
 *
 * 读失败（表不存在、库迁移中）按「没有默认归属」处理并继续建任务：归属是增强，
 * 不能反过来挡住建任务这条主路径。
 */
import type { DbClient } from './client/DbClient';
import { deviceLinkProjectKey, projectIdentityKey } from '../../shared/projectKeys';

export interface SessionDirIdentity {
  workingDir: string | null | undefined;
  remoteHostId?: string | null;
  agentDeviceId?: string | null;
}

/** 会话目录 → 项目目录键。没有工作目录时没有归属可言。 */
export function projectDirKeyForSession(input: SessionDirIdentity): string | null {
  const dir = input.workingDir?.trim();
  if (!dir) return null;
  if (input.remoteHostId) return projectIdentityKey('remote', dir, input.remoteHostId);
  if (input.agentDeviceId) return deviceLinkProjectKey(input.agentDeviceId, dir);
  return projectIdentityKey('local', dir, null);
}

/**
 * 解析默认归属。返回 null 表示「不归属」：目录没人认领、项目已归档、调用方不是成员，
 * 或调用方没有身份（未登录/账号切换中）——最后一种绝不靠猜。
 */
export async function resolveDefaultProjectId(
  client: Pick<DbClient, 'queryOne'>,
  input: SessionDirIdentity,
  actor: { kind: 'account' | 'bot'; id: string } | null,
): Promise<string | null> {
  if (!actor) return null;
  const dirKey = projectDirKeyForSession(input);
  if (!dirKey) return null;
  let binding: { projectId: string; status: string } | undefined;
  try {
    binding = await client.queryOne<{ projectId: string; status: string }>(
      `SELECT d.project_id AS projectId, p.status AS status
         FROM project_dirs d JOIN projects p ON p.id = d.project_id
        WHERE d.dir_key = ?`,
      [dirKey],
    );
  } catch {
    // 精简库 / 旧快照没有 project_dirs：当成没有默认归属，建任务照常继续。
    return null;
  }
  if (!binding || binding.status !== 'active') return null;
  const membership = await client.queryOne<{ projectId: string }>(
    'SELECT project_id AS projectId FROM project_members WHERE project_id = ? AND subject_kind = ? AND subject_id = ?',
    [binding.projectId, actor.kind, actor.id],
  );
  return membership?.projectId ?? null;
}
