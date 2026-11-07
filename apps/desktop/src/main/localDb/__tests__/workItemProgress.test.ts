/**
 * Unit: frozen project-progress contract (2026-11-05). Production transaction entry,
 * real in-memory SQLite; tables below are TARGET FIXTURES, NOT production migrations.
 * Existing pure tests cannot detect forged actors, stale authorization, rollback,
 * replay or persisted evidence. Minimal failures include member completing a task,
 * replay after removal, and moving a completed task to another project.
 * No real waits, user DB, module resets, worker/IPC/UI integration claims.
 */
import type Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runWorkItemProgressTransaction } from '../worker/opHandlers/workItemProgressTx';
import type {
  WorkItemProgressContext,
  WorkItemProgressIntent,
} from '../../../shared/workItemProgress';
import { WORK_ITEM_STATUSES, nextWorkItemStatus } from '../../../shared/workItemStatus';

describe('work item progress SQLite transaction', () => {
  let db: Database.Database;
  const owner: WorkItemProgressContext = { actor: { kind: 'account', id: 'same' }, now: 1000 };
  const member: WorkItemProgressContext = { actor: { kind: 'bot', id: 'same' }, now: 1001 };
  const intent = (patch: Partial<WorkItemProgressIntent> = {}): WorkItemProgressIntent => ({
    projectId: 'p',
    sessionId: 's',
    requestId: 'r',
    expectedRevision: 0,
    expectedBindingRevision: 0,
    to: 'doing',
    ...patch,
  });
  const run = (patch: Partial<WorkItemProgressIntent> = {}, context = owner) =>
    runWorkItemProgressTransaction(db, intent(patch), context);
  const events = () =>
    db.prepare('SELECT * FROM work_item_progress_events ORDER BY event_id').all() as Array<
      Record<string, unknown>
    >;
  const current = () =>
    db.prepare('SELECT * FROM work_item_progress WHERE session_id = ?').get('s');
  const rejected = (fn: () => unknown, code: string) => expect(fn).toThrow(`[${code}]`);

  beforeEach(() => {
    db = createBetterSqliteDatabase(':memory:');
    db.pragma('foreign_keys=ON');
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE project_members (project_id TEXT, subject_kind TEXT, subject_id TEXT, role TEXT,
        PRIMARY KEY(project_id, subject_kind, subject_id));
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT, status TEXT NOT NULL, project_binding_revision INTEGER NOT NULL DEFAULT 0);
      INSERT INTO projects VALUES ('p','active'), ('q','active');
      INSERT INTO project_members VALUES ('p','account','same','owner'), ('p','bot','same','member'),
        ('q','account','same','owner');
      INSERT INTO sessions VALUES ('s','p','active',0);

      -- Target schema fixture only; the integration slice must generate a real migration.
      CREATE TABLE work_item_progress_events (
        event_id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
        binding_revision INTEGER NOT NULL,
        actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
        intent_json TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
        reason TEXT, unblock_condition TEXT, resolution TEXT, completion_note TEXT,
        created_at INTEGER NOT NULL, revision INTEGER NOT NULL,
        before_json TEXT NOT NULL, after_json TEXT NOT NULL,
        UNIQUE(project_id, session_id, actor_kind, actor_id, request_id, binding_revision));
      CREATE TABLE work_item_progress (
        session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, binding_revision INTEGER NOT NULL, status TEXT, revision INTEGER NOT NULL,
        reason TEXT, unblock_condition TEXT, completion_event_id INTEGER REFERENCES work_item_progress_events(event_id),
        updated_by_kind TEXT NOT NULL, updated_by_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
  });
  afterEach(() => db.close());

  it('records first explicit progress from unknown with main-injected identity/time', () => {
    const result = run({}, member);
    expect(result).toMatchObject({
      revision: 1,
      replayed: false,
      record: {
        status: 'doing',
        completionEventId: null,
        updatedBy: member.actor,
        updatedAt: 1001,
      },
    });
    expect(current()).toMatchObject({ status: 'doing', revision: 1 });
    expect(events()[0]).toMatchObject({
      from_status: null,
      to_status: 'doing',
      before_json: 'null',
    });
  });

  it.each(['actor', 'now', 'role', 'members', 'completionEventId'])(
    'rejects client injection of %s',
    (key) => {
      rejected(
        () => runWorkItemProgressTransaction(db, { ...intent(), [key]: owner.actor }, member),
        'INVALID_PARAMS',
      );
      expect(events()).toHaveLength(0);
      expect(current()).toBeUndefined();
    },
  );

  it.each([
    null,
    [],
    {},
    { ...intent(), to: 'unknown' },
    { ...intent(), expectedRevision: -1 },
    { ...intent(), expectedRevision: 0.5 },
    { ...intent(), reason: 42 },
    { ...intent(), requestId: '' },
  ])('rejects invalid intent %j without writes', (raw) => {
    rejected(() => runWorkItemProgressTransaction(db, raw, owner), 'INVALID_PARAMS');
    expect(events()).toHaveLength(0);
  });

  it('requires current membership for writes and replays', () => {
    const first = run({}, member);
    db.prepare("DELETE FROM project_members WHERE project_id='p' AND subject_kind='bot'").run();
    rejected(() => run({}, member), 'FORBIDDEN');
    rejected(() => run({ requestId: 'new', expectedRevision: 1 }, member), 'FORBIDDEN');
    expect(current()).toMatchObject({ revision: first.revision });
    expect(events()).toHaveLength(1);
  });

  it('rechecks owner role before replaying a completion confirmation', () => {
    const patch = { to: 'done' as const, completionNote: 'Progress checked' };
    run(patch);
    db.exec("UPDATE project_members SET role='member' WHERE subject_kind='account'");
    rejected(() => run(patch), 'FORBIDDEN');
    expect(events()).toHaveLength(1);
  });

  it('allows an existing explicit unknown record to receive ordinary progress', () => {
    db.exec(`INSERT INTO work_item_progress VALUES
      ('s','p',0,NULL,3,NULL,NULL,NULL,'account','same',500)`);
    const result = run({ expectedRevision: 3, to: 'todo' });
    expect(result.record).toMatchObject({ status: 'todo', revision: 4 });
    expect(events()[0]).toMatchObject({ from_status: null, to_status: 'todo' });
  });

  it('rejects a missing session without writing history', () => {
    rejected(() => run({ sessionId: 'missing' }), 'NOT_FOUND');
    expect(events()).toHaveLength(0);
  });

  it('does not reveal an inaccessible project or its history', () => {
    run();
    const stranger: WorkItemProgressContext = {
      actor: { kind: 'account', id: 'outsider' },
      now: 2000,
    };
    rejected(() => run({}, stranger), 'FORBIDDEN');
    rejected(() => run({ projectId: 'missing' }, stranger), 'FORBIDDEN');
    expect(events()).toHaveLength(1);
  });

  it('keeps same-id account and bot roles distinct; a bot owner can confirm progress', () => {
    rejected(() => run({ to: 'done', completionNote: 'Progress checked' }, member), 'FORBIDDEN');
    db.prepare("UPDATE project_members SET role='owner' WHERE subject_kind='bot'").run();
    const result = run({ to: 'done', completionNote: 'Progress checked' }, member);
    expect(result.record.updatedBy).toEqual(member.actor);
    expect(events()[0]).toMatchObject({
      actor_kind: 'bot',
      actor_id: 'same',
      completion_note: 'Progress checked',
    });
  });

  it('requires a completion note and binds owner confirmation to the same transaction event', () => {
    rejected(() => run({ to: 'done' }), 'COMPLETION_NOTE_REQUIRED');
    const result = run({ to: 'done', completionNote: ' Owner progress confirmation ' });
    expect(result.record.completionEventId).toBe(result.eventId);
    expect(current()).toMatchObject({ completion_event_id: result.eventId });
    expect(JSON.parse(events()[0].after_json as string)).toEqual(result.record);
    expect(events()[0].completion_note).toBe('Owner progress confirmation');
    const reopened = run({ requestId: 'reopen', expectedRevision: 1, to: 'doing' });
    expect(reopened.record.completionEventId).toBeNull();
    expect(events()).toHaveLength(2);
  });

  it('retains block reason and release condition in append-only release history', () => {
    rejected(() => run({ to: 'blocked' }), 'REASON_REQUIRED');
    rejected(() => run({ to: 'blocked', reason: 'Missing input' }), 'UNBLOCK_CONDITION_REQUIRED');
    run({ to: 'blocked', reason: ' Missing input ', unblockCondition: 'Owner supplies file' });
    const firstEvent = events()[0];
    rejected(
      () => run({ requestId: 'release', expectedRevision: 1, to: 'doing' }),
      'RESOLUTION_REQUIRED',
    );
    rejected(
      () =>
        run({
          requestId: 'skip',
          expectedRevision: 1,
          to: 'done',
          completionNote: 'checked',
          resolution: 'supplied',
        }),
      'ILLEGAL_TRANSITION',
    );
    const result = run({
      requestId: 'release',
      expectedRevision: 1,
      to: 'doing',
      resolution: 'File supplied',
    });
    expect(result.record).toMatchObject({ reason: null, unblockCondition: null });
    expect(events()[0]).toEqual(firstEvent);
    expect(events()[1]).toMatchObject({
      from_status: 'blocked',
      reason: 'Missing input',
      unblock_condition: 'Owner supplies file',
      resolution: 'File supplied',
    });
    expect(JSON.parse(events()[1].before_json as string)).toMatchObject({ status: 'blocked' });
  });

  it('replays original normalized intent before checking stale revision, even after later writes', () => {
    const first = run({ to: 'blocked', reason: ' Missing input ', unblockCondition: 'Ready' });
    run({ requestId: 'second', expectedRevision: 1, to: 'doing', resolution: 'Ready now' });
    const replay = run({ to: 'blocked', reason: 'Missing input', unblockCondition: ' Ready ' });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(current()).toMatchObject({ revision: 2, status: 'doing' });
    expect(events()).toHaveLength(2);
    rejected(
      () => run({ to: 'blocked', reason: 'Other input', unblockCondition: 'Ready' }),
      'REQUEST_CONFLICT',
    );
  });

  it('scopes request IDs by actor kind and id', () => {
    run();
    const second = run({ expectedRevision: 1, to: 'review' }, member);
    expect(second.replayed).toBe(false);
    expect(second.revision).toBe(2);
    expect(events()).toHaveLength(2);
  });

  it('allows only one write for two distinct requests using the same revision', () => {
    run();
    rejected(() => run({ requestId: 'r2', to: 'review' }), 'REVISION_CONFLICT');
    expect(current()).toMatchObject({ revision: 1, status: 'doing' });
    expect(events()).toHaveLength(1);
  });

  it.each(['deleted', 'unbound', 'other-project'])('rejects %s session and replay', (state) => {
    run();
    if (state === 'deleted') db.exec("UPDATE sessions SET status='deleted'");
    else db.prepare('UPDATE sessions SET project_id=?').run(state === 'unbound' ? null : 'q');
    rejected(() => run(), state === 'deleted' ? 'SESSION_DELETED' : 'PROJECT_MISMATCH');
    expect(events()).toHaveLength(1);
  });

  it('does not inherit old-project completion when a completed session moves', () => {
    run({ to: 'done', completionNote: 'Confirmed for p' });
    const oldEvent = events()[0];
    db.exec(
      "UPDATE sessions SET project_id='q', project_binding_revision=project_binding_revision+1",
    );
    rejected(
      () => run({ projectId: 'q', expectedBindingRevision: 1, expectedRevision: 1, to: 'review' }),
      'REVISION_CONFLICT',
    );
    const result = run({ projectId: 'q', expectedBindingRevision: 1, to: 'todo' });
    expect(result.record).toMatchObject({
      projectId: 'q',
      status: 'todo',
      revision: 1,
      completionEventId: null,
    });
    expect(events()[1]).toMatchObject({ project_id: 'q', from_status: null, before_json: 'null' });
    expect(events()[0]).toEqual(oldEvent);
  });

  it.each(['q', null])(
    'consumes binding epochs for p -> %s -> p with no intermediate progress writes',
    (intermediate) => {
      const old = run({ to: 'done', completionNote: 'Confirmed in epoch zero' });
      const oldHistory = JSON.stringify(events());
      const oldCurrent = JSON.stringify(current());
      // Consumer fixture only: the production bindSession producer is tested in its own slice.
      const move = db.prepare(`UPDATE sessions SET project_id=?,
      project_binding_revision=project_binding_revision+1 WHERE id='s'`);
      move.run(intermediate);
      move.run('p');
      const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
      const beforeRejected = changes();
      // The original successful request must not replay done across epochs.
      rejected(
        () => run({ to: 'done', completionNote: 'Confirmed in epoch zero' }),
        'BINDING_CONFLICT',
      );
      rejected(() => run({ requestId: 'fresh-but-stale', to: 'todo' }), 'BINDING_CONFLICT');
      expect(changes()).toBe(beforeRejected);
      expect(JSON.stringify(events())).toBe(oldHistory);
      expect(JSON.stringify(current())).toBe(oldCurrent);
      // The old progress revision is invalid for this binding, even though the project ID matches.
      rejected(
        () => run({ expectedBindingRevision: 2, expectedRevision: old.revision, to: 'todo' }),
        'REVISION_CONFLICT',
      );
      // Reuse the old request ID in the new epoch: this is a new intent, not a replay/conflict.
      const fresh = run({ expectedBindingRevision: 2, to: 'todo' });
      expect(fresh).toMatchObject({
        replayed: false,
        revision: 1,
        record: { status: 'todo', bindingRevision: 2, completionEventId: null },
      });
      expect(events()[1]).toMatchObject({
        from_status: null,
        before_json: 'null',
        binding_revision: 2,
      });
      expect(current()).toMatchObject({ binding_revision: 2, revision: 1, status: 'todo' });
      expect(JSON.stringify(events().slice(0, 1))).toBe(oldHistory);
      expect(run({ expectedBindingRevision: 2, to: 'todo' })).toEqual({ ...fresh, replayed: true });
      expect(events()).toHaveLength(2);
      rejected(
        () => run({ to: 'done', completionNote: 'Confirmed in epoch zero' }),
        'BINDING_CONFLICT',
      );
    },
  );

  it.each([undefined, null, -1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1])(
    'rejects missing or invalid expectedBindingRevision %j',
    (expectedBindingRevision) => {
      rejected(
        () => runWorkItemProgressTransaction(db, { ...intent(), expectedBindingRevision }, owner),
        'INVALID_PARAMS',
      );
      expect(events()).toHaveLength(0);
      expect(current()).toBeUndefined();
    },
  );

  it('checks authorization before an old-epoch replay or binding conflict', () => {
    run({ to: 'done', completionNote: 'Checked' });
    db.exec(`UPDATE sessions SET project_binding_revision=2;
      DELETE FROM project_members WHERE project_id='p' AND subject_kind='account'`);
    rejected(() => run({ to: 'done', completionNote: 'Checked' }), 'FORBIDDEN');
    expect(events()).toHaveLength(1);
  });

  it('includes the epoch in original receipts and completion evidence snapshots', () => {
    db.exec('UPDATE sessions SET project_binding_revision=4');
    const result = run({
      expectedBindingRevision: 4,
      to: 'done',
      completionNote: 'Progress checked',
    });
    expect(result.record.bindingRevision).toBe(4);
    expect(events()[0]).toMatchObject({
      binding_revision: 4,
      event_id: result.record.completionEventId,
    });
    expect(JSON.parse(events()[0].after_json as string)).toEqual(result.record);
    expect(
      run({ expectedBindingRevision: 4, to: 'done', completionNote: 'Progress checked' }),
    ).toEqual({ ...result, replayed: true });
  });

  it('archive does not fabricate done or mutate storage status', () => {
    db.exec("UPDATE sessions SET status='archived'");
    const result = run({ to: 'review' });
    expect(result.record.status).toBe('review');
    expect(result.record.completionEventId).toBeNull();
    expect(db.prepare('SELECT status FROM sessions').get()).toEqual({ status: 'archived' });
  });

  it('rolls back the history insert when saving the current record fails', () => {
    db.exec(`CREATE TRIGGER reject_current BEFORE INSERT ON work_item_progress
      BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;`);
    expect(() => run({ to: 'done', completionNote: 'Checked' })).toThrow('fixture write failure');
    expect(events()).toHaveLength(0);
    expect(current()).toBeUndefined();
  });

  it('preserves the frozen transition graph through the real transaction entry', () => {
    for (const from of WORK_ITEM_STATUSES) {
      for (const to of WORK_ITEM_STATUSES) {
        db.exec('DELETE FROM work_item_progress; DELETE FROM work_item_progress_events');
        run({
          to: from,
          ...(from === 'blocked' ? { reason: 'Wait', unblockCondition: 'Ready' } : {}),
          ...(from === 'done' ? { completionNote: 'Checked' } : {}),
        });
        const patch: Partial<WorkItemProgressIntent> = {
          requestId: 'next',
          expectedRevision: 1,
          to,
          ...(to === 'blocked' ? { reason: 'Wait', unblockCondition: 'Ready' } : {}),
          ...(to === 'done' ? { completionNote: 'Checked' } : {}),
          ...(from === 'blocked' && to !== 'blocked' ? { resolution: 'Ready' } : {}),
        };
        const allowed = nextWorkItemStatus(from, to, { reason: 'Wait' });
        if (allowed.ok) expect(run(patch).record.status).toBe(to);
        else rejected(() => run(patch), allowed.code);
      }
    }
  });

  it('runs without imported runtime helpers when embedded by a legacy inline worker', () => {
    const embedded = new Function(
      `return (${runWorkItemProgressTransaction.toString()})`,
    )() as typeof runWorkItemProgressTransaction;
    expect(embedded(db, intent(), owner).record.status).toBe('doing');
  });
});
