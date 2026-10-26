import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { mountChatroom } from '../public/chatroom/app.js';
import { createHub } from '../src/hub/main.js';
import { browserClient } from './helpers/browser-client.js';
import { RoomClient } from '../src/shared/client.js';

const html = readFileSync(new URL('../public/chatroom/index.html', import.meta.url), 'utf8');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.ok(predicate(), 'Real hub/DOM condition did not settle');
}
async function hubFor(t) {
  const hub = await createHub({ filename: ':memory:' });
  t.after(() => hub.close());
  return hub;
}
async function tab(t, client, options = {}) {
  const { document, window } = parseHTML(html);
  const conversation = document.getElementById('conversation');
  conversation.scrollTop = 0; conversation.scrollHeight = 100; conversation.clientHeight = 100;
  const app = await mountChatroom({ document, client, ...options });
  t.after(() => app.destroy());
  const $ = id => document.getElementById(id);
  function type(text) { $('message-input').value = text; $('message-input').dispatchEvent(new window.Event('input')); }
  function send() { $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }
  return { app, document, window, $, type, send, client };
}

test('two real tabs create/select rooms, retain human identity/drafts and exchange literal messages', { timeout: 15000 }, async t => {
  const hub = await hubFor(t);
  const firstBrowser = await browserClient(hub.url), secondBrowser = await browserClient(hub.url);
  assert.equal(firstBrowser.participant.id, secondBrowser.participant.id);
  let writeText = async () => { throw new Error('denied'); };
  const first = await tab(t, firstBrowser.client, { clipboard: { writeText: value => writeText(value) } });
  assert.equal(first.$('rooms-list').children.length, 0);
  assert.equal(first.$('message-input').disabled, true);
  const createdA = await first.app.rooms.create({ name: '<img src=x> Design', goal: '<script>Goal</script>' });
  const createdB = await first.app.rooms.create({ name: 'Other room', goal: 'Independent discussion' });
  const second = await tab(t, secondBrowser.client);
  await first.app.rooms.select(createdA.room.id); await second.app.rooms.select(createdA.room.id);
  await until(() => first.app.feed.getState().status === 'live' && second.app.feed.getState().status === 'live');
  assert.equal(first.$('connection-status').textContent, 'Room connected');
  assert.equal(first.$('room-title').textContent, '# <img src=x> Design');
  assert.equal(first.$('room-goal').textContent, '<script>Goal</script>');
  assert.equal(first.$('connect-agent').hidden, false);
  assert.equal(first.$('agent-room-id').value, createdA.room.id);
  assert.ok(first.$('agent-room-id').hasAttribute('readonly'));
  assert.equal(first.$('agent-command').textContent, `npm run chat -- --room '${createdA.room.id}' --hub '${firstBrowser.client.baseUrl}' --name "Agent name" --workspace /path/to/repo`);
  assert.match(first.$('connect-agent').textContent, /chatroom project directory/);
  const prompt = id => `Join room ${id} at ${firstBrowser.client.baseUrl}. Use agent_chat_room, participate in the discussion, and keep calling receive_events after timeouts until I tell you to stop.`;
  assert.equal(first.$('agent-join-prompt').textContent, prompt(createdA.room.id));
  const copied = [];
  writeText = async value => { copied.push(value); };
  first.$('agent-join-copy').click();
  await until(() => first.$('agent-join-copy-status').textContent === 'Copied.');
  assert.deepEqual(copied, [prompt(createdA.room.id)]);
  writeText = async () => { throw new Error('denied'); };
  first.$('agent-join-copy').click();
  await until(() => /Copy unavailable/.test(first.$('agent-join-copy-status').textContent));
  assert.equal(first.document.querySelector('img'), null);
  first.type('Draft in A'); await first.app.rooms.select(createdB.room.id);
  first.type('Draft in B'); await first.app.rooms.select(createdA.room.id);
  assert.equal(first.$('message-input').value, 'Draft in A');
  const text = '<img src=x onerror=alert(1)>\nLiteral shared message';
  first.type(text); first.send();
  await until(() => second.$('conversation').textContent.includes('Literal shared message') && first.app.composer.getPending().length === 0);
  assert.equal(second.$('conversation').querySelector('img'), null);
  assert.match(second.$('conversation').textContent, /Human/);
  assert.equal(first.$('conversation').querySelector('.message--own').dataset.authorId, firstBrowser.participant.id);
  assert.equal(second.$('conversation').querySelector('.message--own').dataset.authorId, secondBrowser.participant.id);
  second.type('Reply from the second tab'); second.send();
  await until(() => first.$('conversation').textContent.includes('Reply from the second tab'));
  await first.app.rooms.select(createdB.room.id);
  assert.equal(first.$('agent-room-id').value, createdB.room.id);
  assert.equal(first.$('agent-join-prompt').textContent, prompt(createdB.room.id));
  assert.equal(first.$('agent-join-copy-status').textContent, '');
  assert.equal(first.$('message-input').value, 'Draft in B');
  assert.doesNotMatch(first.$('conversation').textContent, /Literal shared message/);
  assert.equal((await firstBrowser.client.history(createdA.room.id)).events.length, 2);
  assert.equal((await firstBrowser.client.history(createdB.room.id)).events.length, 0);
  await until(() => first.$('participants-list').textContent.includes('Human'));
});

