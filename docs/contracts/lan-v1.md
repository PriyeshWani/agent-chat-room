# LAN collaboration, initial implementation

## Hosting

`ROOM_HUB_LAN_HOST=<private IPv4>` explicitly enables LAN mode. The hub listens on `0.0.0.0` and advertises `http://<private IPv4>:<port>` while preserving its localhost URL for host administration and existing local agents. Without this option it binds only `127.0.0.1`. Supported addresses are literal RFC1918 IPv4 addresses; hostnames, IPv6 and public hosting are outside this increment. Traffic is HTTP, not encrypted.

The HTTP server allows only the configured LAN authority and localhost authority. A browser Origin must match the authority receiving its request. It ignores forwarding headers for local trust. Anonymous host bootstrap requires both an actual loopback peer socket and the localhost Host value; reaching the LAN address from the host also requires an invitation or an established browser session.

No OS firewall, sandbox, managed configuration or proxy setting is changed. The adapter connects directly to the selected hub with the terminal's existing network permissions. This is not a relay for bypassing network restrictions.

## Identity and room access

Migration 004 adds `hub_settings`, `invitations`, `room_access` and `agent_scopes`. It preserves the original local owner explicitly rather than deriving that identity from later guest creation order.

- Host: retains the original local identity, creates rooms, invites people and agents, and revokes room invitations.
- Invited human: has a separate owner/participant and cookie session. May read, join, message and report tasks in granted rooms, and invite agents belonging to them. May not create rooms or invite other people.
- Invited agent: belongs to the inviting human's owner ID and is scoped to the invited room, including agents invited by the host. Local agents enrolled through the localhost endpoint without an invitation retain local behavior.

Every room read/write checks the grant, in addition to membership. Room listing filters by access. These checks cover messages/history, tasks, participants, delivery, acknowledgements and SSE. Guessing a room ID or changing a display name grants no access. Rejoining another room with an invitation preserves an existing human's browser identity and adds a grant.

## Invitations and lifecycle

| Endpoint | Behavior |
| --- | --- |
| `POST /api/v1/sessions/browser` | Restores an existing browser session; allows anonymous local host bootstrap; otherwise returns `JOIN_REQUIRED`. |
| `POST /api/v1/sessions/join` | Redeems a human invitation using `request_id`, `invite_token`, and `name`; sets an HttpOnly, SameSite=Strict cookie. |
| `POST /api/v1/rooms/:room/invitations` | Human member creates an invitation: `request_id`, `kind` (`human` or `agent`), optional label and `expires_in_minutes` (1–1440, default 60). |
| `GET /api/v1/rooms/:room/invitations` | Lists metadata, use and revocation status. The host sees all room invitations; guests see their own agent invitations. Tokens are omitted. |
| `POST /api/v1/rooms/:room/invitations/revoke` | Human creator/host revokes with `request_id` and `invitation_id`. |
| `POST /api/v1/sessions/agent` | Fresh LAN enrollment requires an agent `invite_token`; resume uses the existing resume secret and rechecks scope. |

Codes use 32 random bytes and are matched by hash. Invitation creation/redeem transactions preserve exact retry outcomes, including issuance credentials in the private database's retry records. Human redemption is tied to a request ID/name; agent redemption is tied to its resume secret. Reusing a code for another redemption is rejected. Expiry limits initial redemption; it does not terminate already-established access. Revocation rejects all later access/replay, wakes pending delivery checks, and closes room streams. Revoking human access also revokes that person's agent invitations for the room; later regranting human access does not revive those old agents.

Revocation does not cancel terminal work. Tasks and messages retain historical attribution. Guest browser cookies may still identify the guest after revocation, but grant no access to the revoked room.

## Browser and terminal clients

The host UI provides **Invitations & access**. A human link places the code in `#invite=...`; the browser removes the fragment after reading it and redeems only after form submission. Codes are not put into chat messages, request URLs or persistent browser storage. Agents use a separate code, supplied conversationally to `join_room` as `invite_token`, entered with `npm run chat ... --invite`, or supplied in `ROOM_INVITE_TOKEN`. MCP startup is offline; enrollment occurs on the first hub tool call. Codes passed in a terminal conversation may be retained by that client, and must not be posted to shared room messages or tasks.

The launcher forwards that environment variable using `env_vars = ["ROOM_INVITE_TOKEN"]`. [Official Codex MCP documentation](https://developers.openai.com/codex/mcp), searched and fetched September 28, 2026, defines this field as “Environment variables to allow and forward.” The value stays out of the launch arguments and participation prompt. The launcher uses normal client permissions; it does not pass `--yolo` or change managed settings. Native Declawd forwarding still needs a live agent check; automated launcher tests use a fake child, while adapter tests use actual SDK/stdio processes.

New optional session files include `hubUrl` alongside the profile and resume secret; an origin mismatch fails before enrollment. Legacy files lacking `hubUrl` can only resume to loopback. Invitations are not saved in the session file. HTTP clients reject redirects, so enrollment payloads cannot be forwarded to another destination by a redirect.

Browser message/room/mention IDs use `crypto.getRandomValues` when `crypto.randomUUID` is absent on an HTTP LAN page. Invitation and session secrets are generated by Node on the hub.

## Evidence and live acceptance

`npm test` includes distinct humans and room isolation, actual invited MCP ownership and delivery, expiry, same-request replay, wrong invitation kinds, host-bootstrap checks, scope enforcement, restart persistence, revocation of pending receive/SSE, and second-room grants without reviving revoked agents. Browser DOM tests exercise invitation creation, joining, agent-code generation, attribution, room-switch races and HTTP random-ID fallback. Launcher checks verify environment forwarding and EOF handling; URL/session tests reject a different hub; a real local redirect fixture verifies that enrollment data is not forwarded.

All network integration tests use test-owned loopback listeners. They model the LAN endpoint's Host/Origin and are not a two-machine test. Live checklist:

1. Start LAN mode on the host's current private IP and open its localhost page.
2. Create a person invitation and open the generated link on the second machine. Enter a name; verify room visibility and distinct attribution.
3. From that person's page, create an agent invitation. Run the generated chat command from a source checkout on that machine, using its own repository as workspace. Verify its participant and task reports.
4. Exchange a human message, a peer-agent reply and an @mention. Confirm both browsers see the same history.
5. Revoke the guest's access on the host and verify further room access is rejected. Confirm host/local agents remain usable.

If the second machine cannot connect, record its actual error. Network reachability and native client behavior are unverified until this check; this implementation does not change network policy to make the connection succeed.
