/** R2: public material-reference IPC -> trusted R1 transactions + main-only byte work. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import {
  MATERIALS_LIST_CHANNEL, MATERIALS_ADD_CHANNEL, MATERIALS_ADD_VERSION_CHANNEL, MATERIALS_RECORD_SOURCE_CHANNEL,
  MATERIALS_REMOVE_REFERENCE_CHANNEL, MATERIALS_RETRY_READ_CHANNEL, MATERIALS_PREVIEW_CHANNEL,
  MATERIAL_CONTEXTS_CREATE_CHANNEL, MATERIAL_CONTEXTS_LIST_CHANNEL,
  MATERIAL_NAME_MAX_LENGTH,
  isMaterialContextPurpose,
  type MaterialScope, type MaterialHistoryParams, type MaterialFileInput, type MaterialPreviewParams,
  type MaterialsListResult, type MaterialsAddResult, type MaterialAddVersionResult,
  type MaterialRemoveReferenceResult, type MaterialRetryReadResult, type MaterialPreview,
  type MaterialRecordSourceResult,
  type MaterialContextCreateResult, type MaterialContextsListResult, type MaterialVersion,
  type MaterialRejection, type MaterialReference,
} from '../../../shared/materials';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../../device-link/broadcast-tap';import { ingestMedia } from '../../cindy-media/ingest';
import { probeMaterialSource } from '../../cindy-media/materialSource';
import { captureMediaRefCompensationScope } from '../../cindy-media/refCompensationJournal';
import { isLocalFilePreviewPathSupported } from '../../localFileProtocol';
import { issueMaterialPreview } from '../../materialPreviewAccess';
import { MATERIAL_PREVIEW_MAX_BYTES, readMaterialPreviewBytes } from './materialReferenceIo';
import { throwIpcError } from '../../utils/ipcValidate';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer';
import { getDbClient, getCurrentDbClientSnapshot } from '../client/current';
import type { DbClient } from '../client/DbClient';
import { resolveProjectActor, type ProjectAccessActor } from './projects';
import type { MaterialVersionInput, MaterialsAddTxResult, MaterialsTxRequest } from '../worker/opHandlers/materialsTx';
import { checkMaterialBytes, readVerifiedMaterialText, type PrivateMaterialVersion } from './materialReferenceIo';
import { cleanupMaterialStaging, isDefiniteMaterialRejection, type MaterialStagedRefs, type MaterialCommitState } from './materialReferenceStage';
import { MATERIAL_DISPATCH_STATUS_CHANNEL, type MaterialDispatchStatusItem, type MaterialDispatchStatusList } from '../../../shared/materialDispatch';
import { createMaterialDispatchQueue } from '../materialDispatchQueue';

const own = (body: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(body, key);
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throwIpcError('INVALID_PARAMS', 'Expected an object');
  return raw as Record<string, unknown>;
}
function text(raw: unknown, max = 200): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > max) throwIpcError('INVALID_PARAMS', 'Invalid identifier or text');
  return raw.trim();
}
function integer(raw: unknown, min = 0): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min) throwIpcError('INVALID_PARAMS', 'Invalid integer');
  return raw;
}
function scope(body: Record<string, unknown>): MaterialScope {
  if (!['projectId','workItemId','bindingRevision'].every(k => own(body,k))) throwIpcError('REFERENCE_SCOPE_REQUIRED', 'Explicit material scope is required');
  const projectId = text(body.projectId);
  if (body.workItemId === null) {
    if (body.bindingRevision !== null) throwIpcError('INVALID_PARAMS', 'Project scope has no binding revision');
    return { projectId, workItemId: null, bindingRevision: null };
  }
  return { projectId, workItemId: text(body.workItemId), bindingRevision: integer(body.bindingRevision) };
}
function listParams(body: Record<string, unknown>): MaterialScope | MaterialHistoryParams {
  if (body.history === true) {
    if (!own(body,'workItemId') || own(body,'bindingRevision')) throwIpcError('INVALID_PARAMS', 'Invalid history scope');
    return { projectId: text(body.projectId), workItemId: body.workItemId === null ? null : text(body.workItemId), history: true };
  }
  if (body.history !== undefined && body.history !== false) throwIpcError('INVALID_PARAMS', 'Invalid history flag');
  return scope(body);
}
function fileInput(raw: unknown): MaterialFileInput {
  const b = object(raw), name = text(b.name, MATERIAL_NAME_MAX_LENGTH), filePath = text(b.path, 4096);
  if (!path.isAbsolute(filePath)) throwIpcError('INVALID_PARAMS', 'Material path must be absolute');
  if (b.sameNameAction !== undefined && b.sameNameAction !== 'create-new') throwIpcError('INVALID_PARAMS', 'Invalid same-name action');
  return { name, path: path.resolve(filePath), ...(b.sameNameAction === 'create-new' ? { sameNameAction: 'create-new' as const } : {}) };
}
function referenceId(body: Record<string, unknown>): string {
  if (!own(body,'referenceId')) throwIpcError('REFERENCE_SCOPE_REQUIRED', 'Reference identity is required');
  return text(body.referenceId, 400);
}
function locator(body: Record<string, unknown>): MaterialPreviewParams {
  const materialId = text(body.materialId), version = integer(body.version, 1);
  if (own(body,'contextId')) {
    if (['projectId','workItemId','bindingRevision','referenceId'].some(k => own(body,k))) throwIpcError('INVALID_PARAMS', 'Current and historical locators are exclusive');
    return { contextId: text(body.contextId), materialId, version };
  }
  return { ...scope(body), referenceId: referenceId(body), materialId, version };
}
const PRIVATE_VERSION_SQL = 'SELECT v.id,v.material_id AS materialId,v.version,m.name,v.mime,v.size_bytes AS sizeBytes,v.storage_kind AS storageKind,v.storage_ref AS storageRef,v.sha256 FROM material_versions v JOIN materials m ON m.id=v.material_id';

/** Capture before the first await; raw actor/now/internal ids never enter this envelope. */
function requestContext(accessActor: ProjectAccessActor, client: DbClient) {
  const owner = captureDataOwnerBroadcastScope();
  const db = client.drizzle;
  const subject = resolveProjectActor(accessActor, client);
  if (!subject || (subject.kind !== 'account' && subject.kind !== 'bot')) throwIpcError('PRECONDITION_FAILED', 'No trusted material actor');
  const actor = { kind: subject.kind, id: text(subject.id) };
  const assertStable = () => {
    if (!isDataOwnerBroadcastScopeCurrent(owner) || client.drizzle !== db) throwIpcError('PRECONDITION_FAILED', 'Material request owner or database changed');
  };
  async function execute<T>(input: Record<string, unknown>, changed?: (s: MaterialCommitState) => void): Promise<T> {
    assertStable();
    changed?.('unknown');
    let result: unknown;
    try {
      result = await client.tx('materials.execute', { ...input, actor, now: Date.now() } as MaterialsTxRequest);
      changed?.('acknowledged');
    } catch (error) {
      changed?.(isDefiniteMaterialRejection(error) ? 'rejected' : 'unknown');
      throw error;
    }
    assertStable();
    if (!result || typeof result !== 'object' || (result as { referenceContract?: unknown }).referenceContract !== 1) {
      throwIpcError('PRECONDITION_FAILED', 'Material reference protocol is unavailable');
    }
    return result as T;
  }
  const guard = (s: MaterialScope | MaterialHistoryParams) => execute<MaterialsListResult>({ action: 'list', ...s });
  const resolve = (v: MaterialPreviewParams) => execute<{ referenceContract: 1; version: MaterialVersion }>({ action: 'resolveVersion', ...v });
  async function queryOne<T>(sql: string, args: unknown[]): Promise<T | undefined> {
    assertStable(); const row = await client.queryOne<T>(sql,args); assertStable(); return row;
  }
  async function privateVersion(v: MaterialPreviewParams): Promise<PrivateMaterialVersion> {
    const before = await resolve(v);
    const row = await queryOne<PrivateMaterialVersion>(PRIVATE_VERSION_SQL+' WHERE v.material_id=? AND v.version=?', [v.materialId,v.version]);
    const after = await resolve(v);
    if (!row) throwIpcError('VERSION_NOT_FOUND', 'Material version is missing');
    if (row.id !== before.version.id || row.id !== after.version.id || row.sha256 !== after.version.sha256 || row.mime !== after.version.mime || row.sizeBytes !== after.version.sizeBytes || row.storageKind !== after.version.storageKind) {
      throwIpcError('VERSION_NOT_READABLE', 'Material version metadata changed');
    }
    return row;
  }
  return { owner, db, actor, assertStable, execute, guard, resolve, queryOne, privateVersion, client };
}
type RequestContext = ReturnType<typeof requestContext>;
async function selectedLocator(ctx: RequestContext, s: MaterialScope, id: string, materialId: string): Promise<MaterialPreviewParams> {
  await ctx.guard(s);
  const row = await ctx.queryOne<{ version: number }>('SELECT version FROM material_references WHERE id=?', [id]);
  await ctx.guard(s);
  if (!row) throwIpcError('REFERENCE_NOT_FOUND', 'Material reference is missing');
  const result = { ...s, referenceId: id, materialId, version: row.version };
  await ctx.resolve(result);
  return result;
}
function bytesFailure(reason: string): never {
  if (reason === 'SOURCE_CHANGED' || reason === 'SOURCE_MISSING') throwIpcError(reason, 'Original material source is not the recorded version');
  throwIpcError('VERSION_NOT_READABLE', 'Material bytes are unreadable');
}

