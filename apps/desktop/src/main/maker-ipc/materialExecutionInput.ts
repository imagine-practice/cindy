import { createHash } from 'node:crypto';
import type { DbClient } from '../localDb/client/DbClient';
import type { MaterialContext, MaterialContextPurpose, MaterialContextsListResult, MaterialVersion } from '../../shared/materials';
import { MATERIAL_CONTEXT_PURPOSES } from '../../shared/materials';
import type { AgentInputSerializedFile } from '../../shared/agentInputQueue';
import { openBlobFile } from '../cindy-media/blobStore';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime';
import { readVerifiedMaterialText, type PrivateMaterialVersion } from '../localDb/ipc/materialReferenceIo';
import { readBoundedFileNoFollow } from '../utils/readBoundedFile';

/** Main-only contract. Renderer supplies only these selectors, never refs/actor/paths. */
export interface MaterialExecutionRequest {
  contextId: string;
  projectId: string;
  workItemId: string;
  bindingRevision: number;
  purpose: MaterialContextPurpose;
}
export interface MaterialExecutionHost {
  /** Captured together by the trusted main caller; never resolved from raw input. */
  client: DbClient;
  actor: { kind: 'account' | 'bot'; id: string };
  /** Must check account/owner generation, DB client epoch and source authority. */
  assertCurrent(): void;
}
export type MaterialPreparationCode =
  | 'INVALID_PARAMS' | 'PRECONDITION_FAILED' | 'FORBIDDEN' | 'REFERENCE_NOT_FOUND'
  | 'REFERENCE_MISMATCH' | 'BINDING_CONFLICT' | 'CONTEXT_SCOPE_UNKNOWN'
  | 'PURPOSE_MISMATCH' | 'SNAPSHOT_CHANGED' | 'VERSION_NOT_FOUND' | 'VERSION_CHANGED'
  | 'VERSION_NOT_READABLE' | 'SOURCE_MISSING' | 'SOURCE_CHANGED' | 'UNSUPPORTED_CONTENT' | 'INTERNAL';
interface Selection {
  referenceId: string;
  materialId: string;
  version: number;
  versionId: string;
  expectedSha256: string;
}
export type PreparedMaterialItem = Selection & (
  | { status: 'prepared'; verifiedSha256: string; content: { kind: 'text'; text: string } | { kind: 'attachment'; file: AgentInputSerializedFile } }
  | { status: 'unsupported' | 'failed'; code: MaterialPreparationCode }
);
export type MaterialExecutionResult =
  | { ok: false; code: MaterialPreparationCode; modelDispatch: 'not-dispatched' }
  | {
      ok: true; request: MaterialExecutionRequest; context: MaterialContext;
      preparationKey: string; readiness: 'ready' | 'partial' | 'not-prepared';
      items: PreparedMaterialItem[]; modelDispatch: 'not-dispatched';
      /** Live main-only lease, not a serialized permission token or dispatch receipt. */
      revalidate(): Promise<void>;
    };
class PreparationError extends Error {
  constructor(readonly code: MaterialPreparationCode) { super('Material execution input unavailable'); }
}
const fail = (code: MaterialPreparationCode): never => { throw new PreparationError(code); };
function parse(raw: unknown): MaterialExecutionRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('INVALID_PARAMS');
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some(key => !['contextId', 'projectId', 'workItemId', 'bindingRevision', 'purpose'].includes(key))) return fail('INVALID_PARAMS');
  const id = (value: unknown): string => typeof value === 'string' && value.trim() && value.length <= 200 ? value : fail('INVALID_PARAMS');
  if (typeof body.bindingRevision !== 'number' || !Number.isSafeInteger(body.bindingRevision) || body.bindingRevision < 0) return fail('INVALID_PARAMS');
  const purpose = MATERIAL_CONTEXT_PURPOSES.find(value => value === body.purpose);
  if (!purpose) return fail('INVALID_PARAMS');
  return { contextId: id(body.contextId), projectId: id(body.projectId), workItemId: id(body.workItemId), bindingRevision: body.bindingRevision, purpose };
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const IMAGE_EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

