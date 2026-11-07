import type Database from 'better-sqlite3';
import type {
  Material, MaterialVersion, MaterialReference, MaterialContext, MaterialContextRef,
  MaterialReadState, MaterialStorageKind, MaterialSubjectKind, MaterialScope,
  MaterialsAddResult, MaterialAddVersionResult, MaterialRemoveReferenceResult,
  MaterialRetryReadResult, MaterialContextCreateResult, MaterialsListResult,
  MaterialContextsListResult, MaterialPreviewParams, MaterialContextCreateParams,
  MaterialsListParams, MaterialContextListParams, MaterialRemoveReferenceParams,
  MaterialAddVersionParams, MaterialRetryReadParams, MaterialExistingInput,
} from '../../../../shared/materials';

/** Main-only staged descriptor. A reuse-only probe never licenses creating unstaged bytes. */
export interface MaterialVersionInput {
  referenceId: string;
  versionId: string;
  materialId: string;
  name: string;
  sameNameAction?: 'create-new';
  sha256: string;
  sizeBytes: number;
  mime: string;
  storageKind: MaterialStorageKind;
  storageRef: string;
  sourceMtime: number | null;
  reuseOnly?: boolean;
}
export interface MaterialsActor { kind: MaterialSubjectKind; id: string }
type Trusted = { actor: MaterialsActor; now: number };
export type MaterialsAddRequest = MaterialScope & Trusted & { action: 'add' } & (
  | { files: MaterialVersionInput[]; existing?: never }
  | { existing: Array<MaterialExistingInput & { referenceId: string }>; files?: never }
);
export type MaterialsAddVersionRequest = MaterialScope & Omit<MaterialAddVersionParams, keyof MaterialScope | 'file'> & Trusted &
  { action: 'addVersion'; file: MaterialVersionInput };
export type MaterialsRemoveReferenceRequest = MaterialRemoveReferenceParams & Trusted & { action: 'removeReference' };
export type MaterialsRetryReadRequest = MaterialRetryReadParams & Trusted &
  { action: 'retryRead'; readState: 'ready' | 'failed'; failureReason: string | null };
export type MaterialsCreateContextRequest = MaterialContextCreateParams & Trusted & { action: 'createContext'; newId: string };
export type MaterialsListRequest = MaterialsListParams & { action: 'list'; actor: MaterialsActor };
export type MaterialsListContextsRequest = MaterialContextListParams & { action: 'listContexts'; actor: MaterialsActor };
export type MaterialsResolveVersionRequest = MaterialPreviewParams & { action: 'resolveVersion'; actor: MaterialsActor };
export type MaterialsTxRequest = MaterialsAddRequest | MaterialsAddVersionRequest |
  MaterialsRemoveReferenceRequest | MaterialsRetryReadRequest | MaterialsCreateContextRequest |
  MaterialsListRequest | MaterialsListContextsRequest | MaterialsResolveVersionRequest;
export type MaterialsAddTxResult = Omit<MaterialsAddResult, 'rejected'> & {
  rejected: Array<{ name: string; code: 'DUPLICATE_CONTENT' | 'MEDIA_WRITE_FAILED'; versionId: string }>;
};
export type MaterialsAddVersionTxResult = MaterialAddVersionResult;
export type MaterialsRemoveReferenceTxResult = MaterialRemoveReferenceResult;
export type MaterialsRetryReadTxResult = MaterialRetryReadResult;
export type MaterialsCreateContextTxResult = MaterialContextCreateResult;
export type MaterialsTxResult = MaterialsAddTxResult | MaterialAddVersionResult |
  MaterialRemoveReferenceResult | MaterialRetryReadResult | MaterialContextCreateResult |
  MaterialsListResult | MaterialContextsListResult;

/** All runtime helpers are local: file and legacy inline workers execute identical rules.
 * Bytes stay with main/cindy-media. These transactions authorize and persist references only.
 */