export async function listMaterials(raw: unknown, actor?: ProjectAccessActor, client: DbClient = getDbClient()): Promise<MaterialsListResult> {
  const params = listParams(object(raw)), ctx = requestContext(actor,client);
  const result = await ctx.guard(params);
  await ctx.guard(params); // Re-read membership/epoch before handing out even cached-looking metadata.
  return result;
}

async function stageFile(ctx: RequestContext, file: MaterialFileInput,
  probe: Extract<Awaited<ReturnType<typeof probeMaterialSource>>, { ok: true }>,
  staged: MaterialStagedRefs[], s: MaterialScope,
): Promise<MaterialVersionInput> {
  const ids = { referenceId: randomUUID(), versionId: randomUUID(), materialId: randomUUID() };
  let storageRef = file.path;
  if (probe.storageKind === 'media') {
    const compensation = captureMediaRefCompensationScope(ctx.owner.ownerScopeKey);
    const stored = await ingestMedia({ filePath: file.path, mimeType: probe.mime, isCache: false,
      refs: [{ refKind: 'material', refId: ids.versionId, originKind: 'user' }],
      assertStillValid: ctx.assertStable, refCompensationScope: compensation }, ctx.db);
    staged.push({ versionId: ids.versionId, refIds: [...stored.refIds] });
    await ctx.guard(s);
    if (stored.hash !== probe.sha256 || stored.bytes !== probe.sizeBytes || stored.mimeType !== probe.mime) bytesFailure('SOURCE_CHANGED');
    storageRef = stored.url;
  }
  return { ...ids, name: file.name, ...(file.sameNameAction ? { sameNameAction: file.sameNameAction } : {}),
    sha256: probe.sha256, sizeBytes: probe.sizeBytes, mime: probe.mime, storageKind: probe.storageKind,
    sourceMtime: probe.sourceMtime, storageRef };
}

