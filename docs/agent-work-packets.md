# Bounded implementation assignments for Sol

Packet catalog, September 27, 2026. These packets refine the milestone groups in the [implementation plan](implementation-plan.md). Initially sized for Sol implementation, the same bounded packets now run on Astra after the user's approved fallback. [Progress](progress.md) records actual implementation and review status; listing a packet here does not mark it complete.

## Assignment rule

**Give a Sol session one packet at a time, not an entire milestone or subsystem.** H1, H2, A3, U1, and the other parent IDs remain planning groups. Actual implementation assignments use IDs such as `H1.1` or `U1.3`.

An independent assignment means the agent can complete the specified behavior from supplied inputs without inventing another component's API, changing shared architecture, or waiting for an unfinished dependency. It does not mean the whole system has no dependencies.

Before dispatch, the coordinator supplies:

1. The packet ID, concrete outcome, and explicit exclusions.
2. A contract revision and exact existing schema/client/fixture files to read. Interface names below are proposed names to freeze during C0/C2/L0, not already existing code.
3. Completed prerequisite modules or an explicitly supplied contract fixture for each unavailable dependency. The worker does not build a second fake server or alternate schema.
4. An exact writable-file allowlist, including its focused test file; no broad subsystem glob as the actual assignment boundary.
5. Observable acceptance cases and the exact runnable test command. Usually this is `node --test test/<packet-test>.test.js`; the browser runner and its command must be established before assigning browser-dependent checks.
6. The integration gate that remains after component completion, and any verified client/environment limitation relevant to the task.

Small reversible styling changes do not need implementation-mirroring tests. Use the supported browser checks for visual work; use regression tests for consequential delivery, persistence, identity, and execution behavior.

### Scope guardrails

- Finish the current packet and hand it back before taking the next. A follow-up can reuse the same Sol agent once the coordinator accepts the handoff.
- Do not absorb a neighboring packet to make the current one appear complete. If an input is missing or contradictory, report the exact missing contract/module and the smallest proposed change. The coordinator supplies it or reschedules the packet; this is not a request for a new user permission prompt.
- If implementation uncovers a second independently testable subsystem, split it before continuing. Package/dependency decisions, protocol redesign, authentication policy, and unverified runtime capabilities go to the coordinator/Astra review.
- General helpers live in the owning module unless multiple real consumers justify a shared helper. Shared client/schema changes belong to the coordinator.
- Only one packet writes a given file at a time. This includes migrations, route registries, MCP registrations, UI entry points, global CSS, and fixture servers.
- C0.1/H1.1 will provide ordered discovery of the application's versioned migration modules. Later migration packets add their own module without editing a shared migration registry. Composition packets explicitly own entry-point/route-registration edits; a new service is not considered integrated merely because its module exists.
- Prefer constructor/function injection of already specified dependencies. A component packet can be accepted against validated fixtures; it must be labeled **component complete**, not **integrated** or **live verified**.
- A handoff includes changed paths, exports, command output, relevant failure cases, and remaining integration work. Unexpected failures stay visible; do not replace missing behavior with canned success.

The parent coordinator plus at most three child agents run concurrently. Astra reviews use a free child slot or run before the three-Sol wave. Lane labels below describe file ownership, not permanent staffing: a free Sol agent may take a ready packet in another lane after an explicit ownership handoff.

## Coordinator prerequisites

These are coordinator/Astra preparation tasks, not open-ended assignments handed to an implementation agent.

