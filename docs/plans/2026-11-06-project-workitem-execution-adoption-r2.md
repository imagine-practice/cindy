# Existing work-item adoption: admission receipt revision 2

## Scope and fixed inputs

Independent `project-workitem-execution-adoption-r2`, base `1b18485d193812fa0a91a59939b0ab2aa2149707`. The 59 effective input paths are copied only after SHA256 verification against r1 manifest `A0B45ADFBA4846768CFD1BD9D491E03279EDA4A15B47B96659D8C2F308DD9638`. The original r1 source, manifest and logs remain unchanged. This revision changes the main preparation service, only the pending/unknown reply text in the formal delegation entry, its existing canonical tests, and this handoff. No schema, migration, registry, delegation lifecycle or public interface changes.

## Reproduced failure

`before-tests.txt`: 6 failures / 704 skipped, exit 1, 38.74s. All six call the real migrated 0152 SQLite worker and inject the fault only after `admit` has actually returned from SQLite. Both first admission and existing-execution receipt admission are covered, each with owner epoch change, source boundary change, or transport ACK loss. Persisted delegation/request rows coexist with r1's inaccurate "was not admitted" response. This is a receipt-classification defect, not a new grant or rollback guarantee.

## Minimal fix

`createProjectWorkItemExecutionService(...).start(input)` and all request/result signatures remain unchanged.

A per-invocation boolean records that `admit` submission may have committed immediately before invoking the captured-client transport. A definitive worker `{ok:false}` clears it because this operation's worker checks reject before its writes. A thrown transport/ACK or any subsequent guard exception leaves the state uncertain. The outer catch then returns exactly:

```ts
{
  ok: false,
  errorCode: 'FOLLOWUP_OUTCOME_UNKNOWN',
  message: 'Project work-item admission may have committed; retry only with the same requestId',
}
```

No raw exception, actor, path, project title or body is returned. No second admission, dispatch, rollback, automatic key change, or ledger update is attempted by this catch. Inspect/pre-submit failures retain their original code, as do definitive worker rejections. Owner/source/client guards remain in place. The boolean is not a durable deduplication store: the existing 0152 ledger still owns request replay.

After a committed first admission, same requestId recovery returns existing `FOLLOWUP_PENDING`; after committed existing-execution admission, it returns the persisted original receipt. Both are reauthorized by the normal formal entry. Pending and unknown replay messages now explicitly describe recorded admission or an unconfirmed outcome; they no longer call these states "not admitted". Neither recovery manufactures a new Session, input, run, lifecycle event, group message or dispatch. An unknown response does not prove dispatch or provider consumption. A transport exception may occur before SQLite executes too; without a trustworthy negative ACK it is deliberately classified as uncertain rather than a zero-write refusal.

## Validation

New regression selection: `reports commit uncertainty|preserves definite precommit`: 8 passed / 704 skipped, exit 0, 25.68s total / 1.53s tests. Six postcommit cases exercise actual worker writes and then fresh service recovery with the original requestId; two cases preserve `OWNER_SCOPE_CHANGED` before admission and a real `FORBIDDEN` worker rejection with zero ledger/delegation writes. Read snapshots compare sessions, messages, Bot lifecycle events, group messages, ledger rows, original child and run sequence before/after recovery; controlled dispatcher remains untouched.

The original 43-case selection passed separately with these two new test-name patterns excluded: 43 passed / 669 skipped, exit 0, 30.37s total / 5.56s tests. Exact final logs, typecheck, documentation/test-hygiene results and all output/patch hashes are fixed in the revision-2 manifest under `artifacts/project-workitem-execution-adoption-r2/`. Earlier failure logs are retained rather than overwritten. Existing DB fixture loading/migration collection dominates total time; new tests introduce no sleeps, resetModules, model calls or relaxed timeouts.

## Integration boundary

Apply only the r2-relative-to-r1 patch after r1. Production hunks are the classification in `projectWorkItemExecutionService.ts` and pending/unknown reply text in `botDelegationService.ts`; the pinned worker and delegation execution logic remain unchanged. The central `bots.adoptProjectWorkItem` transport and G3 source/project-control bridges remain integration work. The actual main/native worker registration, real account/source origin, network group/provider operation and future consumption boundary are not validated by controlled-host tests. No models, user databases or real groups were used; no commits, pushes or merges.

Author validation is not independent acceptance.

The full Desktop typecheck exited 0. The final additional production change after that check only corrects the two reply message strings; the final new-8 and original-43 selections were rerun after this change. No signatures or type structure changed.