async function verifyAcceptedReferences(ctx: RequestContext, s: MaterialScope, references: MaterialReference[]): Promise<void> {
  for (const r of references) {
    const loc = { ...s,referenceId:r.id,materialId:r.materialId,version:r.version };
    const row = await ctx.privateVersion(loc), check = await checkMaterialBytes(row);
    await ctx.resolve(loc);
    if (!check.ok) bytesFailure(check.reason);
  }
  await ctx.guard(s);
}

export async function addMaterials(raw: unknown, actor?: ProjectAccessActor, client: DbClient = getDbClient()): Promise<MaterialsAddResult> {
  const b = object(raw), s = scope(b), ctx = requestContext(actor,client);
  const hasFiles = own(b,'files'), hasExisting = own(b,'existing');
  if (hasFiles === hasExisting) throwIpcError('INVALID_PARAMS', 'Choose files or existing versions');
  const array = hasFiles ? b.files : b.existing;
  if (!Array.isArray(array) || !array.length) throwIpcError('INVALID_PARAMS', 'Invalid material batch');
  await ctx.guard(s);
  if (hasExisting) {
    const existing = array.map(v => { const e=object(v); return { materialId: text(e.materialId), version: integer(e.version,1), referenceId: randomUUID() }; });
    const result = await ctx.execute<MaterialsAddTxResult>({ action: 'add', ...s, existing });
    await verifyAcceptedReferences(ctx,s,result.references);
    return { ...result, rejected: result.rejected.map(r => ({ name:r.name,code:r.code })) };
  }
  const files = array.map(fileInput), staged: MaterialStagedRefs[] = [], descriptors: MaterialVersionInput[] = [];
  const rejected: MaterialRejection[] = [];
  let state: MaterialCommitState = 'not-sent';
  try {
    for (const f of files) {
      const probe = await probeMaterialSource(f.path);
      await ctx.guard(s);
      if (!probe.ok) { rejected.push({ name:f.name,code:probe.reason === 'empty' ? 'UNSUPPORTED_FILE' : 'MEDIA_WRITE_FAILED' }); continue; }
      // Read only, no success fast path. The worker repeats the actual lookup under its write lock.
      const candidate = await ctx.queryOne<PrivateMaterialVersion>(PRIVATE_VERSION_SQL+
        " WHERE m.project_id=? AND v.sha256=? AND v.read_state='ready' ORDER BY v.created_at DESC,v.version DESC,v.id LIMIT 1", [s.projectId,probe.sha256]);
      await ctx.guard(s);
      if (candidate) {
        const check = await checkMaterialBytes(candidate);
        await ctx.guard(s);
        if (!check.ok) { rejected.push({ name:f.name,code:'MEDIA_WRITE_FAILED' }); continue; }
        descriptors.push({ referenceId:randomUUID(),versionId:randomUUID(),materialId:randomUUID(),
          name:f.name,...(f.sameNameAction ? { sameNameAction:f.sameNameAction } : {}),
          sha256:probe.sha256,sizeBytes:probe.sizeBytes,mime:probe.mime,storageKind:probe.storageKind,
          sourceMtime:probe.sourceMtime,storageRef:candidate.storageRef,reuseOnly:true });
      } else {
        try { descriptors.push(await stageFile(ctx,f,probe,staged,s)); }
        catch { await ctx.guard(s); rejected.push({ name:f.name,code:'MEDIA_WRITE_FAILED' }); }
      }
    }
    await ctx.guard(s);
    let result: MaterialsAddTxResult = { referenceContract:1,scope:s,added:[],duplicates:[],rejected:[],references:[] };
    if (descriptors.length) result = await ctx.execute<MaterialsAddTxResult>({ action:'add',...s,files:descriptors }, next => { state=next; });
    await ctx.guard(s);
    // An accepted duplicate has a persisted reference. Revalidate its actual bytes before returning success.
    await verifyAcceptedReferences(ctx,s,result.references);
    return { ...result, rejected:[...rejected,...result.rejected.map(r => ({ name:r.name,code:r.code }))] };
  } finally { await cleanupMaterialStaging(staged,state,client,ctx.db,ctx.assertStable); await ctx.guard(s); }
}

