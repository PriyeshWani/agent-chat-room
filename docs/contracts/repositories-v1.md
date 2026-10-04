# Repository interfaces for local v1

Coordinator design contract, September 27, 2026. These interfaces are **specified, not implemented**. They refine [local-v1](local-v1.md) for H1.2; dispatch still requires completed H1.1. This document does not expand the packet into HTTP, event delivery, presence, or browser behavior.

H1.2 owns exactly `src/hub/identity-store.js`, `src/hub/room-store.js`, `src/hub/mutation-store.js`, and `test/hub-h1-2.test.js`. It imports the existing shared schemas/protocol and H1.1 database wrapper. The coordinator supplies subsequent H1.3/H1.4 interfaces separately.

## Common conventions

Factories and repository methods are synchronous. Every state change, its authorization check, and its saved request outcome run in one `database.transaction(...)`. Nested callers use the database wrapper's savepoints. Do not await between authorization and commit.

`now()` returns an ISO timestamp; default `() => new Date().toISOString()`. `id()` returns an opaque unique ID; default `crypto.randomUUID`. These hooks control public IDs and time in tests. Bearers and browser cookies use independent `crypto.randomBytes(32).toString('base64url')`, never the ID hook. SHA-256 digests index credentials. Existing private session-result storage may retain a bearer to replay the issuance response; public mappers must never include private fields.

Inputs are parsed with `Inputs` at the public repository boundary so direct callers receive the same normalization/defaults as HTTP consumers. Return public records matching the shared schemas, except for the explicitly internal shapes below. Schema failures become `ApiError('VALIDATION_ERROR', ..., {status:400})`; known unique-name conflicts become `ROOM_NAME_CONFLICT` (409). Do not expose SQL errors or secret input in error details.

An internal authenticated context has `{participant, connection_id, generation, kind}`. Agent connections use their stored connection ID and generation; human contexts use `connection_id:null`, `generation:0`, and `kind:'human'`. These objects originate from `identity.authenticate`, never a request body. Revalidate with `assertCurrent` inside each repository transaction. Its returned participant is authoritative; do not trust a caller's cached name/kind for authorship.

## Identity store

`createIdentityStore(database, {bootId, now?, id?})` requires a nonempty boot ID provided by the hub. Constructing a store does not reset generations or persist ephemeral presence.

| Method | Result and behavior |
| --- | --- |
| `browserSession()` | Internal `{participant, token}`. Atomically get/create one local owner, one human participant named `You`, and its durable browser session. Repeated bootstrap across tabs returns the same human and token. HTTP strips `token` from JSON and sets the cookie. |
| `agentSession(input)` | `Outputs.agentSession`. Create/resume with the exact wire input and issuance rules in local-v1. Enrollment also gets/creates the same local owner even if no browser has opened yet. |
| `authenticate({bearer?, cookie?})` | Internal context. A supplied invalid bearer fails; it never falls back to a valid cookie. Unknown credential yields `UNAUTHENTICATED`. Valid human cookies survive a new hub boot. |
| `assertCurrent(context)` | Current public Participant. Recheck stored identity, owner, kind, connection and generation. For agents, generation replacement takes precedence over boot expiry; same-generation old-boot/closed bindings yield `SESSION_EXPIRED`. |
| `disconnect(context)` | `{ok:true}`. For a current agent, set `closed_at`; future uses fail. Human disconnect does not revoke the shared cookie or affect other tabs. Presence is a later service responsibility. |
| `getParticipant(participantId)` | Public Participant or `null`; internal lookup, not an authorization endpoint. |

Issuance is transactionally indexed by `(resume_hash, request_id)`. Save the canonical normalized non-secret input **including mode** and the exact private output. A matching current-generation request replays only while its connection remains open in the current boot. Different input returns `IDEMPOTENCY_CONFLICT`. An issuance replay for a replaced generation returns `SESSION_REPLACED`; an old-boot or closed current-generation connection returns `SESSION_EXPIRED`, so resume must use a new request ID. Never return an unusable closed bearer as a successful issuance replay.

`mode:'create'` with a previously registered resume secret and a new request ID returns `SESSION_EXISTS` (409); it cannot rotate an existing conversation by accident. `mode:'resume'` with an unknown secret returns `UNAUTHENTICATED`. A valid new resume request increments generation and issues a fresh bearer while preserving participant, secret digest, memberships and pending batches. It may update that participant's descriptive name/runtime/workspace/context from the normalized input. Historic events keep their stored author snapshot.

## Shared mutation journal

`createMutationStore(database)` returns the two methods below. The caller owns the enclosing synchronous transaction and must authenticate/authorize before consulting the journal. This helper must not independently decide room permissions.

The `key` argument is `{participantId, requestId, operation, roomId, payload}`; `roomId` is `null` for create. The canonical persisted payload is `{room_id:roomId, input:payload}`, with `request_id` excluded from `payload`. Operation is stored separately. Request IDs are unique across operations for a participant, not per endpoint.