| Packet | Output required before consumers start |
| --- | --- |
| **C0.1 — Decisions and module seams** | Record Node/SQLite choice, browser import/serving approach, identity binding, transaction ownership, repository/service signatures, injected clock/ID hooks, resource cleanup, and module entry points. Review the protocol decisions with Astra. |
| **C0.2 — Executable schemas and state fixtures** | Implement the shared schemas and valid/error/state-transition fixtures. Specify pending receives, acknowledgements, filtered progress, channel changes, idempotency conflicts, resume generations, and snapshot/stream handoff with examples. |
| **C0.3 — Shared client implementation** | Implement the actual shared HTTP client used by browser and adapter, with request IDs, cancellation, typed errors, and version compatibility. Provide imports that work in Node and the browser. Defining an interface alone does not unblock its consumers. |
| **C1.1 — Process and fixture harness** | Provide temporary-store/port lifecycle helpers, an SDK subprocess client helper, and one schema-valid fixture server with explicitly documented fault scenarios. Publish exact commands and cleanup behavior. |
| **C1.2 — Browser harness** | Establish a supported browser runner, asset-serving fixture, viewport/keyboard checks, and real-hub hookup. Record blocked rendering checks if the environment cannot launch a browser; DOM checks are separately labeled. |
| **C2.1 — Work contracts and client** | Publish task/claim/control/decision/artifact/review schemas, module signatures, actor rules, transitions, origin-room handling, and validated fixtures. Implement their shared-client methods and extend the single fixture server with executable scenarios before consumer dispatch. Define what freshness checks can and cannot prove. |
| **C2.2 — Verified runtime boundary** | Use D1 evidence to choose actual main-agent reporting versus a supported runtime API binding. Specify available dispatch/result/cancellation operations, unavailable operations, dispatch-journal transitions, and the confirmation source. If using main-agent reports, freeze the exact MCP operations that record intent/worker handles and update the journal. Do not ask Sol to discover an orchestration architecture while implementing it. |
| **C2.3 — Recovery contracts and client** | Before R1–R3, freeze the query/catch-up/restoration/diagnostics interfaces, implement the shared-client extensions, and extend the existing fixture server with pagination, stale-state, and recovery scenarios. These coordinator changes precede dependent Sol packets. |
| **L0.1 — LAN policy, enrollment, and client** | Publish the actor/resource/action matrix, invitations, browser sessions, adapter enrollment, credential lifetimes/storage, session protection, revocation behavior, and local-owner migration fixtures. Implement shared-client enrollment/session/membership methods and executable fixture-server extensions before consumers start. |
| **L0.2 — LAN transport and hosting contract** | Choose the supported transport/deployment approach and define endpoint configuration, origin validation, credential handling, and network-loss behavior; implement the corresponding shared-client transport behavior and fixtures. Preserve normal certificate verification and existing client/sandbox permissions. |

All first-wave packets require C0.1–C0.3 and C1.1. Their shared baseline now exists in `src/shared/` and `test/helpers/` with passing contract tests. The initial H1.1/A1.1 contracts are ready; later packets still need their listed dependencies and exact interfaces. U1.1 source work may proceed against the shell contract, with rendered acceptance explicitly pending C1.2's supported browser environment.

## First wave: local conversation

For each row, the writable paths are relative to the lane root unless an explicit project-root path is given. Each packet also owns one focused test file named `test/hub-<id>.test.js`, `test/mcp-<id>.test.js`, or `test/ui-<id>.test.js`, with dots in the packet ID replaced by hyphens. Examples: `test/hub-h1-3.test.js`, `test/mcp-a1-2.test.js`. New shared helpers require coordinator ownership.

The coordinator fills in the contract revision, real import locations, and test command at dispatch. A prerequisite followed by “fixture” may be supplied by C1.1 for component development. Integration gates always use the real implementation.

### Hub packets — root `src/hub/`

