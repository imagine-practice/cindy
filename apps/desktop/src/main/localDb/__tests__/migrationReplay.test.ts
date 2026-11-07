import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { listAllPrRefs, listPrRefs, managePrRefs } from '../../git-context/prRefsStore';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current';
import type { DbClient } from '../client/DbClient';
import { listMigrations, runMigrationReplay } from '../migrationRunner';
import { initializeTaskTagPresets } from '../taskTagPresets';
import { runProjectsTransaction } from '../worker/opHandlers/projectsTx';
import { runWorkItemProgressTransaction } from '../worker/opHandlers/workItemProgressTx';
import { runMaterialsTransaction } from '../worker/opHandlers/materialsTx';
import { runProjectGroupLinksTransaction } from '../worker/opHandlers/projectGroupLinksTx';
import { runMaterialDispatchTransaction } from '../worker/opHandlers/materialDispatchTx';
import { createHash } from 'node:crypto';

const canRunMigrationReplay = process.platform === 'win32' || process.platform === 'darwin';
const describeMigrationReplay = canRunMigrationReplay ? describe : describe.skip;

function desktopRoot(): string {
  return path.resolve(__dirname, '../../../..');
}

function drizzleDir(): string {
  return path.join(desktopRoot(), 'drizzle');
}

function sqliteVecFilename(): string {
  if (process.platform === 'win32') return 'vec0.dll';
  if (process.platform === 'darwin') return 'vec0.dylib';
  throw new Error(`migration replay tests only support bundled sqlite-vec on macOS/Windows`);
}

function loadSqliteVec(db: Database.Database): void {
  const extPath = path.join(
    desktopRoot(),
    'native',
    'sqlite-vec',
    `${process.platform}-${process.arch}`,
    sqliteVecFilename(),
  );
  db.loadExtension(extPath);
}

function createTempDb(): { db: Database.Database; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'xdmaker-migration-replay-'));
  const dbPath = path.join(dir, 'replay.db');
  const db = createBetterSqliteDatabase(dbPath);
  loadSqliteVec(db);
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function createTempDrizzleDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'xdmaker-drizzle-replay-'));
  writeFileSync(
    path.join(dir, '0000_create_marker.sql'),
    'CREATE TABLE migrated_marker (id TEXT PRIMARY KEY);\n',
    'utf-8',
  );
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function maxMigrationSeq(): number {
  return Math.max(...listMigrations(drizzleDir()).map((migration) => migration.seq));
}

