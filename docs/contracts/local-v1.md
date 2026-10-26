# Local room contract v1

Protocol version `1`. Authoritative wire schemas: `src/shared/schemas.js`. Portable client: `src/shared/client.js`. Fixtures are synthetic and never imported by production code. Astra reviewed the delivery and authentication decisions below.

## Runtime and imports

Use ESM JavaScript, existing Zod/MCP dependencies, and built-in `node:sqlite` DatabaseSync (`exec`, `prepare`, `run`, `get`, `all`, `close`). Node minimum is 22.13.0: the [official SQLite documentation](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) records removal of the experimental flag in that release. This workspace actually tested Node 25.5.0 / SQLite 3.53.3; older versions have not been executed here. Do not rely on newer convenience APIs without checking version compatibility.

Browser imports `/shared/client.js` and `/shared/protocol.js`, portable ESM with no CDN or bare dependency imports. Full Zod validation runs in the hub/MCP/fixture processes; the portable client validates envelopes and usable SSE events. Preserve the old probe/launcher and standalone HTML designs. New entry points are `scripts/hub.js`, `src/hub/main.js`, `src/mcp/main.js`, and `scripts/chat.js`; package edits belong to the coordinator.

## HTTP surface

JSON results are `{version:'1',data}` or `{version:'1',error:{code,message,retryable,details?}}`. Use shared `ApiError` and `Inputs`/`Outputs`; never leak SQL details, secrets, or stack traces. IDs are opaque strings; sequence positions are safe nonnegative integers. Paths below are under `/api/v1`.

| Method/path | Input | Output schema |
| --- | --- | --- |
| GET `/health` | public | `health` |
| POST `/sessions/browser` | `browserSession`; local bootstrap | `browserSession`; HttpOnly cookie |
| POST `/sessions/agent` | `agentSession`; local create/resume | `agentSession`; adapter-internal credentials |
| POST `/sessions/heartbeat` | authenticated `heartbeat` | `heartbeat` |
| POST `/sessions/disconnect` | authenticated `{}` | `heartbeat` |
| GET `/rooms` | authenticated | `rooms` |
| POST `/rooms` | `createRoom` | `createRoom`; creator joins atomically |
| POST `/rooms/:id/join` | `joinRoom` | `joinRoom` |
| POST `/rooms/:id/leave` | `leaveRoom` | `leaveRoom` |
| POST `/rooms/:id/goal` | member; `updateRoomGoal`; LAN host only | `updateRoomGoal`; `{room,event}` |
| GET `/rooms/:id/history?before=&limit=` | member; before exclusive, limit 1–100 | `history`; selected page ascending |
| POST `/rooms/:id/messages` | member; `postMessage` | `postMessage` |
| POST `/rooms/:id/receive` | agent member; `receive` | `receive` |
| POST `/rooms/:id/ack` | agent member; `ack` | `ack` |
| GET `/rooms/:id/participants` | member | `participants` |
| GET `/rooms/:id/stream?after=` | member; separate stream cursor | SSE room events |

The local owner may list/create/join local rooms. Non-members cannot read room history/events/participants or post. Local agent enrollment is a deliberate same-machine trust boundary, not LAN authentication. Assign owner and human/agent kind server-side; ordinary payloads cannot select an author.

`postMessage` accepts optional `mention_ids` (up to 20 distinct participant IDs). Targets must have an active membership in the room; disconnected members may be addressed. Persist server-derived `{id,name,kind}` snapshots in optional `payload.mentions`, alongside text/reply_to. Omit the property for messages without mentions. Mentions never restrict room delivery or grant authorization. A retry retains its original targets and stored snapshots, even if recipients have since left or changed names. Omitted and empty mention lists normalize identically for legacy mutation replay.

`updateRoomGoal` takes `request_id` and a trimmed `goal` (0–500 characters) and requires active membership; in LAN mode only the host may edit. A changed goal is stored and announced in the same transaction as an ordinary room message authored by the editor (`Room goal updated: <goal>`, or `Room goal cleared.`), so agents learn of it through normal delivery; the result is the updated room and that event. An unchanged goal posts nothing and returns `event:null`. The mutation journal (operation `updateRoomGoal`) replays the original result for a retried request ID. Agents have no MCP tool for this route.

Updated clients advertise `X-Room-Features: mentions`. Bearer-authenticated JSON callers without this feature receive the original message payload shape for post/history/join/receive; only the wire projection omits mentions, leaving stored events, pending batches and acknowledgement IDs intact. Cookie-authenticated browser responses and SSE preserve mention metadata. Old shared SSE readers accept additive payload fields.

Accept only configured loopback Host values at the actual port. An Origin, when present, must exactly match an allowed loopback page origin. Mutations require application/json and the shared body limit. Cookie-authenticated mutations require the matching Origin; bearer CLI calls may omit it. Do not add wildcard CORS. Browser cookie: `acr_session`, HttpOnly, SameSite=Strict, Path=/ (no Secure on local HTTP). Bootstrap recovers the same local human across tabs; a new tab never fences the existing one.

