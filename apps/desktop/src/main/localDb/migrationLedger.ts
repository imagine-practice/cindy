import crypto from 'node:crypto';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { catalogIdentity, loadMigrationCatalog, migrationDigest, migrationKey,
  type CatalogEntry, type MigrationCatalog } from './migrationCatalog';
import { executeMigration, runMigrationReplay } from './migrationRunner';
import { isKnownEquivalentMigrationHash } from './schemaDriftCompatibility';

export const DUAL_SCHEMA_VERSION = 'cindy:dual-chain:2';
interface LegacyRow { seq: number; file_name: string; content_hash: string; applied_at: number }
interface LegacyAnchor {
  value: string | null;
  lineage: 'empty' | 'upstream' | 'custom';
  rows: LegacyRow[];
  runtimeManifest: unknown;
}
interface LedgerRow { namespace: string; id: number; identity: string; applied_at: number; provenance: string }
interface State {
  format: 2;
  generation: string;
  anchor: LegacyAnchor;
  historyDigest: string;
  entries: object[];
  appliedDigest: string;
  bootstrapHash: string;
}
interface Manifest {
  version: 2;
  phase: 'intent' | 'committed';
  before: string;
  state: State;
}
export interface DualMigrationPlan {
  catalog: MigrationCatalog;
  anchor: LegacyAnchor;
  state: State | null;
  imported: CatalogEntry[];
  pending: CatalogEntry[];
  manifest: Manifest | null;
}

