/**
 * Open the existing per-owner Desktop database from a plain Node process.
 *
 * This is deliberately not a second storage model: it targets the same
 * `<userData>/<dbFilePrefix>-<ownerId>.db`, runs the same schema-migration
 * runner and takes the same cross-process schema lease as the Electron entry.
 * What differs is only the presentation of failures (no OS dialogs) and the
 * maintenance steps that require a UI or the Electron utility-process host —
 * those stay with Desktop and are listed as TODOs in docs/host/.
 */

import fs from 'node:fs';

import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type Database from 'better-sqlite3';

import { createBetterSqliteDatabase } from './betterSqliteFactory';
import { runMigrations } from './migrate';
import { configureMigrationRuntime } from './migrationRuntime';
import {
  checkMigrationCompatibility,
  prepareMigrationRuntimeManifest,
  readSchemaVersion,
} from './migrationRunner';
import { ownerDatabasePath, prepareModelDefaultsProfile } from './modelDefaultsProfile';
import { ensureCjkFtsTempTriggersInstalled } from './registerCjkSeg';
import { acquireSchemaStartupLease, acquireSchemaMigrationReaderLease, type SchemaMigrationLease } from './schemaMigrationLease';
import { runSchemaStartupPolicy } from './schemaStartupPolicy';
import { configureSqliteVecExtPath, loadSqliteVec } from './sqliteVecLoader';
import * as schema from './schema';

export type OwnerDatabaseErrorCode = 'DB_SCHEMA_LOCKED' | 'MIGRATE_FAILED' | 'DB_INIT_FAILED';

export class OwnerDatabaseError extends Error {
  readonly code: OwnerDatabaseErrorCode;

  constructor(code: OwnerDatabaseErrorCode, message: string) {
    super(message);
    this.name = 'OwnerDatabaseError';
    this.code = code;
  }
}

export interface OpenOwnerDatabaseOptions {
  userDataDir: string;
  ownerId: string;
  isPackaged: boolean;
  /** Absolute directory holding `NNNN_*.sql` migrations. */
  drizzleDir: string;
  /** Absolute sqlite-vec extension path; omitted means vector search stays unavailable. */
  sqliteVecExtPath?: string;
}

export interface OpenedOwnerDatabase {
  db: Database.Database;
  drizzle: BetterSQLite3Database<typeof schema>;
  dbPath: string;
  close(): void;
}

/** Same PRAGMA order as the worker: PRAGMA first, then TEMP trigger installation. */
function applyPragmas(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456');
  db.pragma('cache_size = -65536');
  db.pragma('busy_timeout = 5000');
}

export async function openOwnerDatabase(
  options: OpenOwnerDatabaseOptions,
): Promise<OpenedOwnerDatabase> {
  const { userDataDir, ownerId, isPackaged, drizzleDir, sqliteVecExtPath } = options;
  if (!fs.existsSync(drizzleDir)) {
    throw new OwnerDatabaseError('MIGRATE_FAILED', `drizzle directory not found: ${drizzleDir}`);
  }
  configureMigrationRuntime({ drizzleDir, isPackaged });
  if (sqliteVecExtPath) configureSqliteVecExtPath(sqliteVecExtPath);

  const dbPath = ownerDatabasePath(userDataDir, ownerId);
  const lease = await acquireSchemaStartupLease({
    dbFilePath: dbPath,
    packaged: isPackaged,
    sharedPassive: false,
  });
  if (!lease.acquired) {
    throw new OwnerDatabaseError(
      'DB_SCHEMA_LOCKED',
      `database schema is locked (${lease.reason}); close the other Cindy process and retry`,
    );
  }

  let writerLease: SchemaMigrationLease | null = lease.kind === 'writer' ? lease.lease : null;
  let readerLease: SchemaMigrationLease | null = lease.kind === 'reader' ? lease.lease : null;
  let db: Database.Database | null = null;
  try {
    if (writerLease) prepareModelDefaultsProfile(dbPath);
    db = createBetterSqliteDatabase(dbPath);
    applyPragmas(db);
    ensureCjkFtsTempTriggersInstalled(db);
    loadSqliteVec(db);

    const startup = await runSchemaStartupPolicy({
      sharedPassive: lease.kind === 'reader',
      checkCompatibility: () => checkMigrationCompatibility(db!, drizzleDir, dbPath),
      prepareRuntimeManifest: () => {
        prepareMigrationRuntimeManifest(dbPath, drizzleDir, readSchemaVersion(db!), db!);
      },
      runMigrations: () => runMigrations(db!, dbPath),
      // Electron's dev-only reflective drift repair and nuke flow stays with the
      // Desktop host; a headless host fails closed on an incompatible schema.
      handleSchemaDrift: async () => undefined,
      cleanupSchemaDdl: () => undefined,
    });
    if (!startup.ready) throw new OwnerDatabaseError('MIGRATE_FAILED','Host reader schema is incompatible');

    ensureCjkFtsTempTriggersInstalled(db);
    writerLease?.release();
    writerLease = null;
    if (!readerLease) {
      const reader = await acquireSchemaMigrationReaderLease(dbPath);
      if (!reader.acquired) throw new OwnerDatabaseError('DB_SCHEMA_LOCKED',`Schema changed during Host startup (${reader.reason})`);
      readerLease = reader.lease;
      if (!checkMigrationCompatibility(db,drizzleDir,dbPath).compatible) throw new OwnerDatabaseError('MIGRATE_FAILED','Schema changed before Host reader admission');
    }

    return {
      db,
      drizzle: drizzle(db, { schema }),
      dbPath,
      close() { try { db?.close(); } finally {readerLease?.release(); readerLease=null;} },
    };
  } catch (error) {
    try {
      db?.close();
    } catch {
      /* best effort */
    }
    writerLease?.release();
    readerLease?.release();
    lease.lease.release();
    if (error instanceof OwnerDatabaseError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new OwnerDatabaseError('MIGRATE_FAILED', message);
  }
}