/** Read and hash the SAME retained bytes. No URL/path is returned for later reopen.
 * No new media write, ingest, pin, model call or document parser is introduced here.
 */
async function readImage(row: PrivateMaterialVersion): Promise<Buffer | 'SOURCE_MISSING' | 'SOURCE_CHANGED'> {
  try {
    let bytes: Buffer | null;
    if (row.storageKind === 'media') {
      const opened = await openBlobFile(row.storageRef);
      try {
        if (opened.totalSize !== row.sizeBytes) return 'SOURCE_CHANGED';
        bytes = Buffer.alloc(row.sizeBytes + 1);
        let position = 0;
        while (position < bytes.length) {
          const read = await opened.file.read(bytes, position, bytes.length - position, position);
          if (!read.bytesRead) break;
          position += read.bytesRead;
        }
        bytes = bytes.subarray(0, position);
      } finally { await opened.file.close(); }
    } else {
      bytes = await readBoundedFileNoFollow(row.storageRef, row.sizeBytes, { nonBlocking: true });
    }
    if (!bytes || bytes.length !== row.sizeBytes || digest(bytes) !== row.sha256 || sniffMediaMime(bytes) !== row.mime) return 'SOURCE_CHANGED';
    return bytes;
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' ? 'SOURCE_MISSING' : 'SOURCE_CHANGED';
  }
}

/** Preparation is not dispatch and does not mark a context used. All attachment
 * contents stay user data; this helper constructs no system/host-origin message.
 */
