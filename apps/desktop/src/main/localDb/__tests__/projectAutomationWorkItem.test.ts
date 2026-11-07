/**
 * 项目进度里的「由自动化创建」来源（规格 A6 的读取侧）。
 *
 * 反查口径必须是**同一条链**：某会话最近一次 run 所属的 automation，且该 automation
 * 现在仍绑在这个项目上（`schedules.project_id`）。手写 SQL 拼接很容易出三类错：
 *   1. 别的项目的 automation 也被标成来源；
 *   2. 自动化解绑后标记不消失；
 *   3. 同一会话被多条自动化跑过时叠出多个来源。
 * 最小失败输入就是这三种行，断言标记只在正确的行上出现。
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { readProjectProgressTransaction } from '../worker/opHandlers/projectProgressReadTx';

const read = (db: Database.Database, projectId: string) =>
  readProjectProgressTransaction(
    db,
    { projectId },
    { actor: { kind: 'account', id: 'same' } },
  );

describe('project progress automation origin', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createBetterSqliteDatabase(':memory:');
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE project_members (project_id TEXT, subject_kind TEXT, subject_id TEXT, role TEXT,
        PRIMARY KEY(project_id,subject_kind,subject_id));
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT,
        status TEXT NOT NULL, project_binding_revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE work_item_progress (
        session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, binding_revision INTEGER NOT NULL,
        status TEXT, revision INTEGER NOT NULL, reason TEXT, unblock_condition TEXT,
        completion_event_id INTEGER, updated_by_kind TEXT NOT NULL, updated_by_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL);
      CREATE TABLE work_item_progress_events (
        event_id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
        binding_revision INTEGER NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL,
        request_id TEXT NOT NULL, intent_json TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
        reason TEXT, unblock_condition TEXT, resolution TEXT, completion_note TEXT,
        created_at INTEGER NOT NULL, revision INTEGER NOT NULL, before_json TEXT NOT NULL,
        after_json TEXT NOT NULL);
      CREATE TABLE schedules (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT);
      CREATE TABLE schedule_runs (
        id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, session_id TEXT, fired_at INTEGER NOT NULL,
        status TEXT NOT NULL);
      CREATE TABLE schedule_session_latest_runs (
        session_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, fired_at INTEGER NOT NULL);

      INSERT INTO projects VALUES ('p','active'),('q','active');
      INSERT INTO project_members VALUES ('p','account','same','owner');
      -- 目标 fixture 只建判定/反查用到的列；生产 schema 与迁移属于 migration tier。
      INSERT INTO schedules VALUES
        ('auto-in-project','Nightly check','p'),
        ('auto-other-project','Other project check','q'),
        ('auto-unbound','Unbound check',NULL);
      INSERT INTO sessions VALUES
        ('s-manual','Opened by hand','p','active',0),
        ('s-automated','Nightly check run','p','active',0),
        ('s-rebound','Nightly check run later','p','active',0),
        ('s-foreign','Other project automation run','p','active',0);
      INSERT INTO schedule_runs VALUES
        ('run-1','auto-in-project','s-automated',100,'success'),
        ('run-2','auto-other-project','s-foreign',100,'success'),
        -- 同一会话先被项目内自动化跑过，后来又被不绑项目的自动化接手：最近一次才作数。
        ('run-3','auto-in-project','s-rebound',100,'success'),
        ('run-4','auto-unbound','s-rebound',200,'success');
      INSERT INTO schedule_session_latest_runs VALUES
        ('s-automated','run-1',100),
        ('s-foreign','run-2',100),
        ('s-rebound','run-4',200);
    `);
  });
  afterEach(() => db.close());

  it('marks only sessions whose latest run belongs to an automation bound to this project', () => {
    const items = read(db, 'p').items;
    const byId = new Map(items.map((item) => [item.sessionId, item]));
    expect(byId.get('s-manual')?.automation).toBeNull();
    expect(byId.get('s-automated')?.automation).toEqual({
      scheduleId: 'auto-in-project',
      scheduleName: 'Nightly check',
    });
    // 别的项目的自动化不是本项目的来源。
    expect(byId.get('s-foreign')?.automation).toBeNull();
    // 最近一次 run 的自动化已解绑 → 不再标注（历史归属不受影响）。
    expect(byId.get('s-rebound')?.automation).toBeNull();
  });

  it('drops the marker once the automation is unbound from the project', () => {
    db.exec("UPDATE schedules SET project_id=NULL WHERE id='auto-in-project'");
    const items = read(db, 'p').items;
    expect(items.find((item) => item.sessionId === 's-automated')?.automation).toBeNull();
  });

  // 进度读取不许被调度器 schema 绑架：这两条是回归保护——曾经把三连 JOIN 写进主查询，
  // 缺表的库（旧库 / 部分库 / 受限环境）整块进度读取直接抛 [INTERNAL]，用户看到的是
  // "进度读不出来"而不是"少一个来源标记"。
  it('reads progress without an automation origin when scheduler tables are absent', () => {
    db.exec(`DROP TABLE schedule_session_latest_runs; DROP TABLE schedule_runs; DROP TABLE schedules;`);
    const items = read(db, 'p').items;
    expect(items.map((item) => item.sessionId)).toEqual(
      expect.arrayContaining(['s-manual', 's-automated']),
    );
    expect(items.every((item) => item.automation === null)).toBe(true);
  });

  it('reads progress without an automation origin on a pre-0153 schedules table', () => {
    // 0153 之前的库没有 schedules.project_id：反查列不存在时按"没有来源"降级。
    db.exec(`ALTER TABLE schedules DROP COLUMN project_id;`);
    const items = read(db, 'p').items;
    expect(items.find((item) => item.sessionId === 's-automated')?.automation).toBeNull();
    expect(items.find((item) => item.sessionId === 's-manual')?.automation).toBeNull();
  });

  it('never invents a work item without a real session row', () => {
    db.exec("DELETE FROM sessions WHERE id='s-automated'");
    expect(read(db, 'p').items.some((item) => item.sessionId === 's-automated')).toBe(false);
  });
});
