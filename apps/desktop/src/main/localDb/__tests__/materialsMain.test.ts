/** R2 DB/integration boundary: real exported main functions -> real R1 SQLite transaction,
 * generated 0146..0149 schema, temporary real files and real source probes/SHA/text reads.
 * Regression: duplicate fast paths skipped references; stale access and version-id cleanup
 * crossed scopes. Auth/owner/Electron and media broker/ledger are controlled; this is not
 * native worker transport, real media journal/recycler or UI/model coverage.
 * Preview regression: real main URL -> real registered xdt-file handler, SQLite and temp files.
 * Prior tests only re-invoked preview; old URLs leaked after revoke/source replacement.
 * Minimal inputs: one PDF, an issued URL, then membership removal or file replacement.
 * Tier: DB/integration; controlled Electron registration/identity/media broker, real byte reads.
 * Modules/DDL load once, no real waits, no account database. All mutations use production entries.
 */
import fs from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { MATERIALS_READ_PREVIEW_BYTES_CHANNEL, type MaterialPreviewBytesParams, type MaterialPreviewBytesResult } from '../../../shared/materials';
import type Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runMaterialsTransaction } from '../worker/opHandlers/materialsTx';
import { runProjectsTransaction } from '../worker/opHandlers/projectsTx';
import type { DbClient } from '../client/DbClient';
import type { MaterialReference, MaterialScope } from '../../../shared/materials';
const env = vi.hoisted(() => ({ sourceTrusted: true, epoch: 0, clientEpoch: 0, ingest: vi.fn(), open: vi.fn(), remove: vi.fn(), logger: vi.fn(), current: vi.fn(), handle: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, protocol: { handle: env.handle }, app: { getPath: () => 'C:/cindy-qa-no-profile' } }));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: env.logger, info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../../device-link/broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: () => ({ ownerScopeKey: String(env.epoch) }),
  isDataOwnerBroadcastScopeCurrent: (s: { ownerScopeKey: string }) => s.ownerScopeKey === String(env.epoch),
}));
vi.mock('../client/current', () => ({ getDbClient: env.current, getCurrentDbClientSnapshot: () => ({ client: env.current(), userId: 'owner', clientEpoch: env.clientEpoch }) }));
// Controlled host identity, independently supplied; role/epoch authorization remains real SQLite.
vi.mock('../ipc/projects', () => ({ resolveProjectActor: (actor: unknown) => actor === undefined ? { kind: 'account', id: 'owner' } : actor }));
vi.mock('../../cindy-media/ingest', () => ({ ingestMedia: env.ingest }));
vi.mock('../../cindy-media/blobStore', () => ({ openBlobFile: env.open }));
vi.mock('../../cindy-media/ledger', () => ({ removeRefById: env.remove }));
vi.mock('../../cindy-media/refCompensationJournal', () => ({ captureMediaRefCompensationScope: () => ({ assertStillValid() {} }) }));
import { readMaterialPreviewPdfBytes } from '../../materialPreviewBytes';
import { issueMaterialPreview } from '../../materialPreviewAccess';
import { registerLocalFileProtocolHandler } from '../../localFileProtocol';
vi.mock('../../security/trustedAppRenderer', () => ({ assertTrustedAppRendererEvent: () => {
  if (!env.sourceTrusted) throw Error('private source detail');
} }));
import {
  addMaterials, addMaterialVersion, removeMaterialReference, listMaterials,
  createMaterialContext, listMaterialContexts, previewMaterial, retryMaterialRead,
} from '../ipc/materials';
import * as io from '../ipc/materialReferenceIo';
const dir=path.resolve(__dirname,'../../../../drizzle');
const ddl=['0146_','0147_','0148_','0149_'].map(prefix => readFileSync(path.join(dir,readdirSync(dir).find(n=>n.startsWith(prefix)&&n.endsWith('.sql'))!), 'utf8').split('--> statement-breakpoint').join(';')).join(';');
const owner={kind:'account' as const,id:'owner'}, member={kind:'account' as const,id:'member'};
const s=(task: string | null='t1',epoch=1):MaterialScope=>task===null?{projectId:'p',workItemId:null,bindingRevision:null}:{projectId:'p',workItemId:task,bindingRevision:epoch};
const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489','hex');
type Input=Record<string, unknown>;

// Electron object/lifecycle fixture, never renderer-supplied authority.
function previewSource() {
  const state = { destroyed: false };
  const frame = { url: 'file:///cindy/index.html', parent: null, detached: false, processId: 7, routingId: 11 };
  const sender = Object.assign(new EventEmitter(), { id: 13, mainFrame: frame, isDestroyed: () => state.destroyed });
  return { state, frame, sender, event: { sender, senderFrame: frame } };
}

