import type Database from 'better-sqlite3';
import type { MigrationCatalog } from './migrationCatalog';

/** Self-contained so the emergency inline worker executes exactly the same admission.
 * Only same-package catalog identities cross workerData; no caller-supplied applied claims.
 */
export function assertDualMigrationSnapshot(db: Database.Database, dbPath: string, catalog: MigrationCatalog): void {
  const crypto = process.getBuiltinModule('crypto');
  const fs = process.getBuiltinModule('fs');
  const fail = (): never => { throw Object.assign(new Error('Dual migration runtime/ledger mismatch; schema startup required'), {code:'MIGRATION_REQUIRED'}); };
  const digest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const scalar = db.prepare("SELECT value FROM migration_meta WHERE key='schema_version'").get() as {value: string} | undefined;
  if (scalar?.value !== 'cindy:dual-chain:2' || catalog.format !== 2) fail();
  const records = db.prepare('SELECT key,value FROM migration_state_v2').all() as {key:string;value:string}[];
  if (records.length !== 1 || records[0].key !== 'state') fail();
  const state = JSON.parse(records[0].value);
  const manifest = JSON.parse(fs.readFileSync(`${dbPath}.migration-runtime.json`,'utf8'));
  if (state.format !== 2 || manifest.version !== 2 || manifest.phase !== 'committed' ||
      JSON.stringify(manifest.state) !== JSON.stringify(state) || state.bootstrapHash !== catalog.bootstrapHash) fail();
  const expected = catalog.entries.map(e => ({namespace:e.namespace,id:e.id,fileName:e.fileName,
    sqlHash:e.sqlHash,scriptHash:e.scriptHash,dependsOn:e.dependsOn,legacySeq:e.legacySeq??null}));
  if (JSON.stringify(state.entries) !== JSON.stringify(expected) || state.appliedDigest !== digest(expected)) fail();
  const history = db.prepare('SELECT seq,file_name,content_hash,applied_at FROM migration_history ORDER BY seq').all();
  if (state.historyDigest !== digest(history)) fail();
  const rows = db.prepare('SELECT namespace,id,identity,applied_at,provenance FROM migration_history_v2').all() as {
    namespace:string;id:number;identity:string;applied_at:number;provenance:string;
  }[];
  if (rows.length !== expected.length) fail();
  if (crypto.createHash('sha256').update(fs.readFileSync(catalog.bootstrapPath,'utf8').replace(/\r\n/g,'\n')).digest('hex') !== catalog.bootstrapHash) fail();
  for (let i=0;i<expected.length;i++) {
    const entry = catalog.entries[i], identity = expected[i];
    const row = rows.find(r => r.namespace === entry.namespace && r.id === entry.id);
    if (!row || row.identity !== JSON.stringify(identity) || !['legacy','executed'].includes(row.provenance) || !Number.isSafeInteger(row.applied_at)) fail();
    for (const [file, hash] of [[entry.sqlPath,entry.sqlHash],[entry.scriptPath,entry.scriptHash]]) {
      if (file && crypto.createHash('sha256').update(fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n')).digest('hex') !== hash) fail();
    }
  }
}