| Packet | Prerequisites beyond the common baseline | Writable module files / output | Acceptance boundary |
| --- | --- | --- | --- |
| **H1.1 — Database lifecycle** | SQLite decision in C0.1 | `db.js`, `migrations/001-foundation.js`; database open/migrate/close functions | A fresh store initializes; reopening preserves schema/version; migration failure is recoverable as specified; close releases resources. No HTTP or room behavior. |
| **H1.2 — Identity and membership repositories** | H1.1; [exact methods](contracts/repositories-v1.md) | `identity-store.js`, `room-store.js`, `mutation-store.js`; participant/connection, room/member, and durable mutation journal interfaces | Create/list/join/leave persists correctly; duplicate joins are idempotent; one room's membership cannot grant another's access; replacement connection generations fence stale instances. No authentication transport or event delivery. |
| **H1.3 — Event append and history** | H1.1, H1.2 | `event-store.js`; append/query event repository | Concurrent room appends have correct order; identical retries return the same event; conflicting request reuse fails; history is room-scoped and paginated. No waiters, SSE, or acknowledgement advancement. |
| **H1.4 — Durable batches and acknowledgements** | H1.3; frozen delivery transitions | `delivery-store.js`; batch/prefix acknowledgement repository | Members advance independently; invalid/stale acknowledgements fail; interrupted processing replays; filtered events still permit progress. No network wait lifecycle. |
| **H2.1 — HTTP service shell** | None | `http-server.js`, `static-assets.js`; server factory with injected route handlers | Loopback startup with a chosen/free port, asset allowlist, configured Host/Origin checks, input limits, deterministic close and abort hooks. Only health/static behavior; no invented auth or room routes. |
| **H2.2 — Local session binding** | H1.2 or its fixture; H2.1 interface | `local-session.js`, `routes/session.js`; local browser/adapter authentication context | Bootstrap and resume bind the correct owner/participant; caller IDs cannot be forged in payloads; replaced bindings are rejected. No invitations or LAN identity system. |
| **H2.3 — Room and message routes** | H1.2/H1.3 or fixtures; H2.2 auth contract | `routes/rooms.js`, `routes/messages.js`; route handlers | Create/list/join/leave, history, and message/reply writes obey room access and idempotency. Two authors can reply to one message. No SSE, worker APIs, or server registration changes. |
| **H2.4 — Receive and acknowledge service** | H1.4 or fixture; H2.2; server abort hooks | `delivery-service.js`, `routes/delivery.js`; bounded receive/ack handlers | Independent waiters get their own deltas; timeout is distinct from input; abort/disconnect cleans up; acknowledgements delegate to the durable batch rules. No browser streams or model turn scheduling. |
| **H2.5 — Presence and activity reports** | H1.2 or fixture; H2.4 wait-state interface | `presence-service.js`, `routes/presence.js`; participant status snapshots | Injected-clock cases distinguish connected, receive-waiting, and timestamped activity; expiry gives unknown/stale state and never declares worker failure. No worker execution or reconnect policy. |
| **H2.6 — Browser event stream** | H1.3 or fixture; H2.2; frozen snapshot/stream contract | `browser-stream.js`, `routes/stream.js`; replayable SSE handler | An event at the snapshot/subscription boundary is recoverable; replay positions avoid loss; slow/disconnected consumers release resources; access is room-scoped. No DOM rendering or agent acknowledgements. |
| **H2.7 — Hub composition** | H2.1–H2.6 real modules | `main.js`, `routes/index.js`, project file `scripts/hub.js`; runnable hub entry point | Register existing modules, publish lifecycle output, start/stop cleanly, and pass assembled HTTP smoke scenarios. Do not rewrite repository/delivery logic here; defects go back to its packet owner. |

### Session packets — root `src/mcp/` unless stated otherwise

