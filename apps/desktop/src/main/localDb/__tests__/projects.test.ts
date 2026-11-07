/**
 * 项目内核 M1：服务层规则（`runProjectsTransaction`）。
 *
 * 这些用例直接跑真实 migration 产物 `0146_*.sql` 建表，再用事务入口验证规则：
 *   - 负责人必须是成员且唯一；移除负责人必须先转交
 *   - 处理人为空 = 未分配，不由负责人推断；非成员不可被指派
 *   - 成员按 (kind, id) 去重；同名不同 id 分别保留
 *   - 任务绑定项目时，失效的处理人回落为未分配
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runProjectsTransaction } from '../worker/opHandlers/projectsTx';
import {
  PROJECT_GOAL_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  type ProjectsMutationResult,
} from '../../../shared/projects';

const DRIZZLE_DIR = path.resolve(__dirname, '../../../../drizzle');

/** 0146 建立 projects / project_members 并给 sessions 加三列：直接跑真实 migration 产物。 */
function projectSchemaSql(): string {
  const file = readdirSync(DRIZZLE_DIR)
    .filter((name) => name.startsWith('0146_') && name.endsWith('.sql'))
    .sort()
    .at(-1);
  if (!file) throw new Error('0146 migration not found');
  return readFileSync(path.join(DRIZZLE_DIR, file), 'utf8')
    .split('--> statement-breakpoint')
    .join(';');
}

function expectIpcCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect((error as Error).message).toContain(`[${code}]`);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('project core transactions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createBetterSqliteDatabase(':memory:');
    db.pragma('foreign_keys=ON');
    db.exec(
      `CREATE TABLE sessions (
         id TEXT PRIMARY KEY,
         title TEXT,
         status TEXT NOT NULL DEFAULT 'active',
         updated_at INTEGER NOT NULL DEFAULT 1
       );
       INSERT INTO sessions (id, title) VALUES ('task-1', 'Task one'), ('task-2', 'Task two');`,
    );
    db.exec(projectSchemaSql());
    const bindingMigration = readdirSync(DRIZZLE_DIR).find(name => name.startsWith('0148_') && name.endsWith('.sql'))!;
    db.exec(readFileSync(path.join(DRIZZLE_DIR, bindingMigration), 'utf8').split('--> statement-breakpoint').join(';'));
    // 材料 / 引用 / 群关联是删除级联的真实范围，一并跑它们的真 migration 产物。
    for (const prefix of ['0147_', '0149_', '0150_']) {
      const migration = readdirSync(DRIZZLE_DIR).find(name => name.startsWith(prefix) && name.endsWith('.sql'))!;
      db.exec(readFileSync(path.join(DRIZZLE_DIR, migration), 'utf8').split('--> statement-breakpoint').join(';'));
    }
    // 定时任务只用到 project_id 置空：这张表不在项目 migration 里，按 0146..0150 的形状最小建表。
    db.exec("CREATE TABLE schedules (id TEXT PRIMARY KEY, project_id TEXT)");
  });
  afterEach(() => db.close());

  const run = (input: Record<string, unknown>): ProjectsMutationResult =>
    runProjectsTransaction(db, { actor: { kind: 'account', id: 'acc-1' }, ...input });

  const createProject = (
    input: Partial<{
      name: string;
      goal: string | null;
      owner: { kind: 'account' | 'bot'; id: string };
      members: Array<{ kind: 'account' | 'bot'; id: string }>;
    }> = {},
  ) =>
    run({
      action: 'create',
      newId: 'proj-1',
      now: 1_000,
      input: {
        name: 'Cindy desktop',
        goal: 'Ship the project core',
        owner: { kind: 'account', id: 'acc-1' },
        members: [{ kind: 'bot', id: 'bot-1' }],
        ...input,
      },
    });

  const members = (projectId = 'proj-1') =>
    db
      .prepare(
        'SELECT subject_kind AS kind, subject_id AS id, role FROM project_members WHERE project_id = ? ORDER BY role, id',
      )
      .all(projectId) as Array<{ kind: string; id: string; role: string }>;

  it('creates the project with its owner as a member (C1)', () => {
    const result = createProject();
    expect(result).toEqual({ ok: true, projectId: 'proj-1', sessionId: null });

    const row = db
      .prepare('SELECT name, goal, owner_id AS ownerId, status FROM projects WHERE id = ?')
      .get('proj-1');
    expect(row).toEqual({
      name: 'Cindy desktop',
      goal: 'Ship the project core',
      ownerId: 'acc-1',
      status: 'active',
    });
    expect(members()).toEqual([
      { kind: 'bot', id: 'bot-1', role: 'member' },
      { kind: 'account', id: 'acc-1', role: 'owner' },
    ]);
  });

  it('dedupes members by (kind, id) and keeps same-name subjects with different ids (C3)', () => {
    createProject({
      owner: { kind: 'account', id: 'acc-1' },
      members: [
        { kind: 'account', id: 'acc-1' },
        { kind: 'bot', id: 'bot-1' },
        { kind: 'bot', id: 'bot-1' },
        { kind: 'bot', id: 'bot-2' },
      ],
    });
    expect(members()).toEqual([
      { kind: 'bot', id: 'bot-1', role: 'member' },
      { kind: 'bot', id: 'bot-2', role: 'member' },
      { kind: 'account', id: 'acc-1', role: 'owner' },
    ]);
    // 重复添加是幂等 no-op，不是错误。
    run({ action: 'addMember', projectId: 'proj-1', subject: { kind: 'bot', id: 'bot-2' }, now: 2_000 });
    expect(members().filter((member) => member.id === 'bot-2')).toHaveLength(1);
  });

  it('keeps an account and a bot that share the same id string as two members (F1)', () => {
    // 同一 project 下，account 与 bot 的 id 字符串可以相同 —— 它们是两个主体。
    // 唯一键只取 (project_id, subject_id) 时，第二条 INSERT OR IGNORE 会被静默吞掉，
    // 负责人那一行也可能被忽略，出现 owner_id 有值但成员表里没有 owner 行。
    createProject({
      owner: { kind: 'account', id: 'shared-id' },
      members: [{ kind: 'bot', id: 'shared-id' }],
    });
    expect(members()).toEqual([
      { kind: 'account', id: 'acc-1', role: 'member' },
      { kind: 'bot', id: 'shared-id', role: 'member' },
      { kind: 'account', id: 'shared-id', role: 'owner' },
    ]);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM project_members WHERE project_id = 'proj-1'").get(),
    ).toEqual({ n: 3 });
    // 负责人必须是成员：owner_id 有值就必须存在一行 role='owner'。
    expect(
      db
        .prepare(
          "SELECT subject_kind AS kind, subject_id AS id FROM project_members WHERE project_id = 'proj-1' AND role = 'owner'",
        )
        .get(),
    ).toEqual({ kind: 'account', id: 'shared-id' });
    // 重复添加同一个主体仍然是幂等 no-op，不会因为新唯一键而报错。
    run({
      action: 'addMember',
      actor: { kind: 'account', id: 'shared-id' },
      projectId: 'proj-1',
      subject: { kind: 'bot', id: 'shared-id' },
      now: 2_000,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM project_members WHERE project_id = 'proj-1'").get(),
    ).toEqual({ n: 3 });
  });

  it('refuses to remove the owner until ownership moves, then keeps the old owner as a member (C2)', () => {
    createProject();
    expectIpcCode(
      () =>
        run({
          action: 'removeMember',
          projectId: 'proj-1',
          subject: { kind: 'account', id: 'acc-1' },
          now: 2_000,
        }),
      'MUST_TRANSFER_OWNER_FIRST',
    );
    expect(members()).toContainEqual({ kind: 'account', id: 'acc-1', role: 'owner' });

    run({
      action: 'transferOwner',
      projectId: 'proj-1',
      subject: { kind: 'bot', id: 'bot-1' },
      now: 3_000,
    });
    expect(db.prepare('SELECT owner_id AS ownerId FROM projects WHERE id = ?').get('proj-1')).toEqual({
      ownerId: 'bot-1',
    });
    expect(members()).toEqual([
      { kind: 'account', id: 'acc-1', role: 'member' },
      { kind: 'bot', id: 'bot-1', role: 'owner' },
    ]);

    run({
      action: 'removeMember',
      actor: { kind: 'bot', id: 'bot-1' },
      projectId: 'proj-1',
      subject: { kind: 'account', id: 'acc-1' },
      now: 4_000,
    });
    expect(members()).toEqual([{ kind: 'bot', id: 'bot-1', role: 'owner' }]);
  });

  it('only transfers ownership to an existing member', () => {
    createProject();
    expectIpcCode(
      () =>
        run({
          action: 'transferOwner',
          projectId: 'proj-1',
          subject: { kind: 'bot', id: 'bot-9' },
          now: 2_000,
        }),
      'ASSIGNEE_NOT_MEMBER',
    );
  });

  it('keeps at most one owner row per project at the database level', () => {
    createProject();
    expect(() =>
      db
        .prepare(
          "INSERT INTO project_members (project_id, subject_kind, subject_id, role, added_at) VALUES ('proj-1', 'bot', 'bot-7', 'owner', 1)",
        )
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it('binds tasks to a project and clears an assignee that is not a member there (C4)', () => {
    createProject();
    run({ action: 'bindSession', sessionId: 'task-1', projectId: 'proj-1', now: 2_000 });
    expect(
      db.prepare('SELECT project_id AS projectId FROM sessions WHERE id = ?').get('task-1'),
    ).toEqual({ projectId: 'proj-1' });

    run({
      action: 'setAssignee',
      sessionId: 'task-1',
      assignee: { kind: 'bot', id: 'bot-1' },
      now: 3_000,
    });
    expect(
      db
        .prepare('SELECT assignee_kind AS kind, assignee_id AS id FROM sessions WHERE id = ?')
        .get('task-1'),
    ).toEqual({ kind: 'bot', id: 'bot-1' });

    // 第二个项目里没有 bot-1：换绑后不能留下一个不属于新项目的处理人。
    run({
      action: 'create',
      newId: 'proj-2',
      now: 4_000,
      input: { name: 'Other', owner: { kind: 'account', id: 'acc-1' }, members: [] },
    });
    run({ action: 'bindSession', sessionId: 'task-1', projectId: 'proj-2', now: 5_000 });
    expect(
      db
        .prepare('SELECT project_id AS projectId, assignee_kind AS kind, assignee_id AS id FROM sessions WHERE id = ?')
        .get('task-1'),
    ).toEqual({ projectId: 'proj-2', kind: null, id: null });
  });

  it('leaves the assignee empty unless explicitly set, and never falls back to the owner (C5)', () => {
    createProject();
    run({ action: 'bindSession', sessionId: 'task-1', projectId: 'proj-1', now: 2_000 });
    expect(
      db
        .prepare('SELECT assignee_kind AS kind, assignee_id AS id FROM sessions WHERE id = ?')
        .get('task-1'),
    ).toEqual({ kind: null, id: null });

    run({
      action: 'setAssignee',
      sessionId: 'task-1',
      assignee: { kind: 'account', id: 'acc-1' },
      now: 3_000,
    });
    run({ action: 'setAssignee', sessionId: 'task-1', assignee: null, now: 4_000 });
    expect(
      db
        .prepare('SELECT assignee_kind AS kind, assignee_id AS id FROM sessions WHERE id = ?')
        .get('task-1'),
    ).toEqual({ kind: null, id: null });
  });

  it('rejects assigning non-members and unbound tasks (C5)', () => {
    createProject();
    run({ action: 'bindSession', sessionId: 'task-1', projectId: 'proj-1', now: 2_000 });
    expectIpcCode(
      () =>
        run({
          action: 'setAssignee',
          sessionId: 'task-1',
          assignee: { kind: 'bot', id: 'bot-9' },
          now: 3_000,
        }),
      'ASSIGNEE_NOT_MEMBER',
    );
    expectIpcCode(
      () =>
        run({
          action: 'setAssignee',
          sessionId: 'task-2',
          assignee: { kind: 'account', id: 'acc-1' },
          now: 3_000,
        }),
      'PROJECT_TASK_UNBOUND',
    );
  });

  it('clears the assignee when that member is removed from the project', () => {
    createProject();
    run({ action: 'bindSession', sessionId: 'task-1', projectId: 'proj-1', now: 2_000 });
    run({
      action: 'setAssignee',
      sessionId: 'task-1',
      assignee: { kind: 'bot', id: 'bot-1' },
      now: 3_000,
    });
    run({
      action: 'removeMember',
      projectId: 'proj-1',
      subject: { kind: 'bot', id: 'bot-1' },
      now: 4_000,
    });
    expect(
      db
        .prepare('SELECT assignee_kind AS kind, assignee_id AS id FROM sessions WHERE id = ?')
        .get('task-1'),
    ).toEqual({ kind: null, id: null });
  });

  it('rejects unknown projects, archived targets and unknown actions', () => {
    createProject();
    expectIpcCode(
      () => run({ action: 'bindSession', sessionId: 'task-1', projectId: 'missing', now: 2_000 }),
      'NOT_FOUND',
    );
    run({ action: 'update', projectId: 'proj-1', status: 'archived', now: 3_000 });
    expectIpcCode(
      () => run({ action: 'bindSession', sessionId: 'task-1', projectId: 'proj-1', now: 4_000 }),
      'PRECONDITION_FAILED',
    );
    expectIpcCode(() => run({ action: 'nope' }), 'INVALID_PARAMS');
  });

  it('caps name and goal at the shared limits', () => {
    expect(() => createProject({ name: 'x'.repeat(PROJECT_NAME_MAX_LENGTH + 1) })).toThrow(
      /\[INVALID_PARAMS\]/,
    );
    expect(() => createProject({ goal: 'x'.repeat(PROJECT_GOAL_MAX_LENGTH + 1) })).toThrow(
      /\[INVALID_PARAMS\]/,
    );
    // 边界内合法，且 goal 可显式清空。
    createProject({ name: 'x'.repeat(PROJECT_NAME_MAX_LENGTH) });
    run({ action: 'update', projectId: 'proj-1', goal: null, now: 2_000 });
    expect(db.prepare('SELECT goal FROM projects WHERE id = ?').get('proj-1')).toEqual({ goal: null });
  });

  it('stays self-contained so the legacy inline worker can embed it', () => {
    // WorkerThreadTransport 用 toString() 把实现塞进 inline worker：不能引用模块作用域。
    const embedded = new Function('return (' + runProjectsTransaction.toString() + ')')() as typeof runProjectsTransaction;
    embedded(db, {
      actor: { kind: 'account', id: 'acc-1' },
      action: 'create',
      newId: 'proj-embed',
      now: 1_000,
      input: { name: 'Embedded', owner: { kind: 'account', id: 'acc-1' }, members: [] },
    });
    expect(db.prepare('SELECT name FROM projects WHERE id = ?').get('proj-embed')).toEqual({
      name: 'Embedded',
    });
  });

  // DB tier, B1 regression: real bindSession round trips must invalidate an old binding.
  // Existing M1 tests asserted only project/assignee values, never the ABA generation.
  it('B1 increments only on actual project changes, including unbinding, and rolls back failure', () => {
    createProject();
    run({ action: 'create', newId: 'proj-2', now: 1000,
      input: { name: 'Other', owner: { kind: 'account', id: 'acc-1' } } });
    const generation = () => db.prepare('SELECT project_binding_revision FROM sessions WHERE id = ?')
      .pluck().get('task-1');
    const bind = (projectId: string | null) => run({ action: 'bindSession', sessionId: 'task-1', projectId });
    expect(generation()).toBe(0);
    bind('proj-1'); expect(generation()).toBe(1);
    run({ action: 'setAssignee', sessionId: 'task-1', assignee: { kind: 'bot', id: 'bot-1' } });
    expect(generation()).toBe(1);
    run({ action: 'setAssignee', sessionId: 'task-1', assignee: null });
    bind('proj-1'); expect(generation()).toBe(1);
    bind('proj-2'); expect(generation()).toBe(2);
    bind('proj-1'); expect(generation()).toBe(3);
    bind(null); expect(generation()).toBe(4);
    bind(null); expect(generation()).toBe(4);
    bind('proj-1'); expect(generation()).toBe(5);
    expectIpcCode(() => bind('missing'), 'NOT_FOUND');
    expect(generation()).toBe(5);
    expect(db.prepare('SELECT project_id FROM sessions WHERE id = ?').pluck().get('task-1')).toBe('proj-1');
    db.exec("UPDATE sessions SET status = 'archived' WHERE id = 'task-1'");
    expect(generation()).toBe(5);
  });

  // DB tier, access atomicity regression: main prechecks can go stale before worker entry.
  // Previous M1/B1 tests never supplied a caller or revoked authority between check and write.
  // These use the production transaction and generated migrations; no test-only authority bypass.
  const deniedWithoutWrites = (input: Record<string, unknown>, code = 'FORBIDDEN') => {
    const before = db.prepare('SELECT total_changes()').pluck().get();
    expectIpcCode(() => run(input), code);
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(before);
  };

  it.each(['create', 'update', 'addMember', 'removeMember', 'transferOwner', 'bindSession', 'setAssignee', 'delete'])(
    'requires a valid main-only actor for %s, including no-project actions', action => {
      createProject();
      run({ action: 'bindSession', sessionId: 'task-1', projectId: 'proj-1' });
      const validPayload = {
        action, projectId: 'proj-1', sessionId: 'task-1', newId: 'new-project', now: 2000,
        name: 'Changed', input: { name: 'New', owner: { kind: 'account', id: 'acc-1' } },
        subject: { kind: 'bot', id: 'bot-1' }, assignee: { kind: 'account', id: 'acc-1' },
      };
      for (const actor of [undefined, null, {}, { kind: 'other', id: 'a' }, { kind: 'account', id: '' }]) {
        const before = db.prepare('SELECT total_changes()').pluck().get();
        expectIpcCode(() => runProjectsTransaction(db, { ...validPayload, actor }), 'INVALID_PARAMS');
        expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(before);
      }
    },
  );

  it.each(['update', 'addMember', 'removeMember', 'transferOwner', 'delete'])(
    'rechecks owner authority after a prechecked %s loses ownership', action => {
      createProject();
      expect(members()).toContainEqual({ kind: 'account', id: 'acc-1', role: 'owner' });
      const pending = { action, projectId: 'proj-1', now: 4000, name: 'Changed',
        subject: { kind: 'account', id: 'acc-1' } };
      run({ action: 'transferOwner', projectId: 'proj-1', subject: { kind: 'bot', id: 'bot-1' }, now: 3000 });
      deniedWithoutWrites(pending);
    },
  );

  it('rechecks removed membership for both task binding and assignment', () => {
    createProject();
    run({ action: 'bindSession', sessionId: 'task-1', projectId: 'proj-1' });
    const actor = { kind: 'bot', id: 'bot-1' };
    expect(members()).toContainEqual({ ...actor, role: 'member' }); // Membership observed before queued worker entry.
    run({ action: 'removeMember', projectId: 'proj-1', subject: actor, now: 2000 });
    deniedWithoutWrites({ action: 'bindSession', sessionId: 'task-1', projectId: null, actor });
    deniedWithoutWrites({ action: 'setAssignee', sessionId: 'task-1', assignee: null, actor });
    expect(db.prepare('SELECT project_id, project_binding_revision FROM sessions WHERE id = ?').get('task-1'))
      .toEqual({ project_id: 'proj-1', project_binding_revision: 1 });
  });

  it('rechecks the actual source project after a prechecked task moves elsewhere', () => {
    createProject();
    run({ action: 'create', newId: 'proj-2', now: 1000,
      input: { name: 'Other', owner: { kind: 'account', id: 'acc-1' } } });
    run({ action: 'bindSession', sessionId: 'task-1', projectId: 'proj-1' });
    const actor = { kind: 'bot', id: 'bot-1' };
    expect(members()).toContainEqual({ ...actor, role: 'member' });
    run({ action: 'bindSession', sessionId: 'task-1', projectId: 'proj-2' });
    deniedWithoutWrites({ action: 'setAssignee', sessionId: 'task-1', assignee: null, actor });
    deniedWithoutWrites({ action: 'bindSession', sessionId: 'task-1', projectId: 'proj-1', actor });
    expect(db.prepare('SELECT project_binding_revision FROM sessions WHERE id = ?').pluck().get('task-1')).toBe(2);
  });

  it('requires source and target membership separately, including unbinding and no-op binding', () => {
    createProject();
    // A different creator owns the target; this caller has no target membership.
    run({ action: 'create', newId: 'proj-2', now: 1000, actor: { kind: 'account', id: 'other' },
      input: { name: 'Other', owner: { kind: 'account', id: 'other' } } });
    run({ action: 'bindSession', sessionId: 'task-1', projectId: 'proj-1' });
    deniedWithoutWrites({ action: 'bindSession', sessionId: 'task-1', projectId: 'proj-2' });
    const actor = { kind: 'account', id: 'other' };
    deniedWithoutWrites({ action: 'bindSession', sessionId: 'task-1', projectId: 'proj-2', actor });
    deniedWithoutWrites({ action: 'bindSession', sessionId: 'task-1', projectId: null, actor });
    deniedWithoutWrites({ action: 'bindSession', sessionId: 'task-1', projectId: 'proj-1', actor });
    run({ action: 'setAssignee', sessionId: 'task-1', assignee: { kind: 'account', id: 'acc-1' },
      actor: { kind: 'bot', id: 'bot-1' } });
    expect(db.prepare('SELECT project_binding_revision FROM sessions WHERE id = ?').pluck().get('task-1')).toBe(1);
    run({ action: 'bindSession', sessionId: 'task-1', projectId: null, actor: { kind: 'bot', id: 'bot-1' } });
    expect(db.prepare('SELECT project_binding_revision FROM sessions WHERE id = ?').pluck().get('task-1')).toBe(2);
  });

  it('never elevates a same-id bot member from owner_id, even when the owner row is absent', () => {
    createProject({ owner: { kind: 'account', id: 'shared' }, members: [{ kind: 'bot', id: 'shared' }] });
    const actor = { kind: 'bot', id: 'shared' };
    deniedWithoutWrites({ action: 'update', projectId: 'proj-1', name: 'Changed', now: 2000, actor });
    db.exec("DELETE FROM project_members WHERE subject_kind = 'account'");
    deniedWithoutWrites({ action: 'update', projectId: 'proj-1', name: 'Changed', now: 2000, actor });
    run({ action: 'bindSession', sessionId: 'task-1', projectId: 'proj-1', actor }); // Still only a member.
  });

  it('checks real session existence, deletion and unbound assignment even with no target project', () => {
    deniedWithoutWrites({ action: 'bindSession', sessionId: 'missing', projectId: null }, 'NOT_FOUND');
    deniedWithoutWrites({ action: 'setAssignee', sessionId: 'task-1', assignee: null }, 'PROJECT_TASK_UNBOUND');
    db.exec("UPDATE sessions SET status = 'deleted' WHERE id = 'task-1'");
    deniedWithoutWrites({ action: 'bindSession', sessionId: 'task-1', projectId: null }, 'PRECONDITION_FAILED');
    deniedWithoutWrites({ action: 'setAssignee', sessionId: 'task-1', assignee: null }, 'PRECONDITION_FAILED');
  });

  // C1 regression: selecting a bot owner with members=[] used to hide the new project
  // from its authenticated creator. Production transaction + generated schema, DB tier.
  it.each([false, true])('retains the account creator as member for a bot owner (same id: %s)', sameId => {
    const creator = { kind: 'account' as const, id: 'creator' };
    const owner = { kind: 'bot' as const, id: sameId ? 'creator' : 'owner-bot' };
    run({ action: 'create', newId: 'created', now: 1000, actor: creator,
      creator: { kind: 'account', id: 'forged' },
      input: { name: 'Created', owner, members: [], creator: { kind: 'account', id: 'forged' } } });
    expect(members('created')).toEqual([
      { ...creator, role: 'member' }, { ...owner, role: 'owner' },
    ]);
    deniedWithoutWrites({ action: 'update', projectId: 'created', name: 'No extra owner power', now: 2000, actor: creator });
    run({ action: 'removeMember', projectId: 'created', subject: creator, now: 2000, actor: owner });
    deniedWithoutWrites({ action: 'bindSession', sessionId: 'task-1', projectId: 'created', actor: creator });
    run({ action: 'update', projectId: 'created', goal: 'Still owned by bot', now: 3000, actor: owner });
    expect(members('created')).toEqual([{ ...owner, role: 'owner' }]);
  });

  it('deduplicates creator/owner and duplicate members by kind and id without demoting owner', () => {
    const actor = { kind: 'account' as const, id: 'creator' };
    const other = { kind: 'bot' as const, id: 'other' };
    run({ action: 'create', newId: 'created', now: 1000, actor,
      input: { name: 'Created', owner: actor, members: [actor, actor, other, other] } });
    expect(members('created')).toEqual([{ ...other, role: 'member' }, { ...actor, role: 'owner' }]);
    run({ action: 'create', newId: 'another', now: 1000, actor,
      input: { name: 'Another', owner: other, members: [actor, actor, other, other] } });
    expect(members('another')).toEqual([{ ...actor, role: 'member' }, { ...other, role: 'owner' }]);
  });

  // 用户裁决：项目可以删（真删除 + 二次确认），成员数不设业务上限。
  // DB tier：真 migration 产物 + 真事务，验证「该删的删掉 / 该留的只置空」。
  it('deletes the project with its own records, keeping tasks and automations unbound', () => {
    createProject();
    run({ action: 'bindSession', sessionId: 'task-1', projectId: 'proj-1', now: 2_000 });
    run({ action: 'create', newId: 'proj-2', now: 2_000,
      input: { name: 'Keep me', goal: null, owner: { kind: 'account', id: 'acc-1' }, members: [] } });
    run({ action: 'bindSession', sessionId: 'task-2', projectId: 'proj-2', now: 2_000 });
    const insert = (sql: string, ...values: unknown[]) => db.prepare(sql).run(...values);
    insert("INSERT INTO materials (id,project_id,work_item_id,name,status,created_by_kind,created_by_id,created_at,updated_at) VALUES ('mat-1','proj-1',NULL,'spec.txt','active','account','acc-1',1,1)");
    insert("INSERT INTO material_versions (id,material_id,version,sha256,size_bytes,mime,storage_kind,storage_ref,source_mtime,read_state,failure_reason,created_by_kind,created_by_id,created_at) VALUES ('ver-1','mat-1',1,'a','1','text/plain','file','/tmp/spec.txt',1,'ready',NULL,'account','acc-1',1)");
    insert("INSERT INTO material_references (id,project_id,work_item_id,binding_revision,material_id,version,status,created_by_kind,created_by_id,created_at,updated_at) VALUES ('ref-1','proj-1',NULL,NULL,'mat-1',1,'active','account','acc-1',1,1)");
    insert("INSERT INTO material_contexts (id,project_id,binding_revision,work_item_id,purpose,refs_json,created_by_kind,created_by_id,created_at) VALUES ('ctx-1','proj-1',1,'task-1','reference','[]','account','acc-1',1)");
    insert("INSERT INTO project_group_links (id,resource_account_id,resource_device_id,project_id,group_endpoint,group_room_id,status,revision,created_by_kind,created_by_id,updated_by_kind,updated_by_id,created_at,updated_at) VALUES ('link-1','acc-1','dev-1','proj-1','ep','room','active',1,'account','acc-1','account','acc-1',1,1)");
    insert("INSERT INTO project_group_link_requests (actor_kind,actor_id,request_id,canonical_intent,relation_id,commit_revision,status_at_commit,change,created_at) VALUES ('account','acc-1','req-1','{}','link-1',1,'active','linked',1)");
    insert("INSERT INTO work_item_progress_events (event_id,project_id,session_id,binding_revision,actor_kind,actor_id,request_id,intent_json,from_status,to_status,reason,unblock_condition,resolution,completion_note,created_at,revision,before_json,after_json) VALUES (1,'proj-1','task-1',1,'account','acc-1','r1','{}',NULL,'done',NULL,NULL,NULL,NULL,1,1,'{}','{}')");
    insert("INSERT INTO work_item_progress (session_id,project_id,binding_revision,status,revision,reason,unblock_condition,completion_event_id,updated_by_kind,updated_by_id,updated_at) VALUES ('task-1','proj-1',1,'done',1,NULL,NULL,1,'account','acc-1',1)");
    insert("INSERT INTO schedules (id,project_id) VALUES ('sched-1','proj-1'), ('sched-2','proj-2')");

    expect(run({ action: 'delete', projectId: 'proj-1' })).toEqual({
      ok: true, projectId: 'proj-1', sessionId: null, unboundSessionIds: ['task-1'],
    });

    const count = (sql: string, ...values: unknown[]) =>
      db.prepare(sql).pluck().get(...values) as number;
    // 项目自身的记录全部消失（成员靠 FK 级联）。
    expect(count('SELECT COUNT(*) FROM projects WHERE id = ?', 'proj-1')).toBe(0);
    expect(count('SELECT COUNT(*) FROM project_members WHERE project_id = ?', 'proj-1')).toBe(0);
    expect(count('SELECT COUNT(*) FROM materials WHERE project_id = ?', 'proj-1')).toBe(0);
    expect(count('SELECT COUNT(*) FROM material_versions WHERE material_id = ?', 'mat-1')).toBe(0);
    expect(count('SELECT COUNT(*) FROM material_references WHERE project_id = ?', 'proj-1')).toBe(0);
    expect(count('SELECT COUNT(*) FROM material_contexts WHERE project_id = ?', 'proj-1')).toBe(0);
    expect(count('SELECT COUNT(*) FROM project_group_links WHERE project_id = ?', 'proj-1')).toBe(0);
    expect(count('SELECT COUNT(*) FROM project_group_link_requests WHERE relation_id = ?', 'link-1')).toBe(0);
    expect(count('SELECT COUNT(*) FROM work_item_progress WHERE project_id = ?', 'proj-1')).toBe(0);
    expect(count('SELECT COUNT(*) FROM work_item_progress_events WHERE project_id = ?', 'proj-1')).toBe(0);
    // 任务与定时任务保留，只是回到「无项目」；解绑推进绑定代数。
    expect(db.prepare('SELECT project_id, assignee_kind, assignee_id, project_binding_revision FROM sessions WHERE id = ?').get('task-1'))
      .toEqual({ project_id: null, assignee_kind: null, assignee_id: null, project_binding_revision: 2 });
    expect(db.prepare('SELECT project_id FROM sessions WHERE id = ?').get('task-2')).toEqual({ project_id: 'proj-2' });
    expect(db.prepare('SELECT id, project_id FROM schedules ORDER BY id').all()).toEqual([
      { id: 'sched-1', project_id: null }, { id: 'sched-2', project_id: 'proj-2' },
    ]);
    // 别的项目一行不动。
    expect(count('SELECT COUNT(*) FROM projects WHERE id = ?', 'proj-2')).toBe(1);
    // 已不存在的项目是 NOT_FOUND，不是可重试的成功。
    expectIpcCode(() => run({ action: 'delete', projectId: 'proj-1' }), 'NOT_FOUND');
  });

  it('accepts more members than the removed business cap', () => {
    const membersIn = Array.from({ length: 201 }, (_, index) => ({ kind: 'bot' as const, id: `bot-${index}` }));
    run({ action: 'create', newId: 'wide', now: 1_000,
      input: { name: 'Wide', goal: null, owner: { kind: 'account', id: 'acc-1' }, members: membersIn } });
    expect(members('wide')).toHaveLength(202);
  });
});