export async function prepareMaterialExecutionInput(raw: unknown, host: MaterialExecutionHost): Promise<MaterialExecutionResult> {
  try {
    const request = parse(raw);
    const client = host.client;
    const actor = { ...host.actor };
    if (!actor || !['account', 'bot'].includes(actor.kind) || typeof actor.id !== 'string' || !actor.id.trim()) return fail('FORBIDDEN');
    const assertCurrent = () => {
      host.assertCurrent();
      if (host.client !== client || host.actor.kind !== actor.kind || host.actor.id !== actor.id) fail('PRECONDITION_FAILED');
    };
    const scope = { projectId: request.projectId, workItemId: request.workItemId, bindingRevision: request.bindingRevision };
    const execute = async <T>(input: Record<string, unknown>): Promise<T> => {
      assertCurrent();
      const result = await client.tx<T>('materials.execute', { ...input, actor });
      assertCurrent();
      if (!result || typeof result !== 'object' || !('referenceContract' in result) || result.referenceContract !== 1) return fail('PRECONDITION_FAILED');
      return result;
    };
    // Frozen R2 current-scope entry verifies kind+id membership, current target and
    // binding. Historical contexts are deliberately not a fallback for execution.
    const currentContext = async () => {
      const result = await execute<MaterialContextsListResult>({ action: 'listContexts', ...scope });
      const context = result.contexts.find(value => value.id === request.contextId);
      if (!context) return fail('REFERENCE_NOT_FOUND');
      if (context.projectId !== request.projectId || context.workItemId !== request.workItemId || context.bindingRevision !== request.bindingRevision) return fail('REFERENCE_MISMATCH');
      if (context.purpose !== request.purpose) return fail('PURPOSE_MISMATCH');
      if (context.refs.some(ref => !ref.referenceId)) return fail('CONTEXT_SCOPE_UNKNOWN');
      return context;
    };
    const context = await currentContext();
    const snapshot = JSON.stringify(context);
    const readBoundary = async () => {
      assertCurrent();
      // One SQLite statement is the final authorization/read boundary. In
      // particular, listContexts alone says nothing about active references.
      // All subqueries below see the SAME snapshot, including every earlier
      // item, the exact pinned versions, context, task epoch and membership.
      const state = await client.queryOne<{
        sessionProjectId: string | null; sessionStatus: string | null; sessionEpoch: number | null;
        contextId: string | null; contextProjectId: string | null; contextTaskId: string | null;
        contextEpoch: number | null; purpose: string | null; refsJson: string | null;
        creatorKind: string | null; creatorId: string | null; createdAt: number | null;
        versionsJson: string;
      }>(`/* material-execution-final-snapshot */
        SELECT s.project_id AS sessionProjectId,s.status AS sessionStatus,s.project_binding_revision AS sessionEpoch,
          c.id AS contextId,c.project_id AS contextProjectId,c.work_item_id AS contextTaskId,
          c.binding_revision AS contextEpoch,c.purpose,c.refs_json AS refsJson,
          c.created_by_kind AS creatorKind,c.created_by_id AS creatorId,c.created_at AS createdAt,
          (SELECT json_group_array(json_object(
            'ordinal',CAST(j.key AS INTEGER),'referenceId',r.id,'projectId',r.project_id,
            'workItemId',r.work_item_id,'bindingRevision',r.binding_revision,'referenceStatus',r.status,
            'materialId',r.material_id,'materialProjectId',m.project_id,'name',m.name,
            'versionId',v.id,'version',v.version,'sha256',v.sha256,'sizeBytes',v.size_bytes,
            'mime',v.mime,'storageKind',v.storage_kind,'storageRef',v.storage_ref,'sourceMtime',v.source_mtime,
            'readState',v.read_state,'failureReason',v.failure_reason,
            'versionCreatorKind',v.created_by_kind,'versionCreatorId',v.created_by_id,'versionCreatedAt',v.created_at))
            FROM json_each(CASE WHEN json_valid(c.refs_json) THEN c.refs_json ELSE '[]' END) j
            LEFT JOIN material_references r ON r.id=json_extract(j.value,'$.referenceId')
            LEFT JOIN materials m ON m.id=json_extract(j.value,'$.materialId') AND m.project_id=p.id
            LEFT JOIN material_versions v ON v.material_id=m.id AND v.version=json_extract(j.value,'$.version')
          ) AS versionsJson
        FROM projects p JOIN project_members grant_member ON grant_member.project_id=p.id
        LEFT JOIN sessions s ON s.id=?
        LEFT JOIN material_contexts c ON c.id=? AND c.project_id=p.id
        WHERE p.id=? AND grant_member.subject_kind=? AND grant_member.subject_id=?
          AND grant_member.role IN ('owner','member')`,
      [request.workItemId, request.contextId, request.projectId, actor.kind, actor.id]);
      assertCurrent();
      if (!state) return fail('FORBIDDEN');
      if (!state.sessionStatus || state.sessionStatus === 'deleted') return fail('PRECONDITION_FAILED');
      if (state.sessionProjectId !== request.projectId) return fail('REFERENCE_MISMATCH');
      if (state.sessionEpoch !== request.bindingRevision) return fail('BINDING_CONFLICT');
      if (state.contextId !== context.id || state.contextProjectId !== context.projectId || state.contextTaskId !== context.workItemId ||
        state.contextEpoch !== context.bindingRevision || state.purpose !== context.purpose || state.creatorKind !== context.createdByKind ||
        state.creatorId !== context.createdById || state.createdAt === null || new Date(state.createdAt).toISOString() !== context.createdAt) return fail('SNAPSHOT_CHANGED');
      type BoundaryRef = { referenceId: string; materialId: string; version: number; readStateAtPin: string };
      const normalizeRef = (ref: BoundaryRef) => ({ referenceId: ref.referenceId, materialId: ref.materialId, version: ref.version, readStateAtPin: ref.readStateAtPin });
      const refs = JSON.parse(state.refsJson ?? 'null') as BoundaryRef[] | null;
      if (!Array.isArray(refs) || JSON.stringify(refs.map(normalizeRef)) !== JSON.stringify(context.refs.map(ref => normalizeRef({ ...ref, referenceId: ref.referenceId! })))) return fail('SNAPSHOT_CHANGED');
      const versions = JSON.parse(state.versionsJson) as Array<{
        ordinal: number; referenceId: string | null; projectId: string | null; workItemId: string | null;
        bindingRevision: number | null; referenceStatus: string | null; materialId: string | null;
        materialProjectId: string | null; versionId: string | null; version: number | null;
        name: string; sha256: string; sizeBytes: number; mime: string;
        storageKind: PrivateMaterialVersion['storageKind']; storageRef: string;
        readState: MaterialVersion['readState']; failureReason: string | null; versionCreatedAt: number;
      }>;
      versions.sort((a, b) => a.ordinal - b.ordinal);
      if (versions.length !== context.refs.length) return fail('SNAPSHOT_CHANGED');
      for (const [index, value] of versions.entries()) {
        const ref = context.refs[index];
        if (value.ordinal !== index) return fail('SNAPSHOT_CHANGED');
        if (!value.referenceId) return fail('REFERENCE_NOT_FOUND');
        if (value.referenceId !== ref.referenceId || value.projectId !== request.projectId || value.workItemId !== request.workItemId ||
          value.bindingRevision !== request.bindingRevision || value.materialId !== ref.materialId || value.materialProjectId !== request.projectId) return fail('REFERENCE_MISMATCH');
        if (value.referenceStatus !== 'active') return fail('PRECONDITION_FAILED');
        if (!value.versionId) return fail('VERSION_NOT_FOUND');
        if (value.version !== ref.version) return fail('VERSION_CHANGED');
      }
      // Actual version projections (including readState/private locator) stay
      // main-only. Compare them to the selection that produced the bytes, NOT
      // merely to the first SQL snapshot (which could hide an ABA state change).
      return { refsJson: state.refsJson, versions };
    };
    const boundary = await readBoundary();
    const loadVersion = async (materialId: string, version: number) => {
      const ref = context.refs.find(value => value.materialId === materialId && value.version === version);
      if (!ref?.referenceId) return fail('CONTEXT_SCOPE_UNKNOWN');
      // A removed reference remains viewable through history but is not revived
      // as a new execution input. Its selected snapshot version may still be v1
      // while the active reference now selects v2; R2 resolves the explicit v1.
      await execute({ action: 'resolveVersion', ...scope, referenceId: ref.referenceId, materialId, version });
      const locator = { action: 'resolveVersion', contextId: context.id, materialId, version };
      const before = await execute<{ referenceContract: 1; version: MaterialVersion }>(locator);
      // The exact authorized version only. Never walk a catalogue or use MAX(version).
      const row = await client.queryOne<PrivateMaterialVersion>(`SELECT v.id,v.material_id AS materialId,v.version,m.name,v.mime,
        v.size_bytes AS sizeBytes,v.storage_kind AS storageKind,v.storage_ref AS storageRef,v.sha256
        FROM material_versions v JOIN materials m ON m.id=v.material_id WHERE v.material_id=? AND v.version=?`, [materialId, version]);
      assertCurrent();
      const after = await execute<{ referenceContract: 1; version: MaterialVersion }>(locator);
      if (!row) return fail('VERSION_NOT_FOUND');
      if (JSON.stringify(before.version) !== JSON.stringify(after.version) || row.id !== after.version.id || row.materialId !== materialId || row.version !== version ||
        row.sha256 !== after.version.sha256 || row.mime !== after.version.mime || row.sizeBytes !== after.version.sizeBytes || row.storageKind !== after.version.storageKind) return fail('VERSION_CHANGED');
      return { row, version: after.version };
    };
    const selected: Array<Awaited<ReturnType<typeof loadVersion>>> = [];
    const items: PreparedMaterialItem[] = [];
    for (const ref of context.refs) {
      const loaded = await loadVersion(ref.materialId, ref.version);
      selected.push(loaded);
      const { row, version } = loaded;
      const selection: Selection = { referenceId: ref.referenceId!, materialId: ref.materialId, version: ref.version, versionId: row.id, expectedSha256: row.sha256 };
      if (version.readState !== 'ready') { items.push({ ...selection, status: 'failed', code: 'VERSION_NOT_READABLE' }); continue; }
      if (row.storageKind === 'file' && row.mime.startsWith('text/')) {
        const read = await readVerifiedMaterialText(row);
        assertCurrent();
        items.push(read.ok ? { ...selection, status: 'prepared', verifiedSha256: row.sha256, content: { kind: 'text', text: read.text } }
          : { ...selection, status: read.reason === 'unsupported' ? 'unsupported' : 'failed', code: read.reason === 'unsupported' ? 'UNSUPPORTED_CONTENT' : read.reason });
      } else if (IMAGE_EXT[row.mime]) {
        const bytes = await readImage(row);
        assertCurrent();
        items.push(typeof bytes === 'string' ? { ...selection, status: 'failed', code: bytes } : {
          ...selection, status: 'prepared', verifiedSha256: digest(bytes), content: { kind: 'attachment', file: {
            id: digest(`${context.id}:${row.id}`), name: row.name, path: '', ext: IMAGE_EXT[row.mime], size: bytes.length,
            category: 'image', mimeType: row.mime, base64: bytes.toString('base64'),
          } },
        });
      } else {
        // Existing PDF/Office/file blocks carry mutable filesystem paths. Without
        // a parser or immutable durable handoff this slice cannot promise body bytes.
        items.push({ ...selection, status: 'unsupported', code: 'UNSUPPORTED_CONTENT' });
      }
    }
    const revalidate = async () => {
      if (JSON.stringify(await currentContext()) !== snapshot) return fail('SNAPSHOT_CHANGED');
      for (const original of selected) {
        const latest = await loadVersion(original.row.materialId, original.row.version);
        if (JSON.stringify(latest) !== JSON.stringify(original)) return fail('VERSION_CHANGED');
      }
      const finalBoundary = await readBoundary();
      if (finalBoundary.refsJson !== boundary.refsJson) return fail('SNAPSHOT_CHANGED');
      for (const [index, value] of finalBoundary.versions.entries()) {
        const { row, version } = selected[index];
        if (value.versionId !== row.id || value.materialId !== row.materialId || value.version !== row.version ||
          value.name !== row.name || value.sha256 !== row.sha256 || value.sizeBytes !== row.sizeBytes || value.mime !== row.mime ||
          value.storageKind !== row.storageKind || value.storageRef !== row.storageRef || value.readState !== version.readState ||
          value.failureReason !== version.failureReason || value.versionCreatedAt !== new Date(version.createdAt).getTime()) return fail('VERSION_CHANGED');
      }
      assertCurrent();
    };
    await revalidate();
    assertCurrent();
    const prepared = items.filter(item => item.status === 'prepared').length;
    return { ok: true, request, context, preparationKey: digest(JSON.stringify({ request, snapshot, selections: items.map(({ referenceId, materialId, version, versionId, expectedSha256, status }) => ({ referenceId, materialId, version, versionId, expectedSha256, status })) })),
      readiness: prepared === 0 ? 'not-prepared' : prepared === items.length ? 'ready' : 'partial', items, modelDispatch: 'not-dispatched', revalidate };
  } catch (error) {
    const code = error instanceof PreparationError ? error.code : error instanceof Error ? /^\[([A-Z_]+)\]/.exec(error.message)?.[1] : undefined;
    const known: readonly string[] = ['INVALID_PARAMS', 'PRECONDITION_FAILED', 'FORBIDDEN', 'REFERENCE_NOT_FOUND', 'REFERENCE_MISMATCH', 'BINDING_CONFLICT', 'CONTEXT_SCOPE_UNKNOWN', 'VERSION_NOT_FOUND', 'VERSION_NOT_READABLE'];
    return { ok: false, code: error instanceof PreparationError ? error.code : known.includes(code ?? '') ? code as MaterialPreparationCode : 'INTERNAL', modelDispatch: 'not-dispatched' };
  }
}