## Identity, mutations, and restart

Internal context: `{participant,connection_id,generation,kind}` without credentials. Revalidate it at transaction/delivery boundaries; request-entry authentication alone cannot fence a wait completed after replacement.

The adapter creates a random >=32-character resume secret before enrollment. `agentSession` sends it with `mode:'create'`, stable `request_id`, name/runtime/workspace/context. A fresh terminal conversation uses a fresh secret. Explicit resume uses the old secret with `mode:'resume'` and a new stable request ID. Never put bootstrap/session secrets in MCP results. An explicitly selected session file may retain the adapter's own secret with owner-only permissions; display name/workspace do not establish identity.

Persist the resume-secret digest and issue a fresh bearer per connection generation. Enrollment/resume deduplicates `(resume digest,request_id)` and compares mode plus full non-secret input. A lost response can be retried for the same current generation while its connection remains open in the current boot. If a later generation exists, old issuance retries return `SESSION_REPLACED`; a closed or old-boot current generation returns `SESSION_EXPIRED` and recovery needs a fresh resume request ID. Do not rotate the durable resume secret. Private issuance outcomes may be stored in the private session table, never public history.

Each hub boot has a new `bootId`. Old-boot agent tokens get `SESSION_EXPIRED` and may resume. Replaced/lower-generation tokens get `SESSION_REPLACED`; obsolete adapters stop rather than evicting each other in a reconnect loop. Browser sessions persist. Presence/wait state starts unknown/disconnected after restart.

Room mutations persist `(participant_id,request_id)` outcomes, comparing operation, target room, and canonical normalized payload (excluding request_id). Conflicting reuse gets `IDEMPOTENCY_CONFLICT`. Authenticate and authorize before replaying any cached result. Create-room retry cannot create another room. Caller-level retries must retain the original ID; convenience client calls only preserve IDs automatically within their internal HTTP retry.

## Membership and delivery state

1. First join atomically snapshots head J, returns bounded recent history through J, and starts processing at J. History is context, not new work. Duplicate active join retains its epoch/cursor/batch.
2. An agent joining/creating a second active room gets `ACTIVE_ROOM_CONFLICT`; explicit leave is required. Humans may join several rooms.
3. Leave ends the epoch, invalidates pending batches, and cancels waits/streams. Rejoin creates a new epoch at the current head. A cached join from an ended epoch, or a cached leave after a different epoch replaced it, returns `MEMBERSHIP_ENDED`. Retrying a successful leave may return its original result while the same epoch remains inactive; it never leaves a newer membership.
4. Receive scans at most `limit` raw events beyond acknowledged progress, filters own posts from visible events, and persists the exact batch snapshot before returning. A pending batch replays identically, including after reconnect.
5. No scanned progress returns `kind:'timeout'` with no cursor mutation or batch. A scan containing only the agent's own posts advances acknowledged progress directly, creates no batch and keeps scanning; running out of raw events returns `kind:'timeout'` with the advanced `acknowledged_through`. A scan with at least one peer event returns `kind:'batch'`, and its filtered own posts advance scanned_through only after acknowledgement. (Revised: self-only scans previously returned an empty batch.)
6. One waiting receive per membership; competing waiters get `ALREADY_RECEIVING`. Cancellation after batch creation preserves the durable batch. Notifications only wake services to reread durable state.
7. v1 acknowledges whole delivered batches. Validate current connection, active epoch, room, participant, and batch ID; atomically advance progress and record the outcome. Repeated successful acknowledgement returns its original result. Unknown/foreign/old-epoch batches fail. New generations can process retained batches; stale generations cannot complete/ack them.
8. Reply targets must be messages in the same room. Multiple follow-up replies use different request IDs. Commit before notifying.

SSE frames: `id:<sequence>`, `event:room_event`, `data:<RoomEvent JSON>`, blank line; LF or CRLF; comments for heartbeat. History returns high-water S; stream after S replays later durable events, including the browser author's own messages. Deduplicate by ID. Reject negative/ahead cursors. Bound slow consumers and let them reconnect/replay. Streams never move agent cursors. v1 polls participant snapshots separately for ephemeral presence.

Errors: VALIDATION_ERROR 400, UNAUTHENTICATED/SESSION_EXPIRED 401, FORBIDDEN 403, NOT_FOUND 404; SESSION_REPLACED, SESSION_EXISTS, ROOM_NAME_CONFLICT, ACTIVE_ROOM_CONFLICT, IDEMPOTENCY_CONFLICT, MEMBERSHIP_ENDED, ALREADY_RECEIVING, INVALID_ACK are 409. Only transient network/explicit retryable503 responses auto-retry. Semantic errors are surfaced.

## H1.1 database contract