| Packet | Prerequisites beyond the common baseline | Writable module files / output | Acceptance boundary |
| --- | --- | --- | --- |
| **A1.1 — MCP shell and room tools** | Shared client and fixture server | `server.js`, `tools/rooms.js`; injectable MCP server plus join/list/history/leave tools | SDK can list/call these tools over stdio; schema errors are meaningful; stdout remains protocol-only; tool output does not contain binding credentials. No receive loop or process auto-start of the hub. |
| **A1.2 — Receive and acknowledgement tools** | A1.1; delivery fixtures | `tools/delivery.js`; receive/ack wrappers | Tool cancellation reaches HTTP; timeouts preserve position; returning a batch never implicitly acknowledges it; stale/invalid acknowledgement errors survive translation. No reconnect policy or worker behavior. |
| **A1.3 — Message publishing tool** | A1.1; write-retry fixtures | `tools/messages.js`; post/reply wrapper | Stable request IDs survive uncertain transport outcomes; two replies to one parent are allowed; conflicting reuse is surfaced. No alternate retry/idempotency implementation beyond the agreed shared client responsibilities. |
| **A1.4 — Adapter connection lifecycle** | A1.1; binding/presence fixtures | `connection.js`; connect/heartbeat/resume/close state machine | Injected timing/network cases cover loss, bounded backoff, fresh versus resumed identity, and replaced generations; shutdown cancels pending requests. No automatic model wake-up. |
| **A1.5 — Adapter composition** | A1.1–A1.4; real H2.7 for integration | `main.js`, `tools/index.js`; runnable adapter | Compose existing modules; two SDK-driven adapter processes communicate through one actual hub; closing either leaves the other running. Return module defects to their packet owners. |
| **A2.1 — Workspace-aware launcher** | A1.5 executable/config contract; A2.2 instruction builder | Project files `scripts/chat.js`, `src/runtime/launch-config.js`; launcher/config builder | Wire the instruction builder into the launched prompt. Fake-child checks verify that prompt, workspace cwd, executable location, room/name/hub options, literal argument serialization, invalid-input errors, and exit handling. Do not change the old launcher or client permissions; actual client launch is a distinct integration check. |
| **A2.2 — Conversation-loop instructions** | A1.2/A1.3; stable tool semantics | Project file `src/runtime/participation.js`; initial room instruction builder | Review finite scenarios: join/introduction, useful reply, deliberate silence, empty timeout, error, and targeted leave. Fixtures establish instruction shape, not model compliance. No delegation policy or background scheduling. |

### UI packets — root `public/chatroom/`

| Packet | Prerequisites beyond the common baseline | Writable module files / output | Acceptance boundary |
| --- | --- | --- | --- |
| **U1.1 — Application shell and theme** | Wireframe; C1.2 rendering environment | `index.html`, `style.css`, `theme.js`; accessible responsive shell | Match the approved layout with empty/loading slots; light/dark toggle persists when available; narrow-screen inspector and keyboard focus work. No live data or fabricated participants/results; browser validation, not CSS snapshot tests. |
| **U1.2 — Channel selection and drafts** | U1.1; room fixtures | `rooms.js`, `drafts.js`; room navigation/state module | Create/select channels, keep separate drafts, ignore stale room-selection responses, and preserve human identity. No message stream or task dashboard. |
| **U1.3 — Conversation rendering and send** | U1.1/U1.2 interfaces; message fixtures | `conversation.js`, `composer.js`; message list/composer module | Render literal untrusted text safely, attributed replies, send/pending/error states, and stable-ID retries; Enter/Shift+Enter behave correctly. No stream reconnect or fake model responses. |
| **U1.4 — History and stream reconciliation** | U1.2/U1.3 interfaces; stream/race fixtures | `event-feed.js`; per-room history/live-event coordinator | Dedupe history versus live events, recover reconnect gaps, discard old-channel callbacks, and preserve scroll/draft behavior. Never advance an agent processing cursor. No new backend endpoints. |
| **U1.5 — Participant context and status** | U1.1; participant fixtures | `participants.js`; participant inspector | Render identity/workspace, connection, receiving, queued count, and stale/unknown activity without inferred typing/read receipts. No controls that the current API cannot execute. |
| **U1.6 — Live browser composition** | U1.1–U1.5; H2.7; C1.2 | `app.js`; live application entry point | Wire shared client/local browser identity and existing modules; test two channels/tabs against the actual hub. No normal-path fixture data. Route defects back to the relevant module packet. |

### First dispatch and subsequent handoffs

After the common prerequisites are published, the first three Sol assignments are **H1.1**, **A1.1**, and **U1.1**. They do not need unfinished code from each other. The coordinator prepares integration scenarios while these run.

After accepting each packet, assign the next ready one using its dependency list. Do not batch “H1 then H2” or “finish the frontend” into a single prompt. A free session/UI worker can help with a ready hub module against frozen fixtures if its exact file ownership is reassigned; it must not edit a busy hub composition file.

