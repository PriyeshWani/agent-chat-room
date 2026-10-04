# UI component seams, local v1

Specified interfaces for bounded UI packets. Use the existing RoomClient by injection and literal DOM text; no production fixture imports. Shared client imports are confined to U1.6 composition. Components can import their sibling modules, use standard browser APIs and accept injected DOM elements. DOM tests use the installed `linkedom` dev dependency and do not establish rendered-browser acceptance.

## U1.2 rooms and drafts

`createDraftStore({storage?} = {})` in `drafts.js` returns `get(roomId)`, `set(roomId,{text,replyTo,mentions?})`, `clear(roomId)`. Values are `{text:'',replyTo:null}` by default; `replyTo` is an event ID or null. Optional mentions are `{id,name,kind}` snapshots; omit empty lists, preserve selected IDs and return deep copies. In-memory room isolation is required, optional local storage is failure-safe. Never store credentials.

`createRoomNavigation({client, list, createButton, onSelect, onState, requestRoom?})` in `rooms.js` returns `refresh()`, `select(roomId)`, `create({name,goal})`, `getState()`, `destroy()`.

- `list` is the rooms-list DOM node; `createButton` is the shell control. Use `list.ownerDocument` for new nodes. Render room buttons safely with selected state.
- `requestRoom` is an optional async function resolving `{name,goal}` or null; the default may present a simple accessible native form/dialog created by this module. Cancellation performs no mutation. Enable the create control once mounted.
- `getState()` returns `{rooms,selectedRoomId,status,error,operation}`. State notifications use the same shape; status is `idle`, `loading`, `ready`, or `error`, and operation is `refresh`, `select`, `create`, or null. Emit `loading`/`select` before room-selection I/O so composition can stop the previous feed. A list refresh need not stop an existing feed. `onSelect(joinResult)` runs only for the latest successful selection.
- `refresh` lists rooms and updates navigation; if none is selected, select the first room when any exist. An empty list remains a truthful empty state. Humans retain membership when switching rooms; never leave on tab/channel switch.
- `select` calls join; stale callbacks and destroyed components must not select a room or show an obsolete error. Abort previous HTTP where possible; a completed old human join may remain durable without affecting selected UI state.
- `create` keeps the same request ID across an uncertain retry of that creation; success adds/selects its room. Duplicate names surface errors. Do not create a new mutation on every internal transport retry.
- Destroy aborts owned requests and removes listeners. No conversation rendering/stream behavior in this packet.

U1.2 writes rooms.js, drafts.js, test/ui-u1-2.test.js. Test room selection races, create/list, identity retained, separate draft copies and storage failures using injected client calls or the shared fixture.

## U1.3 conversation and composer

`createConversationView({element,onReply})` in `conversation.js` returns `setEvents(events)`, `addEvents(events)`, `setPending(items)`, `setViewer(participantOrNull)`, `getEvents()`, `clear()`, `destroy()`. Composition supplies the authenticated browser participant through `setViewer`; only that participant's messages align right. Events are shared RoomEvent shapes; deduplicate by ID and sort by sequence. Render human/agent name, role badge, stable participant color/initials, local time with full timestamp on hover, literal message and optional reply reference with a bounded text excerpt. Names and role labels remain visible independently of color. The participant panel shares `participantAppearance(participant)` for consistent avatars. Replies invoke `onReply(event)`. Pending items are `{requestId,roomId,text,replyTo,status,error?,retry?}` with status `sending` or `failed`; they must be visibly unconfirmed and align with the viewer's messages. Only show items for the current room as supplied by composition. Preserve scroll position when reading older content; autoscroll when near the end. Never use untrusted innerHTML.

`createComposer({client,form,input,sendButton,drafts,onPosted,onPending,onError})` in `composer.js` returns `setRoom(roomOrNull)`, `setReply(eventOrNull)`, `retry(requestId)`, `getPending()`, `destroy()`. It uses the shared U1.2 draft store. Generated IDs use crypto.randomUUID; client receives explicit request_id.

`createMentionPicker` in `mentions.js` provides room-scoped asynchronous participant lookup, keyboard/click suggestions, caret-aware insertion and selected recipient snapshots. Names with spaces are supported; duplicate names require explicit selection and show session identity. Unique names typed in full resolve automatically. Editing away a token removes its recipient. Escape dismisses suggestions; Enter/Tab selects before the composer can send, and IME composition does not select. Draft and pending state retain recipient IDs through room switches/retries. Render mentions using text nodes and authoritative event metadata, never HTML or arbitrary display-name attribution.