// Migration tier: 0.1.122 hid every automatic association on a real upgraded profile.
// The previous fixture asserted row retention but accepted disappearance from UI reads.
// Exercise direct and already-upgraded databases through the runner and production store.
describeMigrationReplay('explicit PR association upgrade', () => {
  it.each([140, 143])('keeps existing links visible from schema %i across upgrade and reopen', async (version) => {
    const root = mkdtempSync(path.join(tmpdir(), 'cindy-pr-upgrade-'));
    const staged = path.join(root, 'before'); mkdirSync(staged);
    const filename = path.join(root, 'fixture.db');
    let db = createBetterSqliteDatabase(filename);
    try {
      loadSqliteVec(db);
      for (const migration of listMigrations(drizzleDir()).filter(m => m.seq < 141)) {
        copyFileSync(migration.sqlPath, path.join(staged, migration.fileName));
        if (migration.tsScriptPath) {
          mkdirSync(path.join(staged, 'scripts'), { recursive: true });
          copyFileSync(migration.tsScriptPath, path.join(staged, 'scripts', path.basename(migration.tsScriptPath)));
        }
      }
      runMigrationReplay(db, { drizzleDir: staged });
      db.prepare('INSERT INTO sessions (id,created_at,updated_at) VALUES (?,1,1)').run('fixture');
      const insert = db.prepare(`INSERT INTO session_pr_refs
        (id,session_id,owner,repo,pr_number,url,first_seen_at,last_seen_at,pinned,priority,manually_added,removed_at)
        VALUES (?, 'fixture', 'example', 'repo', ?, ?, 1, 2, ?, ?, ?, ?)`);
      insert.run('manual', 1, 'https://github.com/example/repo/pull/1', 0, 7, 1, null);
      insert.run('pinned', 2, 'https://github.com/example/repo/pull/2', 1, 9, 0, null);
      insert.run('legacy', 3, 'https://github.com/example/repo/pull/3', 0, 0, 0, null);
      insert.run('removed', 4, 'https://github.com/example/repo/pull/4', 0, 3, 1, 42);
      insert.run('removed-auto', 5, 'https://github.com/example/repo/pull/5', 0, 0, 0, 43);
      if (version === 143) {
        for (const migration of listMigrations(drizzleDir()).filter(m => m.seq >= 141 && m.seq <= 143)) {
          copyFileSync(migration.sqlPath, path.join(staged, migration.fileName));
        }
        runMigrationReplay(db, { drizzleDir: staged });
      }
      runMigrationReplay(db, { drizzleDir: drizzleDir() });
      const read = () => db.prepare('SELECT id,association_source,association_origin,priority,removed_at FROM session_pr_refs ORDER BY id').all();
      const upgraded = read();
      expect(upgraded).toEqual([
        { id: 'legacy', association_source: 'explicit', association_origin: 'upgrade', priority: 0, removed_at: null },
        { id: 'manual', association_source: 'explicit', association_origin: null, priority: 7, removed_at: null },
        { id: 'pinned', association_source: 'explicit', association_origin: null, priority: 9, removed_at: null },
        { id: 'removed', association_source: 'explicit', association_origin: null, priority: 3, removed_at: 42 },
        { id: 'removed-auto', association_source: 'legacy', association_origin: null, priority: 0, removed_at: 43 },
      ]);
      setCurrentDbClient({ drizzle: drizzle(db) } as unknown as DbClient, 'fixture');
      expect((await listPrRefs('fixture')).map(ref => ref.id)).toEqual(['pinned', 'manual', 'legacy']);
      expect((await listAllPrRefs()).map(ref => ref.id)).toEqual(['pinned', 'manual', 'legacy']);
      expect(await listPrRefs('unassociated')).toEqual([]);
      await managePrRefs('fixture', { action: 'remove', id: 'legacy' }, async () => undefined);
      const removed = read();
      db.prepare('INSERT INTO github_observations (key,state,updated_at) VALUES (?,?,?)').run('fixture', '{"sequence":1}', 1);
      db.close(); db = createBetterSqliteDatabase(filename); loadSqliteVec(db);
      setCurrentDbClient({ drizzle: drizzle(db) } as unknown as DbClient, 'fixture');
      expect(runMigrationReplay(db, { drizzleDir: drizzleDir() }).applied).toHaveLength(0);
      expect(read()).toEqual(removed);
      expect((await listPrRefs('fixture')).map(ref => ref.id)).toEqual(['pinned', 'manual']);
      expect(db.prepare('SELECT state FROM github_observations WHERE key = ?').pluck().get('fixture')).toBe('{"sequence":1}');
    } finally { clearCurrentDbClient(); db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

function seedFixture(db: Database.Database, name: string): void {
  db.exec(readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8'));
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName) !==
    undefined
  );
}

function indexExists(db: Database.Database, indexName: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(indexName) !==
    undefined
  );
}

function triggerExists(db: Database.Database, triggerName: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(triggerName) !==
    undefined
  );
}

function columnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}


/**
 * `schedules` 在 0152 时的真实形状（0010 建表 + 其后每一处 ALTER）。
 *
 * 0153 是裸 `ALTER TABLE schedules ADD project_id`，而一批"从中途版本回放"的断言夹具从
 * 125+ 起步、自己从不建这张表（真实库自 0010 起必有它）。这些夹具**逐条**调用本常量补出
 * 0152 形状，而不是在 `createTempDb()` 里统一补一个壳：0010 是
 * `CREATE TABLE IF NOT EXISTS`，先建一个只有 id 的壳会让 0010 跳过建全表，
 * 后续读写这些列的迁移反而会崩。迁移文件本身不做条件式改写。
 *
 * 列来源：0010（id…expire_at）、0011 job_type/job_config、0013 manual、
 * 0014 last_finished_at、0015 interval_ms、0021 persistent_session、
 * 0027 source/project_config_id、0037 workspace_kind、0041 fast_mode、
 * 0046 silent_when_idle、0050 provider_id、0061 pre_run_hook_command/
 * pre_run_hook_timeout_ms/skip_log_session_id、0073 execution_mode/script_config、
 * 0079 legacy_session_fallback、0084 notify_wecom_group、0104 model_agent_kind、
 * 0130 agent_device_id、0134 model_agent_device_id、0140 pre_run_plugin_id/
 * pre_run_plugin_on_failure。
 */
const SCHEDULES_AT_0152_SQL = `
  CREATE TABLE schedules (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    kind TEXT DEFAULT 'cron' NOT NULL,
    cron_expr TEXT NOT NULL,
    timezone TEXT NOT NULL,
    recurring INTEGER DEFAULT 1 NOT NULL,
    agent_kind TEXT NOT NULL,
    model TEXT,
    effort TEXT,
    working_dir TEXT,
    use_worktree INTEGER DEFAULT 0 NOT NULL,
    target_session_id TEXT,
    notify_desktop INTEGER DEFAULT 1 NOT NULL,
    notify_feishu INTEGER DEFAULT 0 NOT NULL,
    status TEXT DEFAULT 'active' NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_fired_at INTEGER,
    next_fire_at INTEGER,
    expire_at INTEGER,
    job_type TEXT DEFAULT 'prompt' NOT NULL,
    job_config TEXT,
    manual INTEGER DEFAULT 0 NOT NULL,
    last_finished_at INTEGER,
    interval_ms INTEGER,
    persistent_session INTEGER DEFAULT 0 NOT NULL,
    source TEXT DEFAULT 'user',
    project_config_id TEXT,
    workspace_kind TEXT DEFAULT 'project' NOT NULL,
    fast_mode INTEGER DEFAULT 0 NOT NULL,
    silent_when_idle INTEGER DEFAULT 0 NOT NULL,
    provider_id TEXT,
    pre_run_hook_command TEXT,
    pre_run_hook_timeout_ms INTEGER,
    skip_log_session_id TEXT,
    execution_mode TEXT DEFAULT 'agent' NOT NULL,
    script_config TEXT,
    legacy_session_fallback INTEGER DEFAULT 0 NOT NULL,
    notify_wecom_group INTEGER DEFAULT 0 NOT NULL,
    model_agent_kind TEXT,
    agent_device_id TEXT,
    model_agent_device_id TEXT,
    pre_run_plugin_id TEXT,
    pre_run_plugin_on_failure TEXT
  )`;

describeMigrationReplay('migration replay', () => {
  it.each(['missing', 'legacy', 'partial'])(
    'replays remote report persistence with %s Worker schema',
    (shape) => {
      const { db, cleanup } = createTempDb();
      try {

        // 0153 的裸 ALTER 需要这张表存在；真实库自 0010 起必有。逐条夹具补，不做全局补丁。
        db.exec(SCHEDULES_AT_0152_SQL);
        // Later migrations need the sessions and task tables these Worker fixtures omit.
        db.exec("CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE migration_history (seq INTEGER PRIMARY KEY, file_name TEXT NOT NULL, content_hash TEXT NOT NULL, applied_at INTEGER NOT NULL); CREATE TABLE sessions (id TEXT PRIMARY KEY)");
        if (shape !== 'missing') db.exec(`CREATE TABLE orca_workers (id TEXT PRIMARY KEY${shape === 'partial' ? ', pending_remote_report TEXT' : ''}); INSERT INTO orca_workers (id) VALUES ('worker-1');`);
        db.exec("CREATE TABLE bot_delegations (id TEXT PRIMARY KEY)");
        db.exec("INSERT INTO sessions (id) VALUES ('legacy-session')");
        // These reduced historical fixtures still need the group table present since schema 83.
        db.exec(readFileSync(path.join(drizzleDir(), '0083_gray_katie_power.sql'), 'utf-8'));
        db.exec(readFileSync(path.join(drizzleDir(), '0088_thankful_captain_midlands.sql'), 'utf-8'));
        db.exec(readFileSync(path.join(drizzleDir(), '0045_living_namor.sql'), 'utf-8'));
        const result = runMigrationReplay(db, { drizzleDir: drizzleDir(), currentVersion: 124 });
        expect(result.applied.map((migration) => migration.seq)).toEqual([
          125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142,
          143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154,
        ]);
        expect(columnNames(db, 'chat_cache_rooms')).toEqual(['namespace', 'room_id', 'state', 'version']);
        expect(columnNames(db, 'sessions')).toContain('scheduled_model_baseline');
        expect(columnNames(db, 'sessions')).toContain('notifications_muted');
        expect(columnNames(db, 'sessions')).toContain('last_activity_at');
        expect(db.prepare('SELECT last_activity_at FROM sessions').get()).toEqual({ last_activity_at: null });
        expect(tableExists(db, 'plugin_usage_subjects')).toBe(true);
        expect(tableExists(db, 'plugin_usage_events')).toBe(true);
        expect(columnNames(db, 'plugin_usage_events')).toContain('entry_kind');
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='plugin_usage_events_pending_idx'").get()).toEqual({ name: 'plugin_usage_events_pending_idx' });
        expect(tableExists(db, 'orca_remote_opens')).toBe(true);
        if (shape !== 'missing') {
          expect(columnNames(db, 'orca_workers')).toEqual(expect.arrayContaining(['pending_remote_report', 'remote_stop_confirmed_at']));
          expect(db.prepare('SELECT id FROM orca_workers').all()).toEqual([{ id: 'worker-1' }]);
        }
      } finally {
        cleanup();
      }
    },
  );
  // DB tier: a populated pre-138 PR row must survive the append-only migration.
  // Fresh replay cannot catch losing an existing association or defaulting it hidden.
  // Migration tier regression: replay 0138 through the production runner when
  // a pre-138 database already has some/all columns; the old ALTER SQL failed.
  // The existing fresh-schema test did not cover interrupted/replayed schemas.
  it.each(['none', 'partial', 'all'])(
    'preserves PR associations when %s management/provider columns already exist',
    (existing) => {
      const { db, cleanup } = createTempDb();
      try {

        // 0153 的裸 ALTER 需要这张表存在；真实库自 0010 起必有。逐条夹具补，不做全局补丁。
        db.exec(SCHEDULES_AT_0152_SQL);
        db.exec(
          'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE migration_history (seq INTEGER PRIMARY KEY, file_name TEXT NOT NULL, content_hash TEXT NOT NULL, applied_at INTEGER NOT NULL); CREATE TABLE sessions (id TEXT PRIMARY KEY)',
        );
        db.exec(readFileSync(path.join(drizzleDir(), '0045_living_namor.sql'), 'utf-8'));
        db.exec("INSERT INTO sessions (id) VALUES ('s')");
        db.prepare('INSERT INTO session_pr_refs VALUES (?,?,?,?,?,?,?,?)').run(
          'r',
          's',
          'example',
          'repo',
          1,
          'https://github.com/example/repo/pull/1',
          10,
          20,
        );
        if (existing !== 'none') {
          db.exec('ALTER TABLE session_pr_refs ADD pinned integer DEFAULT false NOT NULL');
          db.exec('ALTER TABLE session_pr_refs ADD priority integer DEFAULT 0 NOT NULL');
          db.exec("ALTER TABLE session_pr_refs ADD provider text DEFAULT 'github' NOT NULL");
        }
        if (existing === 'all') {
          db.exec('ALTER TABLE session_pr_refs ADD manually_added integer DEFAULT false NOT NULL');
          db.exec('ALTER TABLE session_pr_refs ADD removed_at integer');
          db.exec("ALTER TABLE session_pr_refs ADD host text DEFAULT 'github.com' NOT NULL");
        }
        runMigrationReplay(db, { drizzleDir: drizzleDir(), currentVersion: 137 });
        expect(db.prepare('SELECT * FROM session_pr_refs').get()).toEqual({
          id: 'r',
          session_id: 's',
          owner: 'example',
          repo: 'repo',
          pr_number: 1,
          url: 'https://github.com/example/repo/pull/1',
          first_seen_at: 10,
          last_seen_at: 20,
          pinned: 0,
          priority: 0,
          manually_added: 0,
          removed_at: null,
          association_source: 'explicit',
          association_origin: 'upgrade',
          provider: 'github',
          host: 'github.com',
        });
      } finally {
        cleanup();
      }
    },
  );

  it('keeps existing tool usage when upgrading the invocation ledger', () => {
    const { db, cleanup } = createTempDb();
    try {

        // 0153 的裸 ALTER 需要这张表存在；真实库自 0010 起必有。逐条夹具补，不做全局补丁。
        db.exec(SCHEDULES_AT_0152_SQL);
      db.exec("CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE migration_history (seq INTEGER PRIMARY KEY, file_name TEXT NOT NULL, content_hash TEXT NOT NULL, applied_at INTEGER NOT NULL)");
      db.exec(readFileSync(path.join(drizzleDir(), '0128_demonic_odin.sql'), 'utf-8'));
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
      db.prepare('INSERT INTO plugin_usage_subjects (id,source_kind,ghost_id,display_name,recording_started_at) VALUES (?,?,?,?,?)')
        .run('subject', 'manual', 'plugin', 'Plugin', 100);
      db.prepare('INSERT INTO plugin_usage_events (call_id,subject_id,history_generation,occurred_at,tool_name) VALUES (?,?,?,?,?)')
        .run('legacy-tool', 'subject', 0, 100, 'run');
      // These reduced historical fixtures still need the group table present since schema 83.
      db.exec(readFileSync(path.join(drizzleDir(), '0083_gray_katie_power.sql'), 'utf-8'));
      db.exec(readFileSync(path.join(drizzleDir(), '0088_thankful_captain_midlands.sql'), 'utf-8'));
      db.exec(readFileSync(path.join(drizzleDir(), '0045_living_namor.sql'), 'utf-8'));
      runMigrationReplay(db, { drizzleDir: drizzleDir(), currentVersion: 131 });
      expect(db.prepare('SELECT call_id,subject_id,occurred_at,entry_kind FROM plugin_usage_events').all()).toEqual([
        { call_id: 'legacy-tool', subject_id: 'subject', occurred_at: 100, entry_kind: 'tool' },
      ]);
    } finally { cleanup(); }
  });
  it('rolls back migration 131 on failure and safely retries from schema 130', () => {
    const { db, cleanup } = createTempDb();
    try {
      const tempDrizzle = createTempDrizzleDir();
      try {
        copyFileSync(
          path.join(drizzleDir(), '0131_amused_puff_adder.sql'),
          path.join(tempDrizzle.dir, '0131_amused_puff_adder.sql'),
        );
        db.exec(`
          CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO migration_meta (key, value) VALUES ('schema_version', '130');
          CREATE TABLE migration_history (seq INTEGER PRIMARY KEY, file_name TEXT NOT NULL, content_hash TEXT NOT NULL, applied_at INTEGER NOT NULL);
          INSERT INTO migration_history VALUES (130, '0130_parallel_devos.sql', 'fixture-hash', 1);
          CREATE TABLE sessions (id TEXT PRIMARY KEY);
          INSERT INTO sessions (id) VALUES ('existing-session');
          CREATE TRIGGER fail_schema_version_131
          BEFORE UPDATE ON migration_meta
          WHEN NEW.key = 'schema_version' AND NEW.value = '131'
          BEGIN
            SELECT RAISE(ABORT, 'injected schema version failure');
          END;
        `);

        expect(() => runMigrationReplay(db, { drizzleDir: tempDrizzle.dir })).toThrow(
          'injected schema version failure',
        );
        expect(columnNames(db, 'sessions')).not.toContain('last_activity_at');
        expect(db.prepare("SELECT value FROM migration_meta WHERE key = 'schema_version'").pluck().get()).toBe('130');
        expect(db.prepare('SELECT count(*) FROM migration_history WHERE seq = 131').pluck().get()).toBe(0);

        db.exec('DROP TRIGGER fail_schema_version_131');
        const retry = runMigrationReplay(db, { drizzleDir: tempDrizzle.dir });

        expect(retry.applied.map((migration) => migration.seq)).toEqual([131]);
        expect(columnNames(db, 'sessions')).toContain('last_activity_at');
        expect(db.prepare("SELECT value FROM migration_meta WHERE key = 'schema_version'").pluck().get()).toBe('131');
        expect(db.prepare('SELECT count(*) FROM migration_history WHERE seq = 131').pluck().get()).toBe(1);
        expect(db.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 'existing-session' }]);
      } finally {
        tempDrizzle.cleanup();
      }
    } finally { cleanup(); }
  });
  it('adds nullable sessions.hidden_at to a populated database without touching existing tasks', () => {
    const { db, cleanup } = createTempDb();
    try {

        // 0153 的裸 ALTER 需要这张表存在；真实库自 0010 起必有。逐条夹具补，不做全局补丁。
        db.exec(SCHEDULES_AT_0152_SQL);
      db.exec("CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE migration_history (seq INTEGER PRIMARY KEY, file_name TEXT NOT NULL, content_hash TEXT NOT NULL, applied_at INTEGER NOT NULL)");
      db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, pinned_at INTEGER, updated_at INTEGER NOT NULL); INSERT INTO sessions VALUES ('a', 'Visible', 'active', NULL, 1), ('b', 'Pinned', 'archived', 5, 2);");
      db.exec("CREATE TABLE bot_delegations (id TEXT PRIMARY KEY)");
      // These reduced historical fixtures still need the group table present since schema 83.
      db.exec(readFileSync(path.join(drizzleDir(), '0083_gray_katie_power.sql'), 'utf-8'));
      db.exec(readFileSync(path.join(drizzleDir(), '0088_thankful_captain_midlands.sql'), 'utf-8'));
      db.exec(readFileSync(path.join(drizzleDir(), '0045_living_namor.sql'), 'utf-8'));
      const result = runMigrationReplay(db, { drizzleDir: drizzleDir(), currentVersion: 125 });
      expect(result.applied.map((migration) => migration.seq)[0]).toBe(126);
      expect(columnNames(db, 'sessions')).toContain('hidden_at');
      expect(db.prepare('SELECT id, title, status, pinned_at, updated_at, hidden_at FROM sessions ORDER BY id').all()).toEqual([
        { id: 'a', title: 'Visible', status: 'active', pinned_at: null, updated_at: 1, hidden_at: null },
        { id: 'b', title: 'Pinned', status: 'archived', pinned_at: 5, updated_at: 2, hidden_at: null },
      ]);
      db.prepare("UPDATE sessions SET hidden_at = 9 WHERE id = 'a'").run();
      expect(db.prepare("SELECT count(*) AS n FROM sessions WHERE hidden_at IS NULL").get()).toEqual({ n: 1 });
    } finally { cleanup(); }
  });
  it('defaults sessions.notifications_muted to unmuted on a populated database', () => {
    const { db, cleanup } = createTempDb();
    try {

        // 0153 的裸 ALTER 需要这张表存在；真实库自 0010 起必有。逐条夹具补，不做全局补丁。
        db.exec(SCHEDULES_AT_0152_SQL);
      db.exec("CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE migration_history (seq INTEGER PRIMARY KEY, file_name TEXT NOT NULL, content_hash TEXT NOT NULL, applied_at INTEGER NOT NULL)");
      db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL); INSERT INTO sessions VALUES ('a', 'Loud', 'active', 1), ('b', 'Archived', 'archived', 2);");
      db.exec("CREATE TABLE plugin_usage_events (call_id TEXT PRIMARY KEY)");
      // These reduced historical fixtures still need the group table present since schema 83.
      db.exec(readFileSync(path.join(drizzleDir(), '0083_gray_katie_power.sql'), 'utf-8'));
      db.exec(readFileSync(path.join(drizzleDir(), '0088_thankful_captain_midlands.sql'), 'utf-8'));
      db.exec(readFileSync(path.join(drizzleDir(), '0045_living_namor.sql'), 'utf-8'));
      const result = runMigrationReplay(db, { drizzleDir: drizzleDir(), currentVersion: 129 });
      expect(result.applied.map((migration) => migration.seq)).toEqual([
        130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154,
      ]);
      expect(columnNames(db, 'sessions')).toContain('notifications_muted');
      // 存量任务全部回填为「未静音」：升级不能替用户少发提醒。
      expect(db.prepare('SELECT id, notifications_muted FROM sessions ORDER BY id').all()).toEqual([
        { id: 'a', notifications_muted: 0 },
        { id: 'b', notifications_muted: 0 },
      ]);
      db.prepare("UPDATE sessions SET notifications_muted = 1 WHERE id = 'a'").run();
      expect(db.prepare('SELECT id FROM sessions WHERE notifications_muted = 0').all()).toEqual([{ id: 'b' }]);
    } finally { cleanup(); }
  });
  it('commits the complete fresh schema and task presets in one outer transaction', () => {
    const { db, cleanup } = createTempDb();
    try {
      db.transaction(() => {
        runMigrationReplay(db, { drizzleDir: drizzleDir() });
        initializeTaskTagPresets(db);
      })();
      expect(
        db.prepare("SELECT value FROM migration_meta WHERE key='schema_version'").pluck().get(),
      ).toBe(String(maxMigrationSeq()));
      expect(
        db.prepare("SELECT count(*) FROM task_tags WHERE id LIKE 'preset:%'").pluck().get(),
      ).toBe(6);
      expect(db.prepare('SELECT count(*) FROM task_tags').pluck().get()).toBe(12);
    } finally {
      cleanup();
    }
  });
  it('adds runtime provenance without certifying or changing legacy context values', () => {
    const { db, cleanup } = createTempDb();
    const stagedDir = mkdtempSync(path.join(tmpdir(), 'cindy-context-provenance-'));
    try {
      db.exec(`CREATE TABLE migration_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, context_tokens INTEGER, context_window INTEGER);
        INSERT INTO sessions VALUES ('legacy', 140500, 1050000);`);
      const migration = listMigrations(drizzleDir()).find((item) => item.fileName.endsWith('_context_window_runtime.sql'))!;
      copyFileSync(migration.sqlPath, path.join(stagedDir, migration.fileName));
      runMigrationReplay(db, { drizzleDir: stagedDir, currentVersion: migration.seq - 1 });
      expect(db.prepare('SELECT * FROM sessions').get()).toEqual({
        id: 'legacy', context_tokens: 140500, context_window: 1050000, context_window_runtime: null,
      });
    } finally {
      rmSync(stagedDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it.each(['missing table', 'legacy table', 'existing column'] as const)(
    'replays the scheduled Harness migration safely with %s',
    (state) => {
      const { db, cleanup } = createTempDb();
      const stagedDir = mkdtempSync(path.join(tmpdir(), 'xdmaker-drizzle-scheduled-harness-'));
      try {
        db.exec('CREATE TABLE migration_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
        const migration = listMigrations(drizzleDir()).find((item) => item.seq === 104)!;
        copyFileSync(migration.sqlPath, path.join(stagedDir, migration.fileName));
        mkdirSync(path.join(stagedDir, 'scripts'));
        copyFileSync(migration.tsScriptPath!, path.join(stagedDir, 'scripts', path.basename(migration.tsScriptPath!)));
        if (state !== 'missing table') {
          db.exec(`CREATE TABLE schedules (id TEXT PRIMARY KEY, agent_kind TEXT, model TEXT);
            INSERT INTO schedules VALUES ('legacy-schedule', 'codex', 'legacy-model');`);
          if (state === 'existing column') {
            db.exec(`ALTER TABLE schedules ADD model_agent_kind TEXT;
              UPDATE schedules SET model_agent_kind = 'pi';`);
          }
        }
        for (let replay = 0; replay < 2; replay += 1) {
          const result = runMigrationReplay(db, { drizzleDir: stagedDir, currentVersion: 103 });
          expect(result.applied.map((item) => item.seq)).toEqual([104]);
          if (state === 'missing table') {
            expect(tableExists(db, 'schedules')).toBe(false);
          } else {
            expect(db.prepare('SELECT * FROM schedules').all()).toEqual([{
              id: 'legacy-schedule', agent_kind: 'codex', model: 'legacy-model',
              model_agent_kind: state === 'existing column' ? 'pi' : null,
            }]);
          }
          expect(db.prepare("SELECT value FROM migration_meta WHERE key = 'schema_version'").pluck().get()).toBe('104');
        }
      } finally {
        rmSync(stagedDir, { recursive: true, force: true });
        cleanup();
      }
    },
  );

  // Migration tier: upgrading an existing automation must preserve its content
  // and legacy inheritance; partial fixtures and an already-added column are safe.
  it.each(['missing table', 'legacy table', 'existing column'])(
    'replays the scheduled Agent location migration with %s', (state) => {
      const { db, cleanup } = createTempDb();
      const stagedDir = mkdtempSync(path.join(tmpdir(), 'cindy-scheduled-agent-location-'));
      try {
        db.exec('CREATE TABLE migration_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
        const migration = listMigrations(drizzleDir()).find((item) => item.fileName.endsWith('_schedule_model_location.sql'))!;
        copyFileSync(migration.sqlPath, path.join(stagedDir, migration.fileName));
        mkdirSync(path.join(stagedDir, 'scripts'));
        copyFileSync(migration.tsScriptPath!, path.join(stagedDir, 'scripts', path.basename(migration.tsScriptPath!)));
        if (state !== 'missing table') {
          db.exec("CREATE TABLE schedules (id TEXT PRIMARY KEY, prompt TEXT); INSERT INTO schedules VALUES ('old', 'keep this prompt');");
          if (state === 'existing column') db.exec("ALTER TABLE schedules ADD model_agent_device_id TEXT; UPDATE schedules SET model_agent_device_id = 'shared:owner';");
        }
        for (let replay = 0; replay < 2; replay += 1) {
          runMigrationReplay(db, { drizzleDir: stagedDir, currentVersion: migration.seq - 1 });
          if (state === 'missing table') expect(tableExists(db, 'schedules')).toBe(false);
          else expect(db.prepare('SELECT * FROM schedules').all()).toEqual([{ id: 'old', prompt: 'keep this prompt',
            model_agent_device_id: state === 'existing column' ? 'shared:owner' : null }]);
        }
      } finally {
        rmSync(stagedDir, { recursive: true, force: true });
        cleanup();
      }
    },
  );

  it('replays every drizzle migration into a fresh database', () => {
    const { db, cleanup } = createTempDb();
    try {
      const result = runMigrationReplay(db, { drizzleDir: drizzleDir() });
      const schemaVersion = db
        .prepare("SELECT value FROM migration_meta WHERE key='schema_version'")
        .pluck()
        .get();
      const historyCount = db.prepare('SELECT COUNT(*) FROM migration_history').pluck().get();
      const partialIndexes = db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type='index'
             AND name IN (
               'uniq_active_team_per_lead',
               'uniq_orca_workers_focused_per_team',
               'uniq_wechat_inbox_running_session',
               'uniq_wechat_sync_active'
             )
           ORDER BY name`,
        )
        .pluck()
        .all();
      const unreadRunPlan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT count(*) FROM schedule_runs
           WHERE read_at IS NULL
             AND status IN ('success', 'failed', 'aborted', 'interrupted')`,
        )
        .all() as Array<{ detail: string }>;

      expect(result.applied.map((migration) => migration.seq)).toEqual(
        listMigrations(drizzleDir()).map((migration) => migration.seq),
      );
      expect(schemaVersion).toBe(String(maxMigrationSeq()));
      expect(historyCount).toBe(result.applied.length);
      expect(partialIndexes).toEqual([
        'uniq_active_team_per_lead',
        'uniq_orca_workers_focused_per_team',
        'uniq_wechat_inbox_running_session',
        'uniq_wechat_sync_active',
      ]);
      expect(tableExists(db, 'wechat_sync_state')).toBe(true);
      expect(tableExists(db, 'wechat_inbox')).toBe(true);
      expect(tableExists(db, 'wechat_outbox')).toBe(true);
      expect(tableExists(db, 'wechat_file_attachments')).toBe(true);
      expect(tableExists(db, 'schedule_session_latest_runs')).toBe(true);
      // 0153 的加列写在 companion 脚本里（SQLite 的 ADD COLUMN 无 IF NOT EXISTS）：
      // 真实库必须真的多出这一列，守卫不能退化成静默 no-op。
      expect(columnNames(db, 'schedules')).toContain('project_id');
      expect(tableExists(db, 'bot_groups')).toBe(true);
      expect(tableExists(db, 'bot_group_members')).toBe(true);
      expect(tableExists(db, 'bot_group_messages')).toBe(true);
      expect(indexExists(db, 'uniq_bot_group_messages_group_sequence')).toBe(true);
      expect(indexExists(db, 'uniq_bot_group_messages_group_client')).toBe(true);
      expect(indexExists(db, 'idx_bot_group_members_bot')).toBe(true);
      expect(tableExists(db, 'bot_group_plans')).toBe(true);
      expect(tableExists(db, 'bot_group_plan_steps')).toBe(true);
      expect(indexExists(db, 'idx_bot_group_plans_group_created')).toBe(true);
      expect(indexExists(db, 'idx_messages_active_error_tail')).toBe(true);
      expect(indexExists(db, 'idx_schedule_runs_running_schedule')).toBe(true);
      expect(indexExists(db, 'idx_schedule_runs_running_heartbeat')).toBe(true);
      expect(indexExists(db, 'idx_schedule_runs_running_legacy')).toBe(true);
      expect(indexExists(db, 'idx_schedule_runs_unread_terminal')).toBe(true);
      expect(indexExists(db, 'idx_schedule_runs_session_latest')).toBe(true);
      expect(indexExists(db, 'idx_skill_usage_exposures_skill_recent')).toBe(true);
      expect(indexExists(db, 'idx_skill_usage_exposures_skill_recent_any_version')).toBe(true);
      expect(indexExists(db, 'idx_skill_usage_exposures_analyzer_recent_source')).toBe(true);
      expect(triggerExists(db, 'schedule_session_latest_run_insert')).toBe(true);
      expect(triggerExists(db, 'schedule_session_latest_run_delete')).toBe(true);
      expect(triggerExists(db, 'schedule_session_latest_run_update')).toBe(true);
      expect(unreadRunPlan.some((row) => row.detail.includes('idx_schedule_runs_unread_terminal')))
        .toBe(true);

      db.prepare("INSERT INTO sessions (id, created_at, updated_at) VALUES ('s-cjk', 1, 1)").run();
      db.prepare(
        `INSERT INTO messages (id, client_id, session_id, role, content, created_at)
         VALUES ('m-cjk', 'c-cjk', 's-cjk', 'user', '登录报错了', 1)`,
      ).run();
      const indexed = db
        .prepare('SELECT content FROM messages_fts WHERE message_id = ?')
        .get('m-cjk') as { content: string };
      expect(indexed.content).toBe('登 录 报 错 了');
      expect(
        db
          .prepare("SELECT message_id FROM messages_fts WHERE messages_fts MATCH '\"登 录\"'")
          .pluck()
          .all(),
      ).toEqual(['m-cjk']);
    } finally {
      cleanup();
    }
  });

  it('upgrades a schema v39 Orca workflow database through the 0040 script', () => {
    const { db, cleanup } = createTempDb();
    try {
      seedFixture(db, 'schema-v39-orca-workflow.sql');

      const result = runMigrationReplay(db, { drizzleDir: drizzleDir() });
      const workerRows = db
        .prepare(
          `SELECT id, team_id, role, focused
           FROM orca_workers
           ORDER BY created_at`,
        )
        .all();
      const expectedSeqs = listMigrations(drizzleDir())
        .filter((migration) => migration.seq > 39)
        .map((migration) => migration.seq);

      expect(result.applied.map((migration) => migration.seq)).toEqual(expectedSeqs);
      expect(tableExists(db, 'orca_workflows')).toBe(false);
      expect(tableExists(db, 'orca_teams')).toBe(true);
      expect(columnNames(db, 'orca_workers')).toEqual(
        expect.arrayContaining(['team_id', 'role', 'focused', 'idle_since']),
      );
      expect(columnNames(db, 'orca_workers')).not.toContain('workflow_id');
      expect(workerRows).toEqual([
        { id: 'worker-1', team_id: 'team-1', role: 'developer', focused: 1 },
        { id: 'worker-2', team_id: 'team-1', role: 'developer', focused: 0 },
      ]);
      expect(indexExists(db, 'uniq_active_team_per_lead')).toBe(true);
      expect(indexExists(db, 'uniq_orca_workers_focused_per_team')).toBe(true);
      expect(indexExists(db, 'idx_orca_workers_workflow_id')).toBe(false);
      expect(columnNames(db, 'schedules')).toContain('fast_mode');
    } finally {
      cleanup();
    }
  });

  it('converts legacy permission_mode=plan sessions into plan_mode_enabled via 0060', () => {
    const { db, cleanup } = createTempDb();
    // 复刻 0060 之前的库:拷贝 drizzle 目录并剔除 0060,重放到 0059 后再 seed。
    const stagedDir = mkdtempSync(path.join(tmpdir(), 'xdmaker-drizzle-pre0060-'));
    const replay0060Dir = mkdtempSync(path.join(tmpdir(), 'xdmaker-drizzle-only0060-'));
    try {
      for (const migration of listMigrations(drizzleDir())) {
        if (migration.seq >= 60) continue;
        copyFileSync(migration.sqlPath, path.join(stagedDir, migration.fileName));
        if (migration.tsScriptPath) {
          mkdirSync(path.join(stagedDir, 'scripts'), { recursive: true });
          copyFileSync(
            migration.tsScriptPath,
            path.join(stagedDir, 'scripts', path.basename(migration.tsScriptPath)),
          );
        }
      }
      runMigrationReplay(db, { drizzleDir: stagedDir });
      const now = Date.now();
      db.prepare(
        `INSERT INTO sessions (id, permission_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run('legacy-plan-session', 'plan', now, now);
      db.prepare(
        `INSERT INTO sessions (id, permission_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run('plain-session', 'acceptEdits', now, now);

      const result = runMigrationReplay(db, { drizzleDir: drizzleDir() });

      expect(result.applied.map((migration) => migration.seq)).toContain(60);
      expect(columnNames(db, 'sessions')).toContain('plan_mode_enabled');
      const rows = db
        .prepare(
          `SELECT id, permission_mode, plan_mode_enabled FROM sessions ORDER BY id`,
        )
        .all();
      expect(rows).toEqual([
        { id: 'legacy-plan-session', permission_mode: 'ask', plan_mode_enabled: 1 },
        { id: 'plain-session', permission_mode: 'acceptEdits', plan_mode_enabled: 0 },
      ]);

      // 只重放本测试要证明幂等的 0060。把 schema_version 人为倒退后重放所有
      // 后续 DDL 并不是受支持的恢复路径；新表 migration 也不应被迫做成可重复 CREATE。
      const migration0060 = listMigrations(drizzleDir()).find((migration) => migration.seq === 60);
      expect(migration0060).toBeDefined();
      copyFileSync(migration0060!.sqlPath, path.join(replay0060Dir, migration0060!.fileName));
      if (migration0060!.tsScriptPath) {
        mkdirSync(path.join(replay0060Dir, 'scripts'), { recursive: true });
        copyFileSync(
          migration0060!.tsScriptPath,
          path.join(replay0060Dir, 'scripts', path.basename(migration0060!.tsScriptPath)),
        );
      }
      const replayResult = runMigrationReplay(db, { drizzleDir: replay0060Dir, currentVersion: 59 });
      expect(replayResult.applied.map((migration) => migration.seq)).toEqual([60]);
      const replayRows = db
        .prepare(
          `SELECT id, permission_mode, plan_mode_enabled FROM sessions ORDER BY id`,
        )
        .all();
      expect(replayRows).toEqual(rows);
    } finally {
      rmSync(stagedDir, { recursive: true, force: true });
      rmSync(replay0060Dir, { recursive: true, force: true });
      cleanup();
    }
  });

  it('bridges the exact legacy migration lineage through 0074 replay', () => {
    const { db, cleanup } = createTempDb();
    try {

        // 0153 的裸 ALTER 需要这张表存在；真实库自 0010 起必有。逐条夹具补，不做全局补丁。
        db.exec(SCHEDULES_AT_0152_SQL);
      db.exec(`
        CREATE TABLE migration_meta (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        CREATE TABLE migration_history (
          seq INTEGER PRIMARY KEY NOT NULL,
          file_name TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY NOT NULL,
          permission_mode TEXT
        );
        CREATE TABLE schedule_runs (
          id TEXT PRIMARY KEY NOT NULL
        );
        CREATE TABLE right_sidebar_tabs (
          id TEXT PRIMARY KEY NOT NULL,
          session_id TEXT NOT NULL,
          kind TEXT NOT NULL
        );
        INSERT INTO sessions (id, permission_mode) VALUES ('legacy-plan', 'plan');
        INSERT INTO migration_history (seq, file_name, content_hash, applied_at) VALUES
          (47, '0047_add_session_summary.sql', '44c224320ca6f5059d5184deae8f5d074f97bfa6502f3d73a54894a962edaf15', 1047),
          (60, '0060_orange_penance.sql', 'd1dcd9ee1279ef86f5e0a136b8e1b786b11d462373f8ed464476ae3062312ffb', 1060),
          (62, '0062_third_pepper_potts.sql', '8a3ba2f92ebc495995f23a3727a65398fce1a877ffcb08d99df8705f21f49837', 1062),
          (63, '0063_secret_dreaming_celestial.sql', 'd07bdac33796fe1ba80230207f0bf5834d0bf9c9df0c68fe372cbbba42bc7ee8', 1063),
          (64, '0064_amusing_white_tiger.sql', 'ef297d4140b49cb3f6e87d58ea76e7f5a427fc6b3857a02210b9108650dcab23', 1064);
      `);

      db.exec(readFileSync(path.join(drizzleDir(), '0045_living_namor.sql'), 'utf-8'));

      // 本 fixture 自带 0152 形状的 schedules（见 SCHEDULES_AT_0152_SQL）：0153 的裸 ALTER
      // 需要这张表存在，其余表仍是最小库，迁移链必须能一路走完而不是中途炸掉。
      const result = runMigrationReplay(db, {
        drizzleDir: drizzleDir(),
        currentVersion: 73,
      });

      expect(result.applied.map((migration) => migration.seq)).toEqual(
        listMigrations(drizzleDir()).filter((migration) => migration.seq > 73).map((migration) => migration.seq),
      );
      expect(
        db
          .prepare(`SELECT permission_mode, plan_mode_enabled FROM sessions WHERE id = ?`)
          .get('legacy-plan'),
      ).toEqual({ permission_mode: 'ask', plan_mode_enabled: 1 });
      expect(columnNames(db, 'sessions')).toEqual(
        expect.arrayContaining(['active_turn_started_at', 'active_turn_pid']),
      );
      expect(columnNames(db, 'schedule_runs')).toEqual(
        expect.arrayContaining([
          'heartbeat_at',
          'pre_run_hook_result',
          'cost_usd',
          'estimated_value_usd',
          'cost_attribution',
        ]),
      );
      // 本 fixture 现在自带 0152 形状的 schedules：0153 是裸 ALTER，不能作用在不存在的表上
      // （真实库自 0010 起必有该表）。0084 的裸 ALTER 因列已存在而由冻结缺陷守卫跳过。
      expect(tableExists(db, 'schedules')).toBe(true);
      expect(columnNames(db, 'schedules')).toContain('project_id');
      expect(tableExists(db, 'project_aliases')).toBe(true);
      expect(tableExists(db, 'device_link_ownership')).toBe(true);
      expect(
        db
          .prepare(
            `SELECT seq, file_name
           FROM migration_history
           WHERE seq IN (47, 60, 62, 63, 64, 74, 75, 76, 77, 78)
           ORDER BY seq`,
          )
          .all(),
      ).toEqual([
        { seq: 47, file_name: '0047_lame_malice.sql' },
        { seq: 60, file_name: '0060_orange_penance.sql' },
        { seq: 62, file_name: '0062_flaky_mimic.sql' },
        { seq: 63, file_name: '0063_handy_tenebrous.sql' },
        { seq: 64, file_name: '0064_icy_bruce_banner.sql' },
        { seq: 74, file_name: '0074_bridge_legacy_migration_lineage.sql' },
        { seq: 75, file_name: '0075_complex_strong_guy.sql' },
        { seq: 76, file_name: '0076_melted_post.sql' },
        { seq: 77, file_name: '0077_nebulous_veda.sql' },
        { seq: 78, file_name: '0078_same_juggernaut.sql' },
      ]);
    } finally {
      cleanup();
    }
  });

  it('normalizes duplicate worker labels deterministically before enforcing uniqueness', () => {
    const { db, cleanup } = createTempDb();
    const stagedDir = mkdtempSync(path.join(tmpdir(), 'xdmaker-drizzle-pre0078-'));
    try {
      for (const migration of listMigrations(drizzleDir())) {
        if (migration.seq >= 78) continue;
        copyFileSync(migration.sqlPath, path.join(stagedDir, migration.fileName));
        if (migration.tsScriptPath) {
          mkdirSync(path.join(stagedDir, 'scripts'), { recursive: true });
          copyFileSync(
            migration.tsScriptPath,
            path.join(stagedDir, 'scripts', path.basename(migration.tsScriptPath)),
          );
        }
      }
      runMigrationReplay(db, { drizzleDir: stagedDir });
      const now = Date.now();
      for (const id of ['lead', 'worker-1', 'worker-2', 'worker-3', 'worker-4']) {
        db.prepare('INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)').run(id, now, now);
      }
      db.prepare(`INSERT INTO orca_teams
        (id, lead_session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .run('team-1', 'lead', 'active', now, now);
      const insertWorker = db.prepare(`INSERT INTO orca_workers
        (id, team_id, session_id, status, label, role, focused, created_at, updated_at)
        VALUES (?, 'team-1', ?, 'idle', ?, 'tester', 0, ?, ?)`);
      insertWorker.run('worker-row-1', 'worker-1', 'Tester', 1, 1);
      insertWorker.run('worker-row-2', 'worker-2', 'tester', 2, 2);
      insertWorker.run('worker-row-3', 'worker-3', 'tester-2', 3, 3);

      runMigrationReplay(db, { drizzleDir: drizzleDir() });

      expect(db.prepare('SELECT label FROM orca_workers ORDER BY created_at').pluck().all()).toEqual([
        'tester',
        'tester-3',
        'tester-2',
      ]);
      expect(tableExists(db, 'orca_worker_creation_reservations')).toBe(true);
      expect(indexExists(db, 'uniq_orca_workers_team_label')).toBe(true);
      expect(() => insertWorker.run('worker-row-4', 'worker-4', 'TESTER', 4, 4)).toThrow();
    } finally {
      rmSync(stagedDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it('keeps migration committed when the history side-write fails', () => {
    const { db, cleanup: cleanupDb } = createTempDb();
    const { dir, cleanup: cleanupDrizzle } = createTempDrizzleDir();
    try {
      db.exec(`
        CREATE TABLE migration_meta (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        CREATE TABLE migration_history (
          seq INTEGER PRIMARY KEY NOT NULL
        );
      `);

      const historyFailures: Array<{ seq: number; fileName: string; error: unknown }> = [];
      const result = runMigrationReplay(db, {
        drizzleDir: dir,
        onMigrationHistoryWriteFailed: (failure) => {
          historyFailures.push(failure);
        },
      });
      const schemaVersion = db
        .prepare("SELECT value FROM migration_meta WHERE key='schema_version'")
        .pluck()
        .get();

      expect(result.applied.map((migration) => migration.seq)).toEqual([0]);
      expect(tableExists(db, 'migrated_marker')).toBe(true);
      expect(schemaVersion).toBe('0');
      expect(historyFailures).toHaveLength(1);
      expect(historyFailures[0]).toMatchObject({
        seq: 0,
        fileName: '0000_create_marker.sql',
      });
      expect(historyFailures[0]?.error).toBeInstanceOf(Error);
    } finally {
      cleanupDb();
      cleanupDrizzle();
    }
  });
});

// Migration tier, B1: upgrade a populated pre-generation database, then use the real binder.
// Fresh-schema tests cannot detect lost material/context rows or the old default generation.
describeMigrationReplay('project/material/B1 upgrade', () => {
  it('preserves old rows, defaults generation to zero, and retains progress history across bindings', () => {
    const { db, cleanup } = createTempDb();
    const staged = mkdtempSync(path.join(tmpdir(), 'cindy-project-upgrade-'));
    try {
      for (const migration of listMigrations(drizzleDir()).filter(m => m.seq <= 147)) {
        copyFileSync(migration.sqlPath, path.join(staged, migration.fileName));
        if (migration.tsScriptPath) {
          mkdirSync(path.join(staged, 'scripts'), { recursive: true });
          copyFileSync(migration.tsScriptPath, path.join(staged, 'scripts', path.basename(migration.tsScriptPath)));
        }
      }
      runMigrationReplay(db, { drizzleDir: staged });
      db.exec(`INSERT INTO sessions (id,created_at,updated_at,project_id) VALUES ('s',1,1,'p');
        INSERT INTO projects VALUES ('p','Project',NULL,'owner','active',1,1), ('q','Other',NULL,'owner','active',1,1);
        INSERT INTO project_members VALUES ('p','account','owner','owner',1), ('q','account','owner','owner',1);
        INSERT INTO materials VALUES ('m','p','s','doc.txt','active','account','owner',1,1);
        INSERT INTO material_versions VALUES ('v','m',1,'digest',3,'text/plain','file','/fixture/doc.txt',1,'ready',NULL,'account','owner',1);
        INSERT INTO material_contexts VALUES ('c','s','reference','[{"materialId":"m","version":1,"readStateAtPin":"ready"}]','account','owner',1);`);
      const snapshot = () => ['projects','project_members','materials','material_versions','material_contexts']
        .map(table => db.prepare(table === 'material_contexts' ? 'SELECT id,work_item_id,purpose,refs_json,created_by_kind,created_by_id,created_at FROM material_contexts' : 'SELECT * FROM ' + table).all());
      const old = snapshot();
      const result = runMigrationReplay(db, { drizzleDir: drizzleDir() });
      expect(result.applied.map(m => m.seq)).toEqual([148, 149, 150, 151, 152, 153, 154]);
      expect(snapshot()).toEqual(old);
      expect(db.prepare('SELECT project_binding_revision FROM sessions').pluck().get()).toBe(0);
      expect(columnNames(db, 'session_pr_refs')).toEqual(expect.arrayContaining(['provider', 'host']));
      expect(columnNames(db, 'work_item_progress_events')).toContain('binding_revision');
      const insertEvent = db.prepare(`INSERT INTO work_item_progress_events
        (event_id,project_id,session_id,binding_revision,actor_kind,actor_id,request_id,intent_json,
         from_status,to_status,created_at,revision,before_json,after_json,completion_note)
        VALUES (?,'p','s',?,'account','owner','request','{}',NULL,'done',1,1,'null','{}','confirmed')`);
      insertEvent.run(1, 0);
      db.exec(`INSERT INTO work_item_progress
        (session_id,project_id,binding_revision,status,revision,completion_event_id,updated_by_kind,updated_by_id,updated_at)
        VALUES ('s','p',0,'done',1,1,'account','owner',1)`);
      const history = db.prepare('SELECT * FROM work_item_progress_events').all();
      const current = db.prepare('SELECT * FROM work_item_progress').all();
      for (const projectId of ['q','p',null,'p']) {
        runProjectsTransaction(db, { actor: { kind: 'account', id: 'owner' }, action: 'bindSession', sessionId: 's', projectId });
      }
      expect(db.prepare('SELECT project_binding_revision FROM sessions').pluck().get()).toBe(4);
      expect(db.prepare('SELECT * FROM work_item_progress_events').all()).toEqual(history);
      expect(db.prepare('SELECT * FROM work_item_progress').all()).toEqual(current);
      expect(() => insertEvent.run(2, 0)).toThrow(/UNIQUE/);
      insertEvent.run(2, 4); // Same request is legal in a new binding generation.
      expect(db.prepare('SELECT COUNT(*) FROM work_item_progress_events').pluck().get()).toBe(2);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(runMigrationReplay(db, { drizzleDir: drizzleDir() }).applied).toEqual([]);
      expect(snapshot()).toEqual(old);
    } finally {
      rmSync(staged, { recursive: true, force: true });
      cleanup();
    }
  });
});

// Migration tier, B1 integration: target-fixture tests cannot prove the generated SQL,
// actual bindSession producer and fixed progress consumer agree on the binding epoch.
// Minimal ABA: done in p, p -> q/null -> p without intermediate progress, then replay.
describeMigrationReplay('B1 generated schema and production transaction integration', () => {
  it.each(['q', null])('rejects old epoch after p -> %s -> p and starts new progress from unknown', (via) => {
    const { db, cleanup } = createTempDb();
    try {
      runMigrationReplay(db, { drizzleDir: drizzleDir() });
      for (const projectId of ['p', 'q']) {
        runProjectsTransaction(db, {
          actor: { kind: 'account', id: 'owner' },
          action: 'create', newId: projectId, now: 1000,
          input: { name: projectId, owner: { kind: 'account', id: 'owner' } },
        });
      }
      db.prepare('INSERT INTO sessions (id, created_at, updated_at) VALUES (?, 1, 1)').run('s');
      const bind = (projectId: string | null) =>
        runProjectsTransaction(db, { actor: { kind: 'account', id: 'owner' }, action: 'bindSession', sessionId: 's', projectId });
      const epoch = () => db.prepare('SELECT project_binding_revision FROM sessions WHERE id = ?')
        .pluck().get('s') as number;
      const snapshot = () => ({
        current: db.prepare('SELECT * FROM work_item_progress').all(),
        events: db.prepare('SELECT * FROM work_item_progress_events ORDER BY event_id').all(),
      });
      bind('p');
      expect(epoch()).toBe(1);
      const oldIntent = {
        projectId: 'p', sessionId: 's', expectedRevision: 0, expectedBindingRevision: epoch(),
        requestId: 'same-request', to: 'done', completionNote: 'Owner confirmed progress',
      };
      const context = { actor: { kind: 'account' as const, id: 'owner' }, now: 2000 };
      const first = runWorkItemProgressTransaction(db, oldIntent, context);
      expect(first.record).toMatchObject({ status: 'done', bindingRevision: 1, revision: 1,
        completionEventId: first.eventId });
      const old = snapshot();
      bind('p');
      runProjectsTransaction(db, { actor: { kind: 'account', id: 'owner' }, action: 'setAssignee', sessionId: 's',
        assignee: { kind: 'account', id: 'owner' } });
      expect(epoch()).toBe(1);
      expect(runWorkItemProgressTransaction(db, oldIntent, context)).toEqual({ ...first, replayed: true });
      expect(snapshot()).toEqual(old);
      bind(via);
      bind('p');
      expect(epoch()).toBe(3);
      expect(snapshot()).toEqual(old);
      // Both replay and a fresh write with the old binding token must be rejected without writes.
      const beforeRejectedWrites = db.prepare('SELECT total_changes()').pluck().get();
      for (const requestId of ['same-request', 'new-stale-request']) {
        expect(() => runWorkItemProgressTransaction(db, { ...oldIntent, requestId }, context))
          .toThrow('[BINDING_CONFLICT]');
        expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(beforeRejectedWrites);
        expect(snapshot()).toEqual(old);
      }
      expect(() => runWorkItemProgressTransaction(db, {
        ...oldIntent, expectedBindingRevision: epoch(), expectedRevision: 1,
      }, context)).toThrow('[REVISION_CONFLICT]');
      expect(snapshot()).toEqual(old);
      const newIntent = {
        projectId: 'p', sessionId: 's', expectedRevision: 0, expectedBindingRevision: epoch(),
        requestId: 'same-request', to: 'doing',
      };
      const next = runWorkItemProgressTransaction(db, newIntent, { ...context, now: 3000 });
      expect(next).toMatchObject({ replayed: false, revision: 1,
        record: { status: 'doing', bindingRevision: 3, completionEventId: null } });
      expect(next.eventId).not.toBe(first.eventId);
      const saved = snapshot();
      expect(saved.events[0]).toEqual(old.events[0]);
      expect(saved.events[1]).toMatchObject({ from_status: null, before_json: 'null', binding_revision: 3 });
      expect(saved.events).toHaveLength(2);
      expect(runWorkItemProgressTransaction(db, newIntent, context)).toEqual({ ...next, replayed: true });
      expect(snapshot()).toEqual(saved);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

// Migration tier, R1/R12: real populated pre-reference DB, generated SQL + real companion.
// Covers adoption/null-epoch history, immutable snapshot bytes, rollback and reopen idempotency.
describeMigrationReplay('R1 legacy reference adoption', () => {
  it('conservatively migrates each legacy scope and preserves old rows through failure, retry and reopen', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cindy-material-r1-'));
    const staged = path.join(root, 'before'); mkdirSync(staged);
    const filename = path.join(root, 'fixture.db');
    let db = createBetterSqliteDatabase(filename);
    try {
      loadSqliteVec(db);
      for (const m of listMigrations(drizzleDir()).filter(m => m.seq <= 148)) {
        copyFileSync(m.sqlPath, path.join(staged, m.fileName));
        if (m.tsScriptPath) {
          mkdirSync(path.join(staged, 'scripts'), { recursive: true });
          copyFileSync(m.tsScriptPath, path.join(staged, 'scripts', path.basename(m.tsScriptPath)));
        }
      }
      runMigrationReplay(db, { drizzleDir: staged });
      const actor = { kind: 'account' as const, id: 'owner' };
      for (const p of ['p','q']) runProjectsTransaction(db, { action: 'create', newId: p, actor, now: 1, input: { name: p, owner: actor } });
      const insertTask = db.prepare('INSERT INTO sessions (id,project_id,status,project_binding_revision,created_at,updated_at) VALUES (?,?,?,?,1,1)');
      insertTask.run('initial','p','active',0); insertTask.run('later','p','active',7);
      insertTask.run('deleted','p','deleted',0); insertTask.run('other','q','active',0);
      insertTask.run('unbound',null,'active',2);
      const cases = [
        { id: 'project', task: null, status: 'active' },
        { id: 'initial', task: 'initial', status: 'active' },
        { id: 'removed', task: 'initial', status: 'removed' },
        ...['later','deleted','other','missing','unbound'].map(task => ({ id: task, task, status: 'active' })),
        { id: 'no-version', task: null, status: 'active' },
      ];
      const insertMaterial = db.prepare("INSERT INTO materials VALUES (?,'p',?, ?,?,'account','owner',1,2)");
      const insertVersion = db.prepare(`INSERT INTO material_versions VALUES (?,?,?, ?,1,'text/plain','file','/fixture/source.txt',1,'ready',NULL,'account','owner',1)`);
      for (const c of cases) {
        insertMaterial.run(c.id, c.task, c.id+'.txt', c.status);
        if (c.id !== 'no-version') for (const v of [1,2]) insertVersion.run(c.id+'-v'+v,c.id,v,String(v).repeat(64));
      }
      const refsJson = JSON.stringify([{ materialId: 'initial', version: 1, readStateAtPin: 'ready' }]);
      db.prepare('INSERT INTO material_contexts VALUES (?,?,?,?,?,?,?)').run('snapshot','initial','reference',refsJson,'account','owner',1);
      const oldVersions = db.prepare('SELECT * FROM material_versions ORDER BY id').all();
      const oldMaterials = db.prepare('SELECT * FROM materials ORDER BY id').all();
      // Fail after the reference INSERT to prove DDL and backfill roll back together.
      db.exec(`CREATE TRIGGER fail_r1 BEFORE INSERT ON migration_meta
        WHEN NEW.key='material_reference_r1_migration_summary'
        BEGIN SELECT RAISE(ABORT,'r1 fixture failure'); END`);
      expect(() => runMigrationReplay(db, { drizzleDir: drizzleDir() })).toThrow('r1 fixture failure');
      expect(tableExists(db, 'material_references')).toBe(false);
      expect(columnNames(db,'material_contexts')).not.toContain('binding_revision');
      expect(db.prepare("SELECT value FROM migration_meta WHERE key='schema_version'").pluck().get()).toBe('148');
      db.exec('DROP TRIGGER fail_r1');
      expect(runMigrationReplay(db, { drizzleDir: drizzleDir() }).applied.map(m => m.seq)).toEqual([149,150,151,152,153,154]);
      expect(db.prepare('SELECT * FROM material_versions ORDER BY id').all()).toEqual(oldVersions);
      expect(db.prepare('SELECT * FROM materials ORDER BY id').all()).toEqual(oldMaterials);
      expect(db.prepare('SELECT refs_json,project_id,binding_revision FROM material_contexts').get()).toEqual({
        refs_json: refsJson, project_id: null, binding_revision: null,
      });
      const refs = db.prepare('SELECT material_id,binding_revision,version,status FROM material_references ORDER BY material_id').all() as Array<Record<string, unknown>>;
      expect(refs).toHaveLength(8);
      expect(refs.find(r => r.material_id === 'initial')).toMatchObject({ binding_revision: 0, version: 2, status: 'active' });
      expect(refs.find(r => r.material_id === 'removed')).toMatchObject({ binding_revision: 0, version: 2, status: 'removed' });
      for (const id of ['later','deleted','other','missing','unbound']) expect(refs.find(r => r.material_id === id)?.binding_revision).toBeNull();
      expect(JSON.parse(db.prepare("SELECT value FROM migration_meta WHERE key='material_reference_r1_migration_summary'").pluck().get() as string)).toEqual({
        projectReferences: 1, initialTaskReferences: 2, unresolvedTaskReferences: 5, materialsWithoutVersion: 1,
      });
      const base = { actor, projectId: 'p' };
      const list = (task: string | null, binding: number | null) => runMaterialsTransaction(db, {
        ...base, action: 'list', workItemId: task, bindingRevision: binding,
      }) as { materials: Array<{ currentVersion: number }> };
      expect(list(null,null).materials).toHaveLength(1);
      expect(list('initial',0).materials).toHaveLength(1);
      expect(list('later',7).materials).toEqual([]);
      expect((runMaterialsTransaction(db, { ...base, action: 'list', workItemId: 'later', history: true }) as { materials: unknown[] }).materials).toHaveLength(1);
      expect(() => db.exec("UPDATE material_references SET version=99 WHERE material_id='initial'")).toThrow(/FOREIGN KEY/);
      expect(() => db.exec("UPDATE material_references SET binding_revision=0 WHERE material_id='project'")).toThrow(/CHECK/);
      expect(() => db.exec(`INSERT INTO material_references SELECT 'duplicate',project_id,work_item_id,binding_revision,material_id,version,status,created_by_kind,created_by_id,created_at,updated_at FROM material_references WHERE material_id='removed'`)).toThrow(/UNIQUE/);
      for (const projectId of [null,'p']) runProjectsTransaction(db, { action: 'bindSession', actor, sessionId: 'initial', projectId });
      expect(list('initial',2).materials).toEqual([]);
      expect((runMaterialsTransaction(db, { action: 'resolveVersion', actor, contextId: 'snapshot', materialId: 'initial', version: 1 }) as { version: { version: number } }).version.version).toBe(1);
      const stored = db.prepare('SELECT * FROM material_references ORDER BY id').all();
      db.close(); db = createBetterSqliteDatabase(filename); loadSqliteVec(db);
      expect(runMigrationReplay(db, { drizzleDir: drizzleDir() }).applied).toEqual([]);
      expect(db.prepare('SELECT * FROM material_references ORDER BY id').all()).toEqual(stored);
      expect(db.prepare('SELECT refs_json FROM material_contexts').pluck().get()).toBe(refsJson);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

// Migration tier: true 0149 upgrade, DDL rollback, persisted receipts across reopen.
// Existing R1 replay does not cover link CAS/replay; a lost ACK must not relink a tombstone.
describeMigrationReplay('project/group local link upgrade and durable replay', () => {
  it('creates empty metadata tables, rolls back partial DDL, then recovers old link receipts after reopen', () => {
    const root=mkdtempSync(path.join(tmpdir(),'cindy-group-link-upgrade-'));
    const staged=path.join(root,'before');mkdirSync(staged);
    const filename=path.join(root,'fixture.db');let db=createBetterSqliteDatabase(filename);
    try {
      loadSqliteVec(db);
      for(const migration of listMigrations(drizzleDir()).filter(m=>m.seq<=149)) {
        copyFileSync(migration.sqlPath,path.join(staged,migration.fileName));
        if(migration.tsScriptPath){mkdirSync(path.join(staged,'scripts'),{recursive:true});copyFileSync(migration.tsScriptPath,path.join(staged,'scripts',path.basename(migration.tsScriptPath)));}
      }
      runMigrationReplay(db,{drizzleDir:staged});
      const actor={kind:'account' as const,id:'owner'};
      runProjectsTransaction(db,{action:'create',newId:'p',actor,now:1,input:{name:'private-title',goal:'private-goal',owner:actor}});
      db.exec("CREATE TABLE project_group_links(id TEXT PRIMARY KEY)");
      expect(()=>runMigrationReplay(db,{drizzleDir:drizzleDir()})).toThrow(/already exists/);
      expect(tableExists(db,'project_group_link_requests')).toBe(false);
      expect(db.prepare("SELECT value FROM migration_meta WHERE key='schema_version'").pluck().get()).toBe('149');
      expect(db.prepare('SELECT seq FROM migration_history WHERE seq=150').get()).toBeUndefined();
      db.exec('DROP TABLE project_group_links');
      expect(runMigrationReplay(db,{drizzleDir:drizzleDir()}).applied.map(m=>m.seq)).toEqual([150,151,152,153,154]);
      expect(db.prepare('SELECT COUNT(*) FROM project_group_links').pluck().get()).toBe(0);
      expect(db.prepare('SELECT COUNT(*) FROM project_group_link_requests').pluck().get()).toBe(0);
      const group={endpoint:'https://chat.example/Case/API',roomId:'aaaaaaaa-1111-4111-8111-111111111111'};
      const target={accountId:'account',deviceId:'device',projectId:'p'};
      const context={actor,accountId:'account',deviceId:'device',group,now:1000};
      const intent={action:'link',requestId:'lost-ack',group,target,expectedRevision:0};
      runProjectGroupLinksTransaction(db,{intent,context,newRelationId:'stable-row'});
      runProjectGroupLinksTransaction(db,{context,intent:{action:'unlink',requestId:'remove',group,target,relationId:'stable-row',expectedRevision:1}});
      const rows=db.prepare('SELECT * FROM project_group_links').all(),receipts=db.prepare('SELECT * FROM project_group_link_requests ORDER BY request_id').all();
      expect(JSON.stringify([rows,receipts])).not.toMatch(/private-title|private-goal|storageRef|grant/);
      db.close();db=createBetterSqliteDatabase(filename);loadSqliteVec(db);
      expect(runMigrationReplay(db,{drizzleDir:drizzleDir()}).applied).toEqual([]);
      const before=db.prepare('SELECT total_changes()').pluck().get();
      expect(runProjectGroupLinksTransaction(db,{intent,context,newRelationId:'not-used'})).toMatchObject({
        replayed:true,commit:{relationId:'stable-row',revision:1,statusAtCommit:'active'},current:{revision:2,status:'removed'},
      });
      expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(before);
      expect(db.prepare('SELECT * FROM project_group_links').all()).toEqual(rows);
      expect(db.prepare('SELECT * FROM project_group_link_requests ORDER BY request_id').all()).toEqual(receipts);
      expect(runProjectGroupLinksTransaction(db,{context,newRelationId:'ignored',intent:{...intent,requestId:'restore',expectedRevision:2}})).toMatchObject({
        replayed:false,current:{relationId:'stable-row',revision:3,status:'active'},
      });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();const relative=path.relative(tmpdir(),root);
      if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Unsafe temporary cleanup');
      rmSync(root,{recursive:true,force:true});
    }
  });
});

// Migration tier: real 0150 -> generated 0151 rollback and file-backed restart.
// Lost outcome writes must leave the original attempt for reconciliation, never resend.
describeMigrationReplay('material dispatch upgrade and durable recovery', () => {
  it('rolls back partial DDL and recovers pending/unknown evidence after reopen without another consumer call', () => {
    const root=mkdtempSync(path.join(tmpdir(),'cindy-material-dispatch-upgrade-'));
    const staged=path.join(root,'before');mkdirSync(staged);
    const filename=path.join(root,'fixture.db');let db=createBetterSqliteDatabase(filename);
    const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
    const actor={kind:'account' as const,id:'owner'},host={actor,now:1000},key={sessionId:'task',clientId:'input'};
    const selector={projectId:'p',workItemId:'task',bindingRevision:1,contextId:'context',purpose:'reference'};
    const call=(args:Record<string,unknown>)=>runMaterialDispatchTransaction(db,{key,host,...args});
    const cleanup=()=>{
      db.close();const relative=path.relative(tmpdir(),root);
      if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Unsafe temporary cleanup');
      rmSync(root,{recursive:true,force:true});
    };
    try {
      loadSqliteVec(db);
      for(const m of listMigrations(drizzleDir()).filter(m=>m.seq<=150)) {
        copyFileSync(m.sqlPath,path.join(staged,m.fileName));
        if(m.tsScriptPath){mkdirSync(path.join(staged,'scripts'),{recursive:true});copyFileSync(m.tsScriptPath,path.join(staged,'scripts',path.basename(m.tsScriptPath)));}
      }
      runMigrationReplay(db,{drizzleDir:staged});
      db.exec('CREATE TABLE material_dispatch_messages(collision TEXT)');
      expect(()=>runMigrationReplay(db,{drizzleDir:drizzleDir()})).toThrow(/already exists/);
      expect(tableExists(db,'material_dispatch_attempts')).toBe(false);
      expect(db.prepare('SELECT seq FROM migration_history WHERE seq=151').get()).toBeUndefined();
      expect(db.prepare("SELECT value FROM migration_meta WHERE key='schema_version'").pluck().get()).toBe('150');
      db.exec('DROP TABLE material_dispatch_messages');
      expect(runMigrationReplay(db,{drizzleDir:drizzleDir()}).applied.map(m=>m.seq)).toEqual([151,152,153,154]);
      db.prepare("INSERT INTO sessions(id,title,created_at,updated_at) VALUES ('task','private title',1,1)").run();
      runProjectsTransaction(db,{action:'create',actor,newId:'p',now:1,input:{name:'private project',owner:actor}});
      runProjectsTransaction(db,{action:'bindSession',actor,sessionId:'task',projectId:'p'});
      runMaterialsTransaction(db,{action:'add',...selector,actor,now:1,files:[{referenceId:'ref',materialId:'m',versionId:'v',name:'private.txt',
        sha256:hash('bytes'),sizeBytes:5,mime:'text/plain',storageKind:'file',storageRef:'/not-read',sourceMtime:1}]});
      runMaterialsTransaction(db,{action:'createContext',...selector,actor,now:2,newId:'context',refs:[{referenceId:'ref',materialId:'m',version:1}]});
      const content=JSON.stringify({text:'private input'});
      call({action:'queue',expectedRevision:0,selector,contentSha256:hash(content)});
      call({action:'prepare',revision:1,preparation:{preparationKey:hash('prepared'),items:[{referenceId:'ref',materialId:'m',version:1,versionId:'v',expectedSha256:hash('bytes'),verifiedSha256:hash('bytes'),
        readiness:'ready',failureCode:null,representation:'text',textSha256:hash('text'),coverage:null}]}});
      db.prepare("INSERT INTO messages(id,session_id,client_id,role,content,created_at,agent_meta) VALUES ('message','task','input','user',?,1,'{\"sdk\":true}')").run(content);
      call({action:'attachMessage',revision:1,messageId:'message'});
      const begin={action:'begin',revision:1,attemptId:'actual-attempt',turnGeneration:7,consumer:'provider',preparationKey:hash('prepared'),referenceIds:['ref'],payloadSha256:hash('wire')};
      let consumerCalls=0;
      if('started' in call(begin)&& (db.prepare("SELECT outcome FROM material_dispatch_attempts").pluck().get()==='pending'))consumerCalls++;
      // Consumer accepted, but no receipt write occurred before process loss.
      const immutableIntent=db.prepare('SELECT * FROM material_dispatch_revisions').all();
      db.close();db=createBetterSqliteDatabase(filename);loadSqliteVec(db);
      expect(runMigrationReplay(db,{drizzleDir:drizzleDir()}).applied).toEqual([]);
      expect(call(begin)).toMatchObject({started:false,attempt:{outcome:'pending'}});
      expect(()=>call({...begin,attemptId:'blind-new'})).toThrow('[OUTCOME_UNRESOLVED]');
      call({action:'recordOutcome',revision:1,attemptId:'actual-attempt',turnGeneration:7,consumer:'provider',evidence:{source:'session-send-result',outcome:'unknown',receiptSha256:hash('unknown')}});
      db.close();db=createBetterSqliteDatabase(filename);loadSqliteVec(db);
      expect(runMigrationReplay(db,{drizzleDir:drizzleDir()}).applied).toEqual([]);
      expect(call(begin)).toMatchObject({started:false,attempt:{outcome:'unknown'}});
      call({action:'recordOutcome',revision:1,attemptId:'actual-attempt',turnGeneration:7,consumer:'provider',evidence:{source:'reconciliation',outcome:'confirmed',receiptSha256:hash('accepted receipt')}});
      expect(consumerCalls).toBe(1);
      expect(db.prepare('SELECT outcome FROM material_dispatch_attempts').pluck().get()).toBe('confirmed');
      expect(db.prepare('SELECT evidence_json FROM material_dispatch_observations ORDER BY rowid').all()).toHaveLength(2);
      expect(db.prepare('SELECT * FROM material_dispatch_revisions').all()).toEqual(immutableIntent);
      expect(db.prepare('SELECT content,agent_meta FROM messages').get()).toEqual({content,agent_meta:'{"sdk":true}'});
      expect(JSON.stringify(db.prepare('SELECT * FROM material_dispatch_attempts').all())).not.toMatch(/private input|private title|private.txt|not-read/);
      const another=createBetterSqliteDatabase(':memory:');
      try {loadSqliteVec(another);runMigrationReplay(another,{drizzleDir:drizzleDir()});
        expect(()=>runMaterialDispatchTransaction(another,{action:'read',key,host})).toThrow('[NOT_FOUND]');
      } finally {another.close();}
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { cleanup(); }
  });
});

// Migration tier / frozen 5a data contract: real generated 0152 schema vs exact SQL
// target fixture. Existing replay lacks follow-up PK/check/cascade and durable phase
// evidence. Minimal failures: duplicate input admitted or dispatching lost on restart.
// Raw SQL below validates storage only, not service admission/reopen/dispatch behavior.
describeMigrationReplay('frozen follow-up ledger schema and persistence', () => {
  const table='bot_task_followup_requests';
  const seed=(db:Database.Database)=>{
    db.prepare("INSERT INTO bot_profiles(id,display_name,created_at,updated_at) VALUES ('followup-bot','fixture',1,1)").run();
    db.prepare("INSERT INTO sessions(id,title,created_at,updated_at) VALUES ('followup-parent','fixture parent',1,1),('followup-child','fixture child',1,1),('followup-next','fixture next',1,1)").run();
    db.prepare("INSERT INTO bot_delegations(id,requesting_bot_id,parent_session_id,child_session_id,objective,status,run_sequence,permission_snapshot_json,created_at,updated_at) VALUES ('followup-task','followup-bot','followup-parent','followup-child','fixture objective','completed',3,'{\"original\":true}',1,1)").run();
    db.prepare("INSERT INTO bot_delegations(id,requesting_bot_id,objective,created_at,updated_at) VALUES ('other-task','followup-bot','fixture second task',1,1)").run();
  };
  const insert=(db:Database.Database,patch:Record<string,unknown>={})=>{
    const row={task_id:'followup-task',requester_bot_id:'followup-bot',key_digest:'a'.repeat(64),body_digest:'b'.repeat(64),
      input_id:'fixed-input',admitted_run_sequence:3,child_session_id:'followup-child',phase:'admitted',native_accepted_at:null,result_json:null,created_at:1000,updated_at:1000,...patch};
    db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
  };
  const rows=(db:Database.Database)=>db.prepare(`SELECT * FROM ${table} ORDER BY task_id,requester_bot_id,key_digest`).all();

  it('new generated schema matches the frozen fixture columns/keys/FK and observable constraint matrix',()=>{
    const {db,cleanup}=createTempDb(),fixture=createBetterSqliteDatabase(':memory:');
    try {
      runMigrationReplay(db,{drizzleDir:drizzleDir()});seed(db);
      fixture.pragma('foreign_keys=ON');fixture.exec('CREATE TABLE bot_delegations(id TEXT PRIMARY KEY)');
      fixture.prepare("INSERT INTO bot_delegations VALUES ('followup-task'),('other-task')").run();
      fixture.exec(readFileSync(path.join(__dirname,'fixtures','botTaskFollowupRequests.sql'),'utf8'));
      const columns=(database:Database.Database)=>database.prepare(`PRAGMA table_info(${table})`).all();
      expect(columns(db)).toEqual(columns(fixture));expect(columns(db)).toHaveLength(12);
      const foreignKeys=(database:Database.Database)=>database.prepare(`PRAGMA foreign_key_list(${table})`).all();
      expect(foreignKeys(db)).toEqual(foreignKeys(fixture));
      // Drizzle names a UNIQUE index; the fixture uses an SQLite autoindex. Column
      // identities and uniqueness are the same, physical index names are not API.
      const uniqueColumns=(database:Database.Database)=>(database.prepare(`PRAGMA index_list(${table})`).all() as {name:string;unique:number}[])
        .filter(i=>i.unique===1).map(i=>(database.prepare(`PRAGMA index_info('${i.name}')`).all() as {name:string}[]).map(c=>c.name).join(',')).sort();
      expect(uniqueColumns(db)).toEqual(uniqueColumns(fixture));
      for(const database of [db,fixture]) {
        const rejects=(patch:Record<string,unknown>,error:RegExp)=>{const before=rows(database);expect(()=>insert(database,patch)).toThrow(error);expect(rows(database)).toEqual(before);};
        for(const col of ['task_id','requester_bot_id','key_digest','body_digest','input_id','admitted_run_sequence','child_session_id','phase','created_at','updated_at'])
          rejects({[col]:null},/NOT NULL/);
        rejects({admitted_run_sequence:0},/CHECK/);rejects({admitted_run_sequence:-1},/CHECK/);rejects({phase:'running'},/CHECK/);
        rejects({task_id:'missing-task'},/FOREIGN KEY/);
        insert(database); // native_accepted_at/result_json intentionally nullable.
        rejects({input_id:'different-input',body_digest:'c'.repeat(64),admitted_run_sequence:4},/UNIQUE/);
        rejects({task_id:'other-task',requester_bot_id:'other-bot',key_digest:'different'},/UNIQUE/);
        insert(database,{task_id:'other-task',input_id:'other-task-input'});
        insert(database,{requester_bot_id:'other-bot',input_id:'other-bot-input'});
        for(const phase of ['dispatching','unknown','settled'])insert(database,{key_digest:phase,input_id:phase+'-input',phase,
          result_json:phase==='settled'?'{"status":"queued","inputId":"settled-input"}':null});
        database.prepare('DELETE FROM bot_delegations WHERE id=?').run('followup-task');
        expect(rows(database)).toMatchObject([{task_id:'other-task',input_id:'other-task-input'}]);
      }
      expect(rows(db)).toEqual(rows(fixture));expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {fixture.close();cleanup();}
  });

  it('upgrades real 0151 atomically, preserves old records, and reopens original phase/result/input across snapshot and run changes',()=>{
    const root=mkdtempSync(path.join(tmpdir(),'cindy-followup-data-upgrade-'));
    const staged=path.join(root,'before');mkdirSync(staged);
    const filename=path.join(root,'fixture.db');let db=createBetterSqliteDatabase(filename);
    const cleanup=()=>{
      db.close();const relative=path.relative(tmpdir(),root);
      if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Unsafe temporary cleanup');
      rmSync(root,{recursive:true,force:true});
    };
    try {
      loadSqliteVec(db);
      for(const m of listMigrations(drizzleDir()).filter(m=>m.seq<=151)) {
        copyFileSync(m.sqlPath,path.join(staged,m.fileName));
        if(m.tsScriptPath){mkdirSync(path.join(staged,'scripts'),{recursive:true});copyFileSync(m.tsScriptPath,path.join(staged,'scripts',path.basename(m.tsScriptPath)));}
      }
      runMigrationReplay(db,{drizzleDir:staged});seed(db);
      db.prepare("INSERT INTO messages(id,session_id,client_id,role,content,agent_meta,created_at) VALUES ('old-message','followup-child','old-client','user','{\"text\":\"fixture old message\"}','{\"sdk\":true}',1)").run();
      const snapshot=()=>['bot_profiles','sessions','bot_delegations','messages'].map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY id`).all());
      const old=snapshot();
      // Fail AFTER table creation, at the generated unique-index statement.
      db.exec('CREATE TABLE followup_index_collision(id TEXT); CREATE INDEX bot_task_followup_requests_input_id_unique ON followup_index_collision(id)');
      expect(()=>runMigrationReplay(db,{drizzleDir:drizzleDir()})).toThrow(/already exists/);
      expect(tableExists(db,table)).toBe(false);
      expect(db.prepare('SELECT seq FROM migration_history WHERE seq=152').get()).toBeUndefined();
      expect(db.prepare("SELECT value FROM migration_meta WHERE key='schema_version'").pluck().get()).toBe('151');
      expect(snapshot()).toEqual(old);
      db.exec('DROP INDEX bot_task_followup_requests_input_id_unique; DROP TABLE followup_index_collision');
      expect(runMigrationReplay(db,{drizzleDir:drizzleDir()}).applied.map(m=>m.seq)).toEqual([152,153,154]);
      expect(snapshot()).toEqual(old);expect(rows(db)).toEqual([]);
      for(const phase of ['admitted','dispatching','unknown','settled'])insert(db,{key_digest:phase,input_id:phase+'-original-input',phase,
        native_accepted_at:phase==='dispatching'?1100:null,result_json:phase==='settled'?'{"status":"queued","inputId":"settled-original-input","run":3}':null});
      const original=rows(db);
      db.prepare("UPDATE bot_delegations SET permission_snapshot_json='{}',parent_session_id='followup-next',child_session_id=NULL,status='running',run_sequence=4 WHERE id='followup-task'").run();
      db.prepare("UPDATE bot_profiles SET canonical_session_id='followup-next' WHERE id='followup-bot'").run();
      expect(rows(db)).toEqual(original);
      db.close();db=createBetterSqliteDatabase(filename);loadSqliteVec(db);
      expect(runMigrationReplay(db,{drizzleDir:drizzleDir()}).applied).toEqual([]);expect(rows(db)).toEqual(original);
      db.prepare("UPDATE bot_task_followup_requests SET native_accepted_at=1200 WHERE phase='settled'").run();
      expect(db.prepare("SELECT input_id,result_json FROM bot_task_followup_requests WHERE phase='settled'").get()).toEqual({
        input_id:'settled-original-input',result_json:'{"status":"queued","inputId":"settled-original-input","run":3}',
      });
      db.prepare("DELETE FROM sessions WHERE id='followup-child'").run();
      expect(db.prepare('SELECT DISTINCT child_session_id FROM bot_task_followup_requests').all()).toEqual([{child_session_id:'followup-child'}]);
      const retained=rows(db);db.close();db=createBetterSqliteDatabase(filename);loadSqliteVec(db);
      expect(runMigrationReplay(db,{drizzleDir:drizzleDir()}).applied).toEqual([]);expect(rows(db)).toEqual(retained);
      db.prepare("DELETE FROM bot_delegations WHERE id='followup-task'").run();expect(rows(db)).toEqual([]);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {cleanup();}
  });
});
