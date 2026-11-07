/**
 * 项目目录的默认归属（`projectDirBinding`）。
 *
 * Value: a claimed folder gives new tasks their default project — but only for members.
 * Bug: the folder claim could otherwise be mistaken for an access grant.
 * Minimal input: real migration 0154 on an in-memory DB + a tiny queryOne adapter.
 * Tier: unit. No IPC; the create paths that call this are covered by their own suites.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { projectDirKeyForSession, resolveDefaultProjectId } from '../projectDirBinding';

const DRIZZLE_DIR = path.resolve(__dirname, '../../../../drizzle');

function applyMigration(db: Database.Database, prefix: string): void {
  const file = readdirSync(DRIZZLE_DIR).find((name) => name.startsWith(prefix) && name.endsWith('.sql'));
  if (!file) throw new Error(`${prefix} migration not found`);
  db.exec(readFileSync(path.join(DRIZZLE_DIR, file), 'utf8').split('--> statement-breakpoint').join(';'));
}

/** queryOne over better-sqlite3: the helper only ever reads single rows. */
function clientOf(db: Database.Database) {
  return {
    queryOne: async <T>(sql: string, params: unknown[] = []): Promise<T | undefined> =>
      db.prepare(sql).get(...params) as T | undefined,
  };
}

describe('project dir key', () => {
  it('uses the same identity vocabulary as the sidebar grouping', () => {
    expect(projectDirKeyForSession({ workingDir: 'C:/work/app' })).toBe('local:C:/work/app');
    expect(projectDirKeyForSession({ workingDir: '/srv/app', remoteHostId: 'build-box' })).toBe(
      'remote:build-box:/srv/app',
    );
    expect(projectDirKeyForSession({ workingDir: '/srv/app', agentDeviceId: 'dev-1' })).toBe(
      'device:dev-1:/srv/app',
    );
    expect(projectDirKeyForSession({ workingDir: '   ' })).toBeNull();
    expect(projectDirKeyForSession({ workingDir: null })).toBeNull();
  });
});

describe('default project binding', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createBetterSqliteDatabase(':memory:');
    db.pragma('foreign_keys=ON');
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active');`);
    applyMigration(db, '0146_');
    applyMigration(db, '0154_');
    db.prepare(
      "INSERT INTO projects (id, name, owner_id, status, created_at, updated_at) VALUES ('p1','P1','acc-1','active',1,1)",
    ).run();
    db.prepare(
      "INSERT INTO project_members (project_id, subject_kind, subject_id, role, added_at) VALUES ('p1','account','acc-1','owner',1)",
    ).run();
    db.prepare(
      "INSERT INTO project_dirs (project_id, dir_key, dir_path, created_at) VALUES ('p1','local:/work/app','/work/app',1)",
    ).run();
  });
  afterEach(() => db.close());

  const resolve = (workingDir: string | null, actor: { kind: 'account' | 'bot'; id: string } | null) =>
    resolveDefaultProjectId(clientOf(db), { workingDir }, actor);

  it('gives members the claimed project and nobody else', async () => {
    expect(await resolve('/work/app', { kind: 'account', id: 'acc-1' })).toBe('p1');
    // 目录不构成授权：非成员在同一个目录里建任务，仍然得到「不归属」。
    expect(await resolve('/work/app', { kind: 'account', id: 'stranger' })).toBeNull();
    // 没有身份（未登录/账号切换中）不猜。
    expect(await resolve('/work/app', null)).toBeNull();
  });

  it('ignores unclaimed folders, archived projects and missing tables', async () => {
    expect(await resolve('/work/other', { kind: 'account', id: 'acc-1' })).toBeNull();
    db.prepare("UPDATE projects SET status = 'archived' WHERE id = 'p1'").run();
    expect(await resolve('/work/app', { kind: 'account', id: 'acc-1' })).toBeNull();
    const stripped = createBetterSqliteDatabase(':memory:');
    try {
      expect(
        await resolveDefaultProjectId(clientOf(stripped), { workingDir: '/work/app' }, {
          kind: 'account',
          id: 'acc-1',
        }),
      ).toBeNull();
    } finally {
      stripped.close();
    }
  });

  it('keeps local and remote folders apart even at the same path', async () => {
    expect(
      await resolveDefaultProjectId(clientOf(db), {
        workingDir: '/work/app',
        remoteHostId: 'build-box',
      }, { kind: 'account', id: 'acc-1' }),
    ).toBeNull();
  });
});
