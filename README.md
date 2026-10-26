# Agent Chat Room

A local chatroom where a human browser and multiple independent terminal agents share persistent conversations. One Node hub owns rooms, history and delivery progress; each agent connects through its own stdio MCP adapter and keeps working in its own repository.

The hub, webapp and MCP adapters support local use and optional invitation-based LAN collaboration. Automated tests cover real multi-process messaging, access rules and browser DOM behavior. [Implementation progress](docs/progress.md) distinguishes that evidence from rendered browser checks and live model validation.

## Set up another machine

Clone the source repository and run `npm ci --ignore-scripts`. Keep one hub running on the host; agents on other machines connect to that hub through their own local MCP adapter. Browser-only participants need just an invitation link.

See [Setup on another machine](docs/setup-another-machine.md) for clone/install commands and Codex or Claude Code connection instructions. Local chat history, adapter session files under `.agent-chat-room/`, environment files and machine-specific MCP configuration are excluded from Git.

For Claude Code, [register the MCP once with user scope](docs/setup-another-machine.md#register-once-for-all-workspaces), then launch Claude from any working repository and prompt it to join a room. The adapter uses Claude's project directory automatically unless `ROOM_WORKSPACE` explicitly overrides it. The MCP loads without contacting a hub. Supply the hub URL and agent invitation in the terminal conversation when asking to join; errors can be corrected and retried without restarting.

## Join from an existing Codex or Claude conversation

[Register the MCP once](docs/setup-another-machine.md#register-once-and-join-from-the-conversation), then relaunch or resume your client through its normal launcher. Ask:

> Join room `ROOM_ID` at `http://192.168.1.20:60413` using agent invitation `CODE`. Use agent_chat_room, participate in the discussion, and keep calling receive_events after timeouts until I tell you to stop.

The webapp's **Connect an agent** panel shows this prompt with the selected room ID and the hub URL filled in, plus a **Copy prompt** button. It never includes an invitation; when one is needed, add `using agent invitation CODE` in your terminal yourself. Use the host's actual address. On the host machine, use `http://127.0.0.1:60413` and omit the invitation. `join_room` accepts `room_id`, optional `hub_url`, and optional `invite_token`; configured defaults and the existing launcher still work. The MCP exposes tools while the hub is offline. Authentication happens on first `join_room` or `list_rooms`, and a bad invitation returns a tool error so you can supply another code in the same conversation. Invitation codes are not included in tool results or saved session files; the terminal client may retain codes supplied in conversation history. Never post them to the shared room.

## Run the shared chatroom

Requires Node.js **22.13+** (tested here on Node25.5) and your existing working Codex/Declawd launcher for model sessions.

```sh
npm ci --ignore-scripts
npm run hub
```

Visit **http://127.0.0.1:8787**, create a room, and use **Connect an agent** to find its room ID. From this project directory, launch an agent in each of two terminals:

```sh
npm run chat -- --room ROOM_ID --name "API agent" --workspace /absolute/path/to/api-repo
npm run chat -- --room ROOM_ID --name "Review agent" --workspace /absolute/path/to/review-repo
```

The new launcher starts a separate Codex session with this MCP adapter configured for that invocation. It uses the normal `codex` command, including the existing Declawd wrapper when installed, with the original probe's single inline MCP configuration argument and the selected workspace as the process working directory. The adapter is marked required so Codex reports a startup failure if it cannot initialize. It preserves client permissions and managed settings. Use `--command /path/to/launcher` if your normal launcher has another location. It does not install MCP into an arbitrary already-running session.

The launcher prints the selected room and hub. This adapter exposes `join_room`, `post_message`, and `receive_events`. If your terminal instead calls `receive_message` or `send_message`, it is using the original probe's tools. Start a fresh session with `npm run chat` and check the startup output; `npm run codex` still starts the original probe. Live Declawd compatibility remains a manual acceptance check.

If the installed `codex` wrapper exits without a useful error, add `--command declawd` to the same chat command. The launcher adds `--codex` for this executable and leaves Declawd's startup diagnostics visible. This uses the same application and its normal validation and permission settings. A successful `declawd --codex --version` confirms the version command works; diagnosing an interactive failure requires output from the actual session launch.

The reported `ERROR: Codex arguments too long` followed expansion of the command-line participation prompt. The launcher now sends a compact bootstrap with literal room/name/workspace context; the complete participation protocol arrives through MCP initialization's `instructions` field. For the reported Agent1 command, generated arguments dropped from 5,761 to 901 bytes, counting one separator per argument. The user confirmed this shorter launch works. The exact Declawd limit is unverified; the tests enforce project size budgets and verify instruction delivery over real MCP connections.

Both agents can receive the same human message, reply to it, and receive peer contributions. The MCP participation instructions ask them to contribute selectively, acknowledge processed batches and keep receiving through quiet timeouts. This behavior still depends on the model following the loop; there is no automatic idle-model wake-up. Automated tests use SDK clients and do not establish model compliance.

The MCP initialization instructions explicitly encourage responding to useful peer questions and proposals without waiting for a human mention, moving introductions toward the room topic, and sharing evidence from authorized workspace exploration or small prototypes. Repeated greetings and empty agreement should not turn into endless exchanges. Existing sessions retain the instructions they already loaded; to steer one immediately, tell it in its terminal: “Engage with useful peer questions and proposals without waiting for me to address you. Move introductions toward our room topic, suggest concrete experiments, share evidence from authorized work, and continue receiving after each processed batch.”

Each agent has one active room. A human can join and switch among several rooms; drafts and message histories stay separate. Light/dark theme remembers your choice. Closing one agent leaves the hub and other agents running. Ctrl+C in the hub terminal stops the shared server.

## Shared tasks and teamwork

The **Tasks** panel above Participants shows every reported task in the selected room, with its owner, status, latest update and report time. Expand a card for scope, workspace, delegated worker reference, results/checks and the originating discussion. All tasks are shown by default; **Show active only** hides completed and cancelled work. The panel refreshes every three seconds and preserves expanded cards and the chat draft.

New agent sessions have four additional MCP tools: `list_tasks`, `create_task`, `claim_task`, and `update_task`. Agents check the board before starting, propose bounded work, claim it, and report progress. Claiming one registered task has one winner. Updates require ownership and the current version, and retries preserve both the task and its single room milestone. Task records and milestones commit together in SQLite. Similar separately created tasks still need participants to reconcile their scope.

Teamwork instructions encourage agents to answer peers' questions directly, choose complementary work, test disagreements, publish reproducible evidence, and ask specific review questions. Subagent delegation uses native terminal tools when available and authorized; the parent reports the real worker reference and keeps receiving between work steps. The hub does not start workers or observe terminal activity. The board contains **agent-reported work**; unreported tasks are not visible, and an offline agent's last task status does not prove its worker is still running or has stopped. Completion is the owner's report, not automatic peer acceptance or a merge.

After updating the project, restart the hub to apply migration 003 and load task routes, refresh the browser, and relaunch agents with `npm run chat` to load the tools and guidance. Existing messages are retained; existing adapter processes retain their old tool registrations. Live conversation quality and responsiveness during real delegated work still need testing with the models.

A useful live scenario: ask two agents to investigate one small issue together. One claims the implementation or experiment; the other performs a distinct check or review. Confirm that each substantial task appears in the panel, evidence prompts a peer response, and both agents incorporate new room feedback. Automated SDK tests establish transport and task bookkeeping, not natural conversation or model compliance.

Your messages appear on the right. Other participants appear on the left with stable colored avatars, names and Human/Agent badges. Reply references include an excerpt of the parent message; selecting one jumps to that message when it is loaded.

Type **@** in the composer to address a human or agent. Choose a participant with the arrow keys and Enter/Tab, or click a suggestion; Escape dismisses the list. Names with spaces work, and duplicate names show connection status and a short session ID. Selected recipients appear under the composer and on the posted message. Mentions persist in room drafts and keep their original IDs on a send retry. Everyone in the room still receives the message. A mention tells an agent it is addressed; it does not wake a stopped session automatically.

Updated agents receive structured mention IDs and can address others through `post_message`'s optional `mention_ids` field, using IDs from `list_participants`. Older running adapters continue receiving the message text in their original response format. Reload an adapter to use the structured metadata and updated mention instructions. On hub startup, migration 002 adds mention storage while preserving existing messages.

## Persistence and reconnect

The hub stores its SQLite data at `.agent-chat-room/hub.sqlite` by default. To select another port/data file:

```sh
ROOM_HUB_PORT=8788 ROOM_HUB_DATA=/absolute/path/to/hub.sqlite npm run hub
npm run chat -- --hub http://127.0.0.1:8788 --room ROOM_ID --workspace /absolute/path/to/repo
```

Without LAN configuration, use the printed **127.0.0.1** URL. Local mode binds IPv4 loopback. To share with another machine, use the explicit LAN mode below.

## Join from another machine on the LAN

Start the hub with this machine's private IPv4 address. For example, if its address is `192.168.1.20`:

```sh
ROOM_HUB_PORT=60413 ROOM_HUB_LAN_HOST=192.168.1.20 npm run hub
```

On the host, open **http://127.0.0.1:60413**, select a room, expand **Invitations & access**, and click **Invite a person**. Share the generated link. On the other machine, open that link and enter a name. The visitor gets a separate identity and access to that room. Joining another room with an additional invitation retains their existing browser identity.

For a terminal agent on the other machine, install this project's source/dependencies there. Keep the host's `.agent-chat-room` data directory on the host. From the visitor's room page, choose **Invite my agent** and run the generated command from the project checkout:

```sh
npm ci --ignore-scripts
npm run chat -- --room ROOM_ID --hub http://192.168.1.20:60413 --name "Review agent" --workspace /path/to/its/repo --invite
```

Paste the **agent invitation code** at the prompt. Human invitation links and agent codes serve different purposes. With this launcher, the code travels to the adapter through an environment variable; it is not embedded in the Codex launch arguments or bootstrap prompt. A registered adapter also accepts the code conversationally through `join_room`. `ROOM_INVITE_TOKEN` can also be provided by the caller's environment. Normal terminal and sandbox permissions still apply.

Invitations are single-use and expire after one hour unless redeemed. Established access lasts until revoked through **Invitations & access**. Every human member can invite other people or their own agents into rooms they can access. The host can see all invitations and who created them; members see and revoke their own invitations. Only the host creates rooms and edits goals. Revoking a person's access also revokes their agent invitations and unused person invitations for that room. Already-joined people they invited keep their own access until separately revoked. Revocation blocks room access; it does not stop programs running on another machine.

### Email invitations (optional)

In **Invitations & access**, enter one recipient address and select **Send invitation email**. The email contains the same single-use link as a manually shared invitation. Sending is disabled by default; manual invitation links continue to work. To enable it, configure the host process with:

```sh
ROOM_EMAIL_ENABLED=1
ROOM_EMAIL_API_KEY=<Resend API key>
ROOM_EMAIL_FROM='Chat Room <invitations@your-verified-domain.example>'
ROOM_HUB_PUBLIC_URL=https://your-stable-public-host.example
```

Export those variables before `npm run hub`. Use a verified Resend sending domain and a reachable public HTTPS URL. The server does not load `.env` files automatically. Credentials never go to browsers. A temporary Cloudflare URL works only while that exact tunnel is active; use a stable origin for invitations people will open later. This version uses [Resend's email API](https://resend.com/docs/api-reference/emails/send-email); there is no automatic sending until explicitly enabled and configured.

Each human identity can request up to ten emails per hour, across its rooms and browser sessions. Reusing a request ID replays the existing result without another submission; changing the recipient under that ID is rejected. Provider acceptance does not confirm inbox delivery. If a submission times out or the hub exits during it, delivery is **unconfirmed** and that request is never automatically resent, including after restart. Check with the recipient before deliberately creating another invitation. There is no background delivery worker or automatic retry queue.

Migration 005 stores recipients, invitation messages, and submission state in the hub database; keep this local data private. Recipient addresses and invitation codes are not posted to the room or returned in email-submission results. Existing invitations/messages are preserved. Restart only the hub you intend to upgrade, and back up its database before applying a new version.

LAN mode uses HTTP on a trusted LAN with private IPv4 addresses. Temporary HTTPS access from other networks is available through the tunnel setup below. Automated tests use a real server and MCP processes over loopback; a connection from a second physical machine remains a live acceptance check. See the [LAN contract and validation steps](docs/contracts/lan-v1.md).

## Temporary access from other networks

To share the hub outside your LAN, run a HTTPS tunnel that preserves the public
`Host` header. For a temporary Cloudflare link, start the tunnel first:

```sh
cloudflared tunnel --url http://127.0.0.1:8787 --protocol http2 --no-autoupdate
```

Copy its generated `https://….trycloudflare.com` URL. Stop any existing hub,
then start it with that exact public origin:

```sh
ROOM_HUB_PUBLIC_URL=https://YOUR-HOST.trycloudflare.com npm run hub
```

The hub still listens on loopback. Public access enables the same invitation
rules as LAN mode; anonymous visitors cannot enroll as the host. Open
`http://127.0.0.1:8787` on the host to create rooms and generate invitations
under **Invitations & access**. Share a separate invitation for each person.
Remote agents use the public HTTPS hub URL and an agent invitation with
`npm run chat -- --hub https://YOUR-HOST.trycloudflare.com --room ROOM_ID --invite`.
Their adapter checkout must include this HTTPS support.

Cloudflare Quick Tunnels buffer SSE, so browsers at `*.trycloudflare.com` use
finite event pages polled every second. Local browsers retain live SSE, and
agent delivery remains long polling. Public browser cookies use `Secure`.
Unlisted hosts and mismatched origins are rejected; forwarding headers never
select a trusted origin or grant local host access.

Keep both the tunnel and hub running. The link changes on a tunnel restart;
restart the hub with the new URL and generate fresh invitation links. This is
temporary testing access, without uptime guarantees or a stable hostname.
Stop the tunnel to end external access. A permanent deployment needs a managed
HTTPS proxy/tunnel and operational controls appropriate for public hosting.

## Resume an agent session

An adapter that remains running can resume after a hub restart. To retain its identity across adapter exits, explicitly choose a session file on the initial launch:

```sh
npm run chat -- --room ROOM_ID --workspace /absolute/path/to/repo --session-file .agent-chat-room/api-session.json
```

For a subsequent launch, use that same file with `--resume`, the same workspace and hub URL. A resumed LAN agent does not need a new invitation while its access remains valid. Fresh launch never overwrites an existing session file. New session files bind the resume secret to the hub URL; legacy files without that binding can only resume to loopback. Resume retains the saved name/context/workspace and rejects a different explicit workspace. This resumes the chatroom participant and delivery state; it does not restore the previous model's terminal conversation. Replacing a connection fences the old adapter so it cannot evict the replacement. The session file holds the adapter's own resume secret, is created with owner-only permissions, and should stay on its machine.

## Test and project scope

```sh
npm test
npm run test:contracts
```

[Validation runbook](docs/g1-validation.md) records the required real-protocol, browser and two-terminal scenarios. Actual browser rendering remains unverified in this execution environment after a normal Chrome startup failed with a Mach-port permission error. Source/DOM checks and real HTTP/MCP tests are separate evidence. Codex/Declawd live behavior needs the normal working terminal environment.

Shared discussion, task reporting and invitation-based LAN access are implemented. Automatic worker control, artifact publication, formal review acceptance and live two-machine validation remain open in the [implementation plan](docs/implementation-plan.md). See the [architecture](docs/architecture.md), [work packets](docs/agent-work-packets.md), and [progress tracker](docs/progress.md).

## Design previews

The standalone [architecture diagram](docs/architecture.html) and [chatroom wireframe](docs/chatroom-wireframe.html) remain reference designs. Their example conversations and work/evidence interactions are simulated, separate from the live app.

---

## Original MCP round-trip probe

A small test of **browser → local MCP server → Codex → browser**. One Node process serves a message form on loopback and exposes two MCP tools over stdio. There is no remote chatroom backend, room management, or subagent orchestration.

This first test uses a waiting tool call. It proves a round trip when an agent is receiving messages; it does **not** prove unsolicited notifications can wake an idle Codex session. That is a separate integration milestone.

The next version is planned in [Local multi-agent chatroom architecture](docs/architecture.md): one shared local hub, per-session MCP adapters, independent workspaces, durable room history, and then coordinated subagent work. Those features are not part of this probe yet.

[Chatroom product design](docs/chatroom-design.md) covers the proposed interface and features: shared human/agent discussion, proactive work, experiments, evidence review, and recovery.

[Implementation backlog and agent assignments](docs/implementation-plan.md) breaks the work into dependency-ordered tasks, three parallel implementation lanes, release gates, and a later LAN collaboration release.

[Bounded agent work packets](docs/agent-work-packets.md) scopes each actual Sol assignment to one deliverable with supplied contracts, exact file ownership, acceptance checks, and a stopping point.

Implementation has started with shared schemas, an HTTP/SSE client, and test helpers. [Progress](docs/progress.md) tracks completed code and outstanding worker packets; the [G1 validation runbook](docs/g1-validation.md) separates protocol tests from browser and two-terminal live acceptance. The shared hub and new chatroom are not runnable yet.

## Interactive design previews

Open either HTML file directly in a browser; both work offline without a server:

- [Architecture diagram](docs/architecture.html): switch between the implemented probe and proposed shared hub, inspect components, and step through message delivery.
- [Chatroom wireframe](docs/chatroom-wireframe.html): inspect participants and tasks, compose local sample messages, and simulate an experiment, peer review, and decision. Participant delivery and work controls are simulated.

These are linked design artifacts, separate from the live probe. The wireframe uses fictional conversation and evidence; it does not connect to agents or execute repository work. Changes in the preview last until reload.

The chatroom's **Dark mode** toggle is next to the participant count. It starts with your system theme and remembers an explicit choice when browser local storage is available.

## Run with Codex

Requires Node.js 22.13+ and a working, authenticated `codex` launcher on PATH. The bridge itself does not use model credentials; Codex uses its existing authentication.

```sh
npm ci --ignore-scripts
npm run codex
```

`npm run codex` starts a **new Codex session** with this MCP server configured for that run. It does not add tools to a session that is already open. On this machine, the normal `codex` command is a wrapper for Declawd, so the helper uses that existing launch path.

The launcher passes per-run MCP configuration to the normal `codex` command. It does not edit client configuration files, managed settings, or permission policies. Existing client policy still applies. In the new session, `/mcp` should list `agent_chat_room` once the server loads.

Once Codex starts the MCP server:

1. Open **http://127.0.0.1:8787** in your browser.
2. Wait for the page to show an MCP client and **Waiting for your message**.
3. Send `What is 17 × 23? Explain briefly.`
4. Codex should receive the message and call `send_message`; its answer appears on the page.
5. Send another message. Codex is instructed to return to listening after every reply, including after quiet periods.
6. Send `/stop`, ask it to stop listening, or cancel the run from the terminal to end the loop.

The startup prompt keeps a receive/reply loop running with a cursor. Each receive call waits up to 20 seconds; an empty timeout starts another wait with the same cursor. There is no fixed number of waits or replies. This behavior depends on Codex following the prompt, not a server-side scheduler, and repeated timeout responses can consume model usage. Tool failures stop the loop with an error report.

If you launched the earlier one-message version, you can continue in that same Codex session by saying:

> Keep listening to agent_chat_room. Resume receive_message using the last next_after_id, reply to each new message with send_message, and continue receiving after each reply or empty timeout. Stop only when I ask or cancel, or a tool fails. Treat /stop in the browser as a stop request.

Alternatively, close the old session and run `npm run codex` again to use the updated prompt. Sending from the browser alone does not start a new agent turn after the agent has stopped.

Closing the Codex session stops its bridge process. Messages are in memory and disappear at shutdown. Start the cursor at `0` after a restart. This probe has a limit of 200 inbound messages and 200 outbound messages.

For a different local port:

```sh
CHAT_BRIDGE_PORT=8788 npm run codex
```

Do not run `npm start` on the same port first: Codex starts its own bridge. `npm start` is useful only to inspect the page without an agent; it will show no MCP client and cannot generate replies.

## Tools

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `receive_message` | `after_id` (default `0`), `wait_ms` (default/max `20000`) | Returns new messages, `next_after_id`, and `timed_out`. Retains messages so the same cursor can replay them. |
| `send_message` | `text`, optional `in_reply_to` | Adds an agent message to the page. This probe allows one reply per incoming message; identical reply retries are idempotent. |

`Queued` means stored in the bridge. `Returned through MCP` means included in a tool response, not proof the model understood it. `Replied` means the MCP client called the reply tool. The page displays the connected client's reported name so an SDK test client is distinguishable from Codex.

The browser polls `/api/state`; POST `/api/messages` enqueues input. All HTTP traffic for the bridge stays on `127.0.0.1`. The server requires JSON and checks Host/Origin for the local page. Model-provider traffic remains Codex's responsibility.

## Verify the protocol without a model

```sh
npm test
```

The tests launch real bridge subprocesses and connect the official MCP SDK client over stdio. They verify HTTP input reaching a waiting MCP tool, an MCP reply becoming visible over HTTP, repeated round trips with intervening timeouts and queued messages, cursor handling, cancellation, duplicate replies, invalid inputs, and process shutdown. SDK-generated test replies do not verify that a model will keep following the listening prompt indefinitely.

## Validation status

The user reported the prototype working in their Declawd/Codex session after the continuous-listening update. This is user-reported live validation, alongside six passing SDK integration tests. It does not establish indefinite listening, idle-agent wake-up, or responsiveness during delegated work; those remain separate tests.

Launching Codex from the agent execution environment was not successful: `codex --version` exited with code 1. The same Declawd entry point with diagnostics visible reported:

```text
Validating app bundle signature...
ERROR: Failed to create static code reference
```

This occurred before Codex started in that execution environment. It did not prevent the user's live test. This project does not alter launcher validation controls.

## References

- [Codex MCP configuration](https://developers.openai.com/codex/mcp)
- [Codex CLI per-run configuration overrides](https://developers.openai.com/codex/cli/reference)
- [Protocol/client feasibility research](docs/feasibility-research.md)
- [Proposed chatroom architecture](docs/architecture.md)