export async function addMaterialVersion(raw: unknown, actor?: ProjectAccessActor, client: DbClient = getDbClient()): Promise<MaterialAddVersionResult> {
  const b=object(raw), s=scope(b), id=referenceId(b), materialId=text(b.materialId), f=fileInput(b.file);
  if (b.replaceCurrentReference !== undefined && typeof b.replaceCurrentReference !== 'boolean') throwIpcError('INVALID_PARAMS','Invalid replacement flag');
  const ctx=requestContext(actor,client), staged: MaterialStagedRefs[]=[];
  await selectedLocator(ctx,s,id,materialId);
  const probe=await probeMaterialSource(f.path);
  await ctx.guard(s);
  if (!probe.ok) throwIpcError(probe.reason==='empty'?'UNSUPPORTED_FILE':'MEDIA_WRITE_FAILED','Material source cannot be read');
  let state: MaterialCommitState='not-sent';
  try {
    const file=await stageFile(ctx,f,probe,staged,s);
    const result=await ctx.execute<MaterialAddVersionResult>({ action:'addVersion',...s,referenceId:id,materialId,file,
      replaceCurrentReference:b.replaceCurrentReference===true }, next=>{state=next;});
    const loc = { ...s,referenceId:id,materialId,version:result.version.version };
    const row = await ctx.privateVersion(loc), check = await checkMaterialBytes(row);
    await ctx.resolve(loc);
    if (!check.ok) bytesFailure(check.reason);
    return result;
  } finally { await cleanupMaterialStaging(staged,state,client,ctx.db,ctx.assertStable); await ctx.guard(s); }
}
/**
 * 源文件变更 → 记录为新版本。
 *
 * 文档类材料引用原文件（不复制字节），源文件被覆盖后，已记录的旧版本哈希不再匹配。
 * 这条通道让用户把**当前磁盘内容**记成 v(N+1)：renderer 只给 referenceId/materialId，
 * 路径由 main 从已记录版本里取，绝不接受 renderer 传来的任意路径。
 * 内容与当前版本相同则不改版本（unchanged），避免点击一次就造一个空版本。
 */
