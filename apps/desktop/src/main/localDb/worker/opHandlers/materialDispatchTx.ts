import type Database from 'better-sqlite3';
import type { MaterialDispatchSelector, MaterialDispatchPreparation, MaterialDispatchMessageKey,
  MaterialDispatchEvidence, MaterialDispatchConsumer, MaterialDispatchReadResult, MaterialDispatchWriteResult,
  MaterialDispatchBeginResult, MaterialDispatchOutcomeResult, MaterialDispatchAttempt, MaterialDispatchRevision } from '../../../../shared/materialDispatch';

/** Closed main -> worker envelope, NOT public tool/IPC arguments. Outcome evidence is
 * constructed only from actual SessionSendResult/vision/reconciliation observations. */
export interface MaterialDispatchHost { actor: { kind: 'account' | 'bot'; id: string }; now: number }
type Base = { key: MaterialDispatchMessageKey; host: MaterialDispatchHost };
export type MaterialDispatchRequest = Base & (
  | { action: 'queue'; expectedRevision: number; selector: MaterialDispatchSelector; contentSha256: string }
  | { action: 'read'; history?: boolean }
  | { action: 'attachMessage'; revision: number; messageId: string }
  | { action: 'cancel'; revision: number }
  | { action: 'prepare'; revision: number; preparation: MaterialDispatchPreparation }
  | { action: 'begin'; revision: number; attemptId: string; turnGeneration: number;
      consumer: MaterialDispatchConsumer; preparationKey: string; referenceIds: string[]; payloadSha256: string }
  | { action: 'recordOutcome'; revision: number; attemptId: string; consumer: MaterialDispatchConsumer;
      turnGeneration: number; evidence: MaterialDispatchEvidence }
);
export type MaterialDispatchResult = MaterialDispatchReadResult | MaterialDispatchWriteResult |
  MaterialDispatchBeginResult | MaterialDispatchOutcomeResult | MaterialDispatchSessionReadResult;
/** Session-scoped ledger read for the UI. Membership is filtered per revision project. */
export interface MaterialDispatchSessionReadResult {
  sessionId: string;
  messages: MaterialDispatchReadResult[];
}

/** Self-contained for native and inline workers. No media bytes or external side effects.
 * Pending is durable BEFORE consumption; an uncertain attempt never licenses another send.
 */
