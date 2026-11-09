# Entity project mutation Host integration

## Provider connection (integration owner only)

Import `createEntityProjectMutation` from `./entityProjectMutation.js` in
`mcp-providers.ts`. Beside the existing `entityProjects` callback, supply:

```ts
entityProjectMutation: createEntityProjectMutation({
  input: getTaskActionInputState,
  getSession: getTaskActionSession,
}),
```

The exported signature is
`createEntityProjectMutation(runtime: EntityProjectRuntime): EntityProjectMutationCallback`.
Preserve the provider's existing `authorizeCall: authorizeTaskToolCall`, which uses
`createTaskToolCallAuthorizer` and `createDesktopTaskActionAuthorizer`; do not register
an unguarded alternative. This slice adds the tool to the existing task-action effect
set, so teammate/automatic requests use that same permission path. Ordinary owner
tasks retain their normal harness permission behavior; no new approval policy is added.
No provider, runtime registration, UI parity ledger or public MCP file is changed here.

## Dispatch and receipt contract

The public MCP server supplies the bound callerSessionId; the adapter captures the
existing EntityProjectAuthority and passes its explicit actor and captured DbClient
to the real mutateProjects service. create.input.owner is business intent, never actor.
The package's seven-action contract remains unchanged, including the service-owned
default owner and kind/id member deduplication.

mutateProjects now accepts an optional fourth, main-only ProjectMutationGuard.
After all asynchronous access prechecks, beforeDispatch refreshes the captured
task-action permission evidence and source/owner/group authority. Immediately before
client.tx, dispatching synchronously checks authority and permission evidence and
marks the write as dispatched. The authority's existing assertCurrent additionally
checks its captured group lease synchronously, closing the last-await gap.
Old callers omit this guard and retain their behavior; raw IPC never supplies it.
Existing transaction membership and ownership checks remain authoritative.

After service completion the adapter refreshes the caller lifecycle again. It does
not require project membership after the mutation: successful transfer/removal and
permission to read project contents are different facts. Success exposes only
projectId and sessionId, with no project body or private fields.

Before dispatch, refusal means not-applied. After dispatch, every failure is
conservatively unknown, including a recognizable transaction rejection, lost
receipt, account/input change or notification failure. The service continues its
normal broadcasts and reports swallowed notification failures through the optional
guard; existing callers still receive their original result. No automatic retry or
persistent idempotency is introduced. Domain codes map into the fixed public union;
exception messages, SQL and paths never leave the adapter.

## Tests and limits

entityProjectMutation.test.ts resides in localDb/__tests__, hence the existing DB
tier selects it and fast unit excludes it. It uses the public MCP Client and real
registry, real Host action authorizer and project authority, real service/dispatcher,
and an isolated in-memory SQLite database with official migration replay through 0148.
The schema is migrated once; per-case transactions roll back fixtures.
It covers all seven actions, null clearing, owner versus actor, kind/id deduplication,
injected identity, service/transaction permission checks, async precheck revocation,
post-commit lifecycle/notification failures, no retries and old directory coexistence.
The existing task-action test matrix now also covers the new tool.
Windows validation: combined regression 223/223 in 4.25s; standalone DB file
22/22 in 6.01s (554ms test body, 4.68s module collection). It is intentionally
in DB tier rather than the fast unit gate. Desktop typecheck passed.

Electron notifications, app owner/runtime input facts and real group execution lease
validation are controlled. No user profile DB, real group/network/model, worker process,
production provider wiring, multi-device or UI acceptance is claimed. The integration
owner must retain the provider's live permission callback and independently validate
the resulting application wiring.

## Assembly and environment

The isolated tree starts at 1b18485d193812fa0a91a59939b0ab2aa2149707, with the 43 fixed
A files and seven B implementation files hash-verified before byte assembly. Only
the seven implementation files listed in this delivery's manifest are the new slice;
apply its mutation-host-only.patch over that assembled support, not over bare base.
Central effect-set edits need semantic integration by the single integrator.
The original inspiring-liskov delivery is unchanged.

Windows native dependencies were installed independently. A later test encountered
a pnpm-store hardlinked better-sqlite3 binary with an incompatible ABI. Only this
tree's native binding was detached from its hardlinks, then the repository's
ensure-deps script restored the current Node ABI. Other author trees were not edited.
No commits, pushes, schema changes or new migrations were made.
