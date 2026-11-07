import type Database from 'better-sqlite3';
import type { ProjectsMutationResult } from '../../../../shared/projects';

/**
 * 项目内核 v1（M1）写事务。
 *
 * Self-contained so the legacy inline worker can embed the same implementation.
 * 因此本函数不得引用模块作用域的常量／函数——上限数字内联在这里，由
 * `projectsTx.test.ts` 用共享常量锁住，防止两边漂移。
 *
 * 规则全部在这里（而不是 renderer）强制：renderer 只是读投影。
 */
export function runProjectsTransaction(
  db: Database.Database,
  raw: unknown,
): ProjectsMutationResult {
  // 与 shared/projects.ts 的 PROJECT_NAME_MAX_LENGTH / PROJECT_GOAL_MAX_LENGTH 对齐。
  const NAME_MAX = 120;
  const GOAL_MAX = 2000;

  const fail = (code: string, message: string): never => {
    throw new Error(`[${code}] ${message}`);
  };
  const asRecord = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return fail('INVALID_PARAMS', `${label} must be an object`);
    }
    return value as Record<string, unknown>;
  };
  const asText = (value: unknown, max: number, label: string): string => {
    if (typeof value !== 'string') return fail('INVALID_PARAMS', `${label} must be a string`);
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > max) {
      return fail('INVALID_PARAMS', `${label} is invalid`);
    }
    return trimmed;
  };
  const asOptionalText = (value: unknown, max: number, label: string): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') return fail('INVALID_PARAMS', `${label} must be a string`);
    const trimmed = value.trim();
    if (trimmed.length > max) return fail('INVALID_PARAMS', `${label} is too long`);
    return trimmed.length === 0 ? null : trimmed;
  };
  const asTimestamp = (value: unknown, label: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fail('INVALID_PARAMS', `${label} must be a number`);
    }
    return Math.trunc(value);
  };
  const asSubject = (value: unknown): { kind: string; id: string } => {
    const body = asRecord(value, 'subject');
    const kind = body.kind;
    if (kind !== 'account' && kind !== 'bot') {
      return fail('INVALID_PARAMS', 'invalid subject kind');
    }
    return { kind, id: asText(body.id, 200, 'subject id') };
  };
  const asSubjects = (value: unknown): Array<{ kind: string; id: string }> => {
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value)) return fail('INVALID_PARAMS', 'members must be an array');
    // 没有「成员数量上限」：项目成员数不是业务限额，只受输入合法性约束（kind / id）。
    return value.map(asSubject);
  };

  const selectProject = db.prepare(
    'SELECT id, name, goal, owner_id AS ownerId, status, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id = ?',
  );
  const selectMember = db.prepare(
    'SELECT role FROM project_members WHERE project_id = ? AND subject_kind = ? AND subject_id = ?',
  );
  const insertMember = db.prepare(
    'INSERT OR IGNORE INTO project_members (project_id, subject_kind, subject_id, role, added_at) VALUES (?, ?, ?, ?, ?)',
  );
  const touchProject = db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?');
  const selectSession = db.prepare(
    'SELECT id, project_id AS projectId, assignee_kind AS assigneeKind, assignee_id AS assigneeId, status FROM sessions WHERE id = ?',
  );
  const updateSessionBinding = db.prepare(
    'UPDATE sessions SET project_binding_revision = project_binding_revision + CASE WHEN project_id IS NOT ? THEN 1 ELSE 0 END, project_id = ?, assignee_kind = ?, assignee_id = ? WHERE id = ?',
  );
  const clearAssigneeNotMember = db.prepare(
    `UPDATE sessions SET assignee_kind = NULL, assignee_id = NULL
      WHERE id = ?
        AND assignee_kind IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM project_members m
          WHERE m.project_id = ? AND m.subject_kind = sessions.assignee_kind AND m.subject_id = sessions.assignee_id
        )`,
  );

  /**
   * 删除项目的级联清单（真删除，一个事务）。顺序由外键决定，不能随意调换：
   *   1. 先解绑不挂在 projects 外键上的引用：`sessions.project_id` / `schedules.project_id`
   *      只置空——任务与定时任务归用户所有，删项目不删它们；
   *   2. `project_group_link_requests` 先于 `project_group_links`（前者 FK 指向后者）；
   *   3. `material_references` 先于 `material_versions`（复合 FK，NO ACTION），
   *      `material_contexts` 按项目单清；`material_versions` 随 `materials` 级联删除；
   *   4. `work_item_progress` 先于 `work_item_progress_events`（completion_event_id FK）；
   *   5. 最后删 `projects`，`project_members` 由其级联删除。
   * 只删库内记录：用户原文件与媒体字节不在这里碰。
   */
  const deleteProjectCascade = (projectId: string): string[] => {
    const unboundSessionIds = (
      db.prepare('SELECT id FROM sessions WHERE project_id = ?').all(projectId) as Array<{ id: string }>
    ).map((row) => row.id);
    // 材料分发记录属于被删项目：不先清掉，任务上会继续显示指向已删材料/快照的分发状态。
    // 顺序：attempts → revisions → messages（前两者 FK 指向后者）。
    for (const table of ['material_dispatch_attempts', 'material_dispatch_revisions', 'material_dispatch_messages']) {
      // 精简库/历史夹具可能没有这些表：缺表就没有要清的分发记录，直接跳过。
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      db.prepare(`DELETE FROM ${table} WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)`).run(projectId);
    }
    // 解绑等价于一次真实的绑定变化：绑定代数 +1，旧代数的进度幂等键随之失效。
    db.prepare(
      `UPDATE sessions
          SET project_id = NULL, assignee_kind = NULL, assignee_id = NULL,
              project_binding_revision = project_binding_revision + 1
        WHERE project_id = ?`,
    ).run(projectId);
    db.prepare('UPDATE schedules SET project_id = NULL WHERE project_id = ?').run(projectId);
    db.prepare(
      'DELETE FROM project_group_link_requests WHERE relation_id IN (SELECT id FROM project_group_links WHERE project_id = ?)',
    ).run(projectId);
    db.prepare('DELETE FROM project_group_links WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM material_references WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM material_contexts WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM materials WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM work_item_progress WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM work_item_progress_events WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    return unboundSessionIds;
  };

  const requireProject = (id: string) => {
    const row = selectProject.get(id) as
      | {
          id: string;
          name: string;
          goal: string | null;
          ownerId: string;
          status: string;
          createdAt: number;
          updatedAt: number;
        }
      | undefined;
    return row ?? fail('NOT_FOUND', 'Project not found');
  };
  const requireSession = (id: string) => {
    const row = selectSession.get(id) as
      | { id: string; projectId: string | null; assigneeKind: string | null; status: string }
      | undefined;
    if (!row) return fail('NOT_FOUND', 'Task not found');
    if (row.status === 'deleted') return fail('PRECONDITION_FAILED', 'Deleted task cannot be changed');
    return row;
  };

  return db.transaction((): ProjectsMutationResult => {
    const args = asRecord(raw, 'projects tx');
    const action = args.action;
    // This envelope is main-only. The worker must never accept a renderer identity as trusted.
    const actor = asSubject(args.actor);
    const requireAccess = (projectId: string, ownerOnly = false): void => {
      const membership = selectMember.get(projectId, actor.kind, actor.id) as { role: string } | undefined;
      if (!membership || (ownerOnly ? membership.role !== 'owner' :
        membership.role !== 'owner' && membership.role !== 'member')) {
        fail('FORBIDDEN', 'Current project membership does not allow this action');
      }
    };

    if (action === 'create') {
      const input = asRecord(args.input, 'input');
      const name = asText(input.name, NAME_MAX, 'name');
      const goal = asOptionalText(input.goal, GOAL_MAX, 'goal');
      const newId = asText(args.newId, 200, 'newId');
      const now = asTimestamp(args.now, 'now');
      const owner = asSubject(input.owner);
      db.prepare(
        "INSERT INTO projects (id, name, goal, owner_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
      ).run(newId, name, goal, owner.id, now, now);
      // 负责人先落成 owner 行：唯一 owner 索引要求同一项目最多一行 owner。
      insertMember.run(newId, owner.kind, owner.id, 'owner', now);
      // Only creation retains the trusted creator; later mutations never restore revoked access.
      if (actor.kind !== owner.kind || actor.id !== owner.id) {
        insertMember.run(newId, actor.kind, actor.id, 'member', now);
      }
      for (const member of asSubjects(input.members)) {
        if (member.kind === owner.kind && member.id === owner.id) continue;
        insertMember.run(newId, member.kind, member.id, 'member', now);
      }
      return { ok: true, projectId: newId, sessionId: null };
    }

    if (action === 'update') {
      const projectId = asText(args.projectId, 200, 'projectId');
      const now = asTimestamp(args.now, 'now');
      const existing = requireProject(projectId);
      requireAccess(projectId, true);
      // undefined = 「不改」，null = 「清空」：两者不能合并成 COALESCE。
      const nextName = args.name === undefined ? existing.name : asText(args.name, NAME_MAX, 'name');
      const nextGoal =
        args.goal === undefined ? existing.goal : asOptionalText(args.goal, GOAL_MAX, 'goal');
      const nextStatus =
        args.status === undefined
          ? existing.status
          : args.status === 'active' || args.status === 'archived'
            ? args.status
            : fail('INVALID_PARAMS', 'invalid project status');
      db.prepare('UPDATE projects SET name = ?, goal = ?, status = ?, updated_at = ? WHERE id = ?').run(
        nextName,
        nextGoal,
        nextStatus,
        now,
        projectId,
      );
      return { ok: true, projectId, sessionId: null };
    }

    if (action === 'addMember') {
      const projectId = asText(args.projectId, 200, 'projectId');
      const now = asTimestamp(args.now, 'now');
      requireProject(projectId);
      requireAccess(projectId, true);
      const subject = asSubject(args.subject);
      // 去重口径 = (kind, id)；重复添加是幂等 no-op，同名不同 id 是两个成员。
      insertMember.run(projectId, subject.kind, subject.id, 'member', now);
      touchProject.run(now, projectId);
      return { ok: true, projectId, sessionId: null };
    }

    if (action === 'removeMember') {
      const projectId = asText(args.projectId, 200, 'projectId');
      const now = asTimestamp(args.now, 'now');
      requireProject(projectId);
      requireAccess(projectId, true);
      const subject = asSubject(args.subject);
      const existing = selectMember.get(projectId, subject.kind, subject.id) as
        | { role: string }
        | undefined;
      if (!existing) return fail('NOT_FOUND', 'Member not found');
      if (existing.role === 'owner') {
        return fail('MUST_TRANSFER_OWNER_FIRST', 'Transfer ownership before removing the owner');
      }
      db.prepare(
        'DELETE FROM project_members WHERE project_id = ? AND subject_kind = ? AND subject_id = ?',
      ).run(projectId, subject.kind, subject.id);
      // 被移除的成员不能继续作为处理人留在任务上。
      db.prepare(
        'UPDATE sessions SET assignee_kind = NULL, assignee_id = NULL WHERE project_id = ? AND assignee_kind = ? AND assignee_id = ?',
      ).run(projectId, subject.kind, subject.id);
      touchProject.run(now, projectId);
      return { ok: true, projectId, sessionId: null };
    }

    if (action === 'transferOwner') {
      const projectId = asText(args.projectId, 200, 'projectId');
      const now = asTimestamp(args.now, 'now');
      requireProject(projectId);
      requireAccess(projectId, true);
      const subject = asSubject(args.subject);
      const target = selectMember.get(projectId, subject.kind, subject.id) as
        | { role: string }
        | undefined;
      // 负责人必须是成员：转交给非成员不是「顺手加人」，而是两步操作。
      if (!target) return fail('ASSIGNEE_NOT_MEMBER', 'Only project members can own the project');
      // 先降级旧负责人，再抬新负责人：唯一 owner 索引在语句边界生效。
      db.prepare("UPDATE project_members SET role = 'member' WHERE project_id = ? AND role = 'owner'").run(
        projectId,
      );
      db.prepare(
        "UPDATE project_members SET role = 'owner' WHERE project_id = ? AND subject_kind = ? AND subject_id = ?",
      ).run(projectId, subject.kind, subject.id);
      db.prepare('UPDATE projects SET owner_id = ?, updated_at = ? WHERE id = ?').run(
        subject.id,
        now,
        projectId,
      );
      return { ok: true, projectId, sessionId: null };
    }

    if (action === 'bindSession') {
      const sessionId = asText(args.sessionId, 200, 'sessionId');
      const session = requireSession(sessionId);
      if (session.projectId !== null) requireAccess(session.projectId);
      const projectId =
        args.projectId === null || args.projectId === undefined
          ? null
          : asText(args.projectId, 200, 'projectId');
      if (projectId !== null) {
        const project = requireProject(projectId);
        requireAccess(projectId);
        if (project.status === 'archived') {
          return fail('PRECONDITION_FAILED', 'Archived project cannot take new tasks');
        }
      }
      updateSessionBinding.run(projectId, projectId, null, null, sessionId);
      if (projectId !== null) {
        // 换项目后旧处理人若不在新项目成员里，必须回落为「未分配」。
        clearAssigneeNotMember.run(sessionId, projectId);
      }
      return { ok: true, projectId, sessionId };
    }

    if (action === 'setAssignee') {
      const sessionId = asText(args.sessionId, 200, 'sessionId');
      const session = requireSession(sessionId);
      if (!session.projectId) return fail('PROJECT_TASK_UNBOUND', 'Task has no project');
      requireAccess(session.projectId);
      if (args.assignee === null || args.assignee === undefined) {
        // 清空 = 显式未分配；不允许任何路径用负责人补位。
        updateSessionBinding.run(session.projectId, session.projectId, null, null, sessionId);
        return { ok: true, projectId: session.projectId, sessionId };
      }
      const assignee = asSubject(args.assignee);
      if (!selectMember.get(session.projectId, assignee.kind, assignee.id)) {
        return fail('ASSIGNEE_NOT_MEMBER', 'Only project members can be assigned');
      }
      updateSessionBinding.run(session.projectId, session.projectId, assignee.kind, assignee.id, sessionId);
      return { ok: true, projectId: session.projectId, sessionId };
    }

    if (action === 'delete') {
      const projectId = asText(args.projectId, 200, 'projectId');
      // 已不存在的项目是「未找到」，不是可重试的成功：不把幂等做成假删除。
      requireProject(projectId);
      requireAccess(projectId, true);
      const unboundSessionIds = deleteProjectCascade(projectId);
      return { ok: true, projectId, sessionId: null, unboundSessionIds };
    }

    return fail('INVALID_PARAMS', 'Unknown project action');
  })();
}