**G1 remains coordinator-owned:** integrate the real hub, adapter, and browser; run automated multi-client/recovery scenarios and the separate two-real-terminal live demo. Component completion of the rows above is necessary but does not itself establish G1.

## Work and evidence packets

These are scoped backlog items. Dispatch requires C2.1; runtime packets additionally require C2.2 and the actual capability evidence named below. Complete G1 first under the current release order.

Writable roots are the same as above; `runtime/` below means project path `src/runtime/`. Each row owns its matching lane test file. Module-registration files are changed only by the designated composition packet.

| Packet / lane | Inputs and prerequisites | Writable module / output | Bounded acceptance and exclusion |
| --- | --- | --- | --- |
| **H3.1 — Task lifecycle / hub** | C2.1; event/room stores | `task-store.js`, `migrations/002-tasks.js` | Persist tasks and allowed versioned transitions with their events atomically; reject invalid transitions/cross-room references. No worker dispatch or claims yet. |
| **H3.2 — Atomic claim / hub** | H3.1; fixed owner policy | `task-claims.js` | Two concurrent claims have one winner; stale version loses; retries retain outcome. Does not discover semantically duplicate tasks. |
| **H3.3 — Cancellation requests / hub** | H3.1; confirmation/actor fixtures | `task-controls.js` | Persist a targeted request and a separate authorized execution report; offline state never becomes confirmed cancellation. No runtime stop operation. |
| **H3.4 — Delivery and participation controls / hub** | C2.1; H2.4; fixed control-delivery path | `participation-controls.js` | Future delivery pause is hub-confirmed; mode changes track receipt; resume control is not stuck behind paused chat. Existing workers remain running. No claim to wake idle models. |
| **H3.5 — Contribution/work limits / hub** | H3.2; frozen budget policy/clock | `work-limits.js` | Enforce configured contribution and active-work bounds with explicit limit outcomes; coalesce defined repetitive updates. Does not let a heuristic silently discard decisions. |
| **H4.1 — Decision revisions / hub** | C2.1; event/room stores | `decisions.js`, `migrations/003-decisions.js` | Attributed revisions preserve evidence/dissent/history; conflicting updates are detected; silence does not create consensus. No model judgment about applicability. |
| **H4.2 — Artifact ingest / hub** | C2.1 transfer contract; H3.1 | `artifact-store.js`, `migrations/004-artifacts.js` | Bounded content upload, metadata, atomic publication, and cleanup after failure; reject invalid room/task references. No arbitrary-path reads or browser previews. |
| **H4.3 — Artifact retrieval / hub** | H4.2; access/content-type policy | `artifact-delivery.js` | Membership-scoped metadata/download, missing-content errors, safe content disposition, and no traversal outside the store. No uploads or review writes. |
| **H4.4 — Reviews and acceptance / hub** | H3.1/H4.1/H4.2; actor policy | `reviews.js`, `migrations/005-reviews.js` | Attributed findings, requested changes, and explicit acceptance link to the correct version; acceptance never applies a patch. No artifact execution. |
| **H4.5 — Work API composition / hub** | H3.1–H3.5 and H4.1–H4.4 | `main.js`, `routes/work.js`, `routes/artifacts.js`, `routes/index.js` | Construct/wire already implemented services and expose schema/auth-checked handlers with real HTTP tests; delegate service defects back to owners. |
| **A3.1 — Work/control MCP wrappers / session** | C2.1; work/control fixtures | `tools/tasks.js`, `tools/controls.js` | Translate task, claim, status, and control operations without changing actor or confirmation semantics. No worker spawning. |
| **A3.2 — Artifact MCP wrappers / session** | C2.1; artifact fixtures | `tools/artifacts.js` | Publish deliberately selected content with origin/base/reproduction metadata; preserve idempotency and upload failures. Do not expose arbitrary hub-directed workspace reads. |
| **A3.3 — Dispatch journal / session** | C2.2 verified transition contract | `runtime/dispatch-journal.js` | Intent, confirmed handle, ambiguous dispatch, and result states survive interruption; injected-runtime cases never blindly repeat an ambiguous task. No client-specific runtime calls. |
| **A3.4 — Verified runtime binding / session** | C2.2, D1 capability findings, A3.3 | `runtime/worker-binding.js` | Connect only the specific verified operations/reports to the journal; preserve unknown state where operations are unavailable. No new runtime architecture or presumed app-server integration. Re-scope if the capability contract is incomplete. |
| **A3.5 — Queued changes and publication / session** | A3.3/A3.4; decision/task fixtures | `runtime/result-reconciliation.js` | Compare linked revisions, retain newer discussion, require explicit applicability review, and publish to the originating room. A version mismatch does not automatically prove a result invalid. |
| **A3.6 — Active participation instructions / session** | C2.2; A3.1/A3.2 tool names | `runtime/participation.js` | Add bounded proactive contribution, explicit delegation, changed-decision briefing, and silence/loop-control scenarios. Deterministic checks cover the instruction contract; real behavior remains G2 evidence. |
| **A3.7 — Work-enabled adapter composition / session** | A3.1–A3.6; real work API | `tools/index.js`, `main.js` | Register wrappers/bindings and verify end-to-end report/publication/cancellation-request flows. Do not implement an unavailable runtime capability during wiring. |
| **U2.1 — Tasks and workers / UI** | C2.1; task fixtures | `tasks.js` | Task cards/inspector show actual scope, ownership, versions, worker reports, and unknown/blocker states. No standalone worker chat identities or dispatch UI. |
| **U2.2 — Targeted controls / UI** | C2.1; control fixtures | `participant-controls.js` | Mode, delivery, and cancellation actions keep their distinct pending/confirmed states and target the right participant/task. No optimistic claim that work stopped. |
| **U2.3 — Decision history / UI** | C2.1; decision fixtures | `decisions.js` | Render author/evidence/dissent, history, and earlier-revision links; preserve unresolved disagreement. No inferred consensus. |
| **U2.4 — Evidence inspector / UI** | C2.1; artifact fixtures | `artifacts.js` | Retrieve safe previews/downloads, origin/reproduction metadata, absent/failed content, and negative/inconclusive results. No inline execution of published HTML/code. |
| **U2.5 — Review and acceptance UI / UI** | U2.1/U2.3/U2.4; review fixtures | `reviews.js` | Submit attributed reviews and explicit acceptance/version conflicts; neither action implies integration into a repository. |
| **U2.6 — Work UI composition / UI** | U2.1–U2.5; actual work API | `app.js`, `style.css` | Connect conversation cards/inspectors to real events while preserving drafts/position; render controls only for implemented capabilities. Component defects return to their packet owner. |

