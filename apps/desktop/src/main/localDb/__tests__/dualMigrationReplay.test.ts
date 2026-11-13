import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import type Database from 'better-sqlite3';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { loadMigrationCatalog, migrationDigest, migrationFileHash } from '../migrationCatalog';
import { assertDualMigrationReady, DUAL_SCHEMA_VERSION, planDualMigrations, runDualMigrationReplay } from '../migrationLedger';
import { checkMigrationCompatibility, runMigrationReplay } from '../migrationRunner';
import { buildDbWorkerBundle } from './dbWorkerTestUtils';
import { WorkerThreadTransport } from '../client/WorkerThreadTransport';
import { openOwnerDatabase } from '../startupCore';
import { ownerDatabasePath } from '../modelDefaultsProfile';
import { acquireSchemaMigrationReaderLease, acquireSchemaMigrationWriterLease } from '../schemaMigrationLease';
import { tryRestoreWithFallback } from '../backup';
import { cleanupStaleOrcaLeadIndex, hasStaleOrcaLeadIndex } from '../orcaStaleIndexCleanup';
import { planSchemaDriftRepair } from '../schemaDriftRepair';

// Value: the real runner previously used one seq for two distinct 0149 migrations.
// Existing legacy replay cases cannot exercise namespace adoption, the DB format fence,
// or commit/sidecar recovery. Minimal inputs are four actual historical schemas plus
// interrupted intent/commit. Migration tier: native SQLite, generated SQL, bundled vec.
const desktop = path.resolve(__dirname, '../../../..');
const drizzleDir = path.join(desktop, 'drizzle');
const catalog = loadMigrationCatalog(drizzleDir);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dual-replay-'));
const fixtures = new Map<string, Buffer>();
let serial = 0;
let workerScriptPath: string;
let crashScriptPath: string;
function open(filename: string): Database.Database {
  const db = createBetterSqliteDatabase(filename);
  db.loadExtension(path.join(desktop, `native/sqlite-vec/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib'}`));
  return db;
}
const rows = (db: Database.Database) => db.prepare('SELECT * FROM migration_history ORDER BY seq').all();
function fixture(name: string): {db: Database.Database; filename: string} {
  const filename = path.join(root, `case-${serial++}.db`);
  if (name !== 'empty') fs.writeFileSync(filename, fixtures.get(name)!);
  const db = open(filename);
  if (name !== 'empty') {
    const entries = catalog.entries.filter(e => e.namespace === 'upstream'
      ? e.id <= (name === 'official' ? 149 : 148) : name === 'fork');
    fs.writeFileSync(`${filename}.migration-runtime.json`, JSON.stringify({version:1,legacyBaselineVersion:-1,
      migrations:entries.map(e => ({seq:e.legacySeq,fileName:e.fileName,sqlHash:e.sqlHash,scriptHash:e.scriptHash}))}));
  }
  return {db,filename};
}
function isolatedCatalog(): string {
  const out = path.join(root,`catalog-${serial++}`);
  fs.cpSync(drizzleDir,out,{recursive:true,filter:source => !source.includes(`${path.sep}meta`)});
  return out;
}
function appendMigration(out: string, namespace:'upstream'|'custom', id:number, sql:string): void {
  const fileName = `${String(id).padStart(4,'0')}_test_delta.sql`, sqlPath = `catalog/custom/test-${namespace}/${fileName}`;
  fs.mkdirSync(path.dirname(path.join(out,sqlPath)),{recursive:true});
  fs.writeFileSync(path.join(out,sqlPath),sql);
  fs.writeFileSync(path.join(out,`catalog/entries/${namespace}-${String(id).padStart(4,'0')}.json`),JSON.stringify({namespace,id,fileName,sqlPath,
    sqlHash:migrationFileHash(path.join(out,sqlPath)),scriptPath:null,scriptHash:null,dependsOn:[{namespace,id:id-1}]}));
}
beforeAll(async () => {
  workerScriptPath = await buildDbWorkerBundle(path.join(root,'worker-build'));
  crashScriptPath=path.join(root,'dual-crash.mjs');
  await build({entryPoints:[path.join(__dirname,'fixtures/dualMigrationChild.ts')],outfile:crashScriptPath,bundle:true,platform:'node',format:'esm',packages:'external'});
  for (const name of ['common','fork','official']) {
    const filename = path.join(root, `baseline-${name}.db`), db = open(filename);
    try {
      const entries = catalog.entries.filter(e => e.namespace === 'upstream'
        ? e.id <= (name === 'official' ? 149 : 148) : name === 'fork');
      runMigrationReplay(db, {drizzleDir, migrations: entries.map(e => ({seq:e.legacySeq!,fileName:e.fileName,sqlPath:e.sqlPath,tsScriptPath:e.scriptPath??undefined}))});
      fixtures.set(name, db.serialize());
    } finally { db.close(); }
  }
});
afterAll(() => fs.rmSync(root, {recursive:true,force:true}));

