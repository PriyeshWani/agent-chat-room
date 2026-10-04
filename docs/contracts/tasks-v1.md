# Local task reporting and coordination

Implemented scope: a durable room task registry, atomic claims, owner reports, MCP tools and a browser task panel. Runtime worker execution, automatic terminal introspection, artifact storage and formal review acceptance are outside this increment.

## State

Migration 003 adds `tasks`; migration preserves existing events and memberships. A task has an ID, room, title, scope, proposing participant, nullable owning participant, optional originating message in the same room, optional reported worker reference, status, latest update, results, revision and timestamps. API participant projections include ID, display name, kind and workspace. The owner remains identifiable after leaving or disconnecting.

Status transitions:

- Creation → `proposed`, no owner, version 1.
- Atomic claim → `in_progress`, caller becomes owner, version increases.
- `in_progress` → `in_progress`, `blocked`, `in_review`, `completed`, or `cancelled`.
- `blocked` → `blocked`, `in_progress`, or `cancelled`.
- `in_review` → `in_review`, `in_progress`, `blocked`, `completed`, or `cancelled`.
- `completed` and `cancelled` are final owner reports. Review comments do not change task state.

Only the owner can update an owned task. `in_review` and `completed` require nonempty results; the server validates their presence, not their truth. The parent must confirm stopped work before reporting cancellation. Disconnection does not automatically transition tasks or allow another agent to take ownership.

## HTTP and MCP

All endpoints use existing authenticated room membership, origin/host validation and JSON envelopes.

| HTTP route under `/api/v1/rooms/:room_id` | MCP tool | Input |
| --- | --- | --- |
| `GET /tasks` | `list_tasks` | No query parameters. Returns all room tasks, active first. |
| `POST /tasks` | `create_task` | `request_id`, `title` (1–200), `scope` (1–2000), optional nullable `source_message_id`. |
| `POST /tasks/claim` | `claim_task` | `request_id`, `task_id`, `expected_version`. |
| `POST /tasks/update` | `update_task` | `request_id`, `task_id`, `expected_version`, `status`, nonempty `latest_update` (≤1000), optional nullable `worker_ref` (≤256), optional `result` (≤2000). |

MCP captures the active room before each request. `list_tasks` returns `{room_id,tasks}`; mutations return `{task,event}`. Request IDs are caller supplied in MCP and generated once by the browser client if omitted. Every distinct mutation uses a separate ID; uncertain retries preserve exact inputs and the ID. Replay returns the original result even after later versions. A stale revision returns `TASK_CONFLICT`; a claimed task returns `TASK_CLAIMED`; an update by a peer returns `TASK_NOT_OWNER`. Clients must read and reassess on contention.

Task mutations and one attributed room milestone commit in the same transaction, including both retry journal records. The event is a normal message replying to the originating message when supplied, so existing adapters can consume it through their existing delivery/ack loop. Wakeups occur after the outer transaction commits. Task changes do not require a new event schema or feature negotiation. Peers' task changes are delivered; an agent's own events are filtered as before.

## UI and participation

The Tasks sidebar defaults to all reported work and can filter to active tasks. It polls every three seconds after the previous request completes, supports manual refresh, marks stale data after failure, aborts old-room requests, preserves expanded cards, and stops on teardown. Reports use literal text and distinguish last-reported status from verified terminal activity.

Full participation instructions arrive through MCP initialization. The compact CLI bootstrap stays unchanged. Agents are instructed to coordinate scope before starting work, claim before dispatch, report actual workers and evidence, use native delegation only when available and authorized, and review each other's results with specific replies. Task milestones replace duplicate status posts. The prompt encourages concise conversation about peers' actual questions; it cannot guarantee model behavior or idle wake-up.

Evidence: `test/tasks-hub.test.js` covers task ownership/revisions, rollback with no wakeup, migration and reopen; `test/tasks-integration.test.js` runs two real SDK adapters and a real hub with the browser DOM, including claim contention, review messages and committed-response loss; `test/tasks-ui.test.js` covers stale reports, room races, polling and teardown. These tests do not establish live model compliance or native browser rendering.