test('browser autocomplete posts a real mention and SSE/history and agent delivery retain its recipient', { timeout: 15000 }, async t => {
  const hub = await hubFor(t); const human = await browserClient(hub.url);
  const room = await human.client.createRoom({ name: 'Mentions' });
  const agent = new RoomClient({ baseUrl: hub.url });
  const session = await agent.agentSession({ mode: 'create', resume_token: 'mention-test-only-'.repeat(3), name: 'Review Agent' });
  await agent.joinRoom(room.id);
  const ui = await tab(t, human.client);
  ui.$('message-input').setSelectionRange = (start, end) => {
    ui.$('message-input').selectionStart = start; ui.$('message-input').selectionEnd = end;
  };
  ui.type('@Rev');
  await until(() => ui.$('composer').querySelector('[role="option"]'));
  ui.$('composer').querySelector('[role="option"]').dispatchEvent(new ui.window.Event('click', { bubbles: true }));
  assert.equal(ui.$('message-input').value, '@Review Agent ');
  ui.type('@Review Agent can you review?'); ui.send();
  await until(() => ui.app.composer.getPending().length === 0 && ui.$('conversation').querySelector('[data-mentioned-id]'));
  const events = (await human.client.history(room.id)).events;
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload.mentions, [{ id: session.participant.id, name: 'Review Agent', kind: 'agent' }]);
  assert.equal(ui.$('conversation').querySelector('.mention-text').textContent, '@Review Agent');
  assert.equal(ui.$('conversation').querySelector('[data-mentioned-id]').dataset.mentionedId, session.participant.id);
  assert.deepEqual((await agent.receiveEvents(room.id, { wait_ms: 0 })).batch.events, events);
});

test('selection failure clears old content, preserves drafts, retries intended room and ignores stale errors', { timeout: 15000 }, async t => {
  const hub = await hubFor(t); const { client } = await browserClient(hub.url);
  const roomA = await client.createRoom({ name: 'Room A' }), roomB = await client.createRoom({ name: 'Room B' });
  await client.postMessage(roomA.id, { text: 'Only room A' });
  const ui = await tab(t, client); await ui.app.rooms.select(roomA.id); ui.type('Saved draft A');
  const realJoin = client.joinRoom.bind(client);
  let failOnce = true;
  client.joinRoom = (id, ...args) => {
    if (id === roomB.id && failOnce) { failOnce = false; return Promise.reject(Object.assign(Error('Room request failed'), { status: 503 })); }
    return realJoin(id, ...args);
  };
  await ui.app.rooms.select(roomB.id);
  assert.equal(ui.$('message-input').disabled, true);
  assert.equal(ui.$('conversation').children.length, 0);
  assert.equal(ui.$('room-title').textContent, 'No room selected');
  assert.equal(ui.$('connect-agent').hidden, true);
  assert.equal(ui.$('agent-room-id').value, '');
  assert.equal(ui.$('agent-command').textContent, '');
  assert.equal(ui.$('agent-join-prompt').textContent, '');
  assert.match(ui.$('app-error').textContent, /Room request failed/);
  assert.equal(ui.$('retry-button').hidden, false);
  await ui.app.retry(); assert.equal(ui.app.rooms.getState().selectedRoomId, roomB.id);
  await ui.app.rooms.select(roomA.id); assert.equal(ui.$('message-input').value, 'Saved draft A');
  const obsolete = deferred();
  client.joinRoom = (id, ...args) => id === roomB.id ? obsolete.promise : realJoin(id, ...args);
  const old = ui.app.rooms.select(roomB.id);
  assert.equal(ui.app.feed.getState().status, 'idle');
  assert.equal(ui.$('message-input').disabled, true);
  await ui.app.rooms.select(roomA.id);
  obsolete.reject(Error('Obsolete error')); await old;
  assert.equal(ui.$('app-notice').hidden, true);
  assert.equal(ui.$('room-title').textContent, '# Room A');
  assert.match(ui.$('conversation').textContent, /Only room A/);
});