// Execute the production registration statement and production preload arrow, not a
// hand-written channel map. Unrelated registerAll bootstrap remains outside this fixture.
const ipcWiring = (() => {
  const root = path.resolve(__dirname, '../../../..');
  const registerFile = path.join(root, 'src/main/localDb/ipc/registerAll.ts');
  const preloadFile = path.join(root, 'src/preload/preload.ts');
  const registration = ts.createSourceFile(registerFile, readFileSync(registerFile, 'utf8'), ts.ScriptTarget.Latest, true);
  const preload = ts.createSourceFile(preloadFile, readFileSync(preloadFile, 'utf8'), ts.ScriptTarget.Latest, true);
  const statements: string[] = [], methods: string[] = [];
  const visitRegistration = (node: ts.Node) => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      if (ts.isPropertyAccessExpression(call.expression) && call.expression.getText(registration) === 'ipcMain.handle'
        && call.arguments[0]?.getText(registration) === 'MATERIALS_READ_PREVIEW_BYTES_CHANNEL') statements.push(node.getText(registration));
    }
    ts.forEachChild(node, visitRegistration);
  };
  const visitPreload = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(preload) === 'readPreviewBytes') methods.push(node.initializer.getText(preload));
    ts.forEachChild(node, visitPreload);
  };
  visitRegistration(registration); visitPreload(preload);
  if (statements.length !== 1 || methods.length !== 1) throw Error('Expected one production PDF IPC registration and preload method');
  const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const register = new Function('ipcMain', 'MATERIALS_READ_PREVIEW_BYTES_CHANNEL', 'readMaterialPreviewPdfBytes', compile(statements[0]));
  const createPreload = new Function('ipcRenderer', 'MATERIALS_READ_PREVIEW_BYTES_CHANNEL', compile(`return (${methods[0]});`));
  return (event: ReturnType<typeof previewSource>['event']) => {
    const handlers = new Map<string, typeof readMaterialPreviewPdfBytes>();
    register({ handle: (channel: string, handler: typeof readMaterialPreviewPdfBytes) => handlers.set(channel, handler) }, MATERIALS_READ_PREVIEW_BYTES_CHANNEL, readMaterialPreviewPdfBytes);
    const invoke = async (channel: string, raw: unknown) => {
      const handler = handlers.get(channel);
      if (!handler) throw Error('Unregistered channel');
      return handler(event as never, raw);
    };
    const method: (params: MaterialPreviewBytesParams) => Promise<MaterialPreviewBytesResult> = createPreload({ invoke }, MATERIALS_READ_PREVIEW_BYTES_CHANNEL);
    return method;
  };
})();