export function runMaterialsTransaction(db: Database.Database, raw: unknown): MaterialsTxResult {
  type RefRow = { id: string; project_id: string; work_item_id: string | null;
    binding_revision: number | null; material_id: string; version: number; status: 'active' | 'removed';
    created_by_kind: MaterialSubjectKind; created_by_id: string; created_at: number; updated_at: number };
  type VersionRow = { id: string; material_id: string; version: number; sha256: string;
    size_bytes: number; mime: string; storage_kind: MaterialStorageKind; read_state: MaterialReadState;
    failure_reason: string | null; created_at: number };
  type MaterialRow = { id: string; project_id: string; name: string;
    created_by_kind: MaterialSubjectKind; created_by_id: string; created_at: number };
  type ContextRow = { id: string; project_id: string | null; work_item_id: string;
    binding_revision: number | null; purpose: MaterialContext['purpose']; refs_json: string;
    created_by_kind: MaterialSubjectKind; created_by_id: string; created_at: number };
  const fail = (code: string, message = 'Material request rejected'): never => { throw new Error('[' + code + '] ' + message); };
  const record = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('INVALID_PARAMS');
    return v as Record<string, unknown>;
  };
  const text = (v: unknown, max = 200): string => {
    if (typeof v !== 'string' || !v.trim() || v.trim().length > max) return fail('INVALID_PARAMS');
    return v.trim();
  };
  const integer = (v: unknown, min: number): number => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) return fail('INVALID_PARAMS');
    return v;
  };
  const iso = (v: number) => new Date(v).toISOString();
  const toVersion = (v: VersionRow): MaterialVersion => ({ id: v.id, materialId: v.material_id,
    version: v.version, sha256: v.sha256, sizeBytes: v.size_bytes, mime: v.mime,
    storageKind: v.storage_kind, readState: v.read_state, failureReason: v.failure_reason, createdAt: iso(v.created_at) });
  const toReference = (r: RefRow): MaterialReference => ({ id: r.id, projectId: r.project_id,
    workItemId: r.work_item_id, bindingRevision: r.binding_revision, materialId: r.material_id,
    version: r.version, status: r.status, createdByKind: r.created_by_kind,
    createdById: r.created_by_id, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });
  const getMaterial = (id: string): MaterialRow =>
    db.prepare('SELECT * FROM materials WHERE id=?').get(id) as MaterialRow | undefined ?? fail('MATERIAL_NOT_FOUND');
  const getVersion = (id: string, version: number): VersionRow =>
    db.prepare('SELECT * FROM material_versions WHERE material_id=? AND version=?').get(id, version) as VersionRow | undefined ?? fail('VERSION_NOT_FOUND');
  const parseFile = (v: unknown): MaterialVersionInput => {
    const b = record(v);
    if (typeof b.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.sha256)) return fail('INVALID_PARAMS');
    if (b.storageKind !== 'media' && b.storageKind !== 'file') return fail('INVALID_PARAMS');
    if (b.sameNameAction !== undefined && b.sameNameAction !== 'create-new') return fail('INVALID_PARAMS');
    if (b.reuseOnly !== undefined && typeof b.reuseOnly !== 'boolean') return fail('INVALID_PARAMS');
    if (b.storageKind === 'file' && (typeof b.sourceMtime !== 'number' || !Number.isSafeInteger(b.sourceMtime))) return fail('INVALID_PARAMS');
    return { referenceId: text(b.referenceId, 400), versionId: text(b.versionId), materialId: text(b.materialId),
      name: text(b.name, 260), sha256: b.sha256, sizeBytes: integer(b.sizeBytes, 0), mime: text(b.mime),
      storageKind: b.storageKind, storageRef: text(b.storageRef, 4096),
      sourceMtime: b.storageKind === 'file' ? b.sourceMtime as number : null,
      sameNameAction: b.sameNameAction as 'create-new' | undefined, reuseOnly: b.reuseOnly as boolean | undefined };
  };
  return db.transaction((): MaterialsTxResult => {
    const args = record(raw);
    const actor = record(args.actor);
    if (actor.kind !== 'account' && actor.kind !== 'bot') return fail('INVALID_PARAMS');
    const kind = actor.kind;
    const actorId = text(actor.id);
    const action = args.action;
    const projectAccess = (projectId: string) => {
      const r = db.prepare("SELECT p.status FROM projects p JOIN project_members m ON m.project_id=p.id WHERE p.id=? AND m.subject_kind=? AND m.subject_id=? AND m.role IN ('owner','member')")
        .get(projectId, kind, actorId) as { status: string } | undefined;
      return r ?? fail('FORBIDDEN');
    };
    const scope = (): MaterialScope => {
      if (!('projectId' in args) || !('workItemId' in args) || !('bindingRevision' in args)) return fail('REFERENCE_SCOPE_REQUIRED');
      const projectId = text(args.projectId);
      projectAccess(projectId);
      if (args.workItemId === null) {
        if (args.bindingRevision !== null) return fail('INVALID_PARAMS');
        return { projectId, workItemId: null, bindingRevision: null };
      }
      const workItemId = text(args.workItemId);
      const bindingRevision = integer(args.bindingRevision, 0);
      const task = db.prepare('SELECT project_id, status, project_binding_revision FROM sessions WHERE id=?')
        .get(workItemId) as { project_id: string | null; status: string; project_binding_revision: number } | undefined;
      if (!task || task.status === 'deleted') return fail('PRECONDITION_FAILED');
      if (task.project_id !== projectId) return fail('REFERENCE_MISMATCH');
      if (task.project_binding_revision !== bindingRevision) return fail('BINDING_CONFLICT');
      return { projectId, workItemId, bindingRevision };
    };
    const reference = (s: MaterialScope, value: unknown, active = true): RefRow => {
      if (value === undefined) return fail('REFERENCE_SCOPE_REQUIRED');
      const r = db.prepare('SELECT * FROM material_references WHERE id=?').get(text(value, 400)) as RefRow | undefined;
      if (!r) return fail('REFERENCE_NOT_FOUND');
      if (r.project_id !== s.projectId || r.work_item_id !== s.workItemId || r.binding_revision !== s.bindingRevision) return fail('REFERENCE_MISMATCH');
      if (getMaterial(r.material_id).project_id !== s.projectId) return fail('REFERENCE_MISMATCH');
      if (active && r.status !== 'active') return fail('PRECONDITION_FAILED');
      return r;
    };
    const now = () => {
      const t = integer(args.now, 0);
      if (t > 8_640_000_000_000_000) return fail('INVALID_PARAMS');
      return t;
    };
    const upsertReference = (s: MaterialScope, materialId: string, version: number, id: string, time: number): MaterialReference => {
      const material = getMaterial(materialId);
      if (material.project_id !== s.projectId) return fail('REFERENCE_MISMATCH');
      getVersion(materialId, version);
      const old = db.prepare('SELECT * FROM material_references WHERE project_id=? AND work_item_id IS ? AND binding_revision IS ? AND material_id=?')
        .get(s.projectId, s.workItemId, s.bindingRevision, materialId) as RefRow | undefined;
      if (old) {
        if (old.status !== 'active' || old.version !== version) {
          db.prepare("UPDATE material_references SET version=?,status='active',updated_at=? WHERE id=?").run(version, time, old.id);
        }
      } else {
        db.prepare("INSERT INTO material_references (id,project_id,work_item_id,binding_revision,material_id,version,status,created_by_kind,created_by_id,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',?,?,?,?)")
          .run(id, s.projectId, s.workItemId, s.bindingRevision, materialId, version, kind, actorId, time, time);
      }
      return toReference(db.prepare('SELECT * FROM material_references WHERE id=?').get(old?.id ?? id) as RefRow);
    };
    const insertVersion = (f: MaterialVersionInput, id: string, version: number, time: number) => {
      if (f.reuseOnly) return fail('MEDIA_WRITE_FAILED', 'New bytes have not been staged');
      db.prepare("INSERT INTO material_versions (id,material_id,version,sha256,size_bytes,mime,storage_kind,storage_ref,source_mtime,read_state,failure_reason,created_by_kind,created_by_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,'ready',NULL,?,?,?)")
        .run(f.versionId, id, version, f.sha256, f.sizeBytes, f.mime, f.storageKind, f.storageRef, f.sourceMtime, kind, actorId, time);
    };
    const contextRefs = (row: ContextRow): MaterialContextRef[] => {
      let parsed: unknown;
      try { parsed = JSON.parse(row.refs_json); } catch { return fail('CONTEXT_SCOPE_UNKNOWN'); }
      if (!Array.isArray(parsed)) return fail('CONTEXT_SCOPE_UNKNOWN');
      return parsed.map(v => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('CONTEXT_SCOPE_UNKNOWN');
        const b = v as Record<string, unknown>;
        const read = b.readStateAtPin;
        if (read !== 'ready' && read !== 'pending' && read !== 'failed') return fail('CONTEXT_SCOPE_UNKNOWN');
        try {
          return { materialId: text(b.materialId), version: integer(b.version, 1), readStateAtPin: read,
            ...(b.referenceId === undefined ? {} : { referenceId: text(b.referenceId, 400) }) };
        } catch { return fail('CONTEXT_SCOPE_UNKNOWN'); }
      });
    };
    const contextProject = (row: ContextRow): string => {
      if (row.project_id !== null) return row.project_id;
      const refs = contextRefs(row);
      if (!refs.length) return fail('CONTEXT_SCOPE_UNKNOWN');
      const projects = new Set(refs.map(r => {
        const m = db.prepare('SELECT project_id FROM materials WHERE id=?').get(r.materialId) as { project_id: string } | undefined;
        return m?.project_id ?? fail('CONTEXT_SCOPE_UNKNOWN');
      }));
      if (projects.size !== 1) return fail('CONTEXT_SCOPE_UNKNOWN');
      return [...projects][0];
    };
    const toContext = (r: ContextRow): MaterialContext => ({ id: r.id, projectId: r.project_id,
      workItemId: r.work_item_id, bindingRevision: r.binding_revision, purpose: r.purpose,
      refs: contextRefs(r), createdByKind: r.created_by_kind, createdById: r.created_by_id, createdAt: iso(r.created_at) });
    const resolveVersion = (): VersionRow => {
      const materialId = text(args.materialId);
      const v = integer(args.version, 1);
      if (args.contextId !== undefined) {
        if (['projectId','workItemId','bindingRevision','referenceId'].some(k => args[k] !== undefined)) return fail('INVALID_PARAMS');
        const c = db.prepare('SELECT * FROM material_contexts WHERE id=?').get(text(args.contextId)) as ContextRow | undefined;
        if (!c) return fail('REFERENCE_NOT_FOUND');
        const p = contextProject(c);
        projectAccess(p);
        if (!contextRefs(c).some(r => r.materialId === materialId && r.version === v)) return fail('REFERENCE_MISMATCH');
        if (getMaterial(materialId).project_id !== p) return fail('REFERENCE_MISMATCH');
      } else {
        const s = scope();
        const r = reference(s, args.referenceId);
        if (r.material_id !== materialId) return fail('REFERENCE_MISMATCH');
      }
      return getVersion(materialId, v);
    };

    if (action === 'list' || action === 'listContexts') {
      const history = args.history === true;
      if (args.history !== undefined && args.history !== false && !history) return fail('INVALID_PARAMS');
      let s: MaterialScope | undefined;
      let projectId: string;
      let workItemId: string | null;
      if (history) {
        if (args.bindingRevision !== undefined || !('workItemId' in args)) return fail('INVALID_PARAMS');
        projectId = text(args.projectId);
        projectAccess(projectId);
        workItemId = args.workItemId === null ? null : text(args.workItemId);
      } else { s = scope(); projectId = s.projectId; workItemId = s.workItemId; }
      if (action === 'listContexts') {
        if (workItemId === null) return fail('INVALID_PARAMS');
        const rows = (history
          ? db.prepare('SELECT * FROM material_contexts WHERE work_item_id=? ORDER BY created_at,id').all(workItemId)
          : db.prepare('SELECT * FROM material_contexts WHERE project_id=? AND work_item_id=? AND binding_revision=? ORDER BY created_at,id').all(projectId, workItemId, s!.bindingRevision)) as ContextRow[];
        const contexts = rows.filter(r => {
          if (!history) return true;
          try { return contextProject(r) === projectId; } catch (error) {
            if (error instanceof Error && error.message.startsWith('[CONTEXT_SCOPE_UNKNOWN]')) return false;
            throw error;
          }
        }).map(toContext);
        return history ? { referenceContract: 1, projectId, workItemId, history: true, contexts }
          : { referenceContract: 1, scope: s!, contexts };
      }
      const rows = (history
        ? db.prepare('SELECT * FROM material_references WHERE project_id=? AND work_item_id IS ? ORDER BY created_at,id').all(projectId, workItemId)
        : db.prepare("SELECT * FROM material_references WHERE project_id=? AND work_item_id IS ? AND binding_revision IS ? AND status='active' ORDER BY created_at,id").all(projectId, workItemId, s!.bindingRevision)) as RefRow[];
      const materials: Material[] = rows.map(r => {
        const m = getMaterial(r.material_id);
        if (m.project_id !== projectId) return fail('REFERENCE_MISMATCH');
        const versions = (db.prepare('SELECT * FROM material_versions WHERE material_id=? ORDER BY version').all(m.id) as VersionRow[]).map(toVersion);
        const selected = getVersion(m.id, r.version);
        return { id: m.id, projectId, workItemId: r.work_item_id, status: r.status, name: m.name,
          createdByKind: m.created_by_kind, createdById: m.created_by_id, createdAt: iso(m.created_at),
          updatedAt: iso(r.updated_at), currentVersion: r.version, latestVersion: versions.at(-1)!.version,
          readState: selected.read_state, versions, reference: toReference(r) };
      });
      return history ? { referenceContract: 1, projectId, workItemId, history: true, materials }
        : { referenceContract: 1, scope: s!, materials };
    }
    if (action === 'resolveVersion') return { version: toVersion(resolveVersion()), referenceContract: 1 };
    if (action === 'retryRead') {
      const old = resolveVersion();
      if (args.readState !== 'ready' && args.readState !== 'failed') return fail('INVALID_PARAMS');
      now();
      const reason = args.failureReason === null || args.failureReason === undefined ? null : text(args.failureReason, 500);
      db.prepare('UPDATE material_versions SET read_state=?,failure_reason=? WHERE material_id=? AND version=?')
        .run(args.readState, args.readState === 'failed' ? reason : null, old.material_id, old.version);
      return { version: toVersion(getVersion(old.material_id, old.version)), referenceContract: 1 };
    }
    if (!['add','addVersion','removeReference','createContext'].includes(String(action))) return fail('INVALID_PARAMS');
    const s = scope();
    const time = now();
    if (action === 'add') {
      if (projectAccess(s.projectId).status === 'archived') return fail('PRECONDITION_FAILED');
      const filesPresent = args.files !== undefined;
      const existingPresent = args.existing !== undefined;
      if (filesPresent === existingPresent) return fail('INVALID_PARAMS');
      const input = filesPresent ? args.files : args.existing;
      // 不做批次数量上限：长度/类型校验足够，业务不设限额。
      if (!Array.isArray(input) || !input.length) return fail('INVALID_PARAMS');
      const result: MaterialsAddTxResult = { referenceContract: 1, scope: s, added: [], duplicates: [], rejected: [], references: [] };
      if (existingPresent) {
        const entries = input.map(v => { const b = record(v); return { referenceId: text(b.referenceId, 400), materialId: text(b.materialId), version: integer(b.version, 1) }; });
        // Validate every target before any write: a cross-project batch is never partially applied.
        for (const e of entries) {
          if (getMaterial(e.materialId).project_id !== s.projectId) return fail('REFERENCE_MISMATCH');
          getVersion(e.materialId, e.version);
        }
        for (const e of entries) {
          const m = getMaterial(e.materialId);
          result.references.push(upsertReference(s, m.id, e.version, e.referenceId, time));
          result.duplicates.push({ name: m.name, materialId: m.id, version: e.version });
        }
      } else {
        const entries = input.map(parseFile);
        for (const f of entries) {
          const same = db.prepare("SELECT v.* FROM material_versions v JOIN materials m ON m.id=v.material_id WHERE m.project_id=? AND v.sha256=? AND v.read_state='ready' ORDER BY v.created_at DESC,v.version DESC,v.id LIMIT 1")
            .get(s.projectId, f.sha256) as VersionRow | undefined;
          const names = db.prepare('SELECT id FROM materials WHERE project_id=? AND name=? ORDER BY id').all(s.projectId, f.name) as { id: string }[];
          if (f.sameNameAction !== 'create-new' && (names.length > 1 || (names.length === 1 && names[0].id !== same?.material_id))) {
            result.rejected.push({ name: f.name, code: 'DUPLICATE_CONTENT', versionId: f.versionId }); continue;
          }
          if (same) {
            result.references.push(upsertReference(s, same.material_id, same.version, f.referenceId, time));
            result.duplicates.push({ name: f.name, materialId: same.material_id, version: same.version }); continue;
          }
          if (f.reuseOnly) { result.rejected.push({ name: f.name, code: 'MEDIA_WRITE_FAILED', versionId: f.versionId }); continue; }
          db.prepare("INSERT INTO materials (id,project_id,work_item_id,name,status,created_by_kind,created_by_id,created_at,updated_at) VALUES (?,?,?,?,'active',?,?,?,?)")
            .run(f.materialId, s.projectId, s.workItemId, f.name, kind, actorId, time, time);
          insertVersion(f, f.materialId, 1, time);
          result.added.push(toVersion(getVersion(f.materialId, 1)));
          result.references.push(upsertReference(s, f.materialId, 1, f.referenceId, time));
        }
      }
      return result;
    }
    if (action === 'removeReference') {
      const r = reference(s, args.referenceId, false);
      if (r.status !== 'removed') db.prepare("UPDATE material_references SET status='removed',updated_at=? WHERE id=?").run(time, r.id);
      return { ok: true, status: 'removed', reference: toReference(db.prepare('SELECT * FROM material_references WHERE id=?').get(r.id) as RefRow), scope: s, referenceContract: 1 };
    }
    if (action === 'addVersion') {
      const r = reference(s, args.referenceId);
      if (r.material_id !== text(args.materialId)) return fail('REFERENCE_MISMATCH');
      const f = parseFile(args.file);
      const latest = db.prepare('SELECT * FROM material_versions WHERE material_id=? ORDER BY version DESC LIMIT 1').get(r.material_id) as VersionRow;
      if (latest.sha256 === f.sha256 && args.replaceCurrentReference !== true) return fail('DUPLICATE_CONTENT');
      const next = latest.version + 1;
      insertVersion(f, r.material_id, next, time);
      return { version: toVersion(getVersion(r.material_id, next)), reference: upsertReference(s, r.material_id, next, r.id, time), scope: s, referenceContract: 1 };
    }
    if (s.workItemId === null) return fail('INVALID_PARAMS');
    if (!['reference','redecompose','recheck'].includes(String(args.purpose))) return fail('INVALID_PARAMS');
    const input = args.refs;
    // 快照引用数不设上限（不做限额）；每条引用仍逐条过身份与作用域判定。
    if (!Array.isArray(input)) return fail('INVALID_PARAMS');
    const refs: MaterialContextRef[] = input.map(v => {
      const b = record(v);
      const r = reference(s, b.referenceId);
      if (r.material_id !== text(b.materialId)) return fail('REFERENCE_MISMATCH');
      const selected = getVersion(r.material_id, integer(b.version, 1));
      return { referenceId: r.id, materialId: r.material_id, version: selected.version, readStateAtPin: selected.read_state };
    });
    const id = text(args.newId);
    db.prepare('INSERT INTO material_contexts (id,project_id,work_item_id,binding_revision,purpose,refs_json,created_by_kind,created_by_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, s.projectId, s.workItemId, s.bindingRevision, args.purpose, JSON.stringify(refs), kind, actorId, time);
    return { context: toContext(db.prepare('SELECT * FROM material_contexts WHERE id=?').get(id) as ContextRow), referenceContract: 1 };
  }).immediate();
}
