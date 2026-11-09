# Existing project work-item execution adoption v1

Main-only candidate; no public tools, central registration, schema or migration changes in this slice. Production source is pinned 0152 joint input. This entry starts work only for explicit `intent: 'start'`; query/reference/assignment does not execute.

## Signature and ownership

`createProjectWorkItemExecutionService({ runtime, delegation, transact, now }).start(input)`:

```ts
type Input = {
  intent: 'start'; callerSessionId: string; targetBotId: string;
  projectId: string; sessionId: string; expectedBindingRevision: number;
  requestId: string; objective: string;
};
```

No actor, permission, model, source flags, time, plan or path is accepted from raw input. Reuse fixed `captureEntityProjectAuthority` for host principal/owner-client epoch/source identity only, not as execution authorization. The formal delegation service additionally resolves the actual caller and existing owner-action/group/taskAction guard. The requested executor must equal that real caller Bot; an upstream orchestrator must route through the target Bot's genuine authorized execution, never impersonate it or revive a private/group lane as the target work item. Owner agency is resolved by existing host authority, not inferred from source evidence or assignee.

`transact(capturedClient, request)` is a required trusted main transport to the new dedicated worker core; there is no success fallback. Central typed tx/worker registration is handed to the unique integrator/data owner, not edited here. Tests inject the real SQLite core, not a fake success callback. This is not full native-worker registration or G3 source orchestration.

## Transaction contract (0152 reuse; no new table required)

Dedicated operation `bots.adoptProjectWorkItem`, actions inspect/admit/verify. The envelope carries main-injected actor(kind,id), target Bot, project/session/bindingRevision, stable request/body digest and captured immutable session configuration. inspect/verify are authoritative single SQLite snapshots; admit is one immediate SQLite transaction.

admit checks active project, exact actor membership AND Bot-kind executor membership, current binding revision, active ordinary desktop target, no Bot session link of any private/canonical/thread/group/routine role, no pending native/queued execution, and unchanged target configuration. It serializes existing-delegation lookup and insertion on this same connection. Existing execution is returned for the existing formal task channel, never reopened. Directory conflicts use existing working-directory equivalence and durable active execution rows; actual runtime/session lock remains required too. Different conflict-free work items are independent, not globally serialized by Bot.

Insert only a formal `bot_delegations` row pointing to the original `sessions.id` plus its request admission in existing `bot_task_followup_requests` (0152), atomically. Do not INSERT/UPDATE/replace sessions, its parent, model, permission, assignee, binding or history. Use a deterministic work-item delegation identity and a fixed existing interjection-style input ID, with the 0152 global input uniqueness. The first admission is run 1; new request IDs on an existing execution query it instead of spawning a second execution. Same request/different canonical intent is conflict. Request scope/body includes project, binding, session, actual executor and actor; no source label becomes ownerVerified.

The execution plan uses the target session's existing model/permission/workdir unchanged. Caller authorization remains live. Pause/archive/delete and unknown prior execution cannot be implicitly resumed. Native acceptance revalidates project/caller/executor/binding/config and source/owner guard; unknown ACK retains the original admission/input and does not start another run. Formal projection, timeout, dispatch, native receipt and result delivery reuse botDelegationService. SQLite and future provider network are not claimed atomic.

## Write domain and staged delivery

At most eight slice outputs: pure shared DTO; new main service; dedicated worker core; minimal botDelegationService entry/acceptance guard; original canonical test group; this contract; handoff. One optional test helper if needed. No central tx/types, worker registration, existing frozen trees/I1, schema/migration, UI or public tool edits. Fixed authority helper/support is separately hash-whitelisted input.

First prove the old startSessionTask allocates another child. Then test the new entry on real migrated 0152 SQLite with controlled native dispatch: same session/config/history/parent, original result delivery, existing delegation, competing starts, request conflict/unknown/restart, membership revocation at admission/native acceptance, binding ABA, same ID/different kind, busy directory/runtime, pause/archive/delete and rollback. A missing central transport remains explicitly unavailable until integration; no fixture is described as a registered production entry.