export function runMaterialDispatchTransaction(db: Database.Database, raw: unknown): MaterialDispatchResult {
  const fail = (code: string): never => { throw new Error('[' + code + '] Material dispatch request rejected'); };
  const obj = (x: unknown, required: string[], optional: string[] = []): Record<string, unknown> => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return fail('INVALID_PARAMS');
    const o = x as Record<string, unknown>;
    if (required.some(k => !Object.prototype.hasOwnProperty.call(o, k)) || Object.keys(o).some(k => !required.includes(k) && !optional.includes(k))) return fail('INVALID_PARAMS');
    return o;
  };
  const id = (x: unknown, max = 200): string => {
    if (typeof x !== 'string' || !x.length || x.length > max || /\s/u.test(x) || Array.from(x).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return fail('INVALID_PARAMS');
    return x;
  };
  const int = (x: unknown, min = 0): number => typeof x === 'number' && Number.isSafeInteger(x) && x >= min ? x : fail('INVALID_PARAMS');
  const sha = (x: unknown): string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x) ? x : fail('INVALID_PARAMS');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Native and serialized inline workers both provide CommonJS require.
  const hash = (x: string): string => require('node:crypto').createHash('sha256').update(x).digest('hex');
  const selector = (x: unknown): MaterialDispatchSelector => {
    const s = obj(x, ['contextId','projectId','workItemId','bindingRevision','purpose']);
    if (typeof s.purpose !== 'string' || !['reference','redecompose','recheck'].includes(s.purpose)) return fail('INVALID_PARAMS');
    return { contextId: id(s.contextId), projectId: id(s.projectId), workItemId: id(s.workItemId),
      bindingRevision: int(s.bindingRevision), purpose: s.purpose as MaterialDispatchSelector['purpose'] };
  };
  type Head = { client_id: string; current_revision: number; message_id: string | null };
  type Revision = { revision: number; project_id: string; selector_json: string; content_sha256: string;
    state: MaterialDispatchRevision['state']; preparation_json: string | null };
  type Attempt = { session_id: string; client_id: string; revision: number; attempt_id: string; turn_generation: number; consumer: MaterialDispatchConsumer;
    preparation_key: string; reference_ids_json: string; payload_sha256: string; actor_kind: 'account' | 'bot'; actor_id: string;
    outcome: MaterialDispatchAttempt['outcome']; evidence_json: string | null; created_at: number; updated_at: number };
  const toAttempt = (a: Attempt): MaterialDispatchAttempt => ({ attemptId: a.attempt_id, turnGeneration: a.turn_generation,
    consumer: a.consumer, preparationKey: a.preparation_key, referenceIds: JSON.parse(a.reference_ids_json), payloadSha256: a.payload_sha256,
    actor: { kind: a.actor_kind, id: a.actor_id }, outcome: a.outcome, evidence: a.evidence_json ? JSON.parse(a.evidence_json) : null,
    observations: (db.prepare('SELECT evidence_json FROM material_dispatch_observations WHERE session_id=? AND client_id=? AND revision=? AND attempt_id=? AND consumer=? ORDER BY created_at,rowid')
      .all(a.session_id, a.client_id, a.revision, a.attempt_id, a.consumer) as { evidence_json: string }[]).map(o => JSON.parse(o.evidence_json)),
    createdAt: new Date(a.created_at).toISOString(), updatedAt: new Date(a.updated_at).toISOString() });
  try {
    return db.transaction((): MaterialDispatchResult => {
      const r = obj(raw, ['action','host'], ['key','sessionId','expectedRevision','selector','contentSha256','history','revision','messageId','preparation',
        'attemptId','turnGeneration','consumer','preparationKey','referenceIds','payloadSha256','evidence']);
      const action = r.action;
      const fields: Record<string, string[]> = { queue:['expectedRevision','selector','contentSha256'], read:[],
        readSession:[], attachMessage:['revision','messageId'], cancel:['revision'], prepare:['revision','preparation'],
        begin:['revision','attemptId','turnGeneration','consumer','preparationKey','referenceIds','payloadSha256'],
        recordOutcome:['revision','attemptId','turnGeneration','consumer','evidence'] };
      if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(fields, action)) return fail('INVALID_PARAMS');
      if (action !== 'readSession' && !Object.prototype.hasOwnProperty.call(r, 'key')) return fail('INVALID_PARAMS');
      obj(r, ['action','host',...fields[action]],
        action === 'readSession' ? ['key','sessionId','history'] : ['key','history']);
      const h = obj(r.host, ['actor','now']), a = obj(h.actor, ['kind','id']);
      if (a.kind !== 'account' && a.kind !== 'bot') return fail('INVALID_PARAMS');
      const actorKind = a.kind, actorId = id(a.id), now = int(h.now);
      if (now > 8_640_000_000_000_000) return fail('INVALID_PARAMS');
      const member = (projectId: string): boolean => !!db.prepare("SELECT 1 FROM projects p JOIN project_members m ON m.project_id=p.id WHERE p.id=? AND m.subject_kind=? AND m.subject_id=? AND m.role IN ('owner','member')")
        .get(projectId, actorKind, actorId);
      if (action === 'readSession') {
        if (typeof r.sessionId !== 'string') return fail('INVALID_PARAMS');
        if (r.history !== undefined && typeof r.history !== 'boolean') return fail('INVALID_PARAMS');
        const sessionId = id(r.sessionId);
        // Only rows whose current selector still points at this task, and only projects the
        // caller is a current member of. Hidden rows are omitted, never counted.
        const heads = db.prepare('SELECT * FROM material_dispatch_messages WHERE session_id=? ORDER BY updated_at DESC, client_id LIMIT 200')
          .all(sessionId) as Head[];
        const messages: MaterialDispatchReadResult[] = [];
        for (const head of heads) {
          const current = db.prepare('SELECT * FROM material_dispatch_revisions WHERE session_id=? AND client_id=? AND revision=?')
            .get(sessionId, head.client_id, head.current_revision) as Revision | undefined;
          if (!current) continue;
          const s = selector(JSON.parse(current.selector_json));
          if (s.workItemId !== sessionId || !member(s.projectId)) continue;
          const rows = db.prepare('SELECT * FROM material_dispatch_revisions WHERE session_id=? AND client_id=? ORDER BY revision')
            .all(sessionId, head.client_id) as Revision[];
          const visible = rows.filter(v => (r.history === true || v.revision === head.current_revision) && member(v.project_id));
          messages.push({ key: { sessionId, clientId: head.client_id },
            currentRevision: head.current_revision, messageId: head.message_id,
            revisions: visible.map(v => ({ revision: v.revision, selector: JSON.parse(v.selector_json), contentSha256: v.content_sha256,
              state: v.state, preparation: v.preparation_json ? JSON.parse(v.preparation_json) : null,
              attempts: (db.prepare('SELECT * FROM material_dispatch_attempts WHERE session_id=? AND client_id=? AND revision=? ORDER BY created_at,attempt_id,consumer')
                .all(sessionId, head.client_id, v.revision) as Attempt[]).map(toAttempt) })) });
        }
        return { sessionId, messages };
      }
      const k = obj(r.key, ['sessionId','clientId']), sessionId = id(k.sessionId), clientId = id(k.clientId);
      const key = [sessionId, clientId];
      const head = db.prepare('SELECT * FROM material_dispatch_messages WHERE session_id=? AND client_id=?').get(...key) as Head | undefined;
      const getRevision = (revision: number): Revision => db.prepare('SELECT * FROM material_dispatch_revisions WHERE session_id=? AND client_id=? AND revision=?')
        .get(...key, revision) as Revision | undefined ?? fail('NOT_FOUND');
      const authorize = (s: MaterialDispatchSelector, live: boolean) => {
        if (!member(s.projectId)) return fail('FORBIDDEN');
        if (s.workItemId !== sessionId) return fail('SCOPE_MISMATCH');
        if (!live) return;
        const task = db.prepare('SELECT project_id,project_binding_revision,status FROM sessions WHERE id=?').get(sessionId) as
          { project_id: string | null; project_binding_revision: number; status: string } | undefined;
        if (!task || task.status === 'deleted') return fail('SCOPE_MISMATCH');
        if (task.project_id !== s.projectId || task.project_binding_revision !== s.bindingRevision) return fail('BINDING_CONFLICT');
      };
      const refs = (s: MaterialDispatchSelector) => {
        authorize(s, true);
        const c = db.prepare('SELECT * FROM material_contexts WHERE id=?').get(s.contextId) as
          { project_id: string | null; work_item_id: string; binding_revision: number | null; purpose: string; refs_json: string } | undefined;
        if (!c || c.project_id !== s.projectId || c.work_item_id !== s.workItemId || c.binding_revision !== s.bindingRevision || c.purpose !== s.purpose) return fail('SCOPE_MISMATCH');
        const list: unknown = JSON.parse(c.refs_json);
        // 快照引用数不设业务上限；每条引用仍逐条过身份、作用域与版本校验。
        if (!Array.isArray(list)) return fail('SCOPE_MISMATCH');
        return list.map(v => {
          if (!v || typeof v !== 'object') return fail('SCOPE_MISMATCH');
          const x = v as Record<string, unknown>, referenceId = id(x.referenceId, 400), materialId = id(x.materialId), version = int(x.version, 1);
          const ref = db.prepare('SELECT * FROM material_references WHERE id=?').get(referenceId) as
            { project_id: string; work_item_id: string | null; binding_revision: number | null; material_id: string; status: string } | undefined;
          if (!ref || ref.project_id !== s.projectId || ref.work_item_id !== sessionId || ref.binding_revision !== s.bindingRevision
            || ref.material_id !== materialId || ref.status !== 'active') return fail('REFERENCE_INVALID');
          const ver = db.prepare('SELECT v.id,v.sha256,v.read_state FROM material_versions v JOIN materials m ON m.id=v.material_id WHERE v.material_id=? AND v.version=? AND m.project_id=?')
            .get(materialId, version, s.projectId) as { id: string; sha256: string; read_state: string } | undefined;
          if (!ver) return fail('REFERENCE_INVALID');
          return { referenceId, materialId, version, versionId: ver.id, sha256: ver.sha256, readState: ver.read_state };
        });
      };
      const getAttempt = (revision: number, attemptId: string, consumer: string): Attempt | undefined =>
        db.prepare('SELECT * FROM material_dispatch_attempts WHERE session_id=? AND client_id=? AND revision=? AND attempt_id=? AND consumer=?')
          .get(...key, revision, attemptId, consumer) as Attempt | undefined;
      if (action === 'recordOutcome') {
        // Terminal fact recording is deliberately NOT a new read/start authorization.
        // Main must bind evidence to the captured original consumer, DB and owner; never
        // route this action from a public request. Return no private intent after revocation.
        const revision = int(r.revision, 1), attemptId = id(r.attemptId);
        if (r.consumer !== 'vision' && r.consumer !== 'provider') return fail('INVALID_PARAMS');
        const old = getAttempt(revision, attemptId, r.consumer);
        if (!old || old.actor_kind !== actorKind || old.actor_id !== actorId || old.turn_generation !== int(r.turnGeneration, 1)) return fail('EVIDENCE_CONFLICT');
        const e = obj(r.evidence, ['source','outcome','receiptSha256']);
        if (!['session-send-result','vision-result','host-undispatched','reconciliation'].includes(String(e.source))
          || !['confirmed','not-consumed','unknown'].includes(String(e.outcome))) return fail('INVALID_PARAMS');
        if ((e.source === 'session-send-result' && r.consumer !== 'provider') || (e.source === 'vision-result' && r.consumer !== 'vision')
          || (e.source === 'host-undispatched' && e.outcome !== 'not-consumed')) return fail('EVIDENCE_CONFLICT');
        const evidence: MaterialDispatchEvidence = { source: e.source as MaterialDispatchEvidence['source'],
          outcome: e.outcome as MaterialDispatchEvidence['outcome'], receiptSha256: sha(e.receiptSha256) };
        const encoded = JSON.stringify(evidence);
        const prior = db.prepare('SELECT evidence_json FROM material_dispatch_observations WHERE session_id=? AND client_id=? AND revision=? AND attempt_id=? AND consumer=? AND receipt_sha256=?')
          .get(...key, revision, attemptId, r.consumer, evidence.receiptSha256) as { evidence_json: string } | undefined;
        if (prior) {
          if (prior.evidence_json !== encoded) return fail('EVIDENCE_CONFLICT');
          return { recorded: true, replayed: true };
        }
        if (old.evidence_json === encoded) return { recorded: true, replayed: true };
        if (old.outcome === 'confirmed' || old.outcome === 'not-consumed' || (old.outcome === 'unknown' && e.source !== 'reconciliation')) return fail('EVIDENCE_CONFLICT');
        db.prepare('INSERT INTO material_dispatch_observations(session_id,client_id,revision,attempt_id,consumer,receipt_sha256,evidence_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(...key, revision, attemptId, r.consumer, evidence.receiptSha256, encoded, now);
        db.prepare('UPDATE material_dispatch_attempts SET outcome=?,evidence_json=?,updated_at=? WHERE session_id=? AND client_id=? AND revision=? AND attempt_id=? AND consumer=?')
          .run(e.outcome, encoded, now, ...key, revision, attemptId, r.consumer);
        return { recorded: true, replayed: false };
      }
      if (action === 'queue') {
        const s = selector(r.selector), contentSha256 = sha(r.contentSha256), expected = int(r.expectedRevision);
        refs(s);
        const encoded = JSON.stringify(s);
        if (head) {
          const old = getRevision(head.current_revision);
          authorize(selector(JSON.parse(old.selector_json)), false);
          if (old.selector_json === encoded && old.content_sha256 === contentSha256) {
            if (old.state === 'cancelled') return fail('CANCELLED');
            return { revision: old.revision, replayed: true };
          }
          if (expected !== old.revision) return fail('INTENT_CONFLICT');
          if (head.message_id || old.state !== 'queued') return fail('INTENT_FROZEN');
          db.prepare("UPDATE material_dispatch_revisions SET state='superseded' WHERE session_id=? AND client_id=? AND revision=?")
            .run(...key, old.revision);
        } else {
          if (expected !== 0) return fail('REVISION_CONFLICT');
          if (db.prepare('SELECT 1 FROM messages WHERE session_id=? AND client_id=?').get(...key)) return fail('INTENT_FROZEN');
          db.prepare('INSERT INTO material_dispatch_messages(session_id,client_id,current_revision,message_id,created_at,updated_at) VALUES (?,?,0,NULL,?,?)')
            .run(...key, now, now);
        }
        const revision = (head?.current_revision ?? 0) + 1;
        int(revision, 1);
        db.prepare("INSERT INTO material_dispatch_revisions(session_id,client_id,revision,project_id,selector_json,content_sha256,state,preparation_json,created_at) VALUES (?,?,?,?,?,?,'queued',NULL,?)")
          .run(...key, revision, s.projectId, encoded, contentSha256, now);
        db.prepare('UPDATE material_dispatch_messages SET current_revision=?,updated_at=? WHERE session_id=? AND client_id=?').run(revision, now, ...key);
        return { revision, replayed: false };
      }
      if (!head) return fail('NOT_FOUND');
      if (action === 'read') {
        if (r.history !== undefined && typeof r.history !== 'boolean') return fail('INVALID_PARAMS');
        authorize(selector(JSON.parse(getRevision(head.current_revision).selector_json)), false);
        const rows = db.prepare('SELECT * FROM material_dispatch_revisions WHERE session_id=? AND client_id=? ORDER BY revision').all(...key) as Revision[];
        const visible = rows.filter(v => (r.history === true || v.revision === head.current_revision) && member(v.project_id));
        return { key: { sessionId, clientId }, currentRevision: head.current_revision, messageId: head.message_id,
          revisions: visible.map(v => ({ revision: v.revision, selector: JSON.parse(v.selector_json), contentSha256: v.content_sha256,
            state: v.state, preparation: v.preparation_json ? JSON.parse(v.preparation_json) : null,
            attempts: (db.prepare('SELECT * FROM material_dispatch_attempts WHERE session_id=? AND client_id=? AND revision=? ORDER BY created_at,attempt_id,consumer').all(...key, v.revision) as Attempt[]).map(toAttempt) })) };
      }
      const revision = int(r.revision, 1), v = getRevision(revision), s = selector(JSON.parse(v.selector_json));
      authorize(s, true);
      if (head.current_revision !== revision) return fail('REVISION_CONFLICT');
      if (action === 'cancel') {
        if (db.prepare("SELECT 1 FROM material_dispatch_attempts WHERE session_id=? AND client_id=? AND (outcome IN ('pending','unknown') OR (consumer='provider' AND outcome='confirmed'))").get(...key)) return fail('OUTCOME_UNRESOLVED');
        if (v.state === 'superseded') return fail('REVISION_CONFLICT');
        db.prepare("UPDATE material_dispatch_revisions SET state='cancelled' WHERE session_id=? AND client_id=? AND revision=?").run(...key, revision);
        return { revision, replayed: v.state === 'cancelled' };
      }
      if (v.state === 'cancelled') return fail('CANCELLED');
      if (action === 'attachMessage') {
        const messageId = id(r.messageId);
        const message = db.prepare('SELECT id,role,content,rewind_at FROM messages WHERE session_id=? AND client_id=?').get(...key) as
          { id: string; role: string; content: string; rewind_at: number | null } | undefined;
        if (!message || message.id !== messageId || message.role !== 'user' || message.rewind_at !== null || hash(message.content) !== v.content_sha256) return fail('MESSAGE_MISMATCH');
        if (head.message_id && head.message_id !== messageId) return fail('INTENT_CONFLICT');
        db.prepare('UPDATE material_dispatch_messages SET message_id=?,updated_at=? WHERE session_id=? AND client_id=?').run(messageId, now, ...key);
        db.prepare("UPDATE material_dispatch_revisions SET state='attached' WHERE session_id=? AND client_id=? AND revision=?").run(...key, revision);
        return { revision, replayed: head.message_id === messageId };
      }
      const selected = refs(s);
      if (action === 'prepare') {
        const p = obj(r.preparation, ['preparationKey','items']), preparationKey = sha(p.preparationKey);
        if (!Array.isArray(p.items) || p.items.length !== selected.length) return fail('PREPARATION_CONFLICT');
        const seen = new Set<string>();
        const items = p.items.map(value => {
          const item = obj(value, ['referenceId','materialId','version','versionId','expectedSha256','verifiedSha256','readiness','failureCode','representation','textSha256','coverage']);
          const referenceId = id(item.referenceId, 400), match = selected.find(x => x.referenceId === referenceId);
          if (!match || seen.has(referenceId) || item.materialId !== match.materialId || item.version !== match.version || item.versionId !== match.versionId || item.expectedSha256 !== match.sha256) return fail('PREPARATION_CONFLICT');
          seen.add(referenceId);
          if (!['ready','partial','unsupported','failed'].includes(String(item.readiness)) || !['text','image','pdf-text','unavailable'].includes(String(item.representation))) return fail('INVALID_PARAMS');
          const ready = item.readiness === 'ready' || item.readiness === 'partial';
          if (ready ? item.verifiedSha256 !== match.sha256 || match.readState !== 'ready' || item.representation === 'unavailable'
            : item.verifiedSha256 !== null || item.representation !== 'unavailable') return fail('PREPARATION_CONFLICT');
          const textSha256 = item.textSha256 === null ? null : sha(item.textSha256);
          if ((ready && (item.representation === 'text' || item.representation === 'pdf-text')) !== (textSha256 !== null)) return fail('PREPARATION_CONFLICT');
          const failureCode = item.failureCode;
          if (ready ? failureCode !== null : typeof failureCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(failureCode)) return fail('INVALID_PARAMS');
          let coverage: MaterialDispatchPreparation['items'][number]['coverage'] = null;
          if (item.coverage !== null) {
            const c = obj(item.coverage, ['kind','numPages','pagesInspected','textPages','clipped','completeText','textSha256','textChars','characterLimit','pagesWithoutTextOrNotInspected','visualCoverage']);
            const numPages = int(c.numPages), pagesInspected = int(c.pagesInspected), textPages = int(c.textPages), textChars = int(c.textChars),
              characterLimit = int(c.characterLimit), pagesWithoutTextOrNotInspected = int(c.pagesWithoutTextOrNotInspected);
            if (c.kind !== 'extractable-text-only' || c.visualCoverage !== 'not-assessed' || typeof c.clipped !== 'boolean' || typeof c.completeText !== 'boolean'
              || pagesInspected > numPages || textPages > pagesInspected || pagesWithoutTextOrNotInspected > numPages) return fail('INVALID_PARAMS');
            const pdfTextSha = sha(c.textSha256);
            if (ready && (item.representation !== 'pdf-text' || textSha256 !== pdfTextSha)) return fail('PREPARATION_CONFLICT');
            coverage = { kind: 'extractable-text-only', numPages, pagesInspected, textPages, clipped: c.clipped, completeText: c.completeText,
              textSha256: pdfTextSha, textChars, characterLimit, pagesWithoutTextOrNotInspected, visualCoverage: 'not-assessed' };
          } else if (item.representation === 'pdf-text') return fail('PREPARATION_CONFLICT');
          return { referenceId, materialId: match.materialId, version: match.version, versionId: match.versionId,
            expectedSha256: match.sha256, verifiedSha256: ready ? match.sha256 : null, readiness: item.readiness as MaterialDispatchPreparation['items'][number]['readiness'], failureCode: typeof failureCode === 'string' ? failureCode : null,
            representation: item.representation as MaterialDispatchPreparation['items'][number]['representation'], textSha256, coverage };
        }).sort((a,b) => a.referenceId.localeCompare(b.referenceId));
        const encoded = JSON.stringify({ preparationKey, items });
        if (v.preparation_json && v.preparation_json !== encoded) return fail('PREPARATION_CONFLICT');
        if (!v.preparation_json) db.prepare('UPDATE material_dispatch_revisions SET preparation_json=? WHERE session_id=? AND client_id=? AND revision=?').run(encoded, ...key, revision);
        return { revision, replayed: v.preparation_json === encoded };
      }
      if (action !== 'begin') return fail('INVALID_PARAMS');
      if (v.state !== 'attached' || !head.message_id || !v.preparation_json) return fail('NOT_READY');
      const p: MaterialDispatchPreparation = JSON.parse(v.preparation_json), preparationKey = sha(r.preparationKey);
      if (preparationKey !== p.preparationKey || !Array.isArray(r.referenceIds) || !r.referenceIds.length) return fail('PREPARATION_CONFLICT');
      const referenceIds = r.referenceIds.map(x => id(x, 400)).sort();
      if (new Set(referenceIds).size !== referenceIds.length || referenceIds.some(ref => !p.items.some(x => x.referenceId === ref && (x.readiness === 'ready' || x.readiness === 'partial')))) return fail('PREPARATION_CONFLICT');
      for (const item of p.items.filter(x => referenceIds.includes(x.referenceId))) {
        const actual = selected.find(x => x.referenceId === item.referenceId);
        if (!actual || actual.readState !== 'ready' || actual.sha256 !== item.verifiedSha256 || actual.versionId !== item.versionId) return fail('REFERENCE_INVALID');
      }
      // A rewound/edited user message never borrows an old preparation.
      const message = db.prepare('SELECT id,role,content,rewind_at FROM messages WHERE session_id=? AND client_id=?').get(...key) as
        { id: string; role: string; content: string; rewind_at: number | null } | undefined;
      if (!message || message.id !== head.message_id || message.role !== 'user' || message.rewind_at !== null || hash(message.content) !== v.content_sha256) return fail('MESSAGE_MISMATCH');
      const attemptId = id(r.attemptId), turnGeneration = int(r.turnGeneration, 1), consumer = r.consumer, payloadSha256 = sha(r.payloadSha256);
      if (consumer !== 'vision' && consumer !== 'provider') return fail('INVALID_PARAMS');
      const old = getAttempt(revision, attemptId, consumer);
      if (old) {
        if (old.turn_generation !== turnGeneration || old.preparation_key !== preparationKey || old.reference_ids_json !== JSON.stringify(referenceIds)
          || old.payload_sha256 !== payloadSha256 || old.actor_kind !== actorKind || old.actor_id !== actorId) return fail('INTENT_CONFLICT');
        return { revision, started: false, attempt: toAttempt(old) };
      }
      if (db.prepare("SELECT 1 FROM material_dispatch_attempts WHERE session_id=? AND client_id=? AND (outcome IN ('pending','unknown') OR ((consumer=? OR consumer='provider') AND outcome='confirmed'))")
        .get(...key, consumer)) return fail('OUTCOME_UNRESOLVED');
      db.prepare("INSERT INTO material_dispatch_attempts(session_id,client_id,revision,attempt_id,turn_generation,consumer,preparation_key,reference_ids_json,payload_sha256,actor_kind,actor_id,outcome,evidence_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',NULL,?,?)")
        .run(...key, revision, attemptId, turnGeneration, consumer, preparationKey, JSON.stringify(referenceIds), payloadSha256, actorKind, actorId, now, now);
      return { revision, started: true, attempt: toAttempt(getAttempt(revision, attemptId, consumer)!) };
    }).immediate();
  } catch (error) {
    if (error instanceof Error && /^\[[A-Z_]+\] Material dispatch request rejected$/.test(error.message)) throw error;
    return fail('INTERNAL');
  }
}