**D1 and G2 stay with the coordinator/Astra review.** Runtime uncertainty is resolved before dispatching A3.4. If the tested client cannot support the intended concurrent participation, report the finding and move the scheduling investigation to X1; a Sol implementation packet should not have to invent a workaround to satisfy a promised demo.

## Extended local-session packets

The R1–R3 contracts, shared-client methods, and executable fixtures are supplied by coordinator packet C2.3 before dispatch. Earlier basic reconnect behavior remains required in the first wave; these packets extend it.

| Packet / lane | Inputs | Writable module / output | Acceptance boundary |
| --- | --- | --- | --- |
| **R1.1 — Search/backlog queries / hub** | Room log; frozen query contract | `history-queries.js`, `routes/history.js` | Room-scoped search, pagination and bounded backlog results remain stable as new events arrive; no client summaries. |
| **R1.2 — Store recovery reconciliation / hub** | Task/artifact/journal fixtures | `recovery.js` | Resolve documented stale temporary records and report uncertain work; failure/restart cases preserve evidence and never auto-reassign a running task. |
| **R1.3 — Operational diagnostics / hub** | Frozen metrics/logging contract | `diagnostics.js` | Emit bounded counts/latency/lifecycle diagnostics without credentials or private transcript content; report backpressure rather than lose events silently. |
| **R1.4 — Recovery hub composition / hub** | R1.1–R1.3 | `main.js`, `routes/index.js` | Register query handlers and wire recovery/diagnostics into startup/shutdown. Assembled restart/query checks exercise the actual modules; do not implement new recovery logic during wiring. |
| **R2.1 — Catch-up planner / session** | R1.1 or fixture; decision/task references | `runtime/catch-up.js` | Stage bounded deltas and linked history without acknowledging unprocessed events or treating old suggestions as new work. No model summarization claims from a deterministic fixture. |
| **R2.2 — Session restoration / session** | Adapter lifecycle; worker-binding reports | `runtime/session-restore.js` | Distinguish fresh context from an actual resume and reconcile task/worker uncertainty. Never infer restored model memory from a display name. |
| **R2.3 — Session recovery composition / session** | R2.1/R2.2 real modules | `main.js`, `runtime/participation.js` | Integrate catch-up/restoration and useful stopped-loop terminal guidance; restart tests preserve pending work. No idle wake-up feature. |
| **R3.1 — Search and thread navigation / UI** | R1.1 or fixture; existing message references | `search.js`, `threads.js` | Navigate room-scoped search/thread results without losing the current draft or claiming to move an agent cursor. |
| **R3.2 — Unread and catch-up navigation / UI** | Frozen browser view-state contract | `unread.js`, `rooms.js` | Human unread state remains consistent across channel changes/tabs/reconnect; bounded catch-up links expose older history. No reuse of agent acknowledgement state. |
| **R3.3 — Room settings and usability integration / UI** | Work-limit APIs and completed browser modules | `settings.js`, `app.js`, `style.css` | Settings obey actor rules; reconnect, inspector, keyboard, and narrow-screen flows work together against the real hub. Split any new business behavior found here into its own packet. |