export async function recordMaterialSourceVersion(
  raw: unknown, actor?: ProjectAccessActor, client: DbClient = getDbClient(),
): Promise<MaterialRecordSourceResult> {
  const b = object(raw), s = scope(b), id = referenceId(b), materialId = text(b.materialId);
  const ctx = requestContext(actor, client);
  await ctx.guard(s);
  const current = await ctx.queryOne<{
    version: number; name: string; sha256: string; storageKind: string; storageRef: string;
  }>(
    `SELECT v.version AS version, m.name AS name, v.sha256 AS sha256,
            v.storage_kind AS storageKind, v.storage_ref AS storageRef
       FROM material_references r
       JOIN materials m ON m.id = r.material_id AND m.project_id = r.project_id
       JOIN material_versions v ON v.material_id = r.material_id AND v.version = r.version
      WHERE r.id = ? AND r.project_id = ? AND r.material_id = ? AND r.status = 'active'`,
    [id, s.projectId, materialId],
  );
  await ctx.guard(s);
  if (!current) throwIpcError('REFERENCE_NOT_FOUND', 'Material reference not found');
  // 媒体文件在入库时已经复制进 cindy-media，字节不可变，不存在“源文件被改”的问题。
  if (current.storageKind !== 'file') throwIpcError('PRECONDITION_FAILED', 'Material bytes are immutable');
  const probe = await probeMaterialSource(current.storageRef);
  await ctx.guard(s);
  if (!probe.ok) throwIpcError(probe.reason === 'empty' ? 'SOURCE_MISSING' : 'SOURCE_CHANGED', 'Material source cannot be read');
  if (probe.sha256 === current.sha256) {
    return { unchanged: true, version: current.version };
  }
  const result = await addMaterialVersion(
    { ...s, referenceId: id, materialId, file: { name: current.name, path: current.storageRef } },
    actor,
    client,
  );
  return { unchanged: false, version: result.version, reference: result.reference };
}

