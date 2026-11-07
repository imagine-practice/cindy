// Joint DB tier: real frozen 0000..0151 migration template, then real 0152 per
// isolated case. No hand-created ledger or fixture SQL is executed here.
import { copyFileSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { createBetterSqliteDatabase } from '../../betterSqliteFactory';
import { listMigrations, runMigrationReplay } from '../../migrationRunner';

const desktop = resolve(__dirname, '../../../../..');
const drizzleDir = join(desktop, 'drizzle');
let template: string | undefined;
let sequence = 0;

export function openJointFollowupDb(filename: string): Database.Database {
  const db = createBetterSqliteDatabase(filename);
  const extension = process.platform === 'win32' ? 'vec0.dll'
    : process.platform === 'darwin' ? 'vec0.dylib' : null;
  if (!extension) { db.close(); throw new Error('Joint migration requires bundled sqlite-vec on Windows/macOS'); }
  try {
    db.loadExtension(join(desktop, 'native/sqlite-vec', `${process.platform}-${process.arch}`, extension));
    db.pragma('foreign_keys = ON');
    return db;
  } catch (error) { db.close(); throw error; }
}

export function createJointFollowupDb(tempRoot: string, filename = ':memory:'): Database.Database {
  if (!template) {
    const before = join(tempRoot, 'joint-through-0151'); mkdirSync(before, { recursive: true });
    const migrations = listMigrations(drizzleDir);
    if (migrations.at(-1)?.seq !== 152) throw new Error('Frozen joint chain must end at 0152');
    for (const migration of migrations.filter(m => m.seq <= 151)) {
      copyFileSync(migration.sqlPath, join(before, migration.fileName));
      if (migration.tsScriptPath) {
        mkdirSync(join(before, 'scripts'), { recursive: true });
        copyFileSync(migration.tsScriptPath, join(before, 'scripts', migration.tsScriptPath.split(/[\\/]/).at(-1)!));
      }
    }
    const candidate = join(tempRoot, 'joint-0151-template.sqlite');
    const db = openJointFollowupDb(candidate);
    try {
      const result = runMigrationReplay(db, { drizzleDir: before });
      if (result.finalVersion !== 151 || db.prepare("SELECT name FROM sqlite_master WHERE name='bot_task_followup_requests'").get()) {
        throw new Error('0151 template must have no follow-up ledger');
      }
    } finally { db.close(); }
    template = candidate;
  }
  const file = filename === ':memory:' ? join(tempRoot, `joint-case-${++sequence}.sqlite`) : resolve(filename);
  const suffix = relative(resolve(tempRoot), file);
  if (!suffix || suffix.startsWith(`..${sep}`) || suffix === '..' || resolve(tempRoot, suffix) !== file) throw new Error('Joint fixture path outside owned temporary root');
  copyFileSync(template, file);
  const db = openJointFollowupDb(file);
  try {
    const result = runMigrationReplay(db, { drizzleDir });
    if (result.currentVersion !== 151 || result.applied.length !== 1 || result.applied[0].seq !== 152
      || result.finalVersion !== 152 || !db.prepare('SELECT seq FROM migration_history WHERE seq=152').get()) {
      throw new Error('Each joint fixture must upgrade through production 0152');
    }
    return db;
  } catch (error) { db.close(); throw error; }
}