function scalar(db: Database.Database): string | null {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration_meta'").get();
  if (!exists) return null;
  const row = db.prepare("SELECT value FROM migration_meta WHERE key='schema_version'").get() as {value: string} | undefined;
  if (!row || typeof row.value !== 'string') throw new Error('Invalid migration schema control');
  return row.value;
}
function history(db: Database.Database): LegacyRow[] {
  return db.prepare('SELECT seq,file_name,content_hash,applied_at FROM migration_history ORDER BY seq').all() as LegacyRow[];
}
function readManifest(dbPath: string): unknown {
  try { return JSON.parse(fs.readFileSync(`${dbPath}.migration-runtime.json`, 'utf8')); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
}
function identities(entries: CatalogEntry[]): object[] { return entries.map(catalogIdentity); }
function validStateHeader(state: State): boolean {
  return state?.format === 2 && typeof state.generation === 'string' &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(state.generation) &&
    Boolean(state.anchor) && Array.isArray(state.anchor.rows) && Array.isArray(state.entries) &&
    /^[0-9a-f]{64}$/.test(state.historyDigest) && state.appliedDigest === migrationDigest(state.entries);
}
function validTarget(state: State, catalog: MigrationCatalog, anchor: LegacyAnchor): boolean {
  return validStateHeader(state) && state.bootstrapHash === catalog.bootstrapHash &&
    JSON.stringify(state.entries) === JSON.stringify(identities(catalog.entries)) &&
    JSON.stringify(state.anchor) === JSON.stringify(anchor) &&
    (anchor.value === null || state.historyDigest === migrationDigest(anchor.rows));
}
function stateOf(db: Database.Database): State | null {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration_state_v2'").get();
  const hasHistory = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration_history_v2'").get();
  if (!has && !hasHistory) return null;
  if (!has || !hasHistory) throw new Error('Incomplete dual migration metadata');
  const rows = db.prepare('SELECT key,value FROM migration_state_v2').all() as {key: string; value: string}[];
  if (rows.length !== 1 || rows[0].key !== 'state') throw new Error('Invalid dual migration state');
  const state = JSON.parse(rows[0].value) as State;
  if (!validStateHeader(state)) {
    throw new Error('Unsupported dual migration state');
  }
  return state;
}

function verifyLegacy(db: Database.Database, catalog: MigrationCatalog, rawManifest: unknown): {
  anchor: LegacyAnchor; imported: CatalogEntry[];
} {
  const value = scalar(db);
  if (value === null) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) {
      throw new Error('MIGRATION_LINEAGE_UNPROVEN: nonempty database without schema version');
    }
    if (rawManifest !== null) {
      const witness=rawManifest as {version?:number;legacyBaselineVersion?:number;migrations?:{seq:number;fileName:string;sqlHash:string;scriptHash:string|null}[]};
      if (witness.version !== 1 || witness.legacyBaselineVersion !== -1 || !Array.isArray(witness.migrations) ||
          !witness.migrations.length || new Set(witness.migrations.map(m=>m.seq)).size !== witness.migrations.length ||
          witness.migrations.some(m=>!catalog.entries.some(e=>e.legacySeq===m.seq&&e.fileName===m.fileName&&e.sqlHash===m.sqlHash&&e.scriptHash===m.scriptHash))) {
        throw new Error('Unknown migration intent on empty database');
      }
    }
    return { anchor: {value: null, lineage: 'empty', rows: [], runtimeManifest: rawManifest}, imported: [] };
  }
  if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('Unsupported migration database format');
  }
  const version = Number(value), rows = history(db);
  const fork149 = rows.find(r => r.seq === 149);
  const lineage = fork149 && catalog.entries.some(e => e.namespace === 'custom' && e.legacySeq === 149 && e.fileName === fork149.file_name)
    ? 'custom' : 'upstream';
  const imported = catalog.entries.filter(e => e.namespace === 'upstream'
    ? e.id <= Math.min(version, lineage === 'custom' ? 148 : version)
    : lineage === 'custom' && e.legacySeq !== undefined && e.legacySeq <= version);
  const legacyHead=Math.max(...catalog.entries.filter(e=>e.namespace===lineage&&e.legacySeq!==undefined).map(e=>e.legacySeq!));
  if (version > legacyHead || imported.length !== version + 1 || rows.length !== version + 1) {
    throw new Error('MIGRATION_LINEAGE_UNPROVEN: incomplete or unknown legacy history');
  }
  for (const row of rows) {
    const entry = imported.find(e => e.legacySeq === row.seq);
    if (!entry || row.file_name !== entry.fileName || (row.content_hash !== entry.sqlHash &&
        !isKnownEquivalentMigrationHash(row.seq,row.file_name,row.content_hash,entry.sqlHash))) {
      throw new Error(`MIGRATION_LINEAGE_UNPROVEN: legacy identity ${row.seq}`);
    }
  }
  if (rawManifest !== null) {
    const manifest = rawManifest as {version?: number; legacyBaselineVersion?: number; migrations?: Array<{seq: number; fileName: string; sqlHash: string; scriptHash: string | null}>};
    if (manifest.version !== 1 || !Number.isSafeInteger(manifest.legacyBaselineVersion) || !Array.isArray(manifest.migrations)) {
      throw new Error('Invalid legacy migration witness');
    }
    for (const e of imported) {
      const witness = manifest.migrations.find(m => m.seq === e.legacySeq);
      const knownCommentOnly62 = e.namespace === 'upstream' && e.id === 62 && e.fileName === '0062_flaky_mimic.sql' &&
        e.sqlHash === '77b8741ac31c159eb422746c0165d102ad65693236c80d0ff055fd70cd43fe68' &&
        e.scriptHash === '0a72ba2d89237b4b7322ffbbeb644c94e01be7d159851e220f51c03edfa80b78' &&
        witness?.scriptHash === '0ea82003cac0419a4a483b0afc1743d6fdba0b50085104720d5b2561e721072d';
      if (!witness || witness.fileName !== e.fileName || (witness.sqlHash !== e.sqlHash &&
          !isKnownEquivalentMigrationHash(e.legacySeq!,e.fileName,witness.sqlHash,e.sqlHash)) || (witness.scriptHash !== e.scriptHash && !knownCommentOnly62)) {
        throw new Error(`Legacy migration runtime identity changed: ${migrationKey(e)}`);
      }
    }
  } else {
    // A missing legacy witness cannot prove which companion code ran. Numeric SQL-only recognition
    // is insufficient; primary must not silently bless arbitrary pre-existing data.
    throw new Error('MIGRATION_LINEAGE_UNPROVEN: legacy runtime manifest unavailable');
  }
  return { anchor: {value, lineage, rows, runtimeManifest: rawManifest}, imported };
}