describe('dual-chain production replay', () => {
  it('does not apply upstream frozen replay exceptions to a custom file with the same basename', () => {
    const {db,filename}=fixture('fork'),out=isolatedCatalog();
    try {
      runDualMigrationReplay(db,{drizzleDir:out,dbPath:filename});
      appendMigration(out,'custom',14,'CREATE TABLE custom_guard_collision (id INTEGER PRIMARY KEY);');
      const descriptorPath=path.join(out,'catalog/entries/custom-0014.json');
      const descriptor=JSON.parse(fs.readFileSync(descriptorPath,'utf8'));
      const old=path.join(out,descriptor.sqlPath);
      descriptor.fileName='0084_small_gwen_stacy.sql';
      descriptor.sqlPath=`catalog/custom/test-custom/${descriptor.fileName}`;
      fs.renameSync(old,path.join(out,descriptor.sqlPath));fs.writeFileSync(descriptorPath,JSON.stringify(descriptor));
      runDualMigrationReplay(db,{drizzleDir:out,dbPath:filename});
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='custom_guard_collision'").get()).toEqual({name:'custom_guard_collision'});
    } finally {db.close();}
  });
  it('finishes an earlier committed intent before applying a newer catalog', () => {
    const {db,filename}=fixture('fork'),out=isolatedCatalog();
    try {
      expect(()=>runDualMigrationReplay(db,{drizzleDir:out,dbPath:filename,onPhase:phase=>{if(phase==='committed')throw new Error('controlled interruption');}})).toThrow('controlled interruption');
      appendMigration(out,'custom',14,'CREATE TABLE later_delta (id INTEGER PRIMARY KEY);');
      expect(runDualMigrationReplay(db,{drizzleDir:out,dbPath:filename}).applied).toHaveLength(1);
      expect(db.prepare('SELECT count(*) FROM migration_history_v2').pluck().get()).toBe(164);
      expect(()=>assertDualMigrationReady(db,filename,out)).not.toThrow();
    } finally {db.close();}
  });

  it('does not replace unknown empty-database manifests or malformed interrupted target identities', () => {
    const empty=fixture('empty');
    try {
      fs.writeFileSync(`${empty.filename}.migration-runtime.json`,JSON.stringify({version:99}));
      expect(()=>runDualMigrationReplay(empty.db,{drizzleDir,dbPath:empty.filename})).toThrow('Unknown migration intent');
      expect(JSON.parse(fs.readFileSync(`${empty.filename}.migration-runtime.json`,'utf8')).version).toBe(99);
    } finally {empty.db.close();}
    const {db,filename}=fixture('fork');
    try {
      expect(()=>runDualMigrationReplay(db,{drizzleDir,dbPath:filename,onPhase:phase=>{if(phase==='intent')throw new Error('controlled intent');}})).toThrow('controlled intent');
      const target=JSON.parse(fs.readFileSync(`${filename}.migration-runtime.json`,'utf8'));
      target.state.appliedDigest='f'.repeat(64);fs.writeFileSync(`${filename}.migration-runtime.json`,JSON.stringify(target));
      expect(()=>runDualMigrationReplay(db,{drizzleDir,dbPath:filename})).toThrow('Interrupted migration plan changed');
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='migration_history_v2'").get()).toBeUndefined();
    } finally {db.close();}
  });
  it('retains stale-index startup maintenance after the numeric control field becomes a format marker', () => {
    const {db,filename}=fixture('fork');
    try {
      runDualMigrationReplay(db,{drizzleDir,dbPath:filename});
      // A stale older checkout could recreate this retired table and full index.
      // Current history correctly drops it, so construct that leftover explicitly.
      db.exec('CREATE TABLE orca_workflows(id TEXT PRIMARY KEY,lead_session_id TEXT); CREATE UNIQUE INDEX uniq_orca_workflows_lead_session_id ON orca_workflows(lead_session_id)');
      expect(hasStaleOrcaLeadIndex(db)).toBe(true);
      cleanupStaleOrcaLeadIndex(db);
      expect(hasStaleOrcaLeadIndex(db)).toBe(false);
    } finally {db.close();}
  });
  it.each(['intent','executing','committed'])('recovers an actual child termination after %s', phase => {
    const {db,filename}=fixture('fork');db.close();
    const child=spawnSync(process.execPath,[crashScriptPath,filename,drizzleDir,phase,require.resolve('better-sqlite3')],{
      encoding:'utf8',timeout:10000});
    expect(child.error).toBeUndefined();expect(child.status,child.stderr).toBe(73);
    const reopened=open(filename);
    try {
      const result=runDualMigrationReplay(reopened,{drizzleDir,dbPath:filename});
      expect(result.applied).toHaveLength(phase==='committed'?0:1);
      expect(()=>assertDualMigrationReady(reopened,filename,drizzleDir)).not.toThrow();
      expect(reopened.prepare('SELECT count(*) FROM migration_history_v2').pluck().get()).toBe(163);
    } finally {reopened.close();}
  });

  it('restores a paired pre-conversion backup while keeping the v2 fence and resuming its intent', async () => {
    const profile=fs.mkdtempSync(path.join(root,'restore-owner-')), ownerId='temporary-restore';
    const filename=ownerDatabasePath(profile,ownerId), prepared=fixture('fork');prepared.db.close();
    fs.copyFileSync(prepared.filename,filename);fs.copyFileSync(`${prepared.filename}.migration-runtime.json`,`${filename}.migration-runtime.json`);
    const opened=await openOwnerDatabase({userDataDir:profile,ownerId,isPackaged:false,drizzleDir,
      sqliteVecExtPath:path.join(desktop,`native/sqlite-vec/${process.platform}-${process.arch}/${process.platform==='win32'?'vec0.dll':'vec0.dylib'}`)});
    const before=rows(opened.db);opened.close();
    fs.writeFileSync(filename,'controlled damaged SQLite');
    expect(tryRestoreWithFallback(filename)?.source).toBe('iso');
    expect(JSON.parse(fs.readFileSync(`${filename}.migration-runtime.json`,'utf8')).version).toBe(2);
    const restored=open(filename);
    try {
      runDualMigrationReplay(restored,{drizzleDir,dbPath:filename});
      expect(rows(restored)).toEqual(before);
      expect(()=>assertDualMigrationReady(restored,filename,drizzleDir)).not.toThrow();
    } finally {restored.close();}
  });
  it('preserves V2 task identity, messages, permissions, progress, consent, receipts and approval audit', () => {
    const {db,filename}=fixture('fork');
    try {
      db.exec(`INSERT INTO projects(id,name,owner_id,created_at,updated_at) VALUES ('p','Project','owner',1,1);
        INSERT INTO project_members(project_id,subject_kind,subject_id,role,added_at) VALUES ('p','account','owner','owner',1),('p','bot','executor','member',1);
        INSERT INTO sessions(id,title,created_at,updated_at,project_id,project_binding_revision,assignee_kind,assignee_id,permission_mode,working_dir,task_objective)
          VALUES ('original','Original',1,1,'p',7,'bot','executor','ask','C:/isolated-fixture','Keep the original objective');
        INSERT INTO messages(id,session_id,client_id,role,content,created_at) VALUES ('user-1','original','original-input','user','"Original body"',1);
        INSERT INTO work_item_progress_events(event_id,project_id,session_id,binding_revision,actor_kind,actor_id,request_id,intent_json,from_status,to_status,created_at,revision,before_json,after_json)
          VALUES (1,'p','original',7,'account','owner','progress-1','{}',NULL,'todo',1,1,'null','{}'),
            (2,'p','original',7,'account','owner','progress-2','{}','todo','in_progress',2,2,'{}','{}'),
            (3,'p','original',7,'account','owner','progress-3','{}','in_progress','todo',3,3,'{}','{}');
        INSERT INTO work_item_progress(session_id,project_id,binding_revision,status,revision,updated_by_kind,updated_by_id,updated_at)
          VALUES ('original','p',7,'todo',3,'account','owner',3);
        INSERT INTO project_work_item_executions(id,project_id,session_id,binding_revision,executor_bot_id,caller_session_id,actor_kind,actor_id,key_digest,body_digest,fingerprint,input_id,phase,result_json,created_at,updated_at,admission_kind,consent_working_dir,consent_config_hash,execution_body)
          VALUES ('receipt','p','original',7,'executor','caller','account','owner','key','body','config','original-input','unknown',NULL,1,2,'explicit',NULL,NULL,'Original body');
        INSERT INTO project_work_item_execution_approvals(request_id,session_id,audit_json,created_at) VALUES ('approved-once','original','{"permission":"ask"}',2);
        INSERT INTO project_automation_consents(working_dir,consented_at,config_hash) VALUES ('C:/isolated-fixture',1,'original-automation-hash');`);
      const tables=['projects','project_members','sessions','messages','work_item_progress','work_item_progress_events','project_work_item_executions','project_work_item_execution_approvals','project_automation_consents'];
      const snapshot=()=>tables.map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
      const before=snapshot();
      runDualMigrationReplay(db,{drizzleDir,dbPath:filename});
      expect(snapshot()).toEqual(before);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(runDualMigrationReplay(db,{drizzleDir,dbPath:filename}).applied).toEqual([]);
      expect(snapshot()).toEqual(before);
    } finally {db.close();}
  });
  it('runs the actual Host startup/backup and retains a reader lease until close', async () => {
    const profile = fs.mkdtempSync(path.join(root,'owner-')), ownerId='temporary-test-owner';
    const filename=ownerDatabasePath(profile,ownerId), prepared=fixture('fork');
    prepared.db.close();
    fs.copyFileSync(prepared.filename,filename);
    fs.copyFileSync(`${prepared.filename}.migration-runtime.json`,`${filename}.migration-runtime.json`);
    const options={userDataDir:profile,ownerId,isPackaged:false,drizzleDir,
      sqliteVecExtPath:path.join(desktop,`native/sqlite-vec/${process.platform}-${process.arch}/${process.platform === 'win32'?'vec0.dll':'vec0.dylib'}`)};
    const opened=await openOwnerDatabase(options);
    try {
      expect(()=>assertDualMigrationReady(opened.db,filename,drizzleDir)).not.toThrow();
      const contender=await acquireSchemaMigrationWriterLease(filename);
      if(contender.acquired) contender.lease.release();
      expect(contender.acquired).toBe(false);
      expect(fs.readdirSync(profile).some(f=>f.startsWith('.migration-witness-')&&f.endsWith('.json'))).toBe(true);
    } finally {opened.close();}
    const writer=await acquireSchemaMigrationWriterLease(filename);
    expect(writer.acquired).toBe(true);if(writer.acquired)writer.lease.release();
    const reader=await acquireSchemaMigrationReaderLease(filename);
    expect(reader.acquired).toBe(true);
    try {
      const shared=await openOwnerDatabase({...options,isPackaged:true});
      shared.close();
    } finally {if(reader.acquired)reader.lease.release();}
  });
  it('adds both namespace heads once, with stable same-number identities, then reopens', () => {
    const {db,filename} = fixture('fork'), out = isolatedCatalog();
    try {
      runDualMigrationReplay(db,{drizzleDir:out,dbPath:filename});
      appendMigration(out,'upstream',150,'CREATE TABLE upstream_delta (id INTEGER PRIMARY KEY);');
      appendMigration(out,'custom',14,'CREATE TABLE custom_delta (id INTEGER PRIMARY KEY);');
      const result = runDualMigrationReplay(db,{drizzleDir:out,dbPath:filename});
      expect(result.applied.map(e=>`${e.namespace}:${e.id}`)).toEqual(expect.arrayContaining(['upstream:150','custom:14']));
      expect(db.prepare("SELECT namespace FROM migration_history_v2 WHERE id=1 ORDER BY namespace").all()).toEqual([{namespace:'custom'},{namespace:'upstream'}]);
      expect(runDualMigrationReplay(db,{drizzleDir:out,dbPath:filename}).applied).toEqual([]);
    } finally {db.close();}
  });

  // Diagnostic contract: the unexplained 770fff resource rejection only named a descriptor.
  // Existing mismatch cases cannot identify SQL versus companion or retain that read's evidence.
  // Minimal input is one changed resource in a temporary catalog; migration tier exercises the
  // real replay entry, exact error evidence and unchanged SQLite/sidecar before any DDL.
  it.each(['sql','companion'] as const)('diagnoses the single %s resource read that rejects replay before DDL', kind => {
    const {db,filename}=fixture('fork'),out=isolatedCatalog();
    let restoreReadSpy = (): void => {};
    try {
      runDualMigrationReplay(db,{drizzleDir:out,dbPath:filename});
      appendMigration(out,'custom',14,'CREATE TABLE forbidden_delta (id INTEGER PRIMARY KEY);\r\n');
      const descriptorPath=path.join(out,'catalog/entries/custom-0014.json');
      const descriptor=JSON.parse(fs.readFileSync(descriptorPath,'utf8'));
      descriptor.scriptPath=descriptor.sqlPath.replace(/\.sql$/,'.ts');
      const sqlPath=path.join(out,descriptor.sqlPath),scriptPath=path.join(out,descriptor.scriptPath);
      fs.writeFileSync(scriptPath,"exports.run = db => db.exec('CREATE TABLE forbidden_companion (id INTEGER)');\r\n");
      descriptor.scriptHash=migrationFileHash(scriptPath);
      fs.writeFileSync(descriptorPath,JSON.stringify(descriptor));
      const marker=kind==='sql'?'PRIVATE_SQL_MARKER':'PRIVATE_COMPANION_MARKER';
      fs.appendFileSync(kind==='sql'?sqlPath:scriptPath,`${kind==='sql'?'--':'//'} ${marker} 中\r\n`);
      const resourceEvidence=(relativePath:string,actualPath:string,expectedNormalizedSha256:string) => {
        const bytes=fs.readFileSync(actualPath),normalized=bytes.toString('utf8').replace(/\r\n/g,'\n');
        return {relativePath,actualPath,expectedNormalizedSha256,
          actualNormalizedSha256:crypto.createHash('sha256').update(normalized).digest('hex'),
          readBytes:bytes.length,normalizedBytes:Buffer.byteLength(normalized)};
      };
      const details={namespace:'custom',id:14,descriptorPath:'catalog/entries/custom-0014.json',
        sql:resourceEvidence(descriptor.sqlPath,sqlPath,descriptor.sqlHash),
        companion:resourceEvidence(descriptor.scriptPath,scriptPath,descriptor.scriptHash)};
      const beforeDb=db.serialize(),beforeManifest=fs.readFileSync(`${filename}.migration-runtime.json`,'utf8');
      const readSpy=vi.spyOn(fs,'readFileSync');
      restoreReadSpy=()=>{readSpy.mockRestore();};
      let failure:unknown;
      try { runDualMigrationReplay(db,{drizzleDir:out,dbPath:filename}); } catch (error) { failure=error; }
      expect(failure).toMatchObject({code:'MIGRATION_RESOURCE_IDENTITY_CHANGED',details});
      expect((failure as Error).message).toContain(JSON.stringify(details));
      expect((failure as Error).message).not.toContain(marker);
      expect(readSpy.mock.calls.filter(([file])=>file===sqlPath)).toHaveLength(1);
      expect(readSpy.mock.calls.filter(([file])=>file===scriptPath)).toHaveLength(1);
      expect(db.serialize().equals(beforeDb)).toBe(true);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('forbidden_delta','forbidden_companion')").all()).toEqual([]);
      expect(fs.readFileSync(`${filename}.migration-runtime.json`,'utf8')).toBe(beforeManifest);
    } finally {restoreReadSpy();db.close();}
  });

  it.each(['hash','dependency','cycle','ledger'])('rejects %s mismatch before any new DDL', kind => {
    const {db,filename} = fixture('fork'), out = isolatedCatalog();
    try {
      runDualMigrationReplay(db,{drizzleDir:out,dbPath:filename});
      appendMigration(out,'custom',14,'CREATE TABLE forbidden_delta (id INTEGER PRIMARY KEY);');
      const file = path.join(out,'catalog/entries/custom-0014.json'), descriptor=JSON.parse(fs.readFileSync(file,'utf8'));
      if (kind === 'hash') descriptor.sqlHash='f'.repeat(64);
      if (kind === 'dependency') descriptor.dependsOn.push({namespace:'upstream',id:9999});
      if (kind === 'cycle') descriptor.dependsOn.push({namespace:'custom',id:14});
      fs.writeFileSync(file,JSON.stringify(descriptor));
      if (kind === 'ledger') db.exec("UPDATE migration_history_v2 SET identity='{}' WHERE namespace='custom' AND id=1");
      const before = fs.readFileSync(`${filename}.migration-runtime.json`,'utf8');
      expect(()=>runDualMigrationReplay(db,{drizzleDir:out,dbPath:filename})).toThrow();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='forbidden_delta'").get()).toBeUndefined();
      expect(fs.readFileSync(`${filename}.migration-runtime.json`,'utf8')).toBe(before);
    } finally {db.close();}
  });

  it('rolls back a real SQL failure and resumes an unchanged plan after reopen', () => {
    const {db,filename} = fixture('fork'), out = isolatedCatalog();
    runDualMigrationReplay(db,{drizzleDir:out,dbPath:filename});
    appendMigration(out,'custom',14,'CREATE TABLE first_delta (id INTEGER PRIMARY KEY); CREATE TABLE already_there (id INTEGER);');
    db.exec('CREATE TABLE already_there (id INTEGER)');
    try {
      expect(()=>runDualMigrationReplay(db,{drizzleDir:out,dbPath:filename})).toThrow('already exists');
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='first_delta'").get()).toBeUndefined();
      expect(db.prepare("SELECT * FROM migration_history_v2 WHERE namespace='custom' AND id=14").get()).toBeUndefined();
      db.exec('DROP TABLE already_there');
    } finally {db.close();}
    const reopened=open(filename);
    try {
      expect(runDualMigrationReplay(reopened,{drizzleDir:out,dbPath:filename}).applied).toHaveLength(1);
      expect(()=>assertDualMigrationReady(reopened,filename,out)).not.toThrow();
    } finally {reopened.close();}
  });
  it.each([true,false])('admits only committed complete ledgers in the real worker (inline=%s)', async inline => {
    const {db,filename} = fixture('fork');
    try {runDualMigrationReplay(db,{drizzleDir,dbPath:filename});} finally {db.close();}
    const opts = {dbPath:filename,drizzleDir,betterSqliteModulePath:require.resolve('better-sqlite3'),
      ...(inline ? {useInlineWorker:true} : {workerScriptPath})};
    let transport = new WorkerThreadTransport(opts);
    try {await expect(transport.send('query',{sql:'SELECT count(*) AS n FROM migration_history_v2'})).resolves.toEqual([{n:163}]);}
    finally {await transport.close();}
    fs.unlinkSync(`${filename}.migration-runtime.json`);
    transport = new WorkerThreadTransport(opts);
    try {await expect(transport.send('exec',{sql:"INSERT INTO migration_meta VALUES ('should-not-write','1')"})).rejects.toThrow();}
    finally {await transport.close();}
    const verify = open(filename);
    try {expect(verify.prepare("SELECT * FROM migration_meta WHERE key='should-not-write'").get()).toBeUndefined();}
    finally {verify.close();}
  });
  it.each(['empty','common','fork','official'])('adopts %s without rewriting legacy rows and reopens without replay', name => {
    const {db,filename} = fixture(name);
    try {
      const before = name === 'empty' ? null : rows(db);
      const result = runDualMigrationReplay(db,{drizzleDir,dbPath:filename});
      expect(result.applied.length).toBe(name === 'empty' ? 163 : name === 'common' ? 14 : name === 'fork' ? 1 : 13);
      if (before) expect(rows(db)).toEqual(before);
      expect(db.prepare("SELECT value FROM migration_meta WHERE key='schema_version'").pluck().get()).toBe(DUAL_SCHEMA_VERSION);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='mcp_app_view_states'").get()).toBeTruthy();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='project_work_item_executions'").get()).toBeTruthy();
      expect(db.prepare('SELECT count(*) FROM migration_history_v2').pluck().get()).toBe(163);
      expect(planSchemaDriftRepair(db)).toEqual({actions:[],residual:[]});
      expect(checkMigrationCompatibility(db,drizzleDir,filename).compatible).toBe(true);
      const stateBefore = db.prepare('SELECT * FROM migration_history_v2 ORDER BY namespace,id').all();
      expect(runDualMigrationReplay(db,{drizzleDir,dbPath:filename}).applied).toEqual([]);
      expect(db.prepare('SELECT * FROM migration_history_v2 ORDER BY namespace,id').all()).toEqual(stateBefore);
    } finally {db.close();}
    const reopened = open(filename);
    try { expect(() => assertDualMigrationReady(reopened,filename,drizzleDir)).not.toThrow(); }
    finally {reopened.close();}
  });

  it('rolls back DDL and ledger together then retries the exact durable intent', () => {
    const {db,filename} = fixture('fork');
    try {
      const before = rows(db);
      expect(() => runDualMigrationReplay(db,{drizzleDir,dbPath:filename,onPhase:phase => {
        if (phase === 'executing') throw new Error('controlled SQL failure');
      }})).toThrow('controlled SQL failure');
      expect(rows(db)).toEqual(before);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='migration_history_v2'").get()).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(`${filename}.migration-runtime.json`,'utf8')).phase).toBe('intent');
      expect(runDualMigrationReplay(db,{drizzleDir,dbPath:filename}).applied).toHaveLength(1);
    } finally {db.close();}
  });

  it.each(['empty','fork'])('recovers %s committed DB before sidecar publication without rerunning DDL', name => {
    const {db,filename} = fixture(name);
    try {
      expect(() => runDualMigrationReplay(db,{drizzleDir,dbPath:filename,onPhase:phase => {
        if (phase === 'committed') throw new Error('controlled publication failure');
      }})).toThrow('controlled publication failure');
      expect(db.prepare('SELECT count(*) FROM migration_history_v2').pluck().get()).toBe(163);
      const before = migrationDigest(db.prepare('SELECT * FROM migration_history_v2 ORDER BY namespace,id').all());
      expect(runDualMigrationReplay(db,{drizzleDir,dbPath:filename}).applied).toEqual([]);
      expect(migrationDigest(db.prepare('SELECT * FROM migration_history_v2 ORDER BY namespace,id').all())).toBe(before);
      expect(() => assertDualMigrationReady(db,filename,drizzleDir)).not.toThrow();
    } finally {db.close();}
  });

  it.each(['missing','corrupt'])('fails closed for %s v2 witness, preserving the database', kind => {
    const {db,filename} = fixture('fork');
    try {
      runDualMigrationReplay(db,{drizzleDir,dbPath:filename});
      const before = migrationDigest(db.serialize());
      if (kind === 'missing') fs.unlinkSync(`${filename}.migration-runtime.json`);
      else fs.writeFileSync(`${filename}.migration-runtime.json`,'{');
      expect(() => planDualMigrations(db,filename,drizzleDir)).toThrow();
      expect(migrationDigest(db.serialize())).toEqual(before);
      expect(checkMigrationCompatibility(db,drizzleDir,filename).compatible).toBe(false);
    } finally {db.close();}
  });
});
