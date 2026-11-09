/** DB tier: frozen R1 references. Production worker + generated 0146..0149 SQL.
 * Regression: project-level duplicates previously left the second task empty; entity-wide
 * removal/latest-version projection moved other tasks' references. Old tests lacked epochs
 * and authority revocation. Trusted byte descriptors here do not prove real file/media IO.
 * Modules/SQL load once, no real waits or real user DB. Migration companion is tested in replay.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runMaterialsTransaction, type MaterialVersionInput, type MaterialsAddTxResult } from '../worker/opHandlers/materialsTx';
import { runProjectsTransaction } from '../worker/opHandlers/projectsTx';
import type { Material, MaterialContext, MaterialScope, MaterialReference, MaterialVersion } from '../../../shared/materials';
const dir = path.resolve(__dirname, '../../../../drizzle');
const sql = ['0146_', '0147_', '0148_', '0149_'].map(prefix => {
  const name = readdirSync(dir).find(n => n.startsWith(prefix) && n.endsWith('.sql'))!;
  return readFileSync(path.join(dir, name), 'utf8').split('--> statement-breakpoint').join(';');
}).join(';');
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const owner = { kind: 'account' as const, id: 'owner' };
const member = { kind: 'account' as const, id: 'member' };
const scope = (workItemId: string | null = 't1', projectId = 'p', bindingRevision = 1): MaterialScope =>
  workItemId === null ? { projectId, workItemId: null, bindingRevision: null } : { projectId, workItemId, bindingRevision };

describe('R1 material reference transactions', () => {
  let db: Database.Database;
  let seq: number;
  const run = (input: Record<string, unknown>) => runMaterialsTransaction(db, { actor: owner, now: 1000, ...input });
  const file = (patch: Partial<MaterialVersionInput> = {}): MaterialVersionInput => {
    const id = String(++seq);
    return { referenceId: 'r'+id, versionId: 'v'+id, materialId: 'm'+id, name: 'a.txt',
      sha256: A, sizeBytes: 1, mime: 'text/plain', storageKind: 'file', storageRef: '/fixture/a.txt', sourceMtime: 1, ...patch };
  };
  const add = (files: MaterialVersionInput[], s = scope(), actor = owner) =>
    run({ action: 'add', ...s, files, actor }) as MaterialsAddTxResult;
  const reuse = (r: MaterialReference, s = scope('t3'), version = r.version) =>
    run({ action: 'add', ...s, existing: [{ referenceId: 'new-'+(++seq), materialId: r.materialId, version }] }) as MaterialsAddTxResult;
  const list = (s = scope()): Material[] => (run({ action: 'list', ...s }) as { materials: Material[] }).materials;
  const context = (r: MaterialReference, s = scope(), version = r.version): MaterialContext =>
    (run({ action: 'createContext', ...s, newId: 'ctx'+(++seq), purpose: 'reference',
      refs: [{ referenceId: r.id, materialId: r.materialId, version }] }) as { context: MaterialContext }).context;
  const remove = (r: MaterialReference, s = scope()) => run({ action: 'removeReference', ...s, referenceId: r.id });
  const version = (r: MaterialReference, f = file({ sha256: B }), s = scope(), replace = false) =>
    run({ action: 'addVersion', ...s, referenceId: r.id, materialId: r.materialId, file: f, replaceCurrentReference: replace }) as { version: MaterialVersion; reference: MaterialReference };
  const count = (table: string) => db.prepare('SELECT COUNT(*) FROM '+table).pluck().get();
  const unchanged = (input: Record<string, unknown>, code: string) => {
    const changes = db.prepare('SELECT total_changes()').pluck().get();
    expect(() => run(input)).toThrow('['+code+']');
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changes);
  };
  const bind = (target: string | null, task = 't3') => runProjectsTransaction(db, {
    action: 'bindSession', actor: owner, projectId: target, sessionId: task,
  });
  beforeEach(() => {
    seq = 0;
    db = createBetterSqliteDatabase(':memory:');
    db.pragma('foreign_keys=ON');
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY,title TEXT,status TEXT NOT NULL DEFAULT 'active',updated_at INTEGER NOT NULL DEFAULT 1)");
    db.exec(sql);
    for (const p of ['p','q']) runProjectsTransaction(db, { action: 'create', actor: owner, now: 1, newId: p,
      input: { name: p, owner, members: p === 'p' ? [member, { kind: 'bot', id: 'owner' }] : [] } });
    db.exec("INSERT INTO sessions (id) VALUES ('t1'),('t3')");
    bind('p','t1'); bind('p');
  });
  afterEach(() => db.close());

  it('A1/R1: adds distinct versions, then persists the second task duplicate reference without moving t1', () => {
    const first = add([file(), file({ name: 'b.txt', sha256: B })]);
    expect(first.added).toHaveLength(2);
    const duplicate = add([file({ name: 'copy.txt' })], scope('t3'));
    expect(duplicate.duplicates).toEqual([{ name: 'copy.txt', materialId: first.added[0].materialId, version: 1 }]);
    expect(duplicate.references).toHaveLength(1);
    expect(duplicate.references[0].workItemId).toBe('t3');
    expect(list(scope('t3'))[0]).toMatchObject({ currentVersion: 1, latestVersion: 1, readState: 'ready', reference: duplicate.references[0] });
    expect(list()).toHaveLength(2);
    expect(count('materials')).toBe(2); expect(count('material_versions')).toBe(2);
    expect(db.prepare('SELECT work_item_id FROM materials WHERE id=?').pluck().get(first.added[0].materialId)).toBe('t1');
    expect(JSON.stringify(list(scope('t3')))).not.toContain('storageRef');
  });

  it('A2/R2: repeated duplicate inputs retain one reference; removal/restoration reuses its id', () => {
    const result = add([file(), file()]);
    expect(result.added).toHaveLength(1); expect(result.duplicates).toHaveLength(1);
    expect(result.references[0].id).toBe(result.references[1].id);
    const r = result.references[0];
    remove(r); remove(r);
    expect(list()).toEqual([]);
    const restored = reuse(r, scope());
    expect(restored.references[0].id).toBe(r.id);
    const changes = db.prepare('SELECT total_changes()').pluck().get();
    reuse(r, scope());
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changes);
    expect(count('material_references')).toBe(1);
  });

  it('A3: same name different bytes requires explicit create-new; identical content still deduplicates', () => {
    const original = add([file()]).references[0];
    const rejected = add([file({ sha256: B })]);
    expect(rejected.rejected[0].code).toBe('DUPLICATE_CONTENT'); expect(count('materials')).toBe(1);
    const second = add([file({ sha256: B, sameNameAction: 'create-new' })]);
    expect(second.added).toHaveLength(1);
    const duplicate = add([file({ sameNameAction: 'create-new' })]);
    expect(duplicate.duplicates[0]).toMatchObject({ materialId: original.materialId, version: 1 });
    expect(count('materials')).toBe(2); expect(count('material_versions')).toBe(2);
  });

  it('A4/A8/R3/R5: t1 v2 never advances t3 v1 or a snapshot; explicit version selection is exact', () => {
    const t1 = add([file()]).references[0];
    const t3 = reuse(t1).references[0];
    const pinned = context(t3, scope('t3'));
    const bytes = db.prepare('SELECT refs_json FROM material_contexts WHERE id=?').pluck().get(pinned.id);
    version(t1);
    expect(list()[0]).toMatchObject({ currentVersion: 2, latestVersion: 2 });
    expect(list(scope('t3'))[0]).toMatchObject({ currentVersion: 1, latestVersion: 2 });
    const oldFile = add([file()], scope('t3')); // Same filename, exact old bytes despite entity latest v2.
    expect(oldFile.duplicates[0].version).toBe(1);
    const selected = reuse(t3, scope('t3'), 2).references[0];
    expect(selected.id).toBe(t3.id); expect(selected.version).toBe(2);
    expect(context(selected, scope('t3'), 1).refs[0].version).toBe(1);
    expect(db.prepare('SELECT refs_json FROM material_contexts WHERE id=?').pluck().get(pinned.id)).toBe(bytes);
    const old = run({ action: 'resolveVersion', contextId: pinned.id, materialId: t1.materialId, version: 1 }) as { version: MaterialVersion };
    expect(old.version.sha256).toBe(A);
  });

  it('A5/R4: removing one reference leaves the other and historical version readable', () => {
    const t1 = add([file()]).references[0], t3 = reuse(t1).references[0];
    const c = context(t1);
    remove(t1);
    expect(list()).toEqual([]); expect(list(scope('t3'))[0].reference.id).toBe(t3.id);
    expect((run({ action: 'resolveVersion', contextId: c.id, materialId: t1.materialId, version: 1 }) as { version: MaterialVersion }).version.sha256).toBe(A);
    expect(count('material_versions')).toBe(1); expect(count('materials')).toBe(1);
    expect(db.prepare('SELECT status FROM materials').pluck().get()).toBe('active');
  });

  it('A6/R11 data boundary: retry only changes read state; historical retry never restores removal or snapshot state', () => {
    const r = add([file()]).references[0], c = context(r);
    run({ action: 'retryRead', ...scope(), referenceId: r.id, materialId: r.materialId, version: 1,
      readState: 'failed', failureReason: 'SOURCE_CHANGED' });
    expect(list()[0].readState).toBe('failed');
    expect(add([file()]).duplicates).toEqual([]); // A same-name failed version is not a readable duplicate.
    remove(r);
    run({ action: 'retryRead', contextId: c.id, materialId: r.materialId, version: 1, readState: 'ready' });
    expect(count('material_versions')).toBe(1); expect(list()).toEqual([]);
    expect(JSON.parse(db.prepare('SELECT refs_json FROM material_contexts').pluck().get() as string)[0].readStateAtPin).toBe('ready');
  });

  it('R9: project-level references never appear in a task without explicit reuse', () => {
    const r = add([file()], scope(null)).references[0];
    expect(list()).toEqual([]); expect(list(scope(null))).toHaveLength(1);
    const t1 = reuse(r, scope()).references[0];
    remove(r, scope(null));
    expect(list()).toHaveLength(1); expect(list(scope(null))).toEqual([]); expect(t1.id).not.toBe(r.id);
  });

  it.each(['q', null])('R6: actual p -> %s -> p invalidates every current operation, preserving snapshots', via => {
    const r = add([file()], scope('t3')).references[0], c = context(r, scope('t3'));
    bind(via); bind('p');
    const old = { ...scope('t3'), referenceId: r.id, materialId: r.materialId, version: 1 };
    for (const input of [
      { action: 'list', ...old }, { action: 'add', ...old, files: [file()] },
      { action: 'removeReference', ...old }, { action: 'addVersion', ...old, file: file({ sha256: B }) },
      { action: 'createContext', ...old, newId: 'stale', purpose: 'reference', refs: [] },
      { action: 'resolveVersion', ...old }, { action: 'retryRead', ...old, readState: 'failed' },
    ]) unchanged(input, 'BINDING_CONFLICT');
    expect(list(scope('t3','p',3))).toEqual([]);
    expect((run({ action: 'list', projectId: 'p', workItemId: 't3', history: true }) as { materials: Material[] }).materials).toHaveLength(1);
    expect((run({ action: 'resolveVersion', contextId: c.id, materialId: r.materialId, version: 1 }) as { version: MaterialVersion }).version.sha256).toBe(A);
    const fresh = reuse(r, scope('t3','p',3)).references[0];
    expect(fresh.id).not.toBe(r.id); expect(count('material_references')).toBe(2);
  });

  it('R7: revocation after observing a duplicate is rechecked before any duplicate/reference result', () => {
    add([file()]);
    expect(db.prepare('SELECT 1 FROM project_members WHERE project_id=? AND subject_id=?').get('p','member')).toBeTruthy();
    const pending = { action: 'add', ...scope('t3'), files: [file({ name: 'copy.txt', reuseOnly: true })], actor: member };
    runProjectsTransaction(db, { action: 'removeMember', projectId: 'p', subject: member, actor: owner, now: 2000 });
    unchanged(pending, 'FORBIDDEN'); expect(count('material_references')).toBe(1);
    bind('q');
    unchanged({ ...pending, actor: owner }, 'REFERENCE_MISMATCH');
  });

  it('R8: kind-scoped members can manage materials; strangers and mismatched scope/refs cannot', () => {
    const r = add([file()]).references[0];
    const bot = { kind: 'bot' as const, id: 'owner' };
    const managed = run({ action: 'add', ...scope('t3'), existing: [{ materialId: r.materialId, version: 1, referenceId: 'bot-ref' }], actor: bot }) as MaterialsAddTxResult;
    expect(managed.references[0].createdByKind).toBe('bot');
    unchanged({ action: 'list', ...scope(), actor: { kind: 'bot', id: 'member' } }, 'FORBIDDEN');
    unchanged({ action: 'list', ...scope('t1','q') }, 'REFERENCE_MISMATCH');
    unchanged({ action: 'removeReference', ...scope('t3'), referenceId: r.id }, 'REFERENCE_MISMATCH');
    unchanged({ action: 'list', ...scope(null,'q'), actor: bot }, 'FORBIDDEN');
  });

  it('R8: cross-project existing batches validate all entries before any reference write', () => {
    const r = add([file()]).references[0];
    const foreign = add([file()], scope(null,'q')).references[0];
    expect(foreign.materialId).not.toBe(r.materialId);
    unchanged({ action: 'add', ...scope('t3'), existing: [
      { referenceId: 'ok', materialId: r.materialId, version: 1 },
      { referenceId: 'bad', materialId: foreign.materialId, version: 1 },
    ] }, 'REFERENCE_MISMATCH');
    expect(list(scope('t3'))).toEqual([]);
  });

  it('R10: version writes advance only the selected active reference and preserve immutable versions', () => {
    const r = add([file()]).references[0], other = reuse(r).references[0];
    unchanged({ action: 'addVersion', ...scope(), referenceId: other.id, materialId: r.materialId, file: file({ sha256: B }) }, 'REFERENCE_MISMATCH');
    const second = version(r);
    const third = version(other, file({ sha256: C }), scope('t3'));
    expect(second.version.version).toBe(2); expect(third.version.version).toBe(3);
    expect(list()[0].currentVersion).toBe(2); expect(list(scope('t3'))[0].currentVersion).toBe(3);
    expect(db.prepare('SELECT sha256 FROM material_versions WHERE material_id=? AND version=1').pluck().get(r.materialId)).toBe(A);
    unchanged({ action: 'addVersion', ...scope('t3'), referenceId: other.id, materialId: r.materialId, file: file({ sha256: C }) }, 'DUPLICATE_CONTENT');
    expect(version(other, file({ sha256: C }), scope('t3'), true).version.version).toBe(4);
    remove(r);
    unchanged({ action: 'addVersion', ...scope(), referenceId: r.id, materialId: r.materialId, file: file() }, 'PRECONDITION_FAILED');
  });

  it('reuse-only probes cannot create bytes after the candidate becomes unreadable', () => {
    const r = add([file()]).references[0];
    run({ action: 'retryRead', ...scope(), referenceId: r.id, materialId: r.materialId, version: 1, readState: 'failed', failureReason: 'SOURCE_MISSING' });
    const result = add([file({ name: 'different.txt', reuseOnly: true })], scope('t3'));
    expect(result.duplicates).toEqual([]); expect(result.references).toEqual([]);
    expect(result.rejected[0].code).toBe('MEDIA_WRITE_FAILED'); expect(count('materials')).toBe(1);
  });

  it('context creation validates every reference, preserves exact versions and records failed pin state honestly', () => {
    const r = add([file()]).references[0], other = reuse(r).references[0];
    unchanged({ action: 'createContext', ...scope(), newId: 'bad', purpose: 'reference', refs: [
      { referenceId: r.id, materialId: r.materialId, version: 1 },
      { referenceId: other.id, materialId: r.materialId, version: 1 },
    ] }, 'REFERENCE_MISMATCH');
    run({ action: 'retryRead', ...scope(), referenceId: r.id, materialId: r.materialId, version: 1, readState: 'failed' });
    const failedPin = context(r);
    expect(failedPin.refs[0].readStateAtPin).toBe('failed');
    run({ action: 'retryRead', ...scope(), referenceId: r.id, materialId: r.materialId, version: 1, readState: 'ready' });
    expect(JSON.parse(db.prepare('SELECT refs_json FROM material_contexts WHERE id=?').pluck().get(failedPin.id) as string)[0].readStateAtPin).toBe('failed');
    unchanged({ action: 'createContext', ...scope(), newId: 'no-version', purpose: 'reference', refs: [
      { referenceId: r.id, materialId: r.materialId, version: 99 },
    ] }, 'VERSION_NOT_FOUND');
  });

  it('legacy snapshots are source-project history only; unknown origins never disclose a version', () => {
    const r = add([file()]).references[0];
    db.prepare('INSERT INTO material_contexts (id,work_item_id,purpose,refs_json,created_by_kind,created_by_id,created_at) VALUES (?,?,?,?,?,?,?)')
      .run('old', 't3', 'reference', JSON.stringify([{ materialId: r.materialId, version: 1, readStateAtPin: 'ready' }]), 'account','owner',1);
    db.prepare('INSERT INTO material_contexts (id,work_item_id,purpose,refs_json,created_by_kind,created_by_id,created_at) VALUES (?,?,?,?,?,?,?)')
      .run('empty', 't3', 'reference', '[]','account','owner',1);
    for (const [id, payload] of [['invalid-object','[null]'], ['invalid-field','[{"materialId":42,"version":1,"readStateAtPin":"ready"}]']]) {
      db.prepare('INSERT INTO material_contexts (id,work_item_id,purpose,refs_json,created_by_kind,created_by_id,created_at) VALUES (?,?,?,?,?,?,?)').run(id,'t3','reference',payload,'account','owner',1);
      unchanged({ action: 'resolveVersion', contextId: id, materialId: r.materialId, version: 1 }, 'CONTEXT_SCOPE_UNKNOWN');
    }
    bind('q');
    const qOnly = { kind: 'account' as const, id: 'q-only' };
    runProjectsTransaction(db, { action: 'addMember', actor: owner, projectId: 'q', subject: qOnly, now: 1 });
    unchanged({ action: 'resolveVersion', contextId: 'old', materialId: r.materialId, version: 1, actor: qOnly }, 'FORBIDDEN');
    expect((run({ action: 'resolveVersion', contextId: 'old', materialId: r.materialId, version: 1, actor: member }) as { version: MaterialVersion }).version.version).toBe(1);
    expect((run({ action: 'listContexts', projectId: 'p', workItemId: 't3', history: true }) as { contexts: MaterialContext[] }).contexts.map(c => c.id)).toEqual(['old']);
    unchanged({ action: 'resolveVersion', contextId: 'old', materialId: r.materialId, version: 2 }, 'REFERENCE_MISMATCH');
    unchanged({ action: 'resolveVersion', contextId: 'empty', materialId: r.materialId, version: 1 }, 'CONTEXT_SCOPE_UNKNOWN');
    unchanged({ action: 'resolveVersion', contextId: 'old', materialId: r.materialId, version: 1, actor: { kind: 'bot', id: 'member' } }, 'FORBIDDEN');
    expect((run({ action: 'resolveVersion', contextId: 'old', materialId: r.materialId, version: 1 }) as { version: MaterialVersion }).version.version).toBe(1);
  });

  it('requires explicit valid tokens, reference identity and actor without partial malformed-batch writes', () => {
    const r = add([file()]).references[0];
    unchanged({ action: 'list', projectId: 'p', workItemId: 't1' }, 'REFERENCE_SCOPE_REQUIRED');
    unchanged({ action: 'removeReference', materialId: r.materialId }, 'REFERENCE_SCOPE_REQUIRED');
    unchanged({ action: 'list', ...scope(), bindingRevision: -1 }, 'INVALID_PARAMS');
    unchanged({ action: 'list', ...scope(null), bindingRevision: 0 }, 'INVALID_PARAMS');
    unchanged({ action: 'add', ...scope(), files: [file({ name: 'new.txt', sha256: B }), file({ sha256: 'bad' })] }, 'INVALID_PARAMS');
    unchanged({ action: 'add', ...scope(), files: [] }, 'INVALID_PARAMS');
    for (const input of [
      { action: 'list', ...scope() }, { action: 'listContexts', ...scope() },
      { action: 'add', ...scope(), files: [file({ name: 'other.txt', sha256: C })] },
      { action: 'removeReference', ...scope(), referenceId: r.id },
      { action: 'addVersion', ...scope(), referenceId: r.id, materialId: r.materialId, file: file({ sha256: B }) },
      { action: 'createContext', ...scope(), newId: 'no-actor', purpose: 'reference', refs: [] },
      { action: 'resolveVersion', ...scope(), referenceId: r.id, materialId: r.materialId, version: 1 },
      { action: 'retryRead', ...scope(), referenceId: r.id, materialId: r.materialId, version: 1, readState: 'ready' },
    ]) unchanged({ ...input, actor: undefined }, 'INVALID_PARAMS');
    db.exec("UPDATE sessions SET status='deleted' WHERE id='t1'");
    unchanged({ action: 'removeReference', ...scope(), referenceId: r.id }, 'PRECONDITION_FAILED');
  });

  it('legacy inline embedding runs the same implementation without module-scope runtime helpers', () => {
    const embedded = new Function('return (' + runMaterialsTransaction.toString() + ')')() as typeof runMaterialsTransaction;
    const result = embedded(db, { action: 'add', ...scope(), actor: owner, now: 1, files: [file()] }) as MaterialsAddTxResult;
    expect(result.references[0].version).toBe(1);
    expect((embedded(db, { action: 'list', ...scope(), actor: owner }) as { materials: Material[] }).materials[0].currentVersion).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rolls back material/version creation and version advancement if persisting the reference fails', () => {
    db.exec("CREATE TRIGGER fail_ref_insert BEFORE INSERT ON material_references BEGIN SELECT RAISE(ABORT,'reference fixture failure'); END");
    expect(() => add([file()])).toThrow('reference fixture failure');
    expect(count('materials')).toBe(0); expect(count('material_versions')).toBe(0);
    db.exec('DROP TRIGGER fail_ref_insert');
    const r = add([file()]).references[0];
    const c = context(r);
    const snapshot = db.prepare('SELECT refs_json FROM material_contexts WHERE id=?').pluck().get(c.id);
    db.exec("CREATE TRIGGER fail_ref_update BEFORE UPDATE ON material_references BEGIN SELECT RAISE(ABORT,'reference fixture failure'); END");
    expect(() => version(r)).toThrow('reference fixture failure');
    expect(count('material_versions')).toBe(1); expect(list()[0].currentVersion).toBe(1);
    expect(db.prepare('SELECT refs_json FROM material_contexts WHERE id=?').pluck().get(c.id)).toBe(snapshot);
  });

  it('preserves media/file descriptor storage fields without exposing either storage reference', () => {
    add([file({ referenceId: 'legacy-material:' + 'x'.repeat(200), name: 'image.png', storageKind: 'media', storageRef: 'cindy-media://blobs/a.png',
      mime: 'image/png', sourceMtime: null }), file({ name: 'source.txt', sha256: B })]);
    expect(db.prepare('SELECT storage_kind,storage_ref,source_mtime FROM material_versions ORDER BY storage_kind').all()).toEqual([
      { storage_kind: 'file', storage_ref: '/fixture/a.txt', source_mtime: 1 },
      { storage_kind: 'media', storage_ref: 'cindy-media://blobs/a.png', source_mtime: null },
    ]);
    expect(list().find(m => m.name === 'image.png')?.reference.id).toHaveLength(216);
    expect(JSON.stringify(list())).not.toContain('/fixture/');
    expect(JSON.stringify(list())).not.toContain('cindy-media://');
    unchanged({ action: 'add', ...scope(), files: [file({ name: 'bad.txt', sourceMtime: null })] }, 'INVALID_PARAMS');
  });

  it('enforces name limits but no numeric batch/snapshot caps', () => {
    // 字段长度是输入合法性（保留）；批次号与快照引用数不做限额（用户裁决）。
    unchanged({ action: 'add', ...scope(), files: [file({ name: 'x'.repeat(261) })] }, 'INVALID_PARAMS');
    const batch = add(Array.from({ length: 51 }, () => file({ name: 'x'.repeat(260) })));
    expect(batch.references).toHaveLength(51);
    expect(batch.rejected).toEqual([]);
    const r = batch.references[0];
    const ref = { referenceId: r.id, materialId: r.materialId, version: 1 };
    const result = run({ action: 'createContext', ...scope(), purpose: 'reference', newId: 'wide', refs: Array.from({ length: 201 }, () => ref) }) as { context: MaterialContext };
    expect(result.context.refs).toHaveLength(201);
  });
});
