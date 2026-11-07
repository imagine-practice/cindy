# Entity project mutation tool handoff

The public server accepts the optional `entityProjectMutation: EntityProjectMutationCallback`.
Its exact signature and exported intent/result unions live in
[entity_project_mutations.ts](entity_project_mutations.ts), exported from the package index.
Call through `call_tool({name:"mutate_project_entity", args:{intent:{action:"create", input:{name:"Example"}}}})`.
The seven discriminated actions match the frozen desktop ProjectsAction contract.
Names are trimmed and limited to 120 characters; goals are nullable and limited to 2000.
IDs are trimmed; entity/task IDs reject directory and remote identifiers.
Subject IDs use the main parser's nonempty string contract, not display names.
Members and owner are intentions; main deduplicates kind/id and supplies the default owner.

## Host integration still required

Resolve the caller only from the server-bound session context. The callback receives
`{callerSessionId, intent}`; it must resolve actor/account, apply existing live task
permissions and group/visitor boundaries, and recheck account/instance after awaits.
Never use create.input.owner as the actor. Pass the validated intent to the real main
service with its trusted actor; never infer a default account in this package.
No callback means no registered write tool; read callbacks remain independent.
Legacy directory tools keep their original semantics. This is local-only;
remote execution does not fall back to local mutation.

Return success only with exact `{ok:true, projectId:string|null, sessionId:string|null}`.
Failure is `{ok:false, errorCode, writeOutcome:"not-applied"|"unknown"}`; errorCode
is the closed exported union. The package supplies fixed public hints and strips
additional host fields. Map business refusal codes to that union in the host adapter;
do not put raw exception text in codes. Only return not-applied when zero writes is
known. Cancellation before mutation may be CANCELLED/not-applied; cancellation or
notification failure after a possible commit must be unknown. Unexpected throws,
malformed receipts and unknown codes become WRITE_OUTCOME_UNKNOWN.
No retry, persistent idempotency, automatic cancellation, task dispatch or model call
is implemented or promised. Read state before deciding on another request.

## Verification boundary

The unit test uses public MCP Client/InMemoryTransport through the real registry/schema
and controlled callback. It covers all seven actions, nullable clearing, optional owner,
multiple stable subject IDs (including duplicates preserved for main), forged fields,
local context, conditional discovery, projection and uncertain errors without retries.
Existing entity read and directory tests supply coexistence/regression coverage.
This does not validate production Host writes, actor resolution, transaction semantics,
database persistence, real groups or cross-device parity. Integration owner must wire
and independently review those paths; the Agent/UI parity ledger is not marked complete.

The fixed eight read-support files were assembled separately from input A. Apply only
the mutation delta over that support baseline; central server/index/capability edits
require semantic integration with concurrent settings changes. No desktop files,
schema/migrations, prompts, user databases, commits or pushes belong to this slice.