function validateState(db: Database.Database, catalog: MigrationCatalog, state: State): CatalogEntry[] {
  if (scalar(db) !== DUAL_SCHEMA_VERSION || state.bootstrapHash !== catalog.bootstrapHash ||
      migrationDigest(history(db)) !== state.historyDigest ||
      migrationDigest(state.entries) !== state.appliedDigest) throw new Error('Dual migration state/witness mismatch');
  const rowsBefore = state.anchor.rows;
  if (state.anchor.value !== null && migrationDigest(rowsBefore) !== state.historyDigest) throw new Error('Legacy anchor changed');
  if (state.anchor.value === null) {
    const common = catalog.entries.filter(e => e.namespace === 'upstream' && e.id <= 148);
    const actual = history(db);
    if (actual.length !== common.length || actual.some(row => {
      const expected = common.find(e => e.id === row.seq);
      return !expected || row.file_name !== expected.fileName || row.content_hash !== expected.sqlHash;
    })) throw new Error('Initial legacy bootstrap history mismatch');
  }
  const rows = db.prepare('SELECT namespace,id,identity,applied_at,provenance FROM migration_history_v2 ORDER BY namespace,id').all() as LedgerRow[];
  const byKey = new Map(catalog.entries.map(e => [migrationKey(e), e]));
  const imported: CatalogEntry[] = [];
  for (const row of rows) {
    const entry = byKey.get(`${row.namespace}:${row.id}`);
    if (!entry || row.identity !== JSON.stringify(catalogIdentity(entry)) ||
        !['legacy', 'executed'].includes(row.provenance) || !Number.isSafeInteger(row.applied_at)) {
      throw new Error(`Applied migration identity unavailable/changed: ${row.namespace}:${row.id}`);
    }
    imported.push(entry);
  }
  const applied = new Set(imported.map(migrationKey));
  for (const entry of imported) for (const dependency of entry.dependsOn) {
    if (!applied.has(migrationKey(dependency))) throw new Error('Applied migration dependency missing');
  }
  const sorted = catalog.entries.filter(e => applied.has(migrationKey(e)));
  if (JSON.stringify(identities(sorted)) !== JSON.stringify(state.entries)) throw new Error('Dual ledger applied set mismatch');
  return sorted;
}

/** Read-only preflight. Never repairs, claims, or rewrites a witness. */
export function planDualMigrations(db: Database.Database, dbPath: string, drizzleDir: string): DualMigrationPlan {
  const catalog = loadMigrationCatalog(drizzleDir), raw = readManifest(dbPath), state = stateOf(db);
  let anchor: LegacyAnchor, imported: CatalogEntry[], manifest: Manifest | null = null;
  if (state) {
    imported = validateState(db, catalog, state); anchor = state.anchor;
    manifest = raw as Manifest | null;
    const committedMatches = manifest && JSON.stringify(manifest.state) === JSON.stringify(state);
    const initialCommitMatches = manifest?.phase === 'intent' && state.anchor.value === null &&
      JSON.stringify({...manifest.state, historyDigest:state.historyDigest}) === JSON.stringify(state);
    const pendingMatches = manifest?.phase === 'intent' && manifest.before === migrationDigest(state) &&
      catalog.entries.length > state.entries.length && validTarget(manifest.state,catalog,anchor);
    if (!manifest || manifest.version !== 2 || !['intent', 'committed'].includes(manifest.phase) ||
        !(committedMatches || initialCommitMatches || pendingMatches)) {
      throw new Error('Dual migration manifest unavailable/mismatched; refusing legacy bootstrap');
    }
  } else if (raw && (raw as {version?: number}).version === 2) {
    manifest = raw as Manifest;
    if (manifest.phase !== 'intent' || manifest.state?.format !== 2) throw new Error('Invalid uncommitted dual migration intent');
    const legacy = verifyLegacy(db, catalog, manifest.state.anchor.runtimeManifest);
    anchor = legacy.anchor; imported = legacy.imported;
    if (manifest.before !== migrationDigest(anchor) || !validTarget(manifest.state,catalog,anchor)) throw new Error('Interrupted migration plan changed');
  } else {
    const legacy = verifyLegacy(db, catalog, raw); anchor = legacy.anchor; imported = legacy.imported;
  }
  const applied = new Set(imported.map(migrationKey));
  return {catalog, anchor, imported, state, manifest, pending: catalog.entries.filter(e => !applied.has(migrationKey(e)))};
}