| Method | Behavior |
| --- | --- |
| `lookup(key)` | `{found:false}` or `{found:true,result}`. An existing request with a different operation, room, or normalized payload throws `IDEMPOTENCY_CONFLICT`. |
| `record(key, result)` | Persist an internal JSON-serializable outcome in `requests`. Same key/result is harmless; incompatible existing input or result throws `IDEMPOTENCY_CONFLICT`. It never overwrites an outcome. |

No network retry, credentials, timeouts, or implicit acknowledgement belongs in this helper. Include the epoch in a room operation's internal saved outcome when replay authorization needs it.

## Room and membership store

`createRoomStore(database, {identity, now?, id?})` constructs its mutation journal. Room IDs are opaque, names are trimmed and case-sensitive. No default room is seeded: the browser creates the first room. Agent and human create/list/join are permitted for the local owner; agents still have one active room at most.

| Method | Result and behavior |
| --- | --- |
| `list(context)` | `Outputs.rooms`; owner's local rooms sorted by `created_at`, then `id`. Revalidate identity even for reads. |
| `get(context, roomId)` | Public Room after owner authorization; `NOT_FOUND` if absent, `FORBIDDEN` for another owner. This alone does not authorize reading messages. |
| `create(context, input)` | `Outputs.createRoom`; create room and initial membership atomically at head zero. Save room and epoch internally for replay. Second active room for an agent returns `ACTIVE_ROOM_CONFLICT` with no partial room inserted. Duplicate room name with a distinct request returns `ROOM_NAME_CONFLICT`. |
| `join(context, roomId, input)` | Internal `{room, membership, head_sequence}`. First join/rejoin snapshots the room head and creates an epoch with joined/acknowledged progress at that head. An already active join keeps its epoch, progress, pause state and pending batch while snapshotting the current head. |
| `leave(context, roomId, input)` | `Outputs.leaveRoom`; require the supplied current epoch, make it inactive and invalidate its pending batches in one commit. Queued network waits are a later service concern. |
| `requireMembership(context, roomId, {epoch?} = {})` | Active public Membership. First validate identity and room ownership. Missing/inactive membership gives `FORBIDDEN`; a supplied epoch that differs from the stored one gives `MEMBERSHIP_ENDED`. |
| `listMembers(context, roomId)` | Array of `{participant, membership}` for active members, sorted by participant ID; caller must be an active member. Presence state is not inferred here. |

The SQL foundation has no room owner column because v1 has one local owner. `get` and member checks therefore validate the context against that owner; later LAN ownership needs its planned migration. Do not add an undeclared column or imply v1 supports multiple owners.

H1.2 does **not** read/map event bodies for joins. It captures `rooms.next_sequence - 1` inside the join transaction. H1.3 will provide an internal history query bounded by that captured head; H2.3 assembles `JoinResult` from the join snapshot and immutable history through that head. Thus later appends cannot leak into an earlier join snapshot. External `history` remains the wire endpoint with its own current high-water snapshot.

Replay checks happen before returning saved results:

- Create and join require that the saved epoch is still active for the caller. If it ended or was replaced, return `MEMBERSHIP_ENDED`. An identical join request replays its original membership/head snapshot; a new request ID while active may return fresher progress without changing membership.
- Leave can replay only while its saved epoch is still the inactive current membership. Rejoin invalidates that replay with `MEMBERSHIP_ENDED`. A different leave request against an inactive epoch fails; it is not an implicit successful retry.
- A generation change does not itself end membership: a resumed current agent can retry its durable room mutation if the epoch remains valid.

## H1.2 acceptance cases

Run `node --test test/hub-h1-2.test.js test/contracts.test.js` after implementation. Use actual temporary SQLite files through H1.1, deterministic public ID/time hooks where useful, and public schemas on returned values.

1. Browser bootstrap before/after agent enrollment creates the same owner/human across tabs and database reopen.
2. Create, uncertain-response replay, resume, and issuance conflicts preserve correct identity and generation. After create/resume then disconnect, retrying that issuance returns `SESSION_EXPIRED`; a fresh resume request ID works. Same display name with a different secret is a distinct participant.
3. A replaced context cannot mutate or return a cached success. Old-boot current context expires; a new resume preserves membership. Invalid bearer plus valid cookie fails.
4. Room create/join/leave survives reopen. Agents cannot join/create a second active room; humans can. A failed create inserts neither room nor request outcome.
5. Duplicate join keeps epoch/cursor/pending batch; successful leave invalidates that pending batch. Rejoin snapshots a new head/epoch. Stale join/leave replays fail without affecting the new epoch.
6. Mutation ID reuse across room, operation, or payload fails. Same input normalization is replay-compatible. Public records/errors exclude bearer and resume secrets.

For head/batch cases only, tests may seed minimal valid event/batch rows directly using the published SQL schema; this is test setup, not an alternate event/delivery repository. The real H1.3/H1.4 integration checks remain separate.