**G3 is coordinator-owned:** extended live runs, supported environments, failure reports, release evidence, and choice of default entry points.

## LAN packets

L0.1/L0.2 are mandatory dispatch inputs. The intended local-first release order is unchanged. These are future scoped assignments; their policy and deployment choices have not been implemented or verified yet.

| Packet / lane | Inputs / prerequisites | Writable module / output | Acceptance boundary |
| --- | --- | --- | --- |
| **L1.1 — Authorization evaluator / hub** | L0.1 actor/resource/action matrix | `auth/policy.js` | Table-driven allowed/denied cases for rooms, tasks, agent controls, streams, and artifacts; pure policy evaluation only. No credential issuance. |
| **L1.2 — Invitations / hub** | L0.1; owner/membership repositories | `auth/invitations.js`, `migrations/006-invitations.js` | Create/expire/redeem invitations according to single-use/membership policy, including concurrent redemption. No browser sessions or device credentials. |
| **L1.3 — Browser owner sessions / hub** | L0.1; identity repository | `auth/browser-session.js`, `migrations/007-owner-sessions.js` | Establish/expire/revoke owner sessions with the specified browser protections; local owner attribution is preserved. No adapter enrollment. |
| **L1.4 — Adapter enrollment / hub** | L0.1; identity repository | `auth/adapter-enrollment.js`, `migrations/008-device-bindings.js` | Bind/revoke device and participant credentials under the authenticated owner; credentials never become message payloads. No automatic agent launching. |
| **L1.5 — HTTP authorization composition / hub** | L1.1–L1.4; fixed endpoint/action map | `main.js`, `auth/http-context.js`, `routes/auth.js`, `routes/index.js` | Construct the auth services, resolve request identity, and apply the frozen policy at each API boundary; test allowed/denied requests with real handlers. Missing service guards become targeted fixes, not an unbounded rewrite. |
| **L1.6 — Stream/receive revocation / hub** | L1.5; stream/delivery cancel hooks | `main.js`, `auth/delivery-access.js`, `browser-stream.js`, `delivery-service.js` | Wire revocation hooks to stop future unauthorized stream/receive delivery and clean up waits; inject revocation at defined race boundaries. No new credential policies. |
| **L1.7 — Artifact access after revocation / hub** | L1.5; explicit in-flight transfer policy | `artifact-delivery.js`, `artifact-store.js` | Upload/download respects current membership and the agreed in-flight revocation behavior; test private content isolation. No independent interpretation of mid-transfer policy. |
| **L1.8 — Local-owner upgrade / hub** | Frozen old/new schema fixtures; L1.2–L1.4 schemas | `migrations/009-local-owner-upgrade.js` | Existing history/ownership survives migration/restart; interrupted migration follows the specified recovery path. No reassigning existing agents by display name. |
| **L2.1 — Adapter enrollment client / session** | L0.1; enrollment fixture | `enrollment.js` | Obtain/store/revoke the specified binding outside model prompts; clear enrollment/expiry failures. No invented identity provider or credential-storage scheme. |
| **L2.2 — Network hub lifecycle / session** | L0.2; L2.1; adapter connection interface | `main.js`, `connection.js`, project file `src/runtime/launch-config.js` | Wire enrollment/bindings into adapter startup. Network URL and authenticated reconnect work under disconnect/expiry fixtures; standard certificate checks remain enabled; workspace remains local. Requires L1 integration before real completion. |
| **L2.3 — Portable artifact publication / session** | L2.2; artifact tool contract | `tools/artifacts.js` | Publish selected bytes/reference metadata across machines; never substitute a private absolute path for shared content. No whole-repository sharing. |
| **L3.1 — Human invitation/join UI / UI** | L0.1; invitation/session fixtures | `join.js`, `owner-session.js` | Invitation expiry, redemption, signed-in owner, and session-expired states work; a human can join without an agent. No agent-owner control UI yet. |
| **L3.2 — Membership and control ownership UI / UI** | L1.1 action matrix; L3.1 | `memberships.js`, `participant-controls.js` | Show correct owners/actions and handle server denial/revocation; hiding a button is not the authorization mechanism. No policy invention. |
| **L3.3 — Multi-user browser composition / UI** | L3.1/L3.2; real auth API | `app.js`, `style.css` | Integrate joining, owner attribution, membership, and revoked-session recovery with existing rooms. Separate browser fixture results from real hub checks. |

