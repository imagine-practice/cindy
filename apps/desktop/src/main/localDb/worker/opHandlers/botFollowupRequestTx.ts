import type Database from 'better-sqlite3';
import type { BotFollowupRequestArgs, BotFollowupRequestRecord, BotFollowupRequestResult, BotsReopenDelegationArgs, BotsReopenDelegationResult } from '../../client/tx/types.js';

const columns = `task_id AS taskId, requester_bot_id AS requesterBotId, key_digest AS keyDigest,
  body_digest AS bodyDigest, input_id AS inputId, admitted_run_sequence AS admittedRunSequence,
  child_session_id AS childSessionId, phase, native_accepted_at AS nativeAcceptedAt,
  result_json AS resultJson, created_at AS createdAt, updated_at AS updatedAt`;
type Stored = Omit<BotFollowupRequestRecord, 'result'> & { resultJson: string | null };
function decode(row: Stored): BotFollowupRequestRecord {
  const { resultJson, ...rest } = row;
  return { ...rest, result: resultJson === null ? null : JSON.parse(resultJson) };
}

/** Uses the production connection; fixture DDL is deliberately not run here. */
export function runBotFollowupRequest(
  db: Database.Database, raw: unknown,
  reopen: (args: BotsReopenDelegationArgs) => BotsReopenDelegationResult,
): BotFollowupRequestResult {
  const p = raw as BotFollowupRequestArgs;
  if (!p || typeof p.taskId !== 'string') throw new Error('Invalid follow-up request');
  const byInput = (inputId: string) => db.prepare(`SELECT ${columns} FROM bot_task_followup_requests
    WHERE task_id = ? AND input_id = ?`).get(p.taskId, inputId) as Stored | undefined;
  const result = (row: Stored | undefined): BotFollowupRequestResult => row
    ? { kind: 'request', request: decode(row) } : { kind: 'missing' };
  if (p.action === 'lookup') return result(db.prepare(`SELECT ${columns} FROM bot_task_followup_requests
    WHERE task_id = ? AND requester_bot_id = ? AND key_digest = ?`).get(p.taskId, p.requesterBotId, p.keyDigest) as Stored | undefined);
  if (p.action === 'input') return result(byInput(p.inputId));
  if (p.action === 'run') return result(db.prepare(`SELECT ${columns} FROM bot_task_followup_requests
    WHERE task_id = ? AND admitted_run_sequence = ? ORDER BY created_at, input_id LIMIT 1`)
    .get(p.taskId, p.runSequence) as Stored | undefined);

  return db.transaction((): BotFollowupRequestResult => {
    if (p.action === 'admit') {
      if (!Number.isSafeInteger(p.expectedRunSequence) || p.expectedRunSequence < 1) throw new Error('Invalid expectedRunSequence');
      if (![p.keyDigest, p.bodyDigest].every(x => /^[a-f0-9]{64}$/.test(x))) throw new Error('Invalid follow-up digest');
      const current = db.prepare(`SELECT requesting_bot_id AS botId, child_session_id AS childId,
        run_sequence AS run, status, pending_interaction_json AS interaction, permission_snapshot_json AS snapshot
        FROM bot_delegations WHERE id = ?`).get(p.taskId) as
        { botId: string; childId: string; run: number; status: string; interaction: string | null; snapshot: string } | undefined;
      if (!current || current.botId !== p.requesterBotId || current.childId !== p.childSessionId) return { kind: 'changed' };
      const old = db.prepare(`SELECT ${columns} FROM bot_task_followup_requests
        WHERE task_id = ? AND requester_bot_id = ? AND key_digest = ?`)
        .get(p.taskId, p.requesterBotId, p.keyDigest) as Stored | undefined;
      if (old) return old.bodyDigest === p.bodyDigest ? result(old) : { kind: 'conflict' };
      if (current.run !== p.expectedRunSequence) return { kind: 'changed' };
      const snapshot = JSON.parse(current.snapshot);
      if (snapshot.taskPause || snapshot.taskCancelRequested || current.interaction) return { kind: 'changed' };
      const child = db.prepare('SELECT status FROM sessions WHERE id = ?').get(p.childSessionId) as { status: string } | undefined;
      if (child?.status !== 'active') return { kind: 'changed' };
      let run = current.run;
      if (p.reopen) {
        if (p.reopen.delegationId !== p.taskId || p.reopen.requestingBotId !== p.requesterBotId
          || p.reopen.childSessionId !== p.childSessionId || p.reopen.expectedRunSequence !== p.expectedRunSequence) throw new Error('Mismatched follow-up reopen');
        if (!reopen(p.reopen).reopened) return { kind: 'changed' };
        run += 1;
      } else if (!['running', 'waiting'].includes(current.status)) return { kind: 'changed' };
      // Any insert/constraint failure rolls back the reopen and parent mutation too.
      db.prepare(`INSERT INTO bot_task_followup_requests
        (task_id, requester_bot_id, key_digest, body_digest, input_id, admitted_run_sequence,
         child_session_id, phase, native_accepted_at, result_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'admitted', NULL, NULL, ?, ?)`)
        .run(p.taskId, p.requesterBotId, p.keyDigest, p.bodyDigest, p.inputId, run, p.childSessionId, p.now, p.now);
      return { kind: 'admitted', request: decode(byInput(p.inputId)!) };
    }
    const old = byInput(p.inputId);
    if (!old) return { kind: 'missing' };
    if (p.action === 'claim') {
      const task = db.prepare(`SELECT run_sequence AS run, status, pending_interaction_json AS interaction,
        permission_snapshot_json AS snapshot FROM bot_delegations WHERE id = ? AND child_session_id = ?`)
        .get(p.taskId, old.childSessionId) as { run: number; status: string; interaction: string | null; snapshot: string } | undefined;
      const child = db.prepare('SELECT status FROM sessions WHERE id = ?').get(old.childSessionId) as { status: string } | undefined;
      if (!task || task.run !== old.admittedRunSequence || !['queued', 'running', 'waiting'].includes(task.status)
        || task.interaction || JSON.parse(task.snapshot).taskPause || JSON.parse(task.snapshot).taskCancelRequested
        || child?.status !== 'active') return { kind: 'changed' };
      const claimed = db.prepare(`UPDATE bot_task_followup_requests SET phase = 'dispatching', updated_at = ?
        WHERE task_id = ? AND input_id = ? AND phase = 'admitted'`).run(p.now, p.taskId, p.inputId);
      return claimed.changes ? { kind: 'claimed', request: decode(byInput(p.inputId)!) } : result(old);
    }
    if (p.action === 'accepted') db.prepare(`UPDATE bot_task_followup_requests
      SET native_accepted_at = COALESCE(native_accepted_at, ?), updated_at = ? WHERE task_id = ? AND input_id = ?`)
      .run(p.now, p.now, p.taskId, p.inputId);
    else if (p.action === 'unknown') db.prepare(`UPDATE bot_task_followup_requests SET phase = 'unknown', updated_at = ?
      WHERE task_id = ? AND input_id = ? AND phase = 'dispatching'`).run(p.now, p.taskId, p.inputId);
    else if (p.action === 'finish') db.prepare(`UPDATE bot_task_followup_requests SET phase = 'settled', result_json = ?, updated_at = ?
      WHERE task_id = ? AND input_id = ? AND phase = 'dispatching'`).run(JSON.stringify(p.result), p.now, p.taskId, p.inputId);
    else throw new Error('Unknown follow-up action');
    return result(byInput(p.inputId));
  })();
}