test('bootstrap failure has working retry and uncertain creation retry creates only one real room', { timeout: 15000 }, async t => {
  const hub = await hubFor(t); const { client } = await browserClient(hub.url);
  const session = client.browserSession.bind(client); let failSession = true;
  client.browserSession = (...args) => {
    if (failSession) { failSession = false; return Promise.reject(Error('Hub temporarily unavailable')); }
    return session(...args);
  };
  const ui = await tab(t, client);
  assert.equal(ui.$('create-room-button').disabled, true);
  assert.equal(ui.$('app-notice').hidden, false);
  ui.$('retry-button').dispatchEvent(new ui.window.Event('click'));
  await until(() => ui.$('create-room-button').disabled === false && ui.app.rooms.getState().status === 'ready');
  const create = client.createRoom.bind(client); const ids = []; let lostResponse = true;
  client.createRoom = async (input, ...args) => {
    ids.push(input.request_id); const room = await create(input, ...args);
    if (lostResponse) { lostResponse = false; throw Object.assign(Error('Response lost'), { status: 0 }); }
    return room;
  };
  await ui.app.rooms.create({ name: 'Durable creation', goal: 'Retry safely' });
  assert.match(ui.$('app-error').textContent, /Response lost/);
  await ui.app.retry();
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
  assert.equal((await client.listRooms()).rooms.length, 1);
  assert.equal(ui.$('room-title').textContent, '# Durable creation');
  assert.equal(ui.$('app-notice').hidden, true);
});

test('confirmed send with lost HTTP response retries same mutation and leaves one committed event', { timeout: 15000 }, async t => {
  const hub = await hubFor(t); const { client } = await browserClient(hub.url);
  await client.createRoom({ name: 'Delivery' });
  const ui = await tab(t, client); await until(() => ui.app.feed.getState().status === 'live');
  const post = client.postMessage.bind(client); const inputs = []; let lose = true;
  client.postMessage = async (id, input, ...args) => {
    inputs.push(input); const result = await post(id, input, ...args);
    if (lose) { lose = false; throw Object.assign(Error('Unknown send outcome'), { status: 0 }); }
    return result;
  };
  ui.type('One durable message'); ui.send();
  await until(() => ui.$('conversation').querySelector('[data-retry-id]'));
  ui.type('Newer draft');
  ui.$('conversation').querySelector('[data-retry-id]').dispatchEvent(new ui.window.Event('click', { bubbles: true }));
  await until(() => ui.app.composer.getPending().length === 0);
  assert.deepEqual(inputs[0], inputs[1]);
  assert.equal(ui.$('conversation').querySelectorAll('[data-event-id]').length, 1);
  assert.equal(ui.$('message-input').value, 'Newer draft');
  assert.equal((await client.history(ui.app.rooms.getState().selectedRoomId)).events.length, 1);
});

test('older history control uses real pagination and page teardown aborts all owned activity', { timeout: 15000 }, async t => {
  const hub = await hubFor(t); const { client } = await browserClient(hub.url);
  const room = await client.createRoom({ name: 'History' });
  for (let i = 1; i <= 55; i++) await client.postMessage(room.id, { text: `Historical message ${i}` });
  const signals = [];
  const events = client.events.bind(client), participants = client.listParticipants.bind(client);
  client.events = (id, options) => { signals.push(options.signal); return events(id, options); };
  client.listParticipants = (id, options) => { signals.push(options.signal); return participants(id, options); };
  const ui = await tab(t, client);
  assert.equal(ui.$('conversation').querySelectorAll('[data-event-id]').length, 50);
  assert.equal(ui.$('older-history-button').hidden, false);
  ui.$('older-history-button').dispatchEvent(new ui.window.Event('click'));
  await until(() => ui.$('conversation').querySelectorAll('[data-event-id]').length === 55);
  assert.equal(ui.$('older-history-button').hidden, true);
  ui.type('Surviving draft');
  ui.window.dispatchEvent(new ui.window.Event('pagehide'));
  assert.ok(signals.length >= 2); assert.ok(signals.every(signal => signal.aborted));
  assert.equal(ui.$('message-input').disabled, true);
  const previous = ui.$('conversation').textContent;
  await client.postMessage(room.id, { text: 'After teardown' });
  await new Promise(setImmediate);
  assert.equal(ui.$('conversation').textContent, previous);
  assert.equal(await ui.app.retry(), null);
});
