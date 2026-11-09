/**
 * 自动化运行产生的任务行（规格 A1 / A3 / A5 的落库侧）。
 *
 * 被测的是生产入口 `DesktopSessionStorage.create`：带项目归属的新建任务必须走会话创建的
 * **授权事务**（成员资格 + 项目未归档 + `project_binding_revision` 初始 0 在同一事务里），
 * 被拒时一行都不写；不带项目归属时保持原来的普通插入（旧行为、历史任务归属不变）。
 *
 * 最小失败输入：同一条 insert，成员与非成员各一次 —— 只差成员表一行，落库结果相反。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current';
import type { DbClient } from '../../localDb/client/DbClient';
import { runAuthorizedSessionCreateTransaction } from '../../localDb/worker/opHandlers/authorizedSessionCreateTx';
import { createBetterSqliteDatabase } from '../../localDb/betterSqliteFactory';
import { DesktopSessionStorage } from '../session-storage';

const schema = await import('../../localDb/schema');
const { sessions } = schema;

const OWNER = 'owner-account';
let raw: Database.Database;

beforeEach(() => {
  raw = createBetterSqliteDatabase(':memory:');
  // sessions 的列由真实 Drizzle schema 生成（不是手抄的迁移副本，也不改动生产列定义）。
  const config = getTableConfig(sessions);
  raw.exec(`CREATE TABLE sessions (${config.columns
    .map(
      (column) =>
        `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${
          column.name === 'project_binding_revision' ? ' NOT NULL DEFAULT 0' : ''
        }`,
    )
    .join(', ')})`);
  // 判定只读 projects / project_members；生产 schema 与迁移由 migration tier 负责。
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE project_members (
      project_id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
      role TEXT NOT NULL, added_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, subject_kind, subject_id));
    INSERT INTO projects VALUES ('p-active', 'active'), ('p-archived', 'archived');
    INSERT INTO project_members VALUES
      ('p-active', 'account', '${OWNER}', 'owner', 1),
      ('p-archived', 'account', '${OWNER}', 'owner', 1);
  `);
  const db = drizzle(raw, { schema });
  setCurrentDbClient(
    {
      drizzle: db,
      tx: async (_name: string, args: unknown) => runAuthorizedSessionCreateTransaction(raw, args),
    } as unknown as DbClient,
    OWNER,
  );
});

afterEach(() => {
  clearCurrentDbClient();
});

function meta(overrides: Partial<Parameters<DesktopSessionStorage['create']>[0]> = {}) {
  return {
    id: 'scheduled-task',
    agentKind: 'codex' as const,
    workDir: '/repo/project',
    title: '[Schedule] follow-up',
    model: 'gpt-6-astra',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const storage = new DesktopSessionStorage();
const rowOf = (id: string) =>
  raw
    .prepare(
      'SELECT project_id AS projectId, project_binding_revision AS revision FROM sessions WHERE id=?',
    )
    .get(id) as { projectId: string | null; revision: number } | undefined;

describe('scheduled task project binding on insert', () => {
  it('writes the project with an initial binding revision of 0 for a member', async () => {
    await storage.create(meta({ projectId: 'p-active' }));
    expect(rowOf('scheduled-task')).toEqual({ projectId: 'p-active', revision: 0 });
  });

  it('writes a plain task with no project when the automation has no binding', async () => {
    await storage.create(meta({ id: 'plain-task' }));
    expect(rowOf('plain-task')).toEqual({ projectId: null, revision: 0 });
  });

  it('refuses an archived project and writes no row at all', async () => {
    await expect(
      storage.create(meta({ projectId: 'p-archived' })),
    ).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(rowOf('scheduled-task')).toBeUndefined();
  });

  it('refuses a project the account is not a member of and writes no row at all', async () => {
    raw.prepare("DELETE FROM project_members WHERE project_id='p-active'").run();
    await expect(storage.create(meta({ projectId: 'p-active' }))).rejects.toThrow(/FORBIDDEN/);
    expect(rowOf('scheduled-task')).toBeUndefined();
  });
});