function publish(dbPath: string, manifest: Manifest): void {
  const target = `${dbPath}.migration-runtime.json`, temp = `${target}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(manifest)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, target); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  // SQLite FULL + flushed intent protect process-crash recovery. Directory fsync is not
  // portable on Windows; this is not a claim of durability through physical power loss.
}

export interface DualReplayOptions {
  drizzleDir: string;
  dbPath: string;
  initialize?: () => void;
  onPhase?: (phase: 'intent' | 'executing' | 'committed' | 'published', entry?: CatalogEntry) => void;
}

/** Caller must own the existing schema writer lease and complete its backup first. */
export function runDualMigrationReplay(db: Database.Database, options: DualReplayOptions): {applied: CatalogEntry[]; digest: string} {
  let plan = planDualMigrations(db, options.dbPath, options.drizzleDir);
  if (plan.state && plan.manifest?.phase === 'intent' && plan.manifest.state.generation === plan.state.generation &&
      JSON.stringify(plan.manifest.state.entries) === JSON.stringify(plan.state.entries)) {
    // Finish a proven earlier commit before extending its catalog. Reusing that
    // commit's target state for a later plan would lose the newly applied keys.
    publish(options.dbPath,{...plan.manifest,phase:'committed',state:plan.state});
    plan=planDualMigrations(db,options.dbPath,options.drizzleDir);
  }
  if (plan.state && !plan.pending.length) {
    if (plan.manifest!.phase === 'intent') publish(options.dbPath, {...plan.manifest!, phase: 'committed', state:plan.state});
    return {applied: [], digest: plan.catalog.digest};
  }
  const entries = identities(plan.catalog.entries);
  const next: State = plan.manifest?.phase === 'intent' ? plan.manifest.state : {
    format: 2, generation: crypto.randomUUID(), anchor: plan.anchor,
    historyDigest: plan.state?.historyDigest ?? migrationDigest(plan.anchor.rows),
    entries, appliedDigest: migrationDigest(entries), bootstrapHash: plan.catalog.bootstrapHash,
  };
  const intent: Manifest = {version: 2, phase: 'intent', before: migrationDigest(plan.state ?? plan.anchor), state: next};
  publish(options.dbPath, intent); options.onPhase?.('intent');
  const oldSynchronous = db.pragma('synchronous', {simple: true});
  db.pragma('synchronous = FULL');
  try {
    db.transaction(() => {
      let imported = plan.imported;
      if (!plan.state) {
        if (plan.anchor.value === null) {
          const common = plan.catalog.entries.filter(e => e.namespace === 'upstream' && e.id <= 148);
          runMigrationReplay(db, {drizzleDir: options.drizzleDir, currentVersion: -1,
            migrations: common.map(e => ({seq:e.id, fileName:e.fileName,sqlPath:e.sqlPath,tsScriptPath:e.scriptPath ?? undefined}))});
          next.historyDigest = migrationDigest(history(db));
          imported = common;
        }
        db.exec(fs.readFileSync(plan.catalog.bootstrapPath, 'utf8'));
        const insert = db.prepare('INSERT INTO migration_history_v2(namespace,id,identity,applied_at,provenance) VALUES (?,?,?,?,?)');
        for (const entry of imported) {
          const legacyRow = history(db).find(r => r.seq === entry.legacySeq);
          if (!legacyRow) throw new Error('Legacy history write failed during bootstrap');
          insert.run(entry.namespace, entry.id, JSON.stringify(catalogIdentity(entry)), legacyRow.applied_at, 'legacy');
        }
      }
      const importedKeys = new Set(imported.map(migrationKey));
      const insert = db.prepare('INSERT INTO migration_history_v2(namespace,id,identity,applied_at,provenance) VALUES (?,?,?,?,?)');
      for (const entry of plan.catalog.entries.filter(e => !importedKeys.has(migrationKey(e)))) {
        options.onPhase?.('executing', entry);
        executeMigration(db, {namespace:entry.namespace,seq:entry.id,fileName:entry.fileName,sqlPath:entry.sqlPath,tsScriptPath:entry.scriptPath ?? undefined});
        insert.run(entry.namespace, entry.id, JSON.stringify(catalogIdentity(entry)), Date.now(), 'executed');
      }
      options.initialize?.();
      db.prepare("INSERT INTO migration_meta(key,value) VALUES ('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(DUAL_SCHEMA_VERSION);
      db.prepare("INSERT INTO migration_state_v2(key,value) VALUES ('state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));
    }).immediate();
  } finally { db.pragma(`synchronous = ${oldSynchronous}`); }
  options.onPhase?.('committed');
  publish(options.dbPath, {...intent, phase:'committed'});
  options.onPhase?.('published');
  return {applied: plan.pending, digest: plan.catalog.digest};
}

export function assertDualMigrationReady(db: Database.Database, dbPath: string, drizzleDir: string): void {
  const plan = planDualMigrations(db, dbPath, drizzleDir);
  if (!plan.state || plan.pending.length || plan.manifest?.phase !== 'committed') {
    throw new Error('Dual schema migration required before opening a business connection');
  }
}