export async function removeMaterialReference(raw: unknown, actor?: ProjectAccessActor, client: DbClient = getDbClient()): Promise<MaterialRemoveReferenceResult> {
  const b=object(raw), s=scope(b), id=referenceId(b), ctx=requestContext(actor,client);
  await ctx.guard(s);
  const result=await ctx.execute<MaterialRemoveReferenceResult>({ action:'removeReference',...s,referenceId:id });
  await ctx.guard(s); return result;
}
export async function createMaterialContext(raw: unknown, actor?: ProjectAccessActor, client: DbClient = getDbClient()): Promise<MaterialContextCreateResult> {
  const b=object(raw), s=scope(b), ctx=requestContext(actor,client);
  if (s.workItemId===null || !isMaterialContextPurpose(b.purpose) || !Array.isArray(b.refs)) throwIpcError('INVALID_PARAMS','Invalid material snapshot');
  const refs=b.refs.map(v=>{const r=object(v);return { referenceId:referenceId(r),materialId:text(r.materialId),version:integer(r.version,1) };});
  await ctx.guard(s);
  const result=await ctx.execute<MaterialContextCreateResult>({ action:'createContext',...s,newId:randomUUID(),purpose:b.purpose,refs });
  await ctx.guard(s); return result;
}
export async function listMaterialContexts(raw: unknown, actor?: ProjectAccessActor, client: DbClient = getDbClient()): Promise<MaterialContextsListResult> {
  const params=listParams(object(raw)), ctx=requestContext(actor,client);
  if (params.workItemId===null) throwIpcError('INVALID_PARAMS','Snapshot requires a work item');
  const result=await ctx.execute<MaterialContextsListResult>({ action:'listContexts',...params });
  await ctx.execute({ action:'listContexts',...params }); return result;
}
export async function retryMaterialRead(raw: unknown, actor?: ProjectAccessActor, client: DbClient = getDbClient()): Promise<MaterialRetryReadResult> {
  const loc=locator(object(raw)), ctx=requestContext(actor,client), row=await ctx.privateVersion(loc);
  const check=await checkMaterialBytes(row);
  await ctx.resolve(loc);
  const result=await ctx.execute<MaterialRetryReadResult>({ action:'retryRead',...loc,
    readState:check.ok?'ready':'failed',failureReason:check.ok?null:check.reason });
  await ctx.resolve(loc); return result;
}
export async function previewMaterial(raw: unknown, actor?: ProjectAccessActor, client: DbClient = getDbClient()): Promise<MaterialPreview> {
  const loc=locator(object(raw)), ctx=requestContext(actor,client), capturedClient=getCurrentDbClientSnapshot();
  const assertClient = () => {
    const current=getCurrentDbClientSnapshot();
    if (!ctx.owner.ownerScopeKey || !capturedClient || current?.client !== client ||
        current.clientEpoch !== capturedClient.clientEpoch || current.userId !== capturedClient.userId) {
      throwIpcError('PRECONDITION_FAILED','Material database client changed or owner unavailable');
    }
  };
  assertClient();
  const row=await ctx.privateVersion(loc);
  const assertReadable = async () => {
    assertClient();
    const currentRow=await ctx.privateVersion(loc);
    if (Object.keys(row).some(key => row[key as keyof PrivateMaterialVersion] !== currentRow[key as keyof PrivateMaterialVersion])) {
      throwIpcError('VERSION_NOT_READABLE','Material version metadata changed');
    }
    const current=await ctx.resolve(loc);
    assertClient();
    if (current.version.readState!=='ready') throwIpcError('VERSION_NOT_READABLE','Material version is not ready');
  };
  await assertReadable();
  const check=await checkMaterialBytes(row);
  await assertReadable();
  if (!check.ok) bytesFailure(check.reason);
  const base={ referenceContract:1 as const,materialId:row.materialId,version:row.version,name:row.name,mime:row.mime,size:row.sizeBytes };
  let result: MaterialPreview;
  const restrictedUrl = async () => {
    if (row.sizeBytes > MATERIAL_PREVIEW_MAX_BYTES) return {};
    const read = async () => {
      await assertReadable();
      const bytes = await readMaterialPreviewBytes(row);
      await assertReadable();
      return { bytes, mime: row.mime };
    };
    await read();
    return { url: issueMaterialPreview(read) };
  };
  if (row.storageKind==='media') {
    const location = await restrictedUrl();
    result={ ...base,kind:location.url && row.mime.startsWith('image/')?'image':'unsupported',...location };
  }
  else if (row.mime.startsWith('text/')) {
    const read=await readVerifiedMaterialText(row);
    await assertReadable();
    if (!read.ok && read.reason!=='unsupported') bytesFailure(read.reason);
    result=read.ok?{ ...base,kind:'text',text:read.text }:{ ...base,kind:'unsupported' };
  } else result={ ...base,kind:'unsupported',...(isLocalFilePreviewPathSupported(row.storageRef)?await restrictedUrl():{}) };
  await assertReadable(); return result;
}

