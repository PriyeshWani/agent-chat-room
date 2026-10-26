import { createRoomNavigation } from './rooms.js';
import { createDraftStore } from './drafts.js';
import { createConversationView } from './conversation.js';
import { createComposer } from './composer.js';
import { createEventFeed } from './event-feed.js';
import { createParticipantPanel } from './participants.js';
import { createTaskPanel } from './tasks.js';
import { createAccessPanel } from './access.js';
import { requestId } from './ids.js';

export async function mountChatroom({ document, client, clipboard = null }) {
  const $ = id => document.getElementById(id);
  const window = document.defaultView;
  let destroyed = false;
  let bootstrapped = false;
  let bootstrapController = null;
  let bootstrapPromise = null;
  let currentRoom = null;
  let selectionPending = false;
  let pending = [];
  let lastAttempt = { kind: 'refresh' };
  let retryAction = null;
  let noticeOwner = null;
  let historyRequest = 0;
  let historyLoading = false;
  // Goal saves and room metadata reads are fenced by the room selection
  // generation; metadata revisions keep an older read from undoing newer data.
  let selection = 0;
  let goalSave = 0;
  let goalEditor = 0;
  let goalController = null;
  // An uncertain goal save keeps its request_id so retrying the same edit
  // replays the original mutation instead of committing it a second time.
  let goalAttempt = null;
  let roomRevision = 0;
  let metadataController = null;
  let metadataQueued = false;
  let rooms, feed, composer, participants, tasks, accessPanel, browserAccess;
  let storage = null;
  try { storage = window?.localStorage ?? null; } catch { /* Drafts still work in memory. */ }
  const drafts = createDraftStore({ storage });
  const view = createConversationView({ element: $('conversation'), onReply: event => composer.setReply(event) });

  function notice(error, action, owner = 'navigation') {
    if (destroyed) return;
    retryAction = action ?? null;
    noticeOwner = error ? owner : null;
    $('app-error').textContent = error?.message ?? '';
    $('app-notice').hidden = !error;
    $('retry-button').hidden = !action;
  }
  function empty(title, description) {
    $('conversation-empty-title').textContent = title;
    $('conversation-empty-description').textContent = description;
    $('conversation-empty').hidden = false;
  }
  function syncPending() {
    view.setPending(currentRoom ? pending.filter(item => item.roomId === currentRoom.id) : []);
    if (currentRoom) {
      const hasContent = view.getEvents().length > 0 || pending.some(item => item.roomId === currentRoom.id);
      $('conversation-empty').hidden = hasContent;
      if (!hasContent) empty('Start the conversation', 'Send a message to everyone in this room.');
    }
  }
  function resetRoomRequests() {
    ++selection; ++goalSave; ++roomRevision;
    goalController?.abort(); goalController = null;
    metadataController?.abort(); metadataController = null; metadataQueued = false;
  }
  function stopRoom(loading = false) {
    currentRoom = null; selectionPending = loading; resetRoomRequests();
    ++historyRequest; historyLoading = false;
    composer.setRoom(null); feed.select(null); void participants.select(null); void tasks.select(null); view.clear();
    accessPanel.select(null);
    $('older-history-button').hidden = true;
    $('connect-agent').hidden = true;
    $('agent-room-id').value = ''; $('agent-command').textContent = ''; $('agent-join-prompt').textContent = ''; $('agent-join-copy-status').textContent = '';
    $('room-title').textContent = loading ? 'Opening room…' : 'No room selected';
    $('room-goal').textContent = loading ? 'Waiting for room access.' : 'Select or create a room to begin.';
    closeGoalEditor(); $('room-goal-edit').hidden = true; $('room-goal-status').textContent = '';
    empty(loading ? 'Opening room…' : 'A place to work together', loading ? 'Loading the room conversation.' : 'Select or create a room to begin.');
  }
  // A host tab on 127.0.0.1 shares its loopback origin so a local agent can
  // enroll without an invitation; visitors share the advertised LAN URL.
  function promptHubUrl() {
    const origin = client.baseUrl || window?.location?.origin;
    let loopback = false;
    try { loopback = new URL(origin).hostname === '127.0.0.1'; } catch { /* Fall back to the advertised URL. */ }
    return loopback ? origin : browserAccess?.public_url ?? origin;
  }
  const joinPrompt = (roomId, hubUrl) => `Join room ${roomId}${hubUrl ? ` at ${hubUrl}` : ''}. Use agent_chat_room, participate in the discussion, and keep calling receive_events after timeouts until I tell you to stop.`;
  async function copyJoinPrompt() {
    const text = $('agent-join-prompt').textContent;
    if (!text) return;
    try {
      await (clipboard ?? window.navigator.clipboard).writeText(text);
      if (!destroyed) $('agent-join-copy-status').textContent = 'Copied.';
    } catch {
      if (destroyed) return;
      // Fall back to selecting the prompt so it can be copied by hand.
      try { window.getSelection?.().selectAllChildren($('agent-join-prompt')); } catch { /* Selection is optional. */ }
      $('agent-join-copy-status').textContent = 'Copy unavailable; select the prompt and copy it.';
    }
  }
  function closeGoalEditor() { $('room-goal-form').hidden = true; $('room-goal-input').disabled = false; $('room-goal-save').disabled = false; }
  function showGoal(room) {
    $('room-goal').textContent = room.goal || 'No room purpose set.';
    // LAN guests cannot edit; the hub enforces the same host-only rule.
    // An open editor keeps its draft; only the displayed goal changes.
    $('room-goal-edit').hidden = browserAccess?.can_create_rooms === false || !$('room-goal-form').hidden;
  }
  function applyRoom(room) {
    ++roomRevision;
    currentRoom = { ...currentRoom, goal: room.goal };
    showGoal(currentRoom);
  }
  // Room events may follow a metadata change made elsewhere, such as another
  // tab editing the goal. Re-read the authoritative room rather than parsing
  // message text. One read is in flight at a time; later events queue another.
  async function refreshRoom() {
    if (destroyed || !currentRoom || selectionPending) return;
    if (metadataController) { metadataQueued = true; return; }
    const roomId = currentRoom.id, token = selection, revision = roomRevision;
    const controller = metadataController = new AbortController();
    try {
      const history = await client.history(roomId, { limit: 1, signal: controller.signal });
      if (destroyed || token !== selection || controller.signal.aborted || history.room.id !== roomId) return;
      if (revision !== roomRevision) { metadataQueued = true; return; }
      applyRoom(history.room);
    } catch { /* Best effort: the next room event retries. */ }
    finally {
      if (metadataController === controller) {
        metadataController = null;
        if (metadataQueued && token === selection && !destroyed) { metadataQueued = false; void refreshRoom(); }
      }
    }
  }
  function editGoal() {
    if (!currentRoom) return;
    ++goalEditor;
    $('room-goal-input').value = currentRoom.goal; $('room-goal-status').textContent = '';
    $('room-goal-form').hidden = false; $('room-goal-edit').hidden = true; $('room-goal-input').focus?.();
  }
  // Cancel only closes this editor session; a save already sent may still
  // commit, and the displayed goal converges through the authoritative read.
  function cancelGoal() { ++goalEditor; closeGoalEditor(); if (currentRoom) showGoal(currentRoom); }
  async function saveGoal(event) {
    event?.preventDefault();
    if (!currentRoom || $('room-goal-save').disabled) return;
    const roomId = currentRoom.id, token = selection, save = ++goalSave, session = goalEditor, revision = roomRevision;
    goalController?.abort();
    const controller = goalController = new AbortController();
    const selected = () => !destroyed && token === selection && currentRoom?.id === roomId;
    // Only the latest save of the still-open editor session may update the editor.
    const owner = () => selected() && save === goalSave && session === goalEditor;
    const goal = $('room-goal-input').value;
    const retrying = goalAttempt?.roomId === roomId && goalAttempt.goal === goal;
    const attempt = retrying ? goalAttempt : { roomId, goal, requestId: requestId() };
    goalAttempt = attempt;
    $('room-goal-input').disabled = true; $('room-goal-save').disabled = true; $('room-goal-status').textContent = 'Saving goal…';
    try {
      const result = await client.updateRoomGoal(roomId, { request_id: attempt.requestId, goal }, { signal: controller.signal });
      if (goalAttempt === attempt) goalAttempt = null;
      if (!selected()) return;
      if (result.event) feed.add(result.event);
      // A response can be older than room data seen since the save began (or a
      // journaled retry result), so apply it only when nothing newer arrived and
      // always confirm with an authoritative read.
      if (!retrying && revision === roomRevision) applyRoom(result.room);
      void refreshRoom();
      if (!owner()) return;
      goalController = null;
      closeGoalEditor(); showGoal(currentRoom);
      $('room-goal-status').textContent = result.event ? 'Goal updated.' : 'Goal unchanged.';
    } catch (error) {
      // Definitive rejections allow a fresh attempt; uncertain outcomes keep the ID.
      if (goalAttempt === attempt && error.status >= 400 && error.status < 500
        && !['INVALID_RESPONSE', 'VERSION_MISMATCH'].includes(error.code)) goalAttempt = null;
      if (!owner()) return;
      goalController = null;
      $('room-goal-input').disabled = false; $('room-goal-save').disabled = false;
      $('room-goal-status').textContent = `Goal not saved: ${error.message}`;
    }
  }
  function historyControl() {
    const state = feed.getState();
    $('older-history-button').hidden = !currentRoom || state.nextBefore === null;
    $('older-history-button').disabled = historyLoading || !currentRoom;
    $('older-history-button').textContent = historyLoading ? 'Loading earlier messages…' : 'Load earlier messages';
  }
  feed = createEventFeed({
    client,
    onStreamEvent(event) { if (!destroyed && currentRoom?.id === event.room_id) void refreshRoom(); },
    onEvents(events) { if (!destroyed) { view.setEvents(events); syncPending(); } },
    onState(state) {
      if (destroyed) return;
      historyControl();
      if (!currentRoom || selectionPending) return;
      const labels = { connecting: 'Connecting to room…', live: 'Room connected', reconnecting: 'Reconnecting to room…', error: 'Room connection error', idle: 'Not connected' };
      $('connection-status').textContent = labels[state.status];
      if (state.status === 'error') {
        const id = currentRoom.id;
        notice(state.error, () => rooms.select(id), 'feed');
      }
      if (state.status === 'live' && noticeOwner === 'feed') notice(null);
    },
  });
  composer = createComposer({
    client, form: $('composer'), input: $('message-input'), sendButton: $('send-button'), drafts,
    onPosted(event) { if (!destroyed && currentRoom?.id === event.room_id) feed.add(event); },
    onPending(items) { if (!destroyed) { pending = items; syncPending(); } },
    // The composer owns its per-room, visible send error and retry controls.
    onError() {},
  });
  participants = createParticipantPanel({ client, list: $('participants-list'), inspector: $('inspector') });
  tasks = createTaskPanel({ client, element: $('tasks-disclosure') });
  accessPanel = createAccessPanel({ document, client, onJoined: () => bootstrap() });
  const navigationClient = {
    listRooms(...args) { lastAttempt = { kind: 'refresh' }; return client.listRooms(...args); },
    createRoom(input, ...args) {
      lastAttempt = { kind: 'create', input: { name: input.name, goal: input.goal } };
      return client.createRoom(input, ...args);
    },
    joinRoom(id, ...args) { lastAttempt = { kind: 'select', id }; return client.joinRoom(id, ...args); },
  };
  rooms = createRoomNavigation({
    client: navigationClient, list: $('rooms-list'), createButton: $('create-room-button'),
    onSelect(result) {
      if (destroyed) return;
      resetRoomRequests(); selectionPending = false; currentRoom = { ...result.room };
      notice(null); $('room-title').textContent = `# ${result.room.name}`;
      closeGoalEditor(); $('room-goal-status').textContent = ''; showGoal(currentRoom);
      const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
      $('agent-room-id').value = result.room.id;
      $('agent-command').textContent = `npm run chat -- --room ${quote(result.room.id)}${client.baseUrl ? ` --hub ${quote(client.baseUrl)}` : ''} --name "Agent name" --workspace /path/to/repo${browserAccess ? ' --invite' : ''}`;
      // Hub URL and room ID only: invitation codes never belong in a shareable prompt.
      $('agent-join-prompt').textContent = joinPrompt(result.room.id, promptHubUrl());
      $('agent-join-copy-status').textContent = '';
      $('connect-agent').hidden = false;
      composer.setRoom(result.room); feed.select(result); void participants.select(result.room); void tasks.select(result.room); syncPending();
      accessPanel.select(result.room);
    },
    onState(state) {
      if (destroyed) return;
      if (state.status === 'loading' && ['select', 'create'].includes(state.operation)) {
        notice(null); stopRoom(true); $('connection-status').textContent = 'Opening room…';
      } else if (state.status === 'error') {
        if (selectionPending || !currentRoom) {
          stopRoom(); $('connection-status').textContent = 'Room unavailable';
          empty('Room unavailable', 'Retry to open the room, or choose another room.');
        }
        const attempt = lastAttempt;
        notice(state.error, () => attempt.kind === 'create' ? rooms.create(attempt.input)
          : attempt.kind === 'select' ? rooms.select(attempt.id) : rooms.refresh());
      } else if (state.status === 'ready') {
        notice(null);
        if (!currentRoom && !selectionPending) {
          $('connection-status').textContent = 'Hub connected · no room';
          if (browserAccess?.can_create_rooms === false) {
            empty('No rooms available', 'Ask the host for a new room invitation.');
            $('rooms-empty').textContent = 'No rooms available. Ask the host for an invitation.';
          } else empty('A place to work together', 'Create a room to start a conversation.');
        }
      }
    },
  });
  $('create-room-button').disabled = true;

  async function bootstrap() {
    if (destroyed) return null;
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapController = new AbortController();
    $('connection-status').textContent = 'Connecting to room hub…';
    notice(null);
    bootstrapPromise = Promise.resolve().then(async () => {
      try {
        if (destroyed) return null;
        const { participant, access } = await client.browserSession({ signal: bootstrapController.signal });
        if (destroyed) return null;
        if (accessPanel.hasInvitation()) {
          $('connection-status').textContent = 'Join invitation';
          accessPanel.showJoin(participant.name);
          return null;
        }
        bootstrapped = true;
        browserAccess = access; accessPanel.setAccess(access);
        $('hub-mode-label').textContent = access ? 'Shared LAN hub' : 'Local hub';
        view.setViewer(participant);
        $('human-identity').textContent = `You: ${participant.name}`;
        $('create-room-button').disabled = access?.can_create_rooms === false;
        return await rooms.refresh();
      } catch (error) {
        if (!destroyed) {
          if (['JOIN_REQUIRED', 'UNAUTHENTICATED'].includes(error.code)) {
            $('hub-mode-label').textContent = 'Shared LAN hub';
            $('connection-status').textContent = 'Invitation required';
            empty('Join the conversation', 'Enter your name and the invitation shared by the host.');
            accessPanel.showJoin();
            return null;
          }
          $('connection-status').textContent = 'Hub unavailable';
          empty('Unable to connect', 'Retry to connect to the local room hub.');
          notice(error, bootstrap);
        }
        return null;
      } finally { bootstrapPromise = null; }
    });
    return bootstrapPromise;
  }
  async function retry() {
    if (destroyed) return null;
    const action = retryAction ?? (!bootstrapped ? bootstrap : () => currentRoom ? rooms.select(currentRoom.id) : rooms.refresh());
    return action();
  }
  function retryClicked() { void retry(); }
  async function loadOlder() {
    if (destroyed || historyLoading || !currentRoom) return;
    const request = ++historyRequest;
    historyLoading = true; historyControl();
    try { await feed.loadOlder(); }
    finally {
      if (!destroyed && historyRequest === request) { historyLoading = false; historyControl(); }
    }
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true; bootstrapController?.abort(); resetRoomRequests();
    rooms.destroy(); feed.destroy(); composer.destroy(); participants.destroy(); tasks.destroy(); accessPanel.destroy(); view.destroy();
    $('retry-button').removeEventListener('click', retryClicked);
    $('older-history-button').removeEventListener('click', loadOlder);
    $('agent-join-copy').removeEventListener('click', copyJoinPrompt);
    $('room-goal-edit').removeEventListener('click', editGoal);
    $('room-goal-cancel').removeEventListener('click', cancelGoal);
    $('room-goal-form').removeEventListener('submit', saveGoal);
    window?.removeEventListener('pagehide', destroy);
  }
  $('retry-button').addEventListener('click', retryClicked);
  $('older-history-button').addEventListener('click', loadOlder);
  $('agent-join-copy').addEventListener('click', copyJoinPrompt);
  $('room-goal-edit').addEventListener('click', editGoal);
  $('room-goal-cancel').addEventListener('click', cancelGoal);
  $('room-goal-form').addEventListener('submit', saveGoal);
  window?.addEventListener('pagehide', destroy);
  await bootstrap();
  return { rooms, feed, composer, participants, tasks, accessPanel, retry, destroy };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  async function start() {
    try {
      const { RoomClient } = await import('/shared/client.js');
      await mountChatroom({ document, client: new RoomClient() });
    } catch (error) {
      document.getElementById('connection-status').textContent = 'Application unavailable';
      document.getElementById('app-error').textContent = error.message;
      document.getElementById('app-notice').hidden = false;
      const button = document.getElementById('retry-button');
      button.hidden = false; button.onclick = () => { button.onclick = null; void start(); };
    }
  }
  void start();
}