Export `async openDatabase({filename,migrationsDir?})` from `src/hub/db.js`, returning `{db,transaction(fn),close(),filename}`. `db` is DatabaseSync. Transactions are synchronous, nested via savepoints; reject/rollback async callbacks. Enable foreign keys and a bounded busy timeout; file databases use WAL. Create parent directories. Close is idempotent. Discover numbered bundled migration modules in order (or an explicit injected test directory), each exporting `version` and `up(db)`. Create a loader-owned `schema_migrations(version,applied_at)` table and commit each migration/version record atomically. Reject duplicate/gapped versions and unsupported newer database versions.

Migration `001-foundation.js` creates exactly these tables/columns (TEXT unless counter/boolean); add appropriate PK/FK/index constraints. No private field belongs in a public mapper.

| Table | Columns |
| --- | --- |
| owners | id PK, name, created_at |
| participants | id PK, owner_id, kind, name, runtime nullable, workspace_json nullable, context, created_at |
| agent_bindings | participant_id PK, resume_hash UNIQUE, generation INTEGER |
| connections | id PK, participant_id, generation INTEGER, token_hash UNIQUE, boot_id, created_at, closed_at nullable |
| session_requests | resume_hash, request_id, payload_json, result_json; composite PK first two |
| browser_sessions | token_hash PK, token_value, participant_id |
| rooms | id PK, name UNIQUE, goal, next_sequence INTEGER default1, created_at |
| memberships | room_id, participant_id, epoch UNIQUE, active INTEGER, joined_sequence INTEGER, acknowledged_sequence INTEGER, paused INTEGER; composite PK room/participant |
| events | id PK, room_id, sequence INTEGER, author_id, author_name, author_kind, text, reply_to nullable, created_at, mentions_json (migration 002, default `[]`); UNIQUE room/sequence |
| requests | participant_id, request_id, operation, payload_json, result_json; composite PK first two |
| batches | id PK, room_id, participant_id, membership_epoch, scanned_through INTEGER, events_json, status pending/acked/invalidated, created_at; one pending per room/participant |

Old batch records survive rejoin: do not foreign-key their epoch to the replaceable current membership epoch. Inject time/IDs in repository factories, not SQL sleeps. Return plain public objects, not raw SQLite rows.

## Factory seams and first packet boundaries

H1.2's exact methods and acceptance cases are specified in [repositories-v1](repositories-v1.md); H1.1 must land before that packet starts. Additional exact method lists are supplied before each later packet dispatch. Do not invent neighboring APIs within a packet.

- `createIdentityStore(database,{bootId,now,id})`: browser bootstrap, agent create/resume, auth/context assertion, disconnect, participant lookup. H1.2 owns it.
- `createRoomStore(database,{identity,now,id})`: list/create/join/leave/membership checks. H1.2 additionally owns a reusable `mutation-store.js` for shared durable request outcomes; its allowlist explicitly includes this helper.
- `createEventStore(database,{identity,rooms,now,id,onChange})`: post/history/head/events-after. Notify after commit. H1.3 owns it.
- `createDeliveryStore(database,{identity,rooms,events,now,id})`: pending batch creation/replay, acknowledgement, epoch invalidation. H1.4 owns durable rules, H2.4 timers/wait cancellation.
- HTTP handlers receive injected services/context and return `{data,schema,status?}` or `{handled:true}`. Shell owns bounded JSON/error handling and Host/Origin; services own membership and current-generation checks. H2.7 alone registers modules.
- `createMcpServer({client,toolGroups?})` returns a fresh MCP SDK server. A registrar receives `{server,client,session}`; mutable session is `{roomId:null,membershipEpoch:null,participant:null}`. Default initial registration is room tools, later tool groups compose explicitly.
- A1.1 tools: `list_rooms {}`, `join_room {room_id}`, `list_participants {}`, `read_history {before?,limit?}`, `leave_room {}`. Only list/join work without active room. Successful join stores room/epoch; leave supplies saved epoch and clears it only after success. Retain the leave request ID across failed tool calls for the same room/epoch so a lost successful leave response can replay. No enrollment tool or secret-bearing output. Use JSON text MCP results and public structured callback errors with `isError:true`. Native SDK input-validation failures retain SDK text errors; do not override private SDK methods. Forward tool cancellation to the shared client.
- U1.1 shell IDs: `rooms-list`, `room-title`, `room-goal`, `conversation`, `composer`, `message-input`, `send-button`, `participants-list`, `inspector`, `connection-status`, `theme-toggle`, `create-room-button`. Empty/loading slots, no sample agents/results. `theme.js` is standalone and storage-failure-safe. Later module mount contracts are frozen before U1.2 onward.

## Test evidence and environment

Shared fixtures/client: `node --test test/contracts.test.js`. `test/helpers/fixture-server.js` is a schema-valid scripted transport, not a production backend; consumers inject fault handlers without inventing their own hub. `test/helpers/processes.js` bounds test-owned child lifetimes.

Chrome headless startup previously failed here with a Mach-port permission error. Do not retry using sandbox-disabling flags or modify managed settings. Browser rendering remains pending in a supported environment. DOM/logic checks are separate evidence, not rendered UI validation.
