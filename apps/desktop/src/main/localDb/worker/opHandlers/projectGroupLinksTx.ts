import type Database from 'better-sqlite3';
import type { ProjectGroupLinksIntent, ProjectGroupLinksResult, ProjectGroupLink,
  ProjectGroupLinkStatus, ProjectGroupLinkChange } from '../../../../shared/projectGroupLinks';

/** Main-only context from closed dispatch. These fields bind scope, NOT remote group grants.
 * A/main must perform actual group authorization; public callers cannot supply this envelope.
 */
export interface ProjectGroupLinksTxContext {
  actor: { kind: 'account' | 'bot'; id: string };
  accountId: string; deviceId: string;
  group: { endpoint: string; roomId: string };
  now: number;
}
export interface ProjectGroupLinksTxRequest {
  intent: ProjectGroupLinksIntent;
  context: ProjectGroupLinksTxContext;
  /** Main-generated allocation ID, only used by link when no relation exists. */
  newRelationId?: string;
}

/** Self-contained for native and inline workers; all validation/SQL uses this same entry.
 * SQLite proves project roles, scope, CAS and durable replay only, never server permissions.
 */
export function runProjectGroupLinksTransaction(db: Database.Database, raw: unknown): ProjectGroupLinksResult {
  type Row = { id: string; resource_account_id: string; resource_device_id: string; project_id: string;
    group_endpoint: string; group_room_id: string; status: ProjectGroupLinkStatus; revision: number;
    created_at: number; updated_at: number };
  type Receipt = { canonical_intent: string; relation_id: string; commit_revision: number;
    status_at_commit: ProjectGroupLinkStatus; change: ProjectGroupLinkChange };
  const fail=(code:string):never=>{throw new Error('['+code+'] Project group link request rejected');};
  const obj=(v:unknown,required:string[],optional:string[]=[]):Record<string,unknown>=>{
    if(!v||typeof v!=='object'||Array.isArray(v))return fail('INVALID_PARAMS');
    const r=v as Record<string,unknown>;
    if(!required.every(k=>Object.prototype.hasOwnProperty.call(r,k))||Object.keys(r).some(k=>!required.includes(k)&&!optional.includes(k)))return fail('INVALID_PARAMS');
    return r;
  };
  const id=(v:unknown,max=200):string=>{
    if(typeof v!=='string'||!v.length||v.length>max||/\s/u.test(v)||Array.from(v).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))return fail('INVALID_PARAMS');
    return v;
  };
  const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):number=>{
    if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)return fail('INVALID_PARAMS');return v;
  };
  const group=(v:unknown)=>{
    const g=obj(v,['endpoint','roomId']);
    if(typeof g.endpoint!=='string'||g.endpoint.length>2048||Array.from(g.endpoint).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))return fail('INVALID_PARAMS');
    let endpoint=g.endpoint.trim();let end=endpoint.length;
    while(end>0&&endpoint.charCodeAt(end-1)===47)end--;endpoint=endpoint.slice(0,end);
    let url:URL;try{url=new URL(endpoint);}catch{return fail('INVALID_PARAMS');}
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)return fail('INVALID_PARAMS');
    if(typeof g.roomId!=='string'||g.roomId.length!==36||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(g.roomId))return fail('INVALID_PARAMS');
    return {endpoint,roomId:g.roomId.toLowerCase()};
  };
  const view=(r:Row):ProjectGroupLink=>({relationId:r.id,
    group:{endpoint:r.group_endpoint,roomId:r.group_room_id},
    target:{accountId:r.resource_account_id,deviceId:r.resource_device_id,projectId:r.project_id},
    status:r.status,revision:r.revision,createdAt:new Date(r.created_at).toISOString(),updatedAt:new Date(r.updated_at).toISOString()});
  try {
    return db.transaction(():ProjectGroupLinksResult=>{
      const args=obj(raw,['intent','context'],['newRelationId']);
      const c=obj(args.context,['actor','accountId','deviceId','group','now']);
      const actor=obj(c.actor,['kind','id']);
      if(actor.kind!=='account'&&actor.kind!=='bot')return fail('INVALID_PARAMS');
      const actorKind=actor.kind,actorId=id(actor.id),accountId=id(c.accountId),deviceId=id(c.deviceId,500),now=integer(c.now,0,8640000000000000),boundGroup=group(c.group);
      if(!args.intent||typeof args.intent!=='object'||Array.isArray(args.intent))return fail('INVALID_PARAMS');
      const action=(args.intent as Record<string,unknown>).action;
      const i=action==='list'?obj(args.intent,['action','group'],['includeRemoved','cursor','limit']):
        action==='link'?obj(args.intent,['action','requestId','group','target','expectedRevision']):
        action==='unlink'?obj(args.intent,['action','requestId','group','target','expectedRevision','relationId']):fail('INVALID_PARAMS');
      const g=group(i.group);
      if(g.endpoint!==boundGroup.endpoint||g.roomId!==boundGroup.roomId)return fail('UNSUPPORTED_CAPABILITY');
      if(action!=='link'&&args.newRelationId!==undefined)return fail('INVALID_PARAMS');
      const scope=[accountId,deviceId,g.endpoint,g.roomId];
      if(action==='list') {
        if(i.includeRemoved!==undefined&&typeof i.includeRemoved!=='boolean')return fail('INVALID_PARAMS');
        const includeRemoved=i.includeRemoved===true,limit=i.limit===undefined?50:integer(i.limit,1,100);
        let lastId='';
        const cursorScope={v:1,accountId,deviceId,endpoint:g.endpoint,roomId:g.roomId,actorKind,actorId,includeRemoved};
        if(i.cursor!==undefined){
          if(typeof i.cursor!=='string'||!i.cursor.length||i.cursor.length>32768||!/^[A-Za-z0-9_-]+$/.test(i.cursor))return fail('INVALID_PARAMS');
          let decoded:unknown;
          try{const bytes=Buffer.from(i.cursor,'base64url');if(bytes.toString('base64url')!==i.cursor)return fail('INVALID_PARAMS');decoded=JSON.parse(bytes.toString('utf8'));}catch{return fail('INVALID_PARAMS');}
          const parsed=obj(decoded,[...Object.keys(cursorScope),'lastId']);
          if(Object.entries(cursorScope).some(([k,v])=>parsed[k]!==v))return fail('INVALID_PARAMS');lastId=id(parsed.lastId);
        }
        // Filter exact current membership BEFORE LIMIT; no hidden record count/cursor leaks.
        const rows=db.prepare(`SELECT r.* FROM project_group_links r
          JOIN projects p ON p.id=r.project_id
          JOIN project_members m ON m.project_id=r.project_id AND m.subject_kind=? AND m.subject_id=?
          WHERE r.resource_account_id=? AND r.resource_device_id=? AND r.group_endpoint=? AND r.group_room_id=?
          AND r.id>? AND ${includeRemoved?"m.role='owner'":"m.role IN ('owner','member') AND r.status='active'"}
          ORDER BY r.id ASC LIMIT ?`).all(actorKind,actorId,...scope,lastId,limit+1) as Row[];
        const visible=rows.slice(0,limit),tail=visible[visible.length-1];
        const nextCursor=rows.length>limit&&tail?Buffer.from(JSON.stringify({...cursorScope,lastId:tail.id}),'utf8').toString('base64url'):null;
        return {ok:true,contractRevision:1,links:visible.map(view),nextCursor};
      }
      const t=obj(i.target,['accountId','deviceId','projectId']);
      const target={accountId:id(t.accountId),deviceId:id(t.deviceId,500),projectId:id(t.projectId)};
      if(target.accountId!==accountId||target.deviceId!==deviceId)return fail('UNSUPPORTED_CAPABILITY');
      const requestId=id(i.requestId),expectedRevision=integer(i.expectedRevision);
      const relationId=action==='unlink'?id(i.relationId):undefined;
      const allocationId=action==='link'?id(args.newRelationId):undefined;
      // Re-authenticate BEFORE even replaying a successful receipt, including after restart.
      const owner=db.prepare("SELECT m.role FROM projects p JOIN project_members m ON m.project_id=p.id WHERE p.id=? AND m.subject_kind=? AND m.subject_id=? AND m.role='owner'")
        .get(target.projectId,actorKind,actorId);
      if(!owner)return fail('NOT_PROJECT_OWNER');
      const canonical=JSON.stringify({action,group:g,target,expectedRevision,...(relationId===undefined?{}:{relationId})});
      const receipt=db.prepare('SELECT canonical_intent,relation_id,commit_revision,status_at_commit,change FROM project_group_link_requests WHERE actor_kind=? AND actor_id=? AND request_id=?')
        .get(actorKind,actorId,requestId) as Receipt|undefined;
      const read=()=>db.prepare('SELECT * FROM project_group_links WHERE resource_account_id=? AND resource_device_id=? AND group_endpoint=? AND group_room_id=? AND project_id=?')
        .get(...scope,target.projectId) as Row|undefined;
      let row=read();
      if(receipt){
        if(receipt.canonical_intent!==canonical)return fail('REQUEST_CONFLICT');
        if(!row||row.id!==receipt.relation_id)return fail('RELATION_NOT_FOUND');
        return {ok:true,contractRevision:1,requestId,replayed:true,change:receipt.change,
          commit:{relationId:receipt.relation_id,revision:receipt.commit_revision,statusAtCommit:receipt.status_at_commit},current:view(row)};
      }
      if(action==='unlink'&&(!row||row.id!==relationId))return fail('RELATION_NOT_FOUND');
      if((row?.revision??0)!==expectedRevision)return fail('REVISION_CONFLICT');
      let change:ProjectGroupLinkChange='unchanged';
      const status:ProjectGroupLinkStatus=action==='link'?'active':'removed';
      if(!row){
        db.prepare(`INSERT INTO project_group_links(id,resource_account_id,resource_device_id,project_id,group_endpoint,group_room_id,status,revision,
          created_by_kind,created_by_id,updated_by_kind,updated_by_id,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',1,?,?,?,?,?,?)`)
          .run(allocationId!,accountId,deviceId,target.projectId,g.endpoint,g.roomId,actorKind,actorId,actorKind,actorId,now,now);
        change='linked';
      }else if(row.status!==status){
        if(row.revision===Number.MAX_SAFE_INTEGER)return fail('REVISION_CONFLICT');
        db.prepare('UPDATE project_group_links SET status=?,revision=revision+1,updated_by_kind=?,updated_by_id=?,updated_at=? WHERE id=? AND revision=?')
          .run(status,actorKind,actorId,now,row.id,row.revision);
        change=action==='link'?'linked':'unlinked';
      }
      row=read();if(!row)return fail('RELATION_NOT_FOUND');
      db.prepare(`INSERT INTO project_group_link_requests(actor_kind,actor_id,request_id,canonical_intent,relation_id,commit_revision,status_at_commit,change,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(actorKind,actorId,requestId,canonical,row.id,row.revision,row.status,change,now);
      return {ok:true,contractRevision:1,requestId,replayed:false,change,
        commit:{relationId:row.id,revision:row.revision,statusAtCommit:row.status},current:view(row)};
    }).immediate();
  } catch(error) {
    if(error instanceof Error&&/^\[(INVALID_PARAMS|UNSUPPORTED_CAPABILITY|NOT_PROJECT_OWNER|RELATION_NOT_FOUND|REVISION_CONFLICT|REQUEST_CONFLICT)\] Project group link request rejected$/.test(error.message))throw error;
    return fail('INTERNAL');
  }
}
