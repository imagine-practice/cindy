/**
 * Unit: W2 read contract. Exercise the production reader and frozen W1 writer on real
 * in-memory SQLite. Existing writer/view tests cannot detect stale completion evidence,
 * original-project history leakage, or a history LIMIT truncating effective item totals.
 * Minimal failures: missing confirmation event and a 101-event page with >100 items.
 * These are target schema fixtures, not migrations/registered API/real profile evidence.
 * No IO, model calls, real waits or module resets; module imports occur once.
 */
import type Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { readProjectProgressTransaction } from '../worker/opHandlers/projectProgressReadTx';
import { runWorkItemProgressTransaction } from '../worker/opHandlers/workItemProgressTx';
import type { ProjectProgressReadContext } from '../../../shared/projectProgressApi';
import { summarizeWorkItems } from '../../../shared/workItemStatus';

describe('project progress read snapshot', () => {
  let db: Database.Database;
  const owner: ProjectProgressReadContext = { actor: { kind: 'account', id: 'same' } };
  const member: ProjectProgressReadContext = { actor: { kind: 'bot', id: 'same' } };
  const read = (raw: unknown = { projectId: 'p' }, context = owner) =>
    readProjectProgressTransaction(db, raw, context);
  const write = (to: 'doing' | 'done' = 'done') =>
    runWorkItemProgressTransaction(
      db,
      {
        projectId: 'p',
        sessionId: 's',
        expectedRevision: 0,
        expectedBindingRevision: 0,
        requestId: 'first',
        to,
        ...(to === 'done' ? { completionNote: 'Progress confirmed' } : {}),
      },
      { ...owner, now: 1000 },
    );
  const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;

  beforeEach(() => {
    db = createBetterSqliteDatabase(':memory:');
    db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE project_members (project_id TEXT, subject_kind TEXT, subject_id TEXT, role TEXT,
        PRIMARY KEY(project_id,subject_kind,subject_id));
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT,
        status TEXT NOT NULL, project_binding_revision INTEGER NOT NULL DEFAULT 0,
        assignee_kind TEXT, assignee_id TEXT);
      INSERT INTO projects VALUES ('p','active'),('q','active');
      INSERT INTO project_members VALUES ('p','account','same','owner'),('p','bot','same','member'),
        ('q','account','same','owner');
      INSERT INTO sessions VALUES ('s','Original title','p','active',0,'bot','bot-1');
      -- Target fixtures only; production schema/migration belongs to the integration slice.
      CREATE TABLE work_item_progress_events (
        event_id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
        binding_revision INTEGER NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL,
        request_id TEXT NOT NULL, intent_json TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
        reason TEXT, unblock_condition TEXT, resolution TEXT, completion_note TEXT,
        created_at INTEGER NOT NULL, revision INTEGER NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
        UNIQUE(project_id,session_id,actor_kind,actor_id,request_id,binding_revision));
      CREATE TABLE work_item_progress (
        session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, binding_revision INTEGER NOT NULL,
        status TEXT, revision INTEGER NOT NULL, reason TEXT, unblock_condition TEXT,
        completion_event_id INTEGER, updated_by_kind TEXT NOT NULL, updated_by_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
  });
  afterEach(() => db.close());

  it('returns current matching progress, stable actor identity and role hints without internal JSON', () => {
    const saved = write();
    const result = read();
    expect(result.items[0].progress).toEqual(saved.record);
    expect(result.capabilities).toEqual({ canRecord: true, canConfirmDone: true });
    expect(read({ projectId: 'p' }, member).capabilities).toEqual({
      canRecord: true,
      canConfirmDone: false,
    });
    expect(result.history[0]).toMatchObject({
      eventId: saved.eventId,
      actor: { ...owner.actor, displayName: null },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /intent_json|before_json|after_json|intentJson|beforeJson|afterJson/,
    );
  });

  it('rejects revoked/nonmember/missing identity and does not borrow same-id membership', () => {
    write();
    db.exec("DELETE FROM project_members WHERE project_id='p' AND subject_kind='account'");
    const before = changes();
    expect(() => read()).toThrow('[FORBIDDEN]');
    expect(() => read({ projectId: 'p' }, { actor: { kind: 'account', id: 'outsider' } })).toThrow(
      '[FORBIDDEN]',
    );
    expect(() =>
      readProjectProgressTransaction(
        db,
        { projectId: 'p' },
        undefined as unknown as ProjectProgressReadContext,
      ),
    ).toThrow('[FORBIDDEN]');
    expect(read({ projectId: 'p' }, member).history).toHaveLength(1);
    expect(changes()).toBe(before);
  });

  it.each([
    null,
    [],
    {},
    { projectId: '' },
    { projectId: ' ' },
    { projectId: 'p'.repeat(201) },
    { projectId: 'p', actor: owner.actor },
    { projectId: 'p', role: 'owner' },
    { projectId: 'p', now: 1 },
    ...[null, 0, -1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1].map((beforeEventId) => ({
      projectId: 'p',
      beforeEventId,
    })),
  ])('rejects malformed intent %j without writes', (raw) => {
    const before = changes();
    expect(() => read(raw)).toThrow('[INVALID_PARAMS]');
    expect(changes()).toBe(before);
  });

  it('hides missing/inaccessible projects behind a content-free rejection', () => {
    expect(() => read({ projectId: 'missing' })).toThrow('[FORBIDDEN]');
    db.exec("DELETE FROM projects WHERE id='p'");
    expect(() => read()).toThrow('[FORBIDDEN]');
  });

  it.each([
    'DELETE FROM work_item_progress_events',
    "UPDATE work_item_progress_events SET project_id='q'",
    "UPDATE work_item_progress_events SET session_id='other'",
    'UPDATE work_item_progress_events SET binding_revision=1',
    "UPDATE work_item_progress_events SET to_status='doing'",
    "UPDATE work_item_progress_events SET completion_note='   '",
    'UPDATE work_item_progress_events SET revision=9',
    "UPDATE work_item_progress_events SET actor_kind='bot'",
  ])('does not claim done with invalid confirmation evidence: %s', (mutation) => {
    write();
    db.exec(mutation);
    expect(read().items[0].progress).toMatchObject({
      status: null,
      completionEventId: null,
      revision: 1,
    });
  });

  it('keeps historical confirmation valid after owner changes instead of inferring its author', () => {
    write();
    db.exec(
      "UPDATE project_members SET role='member' WHERE subject_kind='account'; UPDATE project_members SET role='owner' WHERE subject_kind='bot'",
    );
    const result = read();
    expect(result.items[0].progress?.status).toBe('done');
    expect(result.history[0].actor).toEqual({ kind: 'account', id: 'same', displayName: null });
    expect(result.capabilities.canConfirmDone).toBe(false);
  });

  it.each(['binding_revision=1', "project_id='q'"])(
    'ignores stale or mismatched current records (%s)',
    (mismatch) => {
      write();
      db.exec(`UPDATE work_item_progress SET ${mismatch}`);
      expect(read().items[0].progress).toBeNull();
    },
  );

  it("exposes each work item's real assignee and reports unassigned as null", () => {
    db.exec(`INSERT INTO sessions VALUES ('unassigned','No owner','p','active',0,NULL,NULL),
      ('unknown-kind','Broken owner','p','active',0,'team','team-1')`);
    const items = read().items;
    expect(items.find((item) => item.sessionId === 's')?.assignee).toEqual({ kind: 'bot', id: 'bot-1' });
    // 未分配就是 null；不认识的 kind 也不当成某个人。
    expect(items.find((item) => item.sessionId === 'unassigned')?.assignee).toBeNull();
    expect(items.find((item) => item.sessionId === 'unknown-kind')?.assignee).toBeNull();
  });

  it('returns unknown for archive without evidence, excludes deleted, and retains explicit archived progress', () => {
    write('doing');
    db.exec(`UPDATE sessions SET status='archived';
      INSERT INTO sessions VALUES ('unknown','No evidence','p','archived',0,NULL,NULL),
        ('deleted','Removed','p','deleted',0,NULL,NULL),('foreign','Private q title','q','active',0,NULL,NULL)`);
    const result = read();
    expect(result.items).toHaveLength(2);
    expect(result.items.find((item) => item.sessionId === 's')?.progress?.status).toBe('doing');
    expect(result.items.find((item) => item.sessionId === 'unknown')?.progress).toBeNull();
    expect(JSON.stringify(result)).not.toContain('Private q title');
  });

  it('reads original-project history after moves/deletion without exposing destination title or events', () => {
    write();
    db.exec(
      "UPDATE sessions SET project_id='q',title='Destination private title',project_binding_revision=1",
    );
    runWorkItemProgressTransaction(
      db,
      {
        projectId: 'q',
        sessionId: 's',
        expectedRevision: 0,
        expectedBindingRevision: 1,
        requestId: 'q-event',
        to: 'doing',
      },
      { ...owner, now: 2000 },
    );
    const original = read();
    expect(original.items).toEqual([]);
    expect(original.history).toHaveLength(1);
    expect(original.history[0].projectId).toBe('p');
    expect(JSON.stringify(original)).not.toContain('Destination private title');
    expect(read({ projectId: 'q' }).history.map((event) => event.projectId)).toEqual(['q']);
    expect(() => read({ projectId: 'q' }, member)).toThrow('[FORBIDDEN]');
    db.exec("UPDATE sessions SET status='deleted'");
    expect(read({ projectId: 'q' }).items).toEqual([]);
    expect(read({ projectId: 'q' }).history).toHaveLength(1);
  });

  it('pages 101 events by stable ID without truncating the 120-item effective set', () => {
    const seed = db.transaction(() => {
      const insert = db.prepare("INSERT INTO sessions VALUES (?,?,'p','active',0,NULL,NULL)");
      for (let i = 1; i < 120; i++) insert.run(`s-${i}`, `Item ${i}`);
      for (let i = 0; i < 101; i++)
        runWorkItemProgressTransaction(
          db,
          {
            projectId: 'p',
            sessionId: 's',
            expectedRevision: i,
            expectedBindingRevision: 0,
            requestId: `r-${i}`,
            to: 'doing',
          },
          { ...owner, now: 1000 },
        );
    });
    seed();
    const before = changes();
    const first = read();
    expect(first.items).toHaveLength(120);
    expect(first.history).toHaveLength(100);
    expect(first.historyPage).toEqual({ limit: 100, hasMore: true, nextBeforeEventId: 2 });
    expect(first.history.map((event) => event.eventId)).toEqual(
      Array.from({ length: 100 }, (_, i) => 101 - i),
    );
    const second = read({ projectId: 'p', beforeEventId: first.historyPage.nextBeforeEventId });
    expect(second.history.map((event) => event.eventId)).toEqual([1]);
    expect(second.items).toEqual(first.items);
    expect(second.historyPage).toEqual({ limit: 100, hasMore: false, nextBeforeEventId: null });
    const summary = summarizeWorkItems(
      first.items.map((item) => ({
        ...item,
        status: item.progress?.status ?? null,
      })),
    );
    expect(summary).toMatchObject({ total: 120, unknownCount: 119, counts: { doing: 1, done: 0 } });
    expect(changes()).toBe(before);
  });

  it('returns capabilities consistent with frozen W1 archive behavior', () => {
    db.exec("UPDATE projects SET status='archived'");
    expect(read().capabilities).toEqual({ canRecord: true, canConfirmDone: true });
    expect(write().record.status).toBe('done');
  });

  it('supports inline embedding with no imported runtime helpers', () => {
    const embedded = new Function(
      `return (${readProjectProgressTransaction.toString()})`,
    )() as typeof readProjectProgressTransaction;
    expect(embedded(db, { projectId: 'p' }, owner).items[0].progress).toBeNull();
  });
});