- Switching rooms saves/restores the correct draft and reply target. No room means disabled composer. The module may create a reply-preview/cancel control inside its form without editing the shell.
- Enter submits; Shift+Enter inserts newline; IME composition must not submit. Whitespace-only input does not send. Submission snapshots room/text/reply/ID. Disallow simultaneous sends in one room but permit room switching.
- A transport failure retains one failed pending item and original ID/payload for retry. Editing a draft must never change an existing pending request's payload. Success removes that item, calls `onPosted(event)`, and clears only the unchanged original draft, never a newer draft or another room's draft.
- `onPending(items)` contains pending items across rooms; composition filters by selected room. `onError(error)` reports a user-appropriate error; no fabricated success. Destroy removes listeners and aborts owned work without implicit confirmation.

U1.3 writes conversation.js, composer.js, test/ui-u1-3.test.js. Use DOM tests for literal markup, ordering/replies, stable retry IDs, stale send completion and keyboard semantics.

## U1.4 event feed

`createEventFeed({client,onEvents,onState,retryMs=1000})` in `event-feed.js` returns `select(joinResult)`, `add(event)`, `loadOlder()`, `getState()`, `destroy()`.

Each selection replaces the current room, aborts the previous feed and seeds immutable join history; `select(null)` stops/clears it. `onEvents(events)` emits sorted/deduplicated current-room events; `onState({roomId,status,error,nextBefore})` reports `connecting`, `live`, `reconnecting`, `error` or `idle`. Stream from that snapshot's head and reconnect from the last contiguous observed sequence. RoomClient.events accepts optional `onOpen`, called after valid stream headers; use it to report live even in a quiet room. A successful HTTP post may render optimistically as confirmed via add but must not advance the stream replay cursor past unseen intervening events. EOF reconnects; fatal authorization/version errors surface instead of spinning. Bounded retry timers are cancelled on selection/destruction. Historical pagination retains the existing feed and is generation-fenced; never mutate an agent acknowledgement. Test with controlled async iterators and deferred history calls, not fixed sleeps.

U1.4 writes event-feed.js, test/ui-u1-4.test.js.

## U1.5 participants

`createParticipantPanel({client,list,inspector,pollMs=5000})` in participants.js returns `select(roomOrNull)`, `refresh()`, `destroy()`. Poll authenticated participants for the selected room; abort/ignore stale room responses. Render name/kind/runtime/workspace/context and explicit connection/delivery/pending/activity timestamp. Preserve shell inspector disclosure controls. Unknown activity is unknown, not inferred worker failure or typing. No pause/task controls in G1. Failure shows stale/error state and does not claim current status. Test with DOM and controlled responses.

U1.5 writes participants.js, test/ui-u1-5.test.js.

## U1.6 live composition

All earlier UI modules and real createHub now exist. Export `async mountChatroom({document,client})` from app.js, returning `{rooms,feed,composer,participants,retry,destroy}` after initial bootstrap/navigation attempt. Injectable client is RoomClient; production auto-start dynamically imports `/shared/client.js` when document/window exist. Node imports must not resolve that absolute browser URL unless actually auto-starting. Keep theme.js as the independent shell script and add app.js as the second module script in index.html.

Compose existing modules, bootstrap the browser identity, list/create/select rooms, update room title/goal and truthful empty states. Selection loading stops old feed/panel and temporarily disables composer while saving its draft. Successful selection seeds feed and panel, restores composer draft, and filters pending messages by room. On failure restore the previous valid room/feed or keep a clear disabled error state with retry; never display old messages under a new title. Feed state controls the connection banner using onOpen; a quiet room is connected. Sender callbacks add committed events only to their own current room. Older-history button delegates loadOlder and is hidden/disabled when unavailable. No fixture data or fake workers. Expose a visible retry control for initial connection/selection failure. Destroy all owned listeners/timers/requests on page teardown.

U1.6 owns app.js, index.html, style.css (final module styling), test/ui-u1-6.test.js. Keep styling consistent with the approved sage light/dark shell; style actual message/reply/pending/history/channel controls and readable participant data. Tests use actual hub plus shared browser client and linkedom for two tabs/rooms, send/receive, room drafts, stale selection errors, markup safety and cleanup. These are real-protocol plus DOM evidence, not rendered browser acceptance. Run node --test test/ui-u1-6.test.js; no model calls or browser-control workarounds.