/** Read-only projection of the dispatch ledger for the work-item UI. The renderer never
 * derives these states from optimistic sends; every value comes from the durable row read
 * through the same membership-filtered worker entry. No hash, body, actor or locator.
 */
export async function readMaterialDispatchStatus(raw: unknown): Promise<MaterialDispatchStatusList> {
  const body = object(raw);
  if (Object.keys(body).some(key => key !== 'sessionId')) throwIpcError('INVALID_PARAMS', 'Invalid dispatch read');
  const sessionId = text(body.sessionId);
  const owner = getCurrentDbClientSnapshot();
  if (!owner?.userId) throwIpcError('PRECONDITION_FAILED', 'Material dispatch read has no owner');
  const assertCurrent = () => {
    if (getCurrentDbClientSnapshot() !== owner) throwIpcError('PRECONDITION_FAILED', 'Material dispatch read owner changed');
  };
  const queue = createMaterialDispatchQueue({ client: owner.client, actor: { kind: 'account', id: owner.userId }, assertCurrent });
  const result = await queue.readSession(sessionId, false);
  assertCurrent();
  const messages: MaterialDispatchStatusItem[] = result.messages.flatMap((message) => {
    const revision = message.revisions.find(item => item.revision === message.currentRevision);
    if (!revision) return [];
    const attempt = revision.attempts.length > 0 ? revision.attempts[revision.attempts.length - 1] : null;
    const items = revision.preparation?.items ?? [];
    const prepared = items.filter(item => item.readiness === 'ready' || item.readiness === 'partial').length;
    return [{
      clientId: message.key.clientId,
      revision: revision.revision,
      state: revision.state,
      consumption: attempt ? { consumer: attempt.consumer, outcome: attempt.outcome } : null,
      readiness: items.length === 0 ? null : prepared === items.length ? 'ready' : prepared > 0 ? 'partial' : 'not-prepared',
      referenceCount: items.length,
    } satisfies MaterialDispatchStatusItem];
  });
  return { referenceContract: 1, sessionId, messages };
}

export function registerMaterialsIpc(): void {
  const channels = [    [MATERIALS_LIST_CHANNEL,listMaterials], [MATERIALS_ADD_CHANNEL,addMaterials],
    [MATERIALS_ADD_VERSION_CHANNEL,addMaterialVersion], [MATERIALS_RECORD_SOURCE_CHANNEL,recordMaterialSourceVersion],
    [MATERIALS_REMOVE_REFERENCE_CHANNEL,removeMaterialReference],
    [MATERIALS_RETRY_READ_CHANNEL,retryMaterialRead], [MATERIALS_PREVIEW_CHANNEL,previewMaterial],
    [MATERIAL_CONTEXTS_CREATE_CHANNEL,createMaterialContext], [MATERIAL_CONTEXTS_LIST_CHANNEL,listMaterialContexts],
    [MATERIAL_DISPATCH_STATUS_CHANNEL,readMaterialDispatchStatus],
  ] as const;
  for (const [channel,handle] of channels) ipcMain.handle(channel, async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event); return handle(raw);
  });
}