**L4 and G4 are coordinator-owned:** supported LAN hosting configuration, origin/transport setup, runbook, and two-real-machine validation. The protocol/module packets above do not independently establish that deployment or two-person collaboration works.

## Extensions start with an architecture decision

X1 (runtime-driven wake-up), X2 (one agent receiving multiple channels), and X3 (additional runtimes) are not ready-made Sol implementation assignments. Each begins with a bounded coordinator/Astra capability/design investigation. Its output must select supported APIs, define state transitions and compatibility fixtures, and add a packet list here before implementation delegation. This prevents “support another runtime” or “make the agent always available” becoming an unbounded worker request.

## Dispatch template

Fill every bracket before sending. If an input cannot be filled, the packet is not ready.

```text
Model: gpt-5.6-sol
Task: [one packet ID and outcome]
Read: [this packet, exact contract/schema/client/fixture paths and revision]
Inputs available: [completed modules or named provided fixtures]
Write only: [exact files plus focused test file]
Implement: [the bounded behavior and export contract]
Do not implement: [adjacent features and shared architectural decisions]
Verify: [exact commands + observable success/failure cases]
Integration remaining: [which real hub/browser/runtime/release gate is separate]
Stop when: the packet's acceptance cases pass and its handoff is ready.
If blocked by a missing contract/dependency: report the precise gap to the
coordinator; do not redesign another component or wait for the user by default.
Handoff: changed paths, exports, test results, blockers, and remaining gate.
```

The first-wave assignment text in the parent plan now points to individual packets. A reviewer accepts the packet, then the coordinator assigns the next ready packet or an explicitly scoped fix. No worker is told to finish an entire wave independently.
