import type Database from 'better-sqlite3';
import type {
  ProjectGroupLink,
  ProjectGroupLinksProjectListResult,
} from '../../../../shared/projectGroupLinks';

/**
 * 本机封闭输入：actor / account / device 全部由已鉴权的宿主捕获，不从 raw 反序列化。
 * 它们只界定「谁的、哪台机器的」关联，**不是**群权限证明。
 */
export interface ProjectGroupLinksProjectReadContext {
  actor: { kind: 'account' | 'bot'; id: string };
  accountId: string;
  deviceId: string;
}

/**
 * 按项目读本机群关联（`project_group_links` 的 `byProject` 索引）。
 *
 * 三条边界：
 * 1. **同一快照内先证成员资格再出行**：成员判断与关系读取在同一个事务里，
 *    不存在「成员已撤但关系仍被返回」的中间态。
 * 2. **只读**：不写 `project_group_link_requests`、不需要 `requestId`，也不改 revision。
 * 3. **只返回当前账号 + 本机设备上的 active 行**：别人的机器、已解除的关系都不出现；
 *    读不到群权限不在这里判断——发送时群通道自己再鉴权。
 *
 * self-contained：与其它 op handler 一样可被 file/inline worker 单独装载，不 import
 * 任何 main 进程模块，也不安装迁移。
 */
export function readProjectGroupLinksByProjectTransaction(
  db: Database.Database,
  raw: unknown,
  context: ProjectGroupLinksProjectReadContext,
): ProjectGroupLinksProjectListResult {
  // 所有常量与辅助都留在函数内：inline worker 用 `fn.toString()` 嵌源码，
  // 任何模块级引用都会在那边变成 ReferenceError。
  /** 一个项目关联的群数量现实上很小；上限只用来避免一次读回无界结果。 */
  const MAX_LINKS = 200;
  const fail = (code: string): never => {
    throw new Error(`[${code}] Project group links project read rejected`);
  };
  const id = (value: unknown, max = 200): string =>
    typeof value === 'string' && value.length > 0 && value.length <= max
      && !/\s/u.test(value)
      && !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      ? value
      : fail('INVALID_PARAMS');

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('INVALID_PARAMS');
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'projectId')) return fail('INVALID_PARAMS');
  const projectId = id(body.projectId);

  if (!context || typeof context !== 'object' || Array.isArray(context)) return fail('INVALID_PARAMS');
  const actor = context.actor;
  if (!actor || (actor.kind !== 'account' && actor.kind !== 'bot')) return fail('INVALID_PARAMS');
  const actorKind = actor.kind;
  const actorId = id(actor.id);
  const accountId = id(context.accountId);
  const deviceId = id(context.deviceId, 500);

  type Row = {
    id: string;
    resource_account_id: string;
    resource_device_id: string;
    project_id: string;
    group_endpoint: string;
    group_room_id: string;
    status: 'active' | 'removed';
    revision: number;
    created_at: number;
    updated_at: number;
  };

  return db.transaction((): ProjectGroupLinksProjectListResult => {
    const member = db
      .prepare(
        `SELECT m.role FROM project_members m JOIN projects p ON p.id = m.project_id
         WHERE p.id = ? AND m.subject_kind = ? AND m.subject_id = ?`,
      )
      .get(projectId, actorKind, actorId) as { role: string } | undefined;
    // 非成员连「有没有关联群」都不回答：关系本身就是元数据。
    if (!member) return fail('NOT_PROJECT_MEMBER');
    const rows = db
      .prepare(
        `SELECT id, resource_account_id, resource_device_id, project_id, group_endpoint, group_room_id,
                status, revision, created_at, updated_at
           FROM project_group_links
          WHERE project_id = ? AND status = 'active'
            AND resource_account_id = ? AND resource_device_id = ?
          ORDER BY id ASC LIMIT ?`,
      )
      .all(projectId, accountId, deviceId, MAX_LINKS + 1) as Row[];
    const visible = rows.slice(0, MAX_LINKS);
    const links: ProjectGroupLink[] = visible.map((row) => ({
      relationId: row.id,
      group: { endpoint: row.group_endpoint, roomId: row.group_room_id },
      target: {
        accountId: row.resource_account_id,
        deviceId: row.resource_device_id,
        projectId: row.project_id,
      },
      status: row.status,
      revision: row.revision,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
    return { ok: true, contractRevision: 1, links, truncated: rows.length > MAX_LINKS };
  })();
}
