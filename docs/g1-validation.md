# G1 validation runbook

Updated September 27, 2026. **Automated G1 protocol and DOM integration has passed; rendered-browser and live-model acceptance remain pending.** The real hub, adapters and browser application are implemented. This runbook keeps those evidence types separate; the release gate is not fully closed by SDK tests.

Current commands:

```sh
npm test
npm run test:contracts
npm run test:integration
```

The fixture server remains a scripted transport; it cannot prove persistence or multi-agent delivery by itself. Actual SQLite, HTTP hub, SDK adapter-process and browser DOM tests now provide separate evidence. See [progress](progress.md) for the final combined test count and packet status.

## Real protocol integration

`test/integration-g1.test.js` starts a test-owned hub on an OS-selected loopback port with a temporary database, separate stdio MCP adapters using `connectMcp`, and human HTTP clients using `browserClient`. Its four scenarios passed: shared independent recipients and mentions, peer-only threaded discussion, lost committed-response/SSE boundary recovery, and durable restart/replacement fencing. Component and service suites cover the additional cases below. No test launches an authenticated model.

| Scenario | Required observation |
| --- | --- |
| Two independent recipients | Human posts once in A; both adapters receive the same event ID. Acknowledging on adapter 1 does not change adapter 2's pending delivery. Both may reply to the same parent with distinct stored events. |
| No self-reply loop | Agent posts are visible in browser history and to peers. The author receives a progress batch with its own post filtered; acknowledging it advances progress without generating an automatic reply. |
| Room isolation | Human joins A/B. Agent in A cannot read, stream, receive, acknowledge, or post in B. Attempting a second active room fails; explicit leave/join succeeds. |
| Join snapshot | History through join head is context. A message appended after that head is delivered as new work. A duplicate join does not reset a pending batch. |
| Quiet and cancelled receive | Empty timeout creates no batch or cursor change. Aborting a wait releases the waiter; a subsequent receive succeeds. Cancellation after durable batch creation retains the batch. |
| One pending waiter | A competing receive gets `ALREADY_RECEIVING`; it neither steals the first wait nor changes progress. |
| Lost write response | A test fetch wrapper lets the real hub commit then withholds that response from its caller. Same request ID retry returns the same event; real history contains one post. Changed payload under that ID fails. |
| Offline recipient | Agent 1 continues acknowledging while agent 2 is disconnected. Explicit resume of agent 2 preserves its membership and its exact pending batch, including ID and scan position. |
| Generation fencing | Resume replaces an old connection. The old connection cannot post, complete a wait, acknowledge, or replay a saved mutation. Its adapter surfaces replacement and stops retrying. |
| Leave/rejoin | Leave invalidates a batch. Rejoin starts a new epoch. An old ack or cached leave cannot mutate the new epoch. |
| Browser stream boundary | Fetch history at S, append a message before subscribing, then stream after S: the message arrives. History/live overlap renders once. Browser reads never acknowledge agent batches. |
| Adapter exit | Close adapter 1. The hub and adapter 2 still process a human message. Test teardown removes all test-owned processes and ports. |
| Hub restart | Restart the hub on the same test database. History, acknowledged progress and pending batches survive. Old bearer expires, explicit resume works, and stale presence is not restored as online. |
| Local HTTP boundary | Normal loopback browser and bearer clients work. Application Host/Origin checks, JSON/body limits, forged authors and room access reject invalid requests. These tests target the application's own checks, not the environment's sandbox. |

Protocol assertions validate real responses using shared output schemas, and assert both returned results and resulting history/progress. Do not substitute fixture responses in this gate.

## Browser acceptance

Current execution limitation: a previous normal headless Chrome startup failed with a Mach-port permission error in this environment. Rendered acceptance is **blocked here**, not passed by DOM inspection. `test/ui-u1-6.test.js` uses the actual hub and app modules with LinkeDOM; six scenarios passed, including two tabs/rooms, mention autocomplete and agent delivery, retries, drafts, pagination and cleanup. The user has separately shown room creation and human/agent replies in a native browser; new mention interactions still need a rendered check.

Run `npm run hub`, visit its printed URL in a supported browser, and record browser/version, viewport, screenshot paths and observations:

1. At desktop and narrow phone widths, navigate rooms, composer and participant inspector with the keyboard. Verify visible focus and access to controls without hidden/offscreen content.
2. Toggle light/dark theme and reload. Verify the explicit choice persists; unavailable storage still leaves the page usable. Check actual contrast and layout visually.
3. Use two tabs; confirm one local human identity. Create two rooms, preserve a different unsent draft in each, and switch rapidly while responses arrive late. No old-room message appears in the selected room.
4. Send a message and two attributed agent replies. Show literal markup as text. Verify Enter sends, Shift+Enter inserts a newline, and reply references identify the correct parent.
5. Interrupt the connection with a draft/pending send present, then restore it. Verify truthful reconnect state, retained draft/request ID, and one committed message after retry.
6. Inspect agents with different workspaces and status. Connected, actively receiving and reported activity remain distinct. No test agents, fabricated results, typing indicators, or unsupported work controls appear in normal mode.
7. Type @ and select a human/agent with keyboard or pointer. Include a name with spaces and distinguish duplicate names. Verify the recipient chips and highlighted message, drafts across room switches, and removal of a deleted mention. The addressed agent and its peers should receive the same room event; updated adapters include the recipient IDs. Verify an older adapter continues receiving text without failing its strict schema.

Do not mark the browser gate passed from the Node cookie client or fixture tests.

## Two-terminal live demo

Run `npm run hub`. Create a room in its webapp and open **Connect an agent** for the room ID. From the chatroom project directory, run these in separate normal terminals:

```sh
npm run chat -- --room ROOM_ID --name "API agent" --workspace /absolute/path/to/api-repo
npm run chat -- --room ROOM_ID --name "Review agent" --workspace /absolute/path/to/review-repo
```

For a nondefault port add `--hub` with the hub's printed127.0.0.1 URL. The launcher passed fake-child tests for documented Codex configuration/arguments; the actual Declawd wrapper requires this live check. The existing `npm run codex` launches the old one-agent probe and is not a substitute for this demo.

Use two disposable repository workspaces, two independently launched terminal model sessions, one real browser, and one hub. Use the existing approved client configuration and permissions. Record client/runtime/model versions and names/workspaces shown in the room, without credentials or unrelated terminal content.

1. Join both sessions to A with distinct names and descriptions. Each introduces the context it actually has.
2. In the browser, post a short question relevant to both contexts without mentioning either agent. Observe whether both contribute usefully, receive each other's replies, and return to waiting without repetitive acknowledgements.
3. After a quiet interval covering multiple receive timeouts, post another message. Confirm both continue listening; report a stopped loop as a behavioral failure even when transport tests passed.
4. Ask one particular agent to leave. Verify the other continues, and the departed agent neither responds nor shuts down the hub.
5. Reconnect the departed session explicitly as supported by the launcher. Confirm identity/history/queued delivery behavior agrees with the runbook and UI.

G1 does not validate delegated implementation, automatic idle wake-up, or responsiveness while reviewing worker results. Those remain D1/G2 scenarios. If the live launcher cannot run in this execution environment, retain the exact failure and run the demo in the user's supported terminal; passing SDK checks alone cannot close G1.

## Evidence record

For each gate record the working-tree snapshot or revision, runtime versions, command, pass/fail/blocked/not-run state, and evidence type (fixture, real protocol, rendered browser, or live model). Include concrete failure details and the next action. G1 closes only when its required layers pass; partial completion stays visible in `docs/progress.md`.
