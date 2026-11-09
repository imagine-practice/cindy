# Native group authority slice A

Uncommitted independent slice based on `1b18485d193812fa0a91a59939b0ab2aa2149707`.
Frozen minimum contract SHA256:
`F845E00D0B0B06CD621871C74749BEEB38FCC0DF10ACB776E027CA93320CE0B1`.

## Main integration

Obtain `groupService.groupAuthority` from the existing main `BotGroupChatService`
returned by `withChatServer`. Absence means unsupported; do not use a local-group
fallback. This is separate from the shared/public `chatServer: ChatServerApi`.
No register/provider/preload/IPC/tool wiring is included.

```ts
capture(roomId: string, permission: 'read' | 'configure', caller: ChatGroupAuthorityCaller): Promise<CapturedChatGroupAuthority>
// caller: { subject: { kind: 'account' | 'bot'; id: string }; assertCurrent(): void }
// result: { facts; assertCurrent(): void; refresh(): Promise<CapturedChatGroupAuthority> }
```

Use a trusted UI event or captured task/project authority for `caller`, never
deserialize it from renderer/tool input or fabricate a caller Session. Task
`assertCurrent` must retain input/client/owner/channel/source group lease fences.
The host's genuine caller capture is the integrator's responsibility. Missing
function/owner scope fails closed, but possession of a function is not proof of
trusted provenance: this API must stay main-only.

`facts` contains endpoint, canonical roomId, ownerId, selfActorId, selected actorId,
role, roomRevision, accessRevision and permission. No names, messages or tokens
are returned. Identity maps from authenticated `/me` and `/actors`; bot subject
IDs are stable external IDs, never server actor IDs or account aliases.

The native closure captures owner scope/generation, DB client, authentication
realm/token, endpoint and service lifetime. Each request and async completion
checks the fences. `assertCurrent` checks local lifetime only. **Replace** the old
capture with `await capture.refresh()` immediately before commit and recheck
afterwards; the old capture expires even when refresh fails. A changed selected
actor or role requires a new operation capture. Do not persist these objects or
forward them to a worker as an authorization boolean.

Read/configuration checks are distinct. Account configuration preserves native
owner-first, self-next, owned-admin-next selection. A bot uses only its exact
owned joined bot actor. Dissolved/non-group rooms are refused; archived groups
are read-only here. Native settings/chat behavior is unchanged.

Completed native resolution maps and account/endpoint-scoped migration receipts
can resolve a legacy alias. An unmigrated local group is **not** upgraded by this
API: native resolveGroup/groupSnapshot registration can issue writes, so the
caller must finish the existing normal migration flow separately. An unresolved
ID must succeed as an actual authorized server room or fail; there is no local
authorization fallback.

## Validation and limits

The dedicated unit fixture invokes real `withChatServer`, real authority selection
and real authenticated HTTP wrapping with controlled request responses. It tests
owner/admin/member, owned admin bot account management, same-ID account/bot,
exact bot request header, different owner, fresh revocation, role changes,
non-group/left membership, owner/endpoint/token/source/disposal fences, missing
guards/capability, HTTP/network failures and completed migration receipts.
All intercepted requests must be GET with the expected authentication header;
unexpected routes fail. No real server/account database/model is used.

Native chat regressions: chatServer, chatServerMembership, chatServerInvitations,
chatServerParity (608 tests passed). Desktop typecheck and test-hygiene were run;
final timing/results and frozen file/patch hashes accompany the delivery manifest.
The standalone fixture's observed total runtime exceeds the 5s target on this
Windows host (5.75–12.85s in recorded runs while other work was running; module
collection dominates, with test execution 40–145ms). No
timeout or baseline was weakened. This remains a validation limitation.

Not verified: live Chat Server response contracts/deployment, real authentication
teardown, real Host/UI/task provenance, macOS, cross-device integration, project
transactions or final registration. No server-side relation or protocol capability
was added. Real `/actors` must be the authenticated owner's directory and `/me`
human `externalId` must match the captured data owner; unknown shapes fail closed.

Server authorization checks and a later SQLite commit are not atomic. Snapshot
revision is not a permission lock. Integrator must preserve committed/unknown
outcomes and withhold private response content after failed post-commit checks;
never claim a committed mutation was rolled back because refresh failed.