describe('material main R2 with R1 database and real files',()=>{
  let db: Database.Database, client: DbClient, root: string;
  let beforeTx: ((a: Input)=>Promise<void>|void)|undefined;
  let afterTx: ((a: Input,result: unknown)=>Promise<unknown>|unknown)|undefined;
  let afterBytes: (()=>Promise<void>|void)|undefined;
  let onStage: (()=>Promise<void>|void)|undefined;
  let refs: Map<string,{refId:string;hash:string}>, blobs: Map<string,string>;
  let calls: Input[];
  const write=async(name='a.txt',bytes: string|Buffer='version one')=>{const p=path.join(root,name);await fs.writeFile(p,bytes);return {name,path:p};};
  const add=async(task='t1',file?: {name:string;path:string},actor=owner)=>addMaterials({...s(task),files:[file??await write()]},actor,client);
  const loc=(r:MaterialReference,task='t1',epoch=1)=>({...s(task,epoch),referenceId:r.id,materialId:r.materialId,version:r.version});
  const bind=(target:string|null,task='t3')=>runProjectsTransaction(db,{action:'bindSession',actor:owner,sessionId:task,projectId:target});
  const removeMember=()=>runProjectsTransaction(db,{action:'removeMember',actor:owner,projectId:'p',subject:member,now:2000});
  const count=(table:string)=>db.prepare('SELECT COUNT(*) FROM '+table).pluck().get();
  beforeEach(async()=>{
    env.sourceTrusted=true;env.epoch=0;env.clientEpoch=0;beforeTx=undefined;afterTx=undefined;afterBytes=undefined;onStage=undefined;
    refs=new Map();blobs=new Map();calls=[];
    root=await fs.mkdtemp(path.join(tmpdir(),'cindy-material-main-'));
    db=createBetterSqliteDatabase(':memory:');db.pragma('foreign_keys=ON');
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'active')");db.exec(ddl);
    for(const p of ['p','q'])runProjectsTransaction(db,{action:'create',actor:owner,newId:p,now:1,input:{name:p,owner,members:p==='p'?[member,{kind:'bot',id:'owner'}]:[]}});
    db.exec("INSERT INTO sessions (id) VALUES ('t1'),('t3')");bind('p','t1');bind('p');
    client={
      query:async(sql:string,args:unknown[]=[])=>db.prepare(sql).all(...args),
      queryOne:async(sql:string,args:unknown[]=[])=>db.prepare(sql).get(...args),
      exec:async(sql:string,args:unknown[]=[])=>db.prepare(sql).run(...args),
      tx:async(_name:string,input:unknown)=>{
        const a=structuredClone(input) as Input;calls.push(a);await beforeTx?.(a);
        const result=runMaterialsTransaction(db,a);const replacement=await afterTx?.(a,result);
        return replacement===undefined?result:replacement;
      },drizzle:{},vecAvailable:false,dispose:async()=>{},
    } as unknown as DbClient;
    env.current.mockReset().mockReturnValue(client);
    env.ingest.mockReset().mockImplementation(async(params:{filePath:string;refs:Array<{refId:string}>;assertStillValid:()=>void})=>{
      params.assertStillValid();const bytes=await fs.readFile(params.filePath),hash=createHash('sha256').update(bytes).digest('hex');
      const url='cindy-media://blobs/'+hash+'.png',filename=path.join(root,hash+'.png');await fs.writeFile(filename,bytes);blobs.set(url,filename);
      const id='ledger-'+randomUUID();refs.set(id,{refId:params.refs[0].refId,hash});
      await onStage?.();
      return {hash,url,bytes:bytes.length,mimeType:'image/png',refIds:[id],deduplicated:false,ext:'.png'};
    });
    env.open.mockReset().mockImplementation(async(url:string)=>{
      const filename=blobs.get(url);if(!filename)throw Error('missing blob');return {file:await fs.open(filename,'r')};
    });
    env.remove.mockReset().mockImplementation(async(id:string)=>refs.delete(id)?1:0);
    env.logger.mockClear();
    const check=io.checkMaterialBytes;
    vi.spyOn(io,'checkMaterialBytes').mockImplementation(async row=>{const result=await check(row);await afterBytes?.();return result;});
  });
  afterEach(async()=>{
    vi.restoreAllMocks();db.close();
    const relative=path.relative(tmpdir(),root);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Unsafe temp cleanup');
    await fs.rm(root,{recursive:true,force:true});
  });

  it('same-name and renamed duplicate adds both reach the transaction and persist separate task references',async()=>{
    const f=await write(),a=await add('t1',f),b=await add('t3',f);
    const renamed=await add('t3',await write('copy.txt'));
    expect(a.added).toHaveLength(1);expect(b.duplicates).toHaveLength(1);expect(renamed.duplicates).toHaveLength(1);
    expect(calls.filter(a=>a.action==='add')).toHaveLength(3);
    expect(count('materials')).toBe(1);expect(count('material_references')).toBe(2);
    const list=await listMaterials(s('t3'),owner,client);
    expect(list.materials[0]).toMatchObject({currentVersion:1,reference:{id:b.references[0].id}});
    expect(JSON.stringify(list)).not.toContain(root);
    expect(env.ingest).not.toHaveBeenCalled();
  });

  it('existing reuse never ingests and removal only removes its reference',async()=>{
    const a=await add(),r=a.references[0];
    const b=await addMaterials({...s('t3'),existing:[{materialId:r.materialId,version:1,referenceId:'forged'}]},owner,client);
    expect(b.references[0].id).not.toBe('forged');expect(b.references[0].id).not.toBe(r.id);
    await removeMaterialReference({...s(),referenceId:r.id},owner,client);
    expect((await listMaterials(s(),owner,client)).materials).toEqual([]);
    expect((await listMaterials(s('t3'),owner,client)).materials).toHaveLength(1);expect(env.remove).not.toHaveBeenCalled();
  });

  it('snapshots and other task references retain v1 after explicit v2, using actual separate source files',async()=>{
    const r=(await add()).references[0];
    const b=await addMaterials({...s('t3'),existing:[{materialId:r.materialId,version:1}]},owner,client);
    const c=await createMaterialContext({...s('t3'),purpose:'reference',refs:[{referenceId:b.references[0].id,materialId:r.materialId,version:1}]},owner,client);
    const before=db.prepare('SELECT refs_json FROM material_contexts').pluck().get();
    await addMaterialVersion({...s(),referenceId:r.id,materialId:r.materialId,file:await write('v2.txt','version two')},owner,client);
    expect((await listMaterials(s(),owner,client)).materials[0].currentVersion).toBe(2);
    expect((await listMaterials(s('t3'),owner,client)).materials[0].currentVersion).toBe(1);
    const old=await previewMaterial({contextId:c.context.id,materialId:r.materialId,version:1},owner,client);
    expect(old).toMatchObject({kind:'text',text:'version one',version:1});
    expect(db.prepare('SELECT refs_json FROM material_contexts').pluck().get()).toBe(before);
    await removeMaterialReference({...s('t3'),referenceId:b.references[0].id},owner,client);
    expect((await previewMaterial({contextId:c.context.id,materialId:r.materialId,version:1},owner,client)).text).toBe('version one');
    expect((await listMaterialContexts({...s('t3'),history:false},owner,client)).contexts).toHaveLength(1);
  });

  it.each(['q',null])('rejects old scope after actual p -> %s -> p while keeping the snapshot',async via=>{
    const r=(await add('t3')).references[0];
    const c=await createMaterialContext({...s('t3'),purpose:'reference',refs:[{referenceId:r.id,materialId:r.materialId,version:1}]},owner,client);
    bind(via);bind('p');
    const changes=db.prepare('SELECT total_changes()').pluck().get();
    await expect(add('t3',await write('copy.txt'))).rejects.toThrow('[BINDING_CONFLICT]');
    await expect(previewMaterial(loc(r,'t3'),owner,client)).rejects.toThrow('[BINDING_CONFLICT]');
    await expect(removeMaterialReference({...s('t3'),referenceId:r.id},owner,client)).rejects.toThrow('[BINDING_CONFLICT]');
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changes);
    expect((await listMaterials(s('t3',3),owner,client)).materials).toEqual([]);
    expect((await previewMaterial({contextId:c.context.id,materialId:r.materialId,version:1},owner,client)).text).toBe('version one');
  });

  it('revocation after duplicate precheck causes real worker rejection with no new reference',async()=>{
    await add();
    beforeTx=a=>{if(a.action==='add'){beforeTx=undefined;removeMember();}};
    await expect(addMaterials({...s('t3'),files:[await write('copy.txt')]},member,client)).rejects.toThrow('[FORBIDDEN]');
    expect(count('material_references')).toBe(1);expect(count('materials')).toBe(1);
  });

  it('a candidate becoming unreadable after precheck returns rejection instead of unstaged creation',async()=>{
    const r=(await add()).references[0];
    beforeTx=a=>{if(a.action==='add'){
      beforeTx=undefined;expect((a.files as Array<{reuseOnly:boolean}>)[0].reuseOnly).toBe(true);
      runMaterialsTransaction(db,{action:'retryRead',...s(),actor:owner,now:2000,referenceId:r.id,materialId:r.materialId,version:1,readState:'failed',failureReason:'SOURCE_CHANGED'});
    }};
    const result=await add('t3',await write('copy.txt'));
    expect(result.added).toEqual([]);expect(result.duplicates).toEqual([]);expect(result.references).toEqual([]);
    expect(result.rejected).toMatchObject([{code:'MEDIA_WRITE_FAILED'}]);expect(count('materials')).toBe(1);expect(env.ingest).not.toHaveBeenCalled();
  });

  it('real source changes and deletion retain SOURCE_CHANGED/MISSING and retry updates only that version',async()=>{
    const f=await write(),r=(await add('t1',f)).references[0];
    await fs.writeFile(f.path,'changed');
    await expect(previewMaterial(loc(r),owner,client)).rejects.toThrow('SOURCE_CHANGED');
    const failed=await retryMaterialRead({...loc(r),readState:'ready',failureReason:null},owner,client);
    expect(failed.version).toMatchObject({version:1,readState:'failed',failureReason:'SOURCE_CHANGED'});
    await fs.unlink(f.path);
    const missing=await retryMaterialRead(loc(r),owner,client);
    expect(missing.version.failureReason).toBe('SOURCE_MISSING');expect(count('material_versions')).toBe(1);
  });

  it('deleting a still-ready source makes preview fail SOURCE_MISSING',async()=>{
    const f=await write(),r=(await add('t1',f)).references[0];await fs.unlink(f.path);
    await expect(previewMaterial(loc(r),owner,client)).rejects.toThrow('SOURCE_MISSING');
  });

  it.each(['owner','member','database'])('rechecks %s changes after actual byte verification before returning content',async change=>{
    const r=(await addMaterials({...s(),files:[await write()]},member,client)).references[0];
    afterBytes=()=>{afterBytes=undefined;if(change==='owner')env.epoch++;else if(change==='member')removeMember();else (client as {drizzle:unknown}).drizzle={};};
    await expect(previewMaterial(loc(r),member,client)).rejects.toThrow(change==='member'?'[FORBIDDEN]':'[PRECONDITION_FAILED]');
  });

  it('does not trust raw actor, time, staging/reference ids, hashes or storage paths',async()=>{
    const f=await write();
    const result=await addMaterials({...s(),actor:owner,now:9,files:[{...f,referenceId:'forged',materialId:'alien',versionId:'forged-version',sha256:'x',storageRef:'elsewhere',reuseOnly:true}]},member,client);
    const r=result.references[0];expect(r.createdById).toBe('member');expect(r.id).not.toBe('forged');
    const call=calls.find(a=>a.action==='add')!;const descriptor=(call.files as Array<Record<string,unknown>>)[0];
    expect(call.actor).toEqual(member);expect(call.now).not.toBe(9);
    expect(descriptor.materialId).not.toBe('alien');expect(descriptor.versionId).not.toBe('forged-version');
    expect(descriptor.sha256).toBe(createHash('sha256').update('version one').digest('hex'));expect(descriptor.storageRef).toBe(f.path);
    const text=await previewMaterial({...loc(r),storageRef:'elsewhere',actor:{kind:'bot',id:'owner'}},member,client);
    expect(text.text).toBe('version one');
    await expect(removeMaterialReference({...s('t3'),referenceId:r.id},owner,client)).rejects.toThrow('[REFERENCE_MISMATCH]');
  });

  it('media duplicates do not ingest twice; pins are independent from soft reference removal',async()=>{
    const f=await write('image.png',png),r=(await add('t1',f)).references[0];
    const b=await add('t3',await write('renamed.png',png));
    expect(b.duplicates).toHaveLength(1);expect(env.ingest).toHaveBeenCalledTimes(1);expect(refs.size).toBe(1);
    await removeMaterialReference({...s(),referenceId:r.id},owner,client);
    expect((await previewMaterial(loc(b.references[0],'t3'),owner,client)).kind).toBe('image');
    expect(refs.size).toBe(1);expect(env.remove).not.toHaveBeenCalled();
  });

  it('stage then reject compensates only returned ledger-row ids, never version ids or other pins',async()=>{
    refs.set('foreign-ledger-row',{refId:'other-version',hash:'other'});
    beforeTx=a=>{if(a.action==='add'){beforeTx=undefined;removeMember();}};
    await expect(addMaterials({...s(),files:[await write('image.png',png)]},member,client)).rejects.toThrow('[FORBIDDEN]');
    expect(count('material_versions')).toBe(0);expect([...refs.keys()]).toEqual(['foreign-ledger-row']);
    expect(env.remove).toHaveBeenCalledTimes(1);expect(env.remove.mock.calls[0][0]).toMatch(/^ledger-/);
  });

  it('a same-content winner appearing after staging releases only this request unused media row',async()=>{
    onStage=()=>{
      onStage=undefined;
      const [url]=blobs.keys();const hash=[...refs.values()][0].hash;
      refs.set('other-pin',{refId:'winning-version',hash});
      runMaterialsTransaction(db,{action:'add',...s(),actor:owner,now:1,files:[{referenceId:'winner-ref',versionId:'winning-version',materialId:'winning-material',name:'winner.png',sha256:hash,sizeBytes:png.length,mime:'image/png',storageKind:'media',storageRef:url,sourceMtime:null}]});
    };
    const result=await add('t3',await write('image.png',png));
    expect(result.duplicates).toHaveLength(1);expect([...refs.keys()]).toEqual(['other-pin']);expect(count('material_versions')).toBe(1);
  });

  it.each([false,true])('unknown commit receipt retains staging (actual commit: %s)',async committed=>{
    if(committed)afterTx=a=>{if(a.action==='add')throw Error('ACK lost');};
    else beforeTx=a=>{if(a.action==='add')throw Error('transport outcome unknown');};
    await expect(add('t1',await write('image.png',png))).rejects.toThrow(committed?'ACK lost':'outcome unknown');
    expect(count('material_versions')).toBe(committed?1:0);expect(refs.size).toBe(1);expect(env.remove).not.toHaveBeenCalled();
  });


  it('same-name changed bytes require explicit create-new; identical bytes still deduplicate',async()=>{
    await add();
    const f=await write('second.txt','changed bytes');f.name='a.txt';
    const rejected=await add('t3',f);
    expect(rejected.rejected).toMatchObject([{code:'DUPLICATE_CONTENT'}]);expect(count('materials')).toBe(1);
    const created=await addMaterials({...s('t3'),files:[{...f,sameNameAction:'create-new'}]},owner,client);
    expect(created.added).toHaveLength(1);expect(count('materials')).toBe(2);
    const reused=await addMaterials({...s(),files:[{...f,sameNameAction:'create-new'}]},owner,client);
    expect(reused.duplicates).toHaveLength(1);expect(count('materials')).toBe(2);
  });

  it('owner change after actual business commit retains the accepted media pin',async()=>{
    afterTx=a=>{if(a.action==='add')env.epoch++;};
    await expect(add('t1',await write('image.png',png))).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(count('material_versions')).toBe(1);expect(refs.size).toBe(1);expect(env.remove).not.toHaveBeenCalled();
  });

  it('revocation during unused-stage cleanup rejects the final response without removing the winning pin',async()=>{
    onStage=()=>{
      onStage=undefined;const [url]=blobs.keys();const hash=[...refs.values()][0].hash;
      refs.set('winning-pin',{refId:'winning-version',hash});
      runMaterialsTransaction(db,{action:'add',...s(),actor:owner,now:1,files:[{referenceId:'winner-ref',versionId:'winning-version',materialId:'winning-material',name:'winner.png',sha256:hash,sizeBytes:png.length,mime:'image/png',storageKind:'media',storageRef:url,sourceMtime:null}]});
    };
    env.remove.mockImplementation(async(id:string)=>{refs.delete(id);removeMember();return 1;});
    await expect(addMaterials({...s('t3'),files:[await write('image.png',png)]},member,client)).rejects.toThrow('[FORBIDDEN]');
    expect([...refs.keys()]).toEqual(['winning-pin']);expect(count('material_references')).toBe(2);
  });

  it('historical preview checks its source project after the task moves elsewhere',async()=>{
    const r=(await add()).references[0];
    const c=await createMaterialContext({...s(),purpose:'reference',refs:[{referenceId:r.id,materialId:r.materialId,version:1}]},owner,client);
    bind('q','t1');
    expect((await previewMaterial({contextId:c.context.id,materialId:r.materialId,version:1},member,client)).text).toBe('version one');
    removeMember();
    runProjectsTransaction(db,{action:'addMember',actor:owner,projectId:'q',subject:member,now:2000});
    await expect(previewMaterial({contextId:c.context.id,materialId:r.materialId,version:1},member,client)).rejects.toThrow('[FORBIDDEN]');
  });

  it('text preview hashes the actual decoded buffer and accepts a UTF-8 BOM',async()=>{
    const f=await write('bom.txt',Buffer.from('\uFEFFversion one','utf8')),r=(await add('t1',f)).references[0];
    expect((await previewMaterial(loc(r),owner,client)).text).toBe('version one');
    const read=io.readVerifiedMaterialText;
    vi.spyOn(io,'readVerifiedMaterialText').mockImplementation(async row=>{await fs.writeFile(f.path,'other bytes');return read(row);});
    await expect(previewMaterial(loc(r),owner,client)).rejects.toThrow('SOURCE_CHANGED');
  });

  // Imported references may exceed the material-id limit. Seed their persisted identity via
  // the real transaction, then exercise every public main parser accepting a reference id.
  it.each([216,400])('preserves a %i-character legacy-material reference id while material ids stay limited to 200',async length=>{
    const f=await write(),materialId='m'.repeat(200),id='legacy-material:'+('r'.repeat(length-16));
    const stat=await fs.stat(f.path);
    runMaterialsTransaction(db,{action:'add',...s(),actor:owner,now:1,files:[{
      referenceId:id,versionId:'legacy-v1',materialId,name:f.name,
      sha256:createHash('sha256').update('version one').digest('hex'),sizeBytes:stat.size,
      mime:'text/plain',storageKind:'file',storageRef:f.path,sourceMtime:Math.trunc(stat.mtimeMs),
    }]});
    const r=(await listMaterials(s(),owner,client)).materials[0].reference;
    expect(id).toHaveLength(length);expect(r.id).toBe(id);
    expect((await previewMaterial(loc(r),owner,client)).text).toBe('version one');
    expect((await retryMaterialRead(loc(r),owner,client)).version.readState).toBe('ready');
    const c=await createMaterialContext({...s(),purpose:'reference',refs:[{referenceId:id,materialId,version:1}]},owner,client);
    expect(c.context.refs[0].referenceId).toBe(id);
    const v=await addMaterialVersion({...s(),referenceId:id,materialId,file:await write('v2.txt','version two')},owner,client);
    expect(v.reference.id).toBe(id);expect(v.reference.version).toBe(2);
    const changes=db.prepare('SELECT total_changes()').pluck().get(),before=calls.length;
    const overlong='legacy-material:'+('r'.repeat(385));
    await expect(previewMaterial({...s(),referenceId:overlong,materialId,version:2},owner,client)).rejects.toThrow('[INVALID_PARAMS]');
    await expect(removeMaterialReference({...s(),referenceId:overlong},owner,client)).rejects.toThrow('[INVALID_PARAMS]');
    await expect(previewMaterial({...s(),referenceId:id,materialId:materialId+'x',version:2},owner,client)).rejects.toThrow('[INVALID_PARAMS]');
    expect(calls).toHaveLength(before);expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changes);
    const removed=await removeMaterialReference({...s(),referenceId:id},owner,client);
    expect(removed.reference).toMatchObject({id,status:'removed'});
  });

  it('legacy requests and unsupported data responses cannot advertise referenceContract:1',async()=>{
    await expect(listMaterials({projectId:'p',workItemId:'t1'},owner,client)).rejects.toThrow('[REFERENCE_SCOPE_REQUIRED]');
    await expect(removeMaterialReference({materialId:'m'},owner,client)).rejects.toThrow('[REFERENCE_SCOPE_REQUIRED]');
    afterTx=a=>a.action==='list'?{materials:[]}:undefined;
    await expect(listMaterials(s(),owner,client)).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(env.ingest).not.toHaveBeenCalled();
  });
  it('audit denies fresh reads through an issued project preview URL after revocation', async () => {
    const bytes = '%PDF-1.7\nPRIVATE PROJECT FIXTURE';
    const item = (await add('t1', await write('private.pdf', bytes))).references[0];
    const preview = await previewMaterial(loc(item), member, client);
    expect(preview.url).toBeTruthy();
    registerLocalFileProtocolHandler();
    const handler = env.handle.mock.calls.at(-1)![1] as (req: Request) => Promise<Response>;
    const before = await handler(new Request(preview.url!));
    expect(before.status).toBe(200); expect(await before.text()).toBe(bytes);
    removeMember();
    await expect(previewMaterial(loc(item), member, client)).rejects.toThrow();
    const after = await handler(new Request(preview.url!));
    const afterBody = await after.text();
    expect({status: after.status, leaked: afterBody.includes('PRIVATE PROJECT FIXTURE')}).toEqual({status: 403, leaked: false});
  });
  it('audit does not serve replacement bytes as the old material version', async () => {
    const file = await write('private.pdf', '%PDF-1.7\nVERSION ONE');
    const item = (await add('t1', file)).references[0];
    const preview = await previewMaterial(loc(item), member, client);
    registerLocalFileProtocolHandler();
    const handler = env.handle.mock.calls.at(-1)![1] as (req: Request) => Promise<Response>;
    await fs.writeFile(file.path, '%PDF-1.7\nREPLACEMENT VERSION');
    await expect(previewMaterial(loc(item), member, client)).rejects.toThrow();
    const fetched = await handler(new Request(preview.url!));
    const body = await fetched.text();
    expect(body).not.toContain('REPLACEMENT VERSION');
  });

  const fetchPreview = (url: string, range?: string) => {
    registerLocalFileProtocolHandler();
    const handler = env.handle.mock.calls.at(-1)![1] as (req: Request) => Promise<Response>;
    return handler(new Request(url, { headers: range ? { Range: range } : {} }));
  };
  it('restricted URLs expose no raw fallback and repeat full/range reads with no-store', async () => {
    const body='%PDF-1.7\nVERSION ONE', f=await write('range.pdf',body), r=(await add('t1',f)).references[0];
    const preview=await previewMaterial(loc(r),member,client);
    expect(preview.url).toMatch(/^xdt-file:\/\/material\/[a-f0-9]{64}$/);
    expect(JSON.stringify(preview)).not.toContain(root);
    for (const [range,status,expected] of [[undefined,200,body],['bytes=0-3',206,'%PDF'],['bytes=-3',206,'ONE'],['bytes=999-',416,''],['bytes=0-3',206,'%PDF']] as const) {
      const res=await fetchPreview(preview.url!,range);
      expect(res.status).toBe(status);expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(await res.text()).toBe(expected);
    }
    removeMember();
    const res=await fetchPreview(preview.url!,'bytes=0-3');expect(res.status).toBe(403);expect(await res.text()).toBe('');
  });
  it.each(['owner','database','client','client-roundtrip','binding','reference'])('old URL rejects %s changes including binding round trips',async change=>{
    const r=(await add('t1',await write('private.pdf','%PDF-1.7\nsecret'))).references[0];
    const url=(await previewMaterial(loc(r),member,client)).url!;
    if(change==='owner')env.epoch++;
    else if(change==='database')(client as {drizzle:unknown}).drizzle={};
    else if(change==='client-roundtrip')env.clientEpoch+=2;
    else if(change==='client')env.current.mockReturnValue({...client});
    else if(change==='binding'){bind('q','t1');bind('p','t1');}
    else await removeMaterialReference({...s(),referenceId:r.id},owner,client);
    const res=await fetchPreview(url,'bytes=0-3');expect(res.status).toBe(403);expect(await res.text()).toBe('');
  });
  it('historical URL survives legitimate task move/removal but requires source-project membership',async()=>{
    const body='%PDF-1.7\nretained',r=(await add('t1',await write('history.pdf',body))).references[0];
    const context=await createMaterialContext({...s(),purpose:'reference',refs:[{referenceId:r.id,materialId:r.materialId,version:1}]},owner,client);
    const url=(await previewMaterial({contextId:context.context.id,materialId:r.materialId,version:1},member,client)).url!;
    await removeMaterialReference({...s(),referenceId:r.id},owner,client);bind('q','t1');
    expect(await (await fetchPreview(url)).text()).toBe(body);
    removeMember();runProjectsTransaction(db,{action:'addMember',actor:owner,projectId:'q',subject:member,now:2000});
    expect((await fetchPreview(url)).status).toBe(403);
  });
  it('forged tokens, altered URLs and raw fallback injection fail closed',async()=>{
    const f=await write('forge.pdf','%PDF-1.7\nsecret'),r=(await add('t1',f)).references[0];
    const url=(await previewMaterial({...loc(r),actor:owner,storageRef:f.path},member,client)).url!;
    for(const bad of ['xdt-file://material/'+ 'a'.repeat(64),url+'?path='+encodeURIComponent(f.path),url+'/extra',url.replace('material/','material:123/'),url+'#x']) {
      const res=await fetchPreview(bad);expect(res.status).toBe(403);expect(await res.text()).toBe('');
    }
    expect((await fetchPreview(url)).status).toBe(200);
  });
  it('media grants use the same live authorization without exposing blob URLs',async()=>{
    const r=(await add('t1',await write('image.png',png))).references[0];
    const preview=await previewMaterial(loc(r),member,client);
    expect(preview.kind).toBe('image');expect(preview.url).toMatch(/^xdt-file:\/\/material\//);
    expect(JSON.stringify(preview)).not.toContain('cindy-media:');
    expect(Buffer.from(await (await fetchPreview(preview.url!)).arrayBuffer())).toEqual(png);
    removeMember();expect((await fetchPreview(preview.url!)).status).toBe(403);
  });
  it('revalidates authorization after reading bytes and serves the same validated buffer',async()=>{
    const body='%PDF-1.7\noriginal',f=await write('timing.pdf',body),r=(await add('t1',f)).references[0];
    const url=(await previewMaterial(loc(r),member,client)).url!;
    const read=io.readMaterialPreviewBytes;
    const spy=vi.spyOn(io,'readMaterialPreviewBytes').mockImplementationOnce(async row=>{
      const bytes=await read(row);await fs.writeFile(f.path,'%PDF-1.7\nreplacement');return bytes;
    });
    expect(await (await fetchPreview(url,'bytes=0-99')).text()).toBe(body);
    expect((await fetchPreview(url)).status).toBe(403);
    await fs.writeFile(f.path,body);
    const next=(await previewMaterial(loc(r),member,client)).url!;
    spy.mockImplementationOnce(async row=>{const bytes=await read(row);removeMember();return bytes;});
    expect((await fetchPreview(next)).status).toBe(403);
  });
  it('truncation during the actual handle read cannot produce a partial successful Range',async()=>{
    const f=await write('truncate.pdf','%PDF-1.7\noriginal'),r=(await add('t1',f)).references[0];
    const url=(await previewMaterial(loc(r),member,client)).url!;
    const open=fs.open;
    vi.spyOn(fs,'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>)=>{
      const handle=await open(...args),read=handle.read.bind(handle);
      vi.spyOn(handle,'read').mockImplementationOnce(async (...params: unknown[])=>{
        const result=await (read as (...args:unknown[])=>Promise<{bytesRead:number}>)(...params);
        await fs.truncate(f.path,3);return result as Awaited<ReturnType<typeof handle.read>>;
      });
      return handle;
    });
    const res=await fetchPreview(url,'bytes=0-3');expect(res.status).toBe(403);expect(await res.text()).toBe('');
  });
  it('oversize material explicitly has no preview URL or raw fallback',async()=>{
    const f=await write('large.pdf','%PDF-1.7\n');
    await fs.truncate(f.path,io.MATERIAL_PREVIEW_MAX_BYTES+1);
    const r=(await add('t1',f)).references[0];
    const preview=await previewMaterial(loc(r),member,client);
    expect(preview.kind).toBe('unsupported');expect(preview.url).toBeUndefined();
    expect(JSON.stringify(preview)).not.toContain(root);
  });
  it('generic local-file URLs retain their existing semantics',async()=>{
    const f=await write('ordinary.pdf','%PDF-1.7\nordinary');
    const url='xdt-file://local/?path='+encodeURIComponent(f.path);
    expect(await (await fetchPreview(url,'bytes=0-3')).text()).toBe('%PDF');
    await fs.writeFile(f.path,'%PDF-1.7\nupdated');
    expect(await (await fetchPreview(url)).text()).toBe('%PDF-1.7\nupdated');
  });
  it.each(['allowed','revoked','changed','expired','owner'])('dedicated PDF byte entry validates issued grants: %s',async mode=>{
    const body='%PDF-1.7\nprotected PDF',f=await write('protected.pdf',body),r=(await add('t1',f)).references[0];
    const url=(await previewMaterial(loc(r),member,client)).url!;
    if(mode==='revoked')removeMember();
    if(mode==='changed')await fs.writeFile(f.path,'%PDF-1.7\nchanged');
    if(mode==='owner')env.epoch++;
    if(mode==='expired'){vi.useFakeTimers();vi.setSystemTime(Date.now()+11*60*1000);}
    try {
      const result=readMaterialPreviewPdfBytes(previewSource().event as never,{url});
      if(mode==='allowed')expect(Buffer.from((await result).bytes).toString()).toBe(body);
      else await expect(result).rejects.toThrow('[VERSION_NOT_READABLE]');
    } finally {if(mode==='expired')vi.useRealTimers();}
  });
  it('PDF byte entry rejects arbitrary URLs, path fields and non-PDF grants',async()=>{
    for(const input of [{url:'xdt-file://local/?path=C:/test.pdf'},{url:'https://example.com'},{url:'xdt-file://material/'+'f'.repeat(64)},{url:'invalid',filePath:'secret'}]) {
      await expect(readMaterialPreviewPdfBytes(previewSource().event as never,input)).rejects.toThrow();
    }
    const r=(await add('t1',await write('image.png',png))).references[0];
    const url=(await previewMaterial(loc(r),member,client)).url!;
    await expect(readMaterialPreviewPdfBytes(previewSource().event as never,{url})).rejects.toThrow('[VERSION_NOT_READABLE]');
  });

  // New central seam: exact production registration/preload -> real guarded handler,
  // real R2 preview/R1 SQLite/temp file. Existing tests called the handler directly.
  it('production registered PDF IPC and preload return exact version bytes and reject revoked/raw-path reads', async () => {
    const body = '%PDF-1.7\nregistered private version';
    const r = (await add('t1', await write('registered.pdf', body))).references[0];
    const url = (await previewMaterial(loc(r), member, client)).url;
    if (!url) throw Error('Missing opaque PDF grant');
    const readPreviewBytes = ipcWiring(previewSource().event);
    const result = await readPreviewBytes({ url });
    expect(result.mime).toBe('application/pdf');
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(result.bytes).toString()).toBe(body);
    expect(Object.keys(result).sort()).toEqual(['bytes', 'mime']);
    await expect(readPreviewBytes({ url: 'xdt-file://local/?path=' + encodeURIComponent(path.join(root, 'registered.pdf')) })).rejects.toThrow('[VERSION_NOT_READABLE]');
    removeMember();
    await expect(readPreviewBytes({ url })).rejects.toThrow('[VERSION_NOT_READABLE]');
  });

  it('registered PDF reply is dropped when its real source becomes stale across grant await', async () => {
    const source = previewSource();
    let finish!: (value: { bytes: Uint8Array<ArrayBuffer>; mime: string }) => void;
    const wait = new Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }>(resolve => { finish = resolve; });
    const url = issueMaterialPreview(() => wait);
    const result = ipcWiring(source.event)({ url });
    source.sender.emit('did-start-navigation', {}, source.frame.url, false, true);
    finish({ bytes: new Uint8Array([37, 80, 68, 70]), mime: 'application/pdf' });
    await expect(result).rejects.toThrow('[VERSION_NOT_READABLE]');
    for (const name of ['did-start-navigation', 'destroyed', 'render-process-gone']) expect(source.sender.listenerCount(name)).toBe(0);
  });

  /** Handler race regression, unit behavior within this existing integration file.
   * Existing grant tests covered owner/version changes, not the replying Electron source.
   * Minimal input: real issued grant paused at read, then source invalidation before resolve.
   * Real issuer/loader/handler; only Electron objects/events and trusted predicate controlled. */
  it.each([
    'trusted-source', 'navigation-roundtrip', 'same-document-navigation', 'destroyed',
    'destroyed-flag', 'renderer-gone', 'detached-frame', 'replaced-frame',
    'replaced-event-frame', 'replaced-sender', 'process-change', 'routing-change', 'url-change',
  ])('does not return PDF bytes after source invalidation during read: %s', async change => {
    const source = previewSource();
    let finish!: (value: { bytes: Uint8Array<ArrayBuffer>; mime: string }) => void;
    const pendingRead = new Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }>(resolve => { finish = resolve; });
    const read = vi.fn(() => pendingRead);
    const url = issueMaterialPreview(read);
    const result = readMaterialPreviewPdfBytes(source.event as never, { url });
    expect(read).toHaveBeenCalledOnce(); // The request must actually cross the await boundary.
    if (change === 'trusted-source') env.sourceTrusted = false;
    if (change === 'navigation-roundtrip' || change === 'same-document-navigation') {
      source.sender.emit('did-start-navigation', {}, source.frame.url, change === 'same-document-navigation', true);
      // The same frame/URL and trusted verdict are current again; this read stays invalid.
    }
    if (change === 'destroyed') source.sender.emit('destroyed');
    if (change === 'destroyed-flag') source.state.destroyed = true;
    if (change === 'renderer-gone') source.sender.emit('render-process-gone', {}, { reason: 'crashed' });
    if (change === 'detached-frame') source.frame.detached = true;
    if (change === 'replaced-frame') source.sender.mainFrame = { ...source.frame };
    if (change === 'replaced-event-frame') source.event.senderFrame = { ...source.frame };
    if (change === 'replaced-sender') source.event.sender = previewSource().sender;
    if (change === 'process-change') source.frame.processId++;
    if (change === 'routing-change') source.frame.routingId++;
    if (change === 'url-change') source.frame.url = 'file:///cindy/index.html?other';
    finish({ bytes: new Uint8Array([37, 80, 68, 70]), mime: 'application/pdf' });
    await expect(result).rejects.toThrow('[VERSION_NOT_READABLE] Material preview is unavailable');
    for (const name of ['did-start-navigation', 'destroyed', 'render-process-gone']) {
      expect(source.sender.listenerCount(name)).toBe(0);
    }
  });

  it.each(['success', 'read-error'])('cleans source listeners after %s and permits unrelated subframe navigation', async mode => {
    const source = previewSource(), bytes = new Uint8Array([37, 80, 68, 70]);
    const url = issueMaterialPreview(async () => {
      source.sender.emit('did-start-navigation', {}, 'https://subframe.invalid', false, false);
      if (mode === 'read-error') throw Error('private path or content');
      return { bytes, mime: 'application/pdf' };
    });
    const result = readMaterialPreviewPdfBytes(source.event as never, { url });
    if (mode === 'success') expect((await result).bytes).toBe(bytes);
    else await expect(result).rejects.toThrow('[VERSION_NOT_READABLE] Material preview is unavailable');
    for (const name of ['did-start-navigation', 'destroyed', 'render-process-gone']) {
      expect(source.sender.listenerCount(name)).toBe(0);
    }
  });

});

