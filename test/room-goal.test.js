import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createHub } from '../src/hub/main.js';
import { mountChatroom } from '../public/chatroom/app.js';
import { Outputs } from '../src/shared/schemas.js';
import { RoomClient } from '../src/shared/client.js';
import { browserClient } from './helpers/browser-client.js';
import { lanBrowser } from './helpers/lan-client.js';

const html = readFileSync(new URL('../public/chatroom/index.html', import.meta.url), 'utf8');
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise(setImmediate);
  assert.ok(predicate(), 'Real hub/DOM condition did not settle');
}
async function hubFor(t, options = {}) {
  const hub = await createHub({ filename: ':memory:', ...options });
  t.after(() => hub.close());
  return hub;
}

test('goal updates are idempotent, announced to agents as room messages and limited to members', { timeout: 15000 }, async t => {
  const hub = await hubFor(t);
  const { client, participant } = await browserClient(hub.url);
  const room = await client.createRoom({ name: 'Goals', goal: 'Old goal' });
  const agent = new RoomClient({ baseUrl: hub.url });
  await agent.agentSession({ mode: 'create', resume_token: 'goal-agent-test-only-'.repeat(2), name: 'Goal Agent' });
  await agent.joinRoom(room.id);
  const outsider = new RoomClient({ baseUrl: hub.url });
  await outsider.agentSession({ mode: 'create', resume_token: 'goal-outsider-test-only-'.repeat(2), name: 'Outsider' });
  const updated = Outputs.updateRoomGoal.parse(await client.updateRoomGoal(room.id, { request_id: 'goal-1', goal: '  Ship the release  ' }));
  assert.equal(updated.room.goal, 'Ship the release');
  assert.equal(updated.event.payload.text, 'Room goal updated: Ship the release');
  assert.equal(updated.event.author.id, participant.id);
  assert.deepEqual(await client.updateRoomGoal(room.id, { request_id: 'goal-1', goal: '  Ship the release  ' }), updated);
  await assert.rejects(client.updateRoomGoal(room.id, { request_id: 'goal-1', goal: 'Different' }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal((await client.listRooms()).rooms[0].goal, 'Ship the release');
  assert.deepEqual((await client.history(room.id)).events, [updated.event]);
  assert.deepEqual((await agent.receiveEvents(room.id, { wait_ms: 0 })).batch.events, [updated.event]);
  assert.deepEqual(await client.updateRoomGoal(room.id, { request_id: 'goal-same', goal: 'Ship the release' }), { room: updated.room, event: null });
  const cleared = await client.updateRoomGoal(room.id, { request_id: 'goal-clear', goal: '' });
  assert.equal(cleared.room.goal, '');
  assert.equal(cleared.event.payload.text, 'Room goal cleared.');
  await assert.rejects(outsider.updateRoomGoal(room.id, { request_id: 'outsider', goal: 'Hijack' }), { code: 'FORBIDDEN' });
  await assert.rejects(client.updateRoomGoal(room.id, { request_id: 'long', goal: 'x'.repeat(501) }), { code: 'VALIDATION_ERROR' });
  assert.equal((await client.history(room.id)).events.length, 2);
});

test('in LAN mode only the host may edit a room goal', { timeout: 15000 }, async t => {
  const hub = await hubFor(t, { lanHost: '192.168.50.10', host: '127.0.0.1' });
  const { client: host } = await browserClient(hub.url);
  const room = await host.createRoom({ name: 'LAN goals', goal: 'Host goal' });
  const invitation = await host.createInvitation(room.id, { kind: 'human', label: 'Sam' });
  const guest = lanBrowser(hub);
  await guest.joinBrowser({ request_id: 'join-sam', invite_token: invitation.token, name: 'Sam' });
  await guest.joinRoom(room.id);
  await assert.rejects(guest.updateRoomGoal(room.id, { request_id: 'guest-goal', goal: 'Guest goal' }), { code: 'FORBIDDEN' });
  assert.equal((await guest.listRooms()).rooms[0].goal, 'Host goal');
  assert.equal((await host.updateRoomGoal(room.id, { request_id: 'host-goal', goal: 'New host goal' })).room.goal, 'New host goal');
});

test('browser goal control edits the selected room goal and posts its announcement', { timeout: 15000 }, async t => {
  const hub = await hubFor(t);
  const { client } = await browserClient(hub.url);
  const room = await client.createRoom({ name: 'Edit goal', goal: 'First goal' });
  const other = await client.createRoom({ name: 'Other room' });
  const { document, window } = parseHTML(html);
  const app = await mountChatroom({ document, client }); t.after(() => app.destroy());
  const $ = id => document.getElementById(id);
  await app.rooms.select(room.id);
  await until(() => app.feed.getState().status === 'live');
  assert.equal($('room-goal').textContent, 'First goal');
  assert.equal($('room-goal-edit').hidden, false);
  $('room-goal-edit').click();
  assert.equal($('room-goal-form').hidden, false);
  assert.equal($('room-goal-input').value, 'First goal');
  $('room-goal-cancel').click();
  assert.equal($('room-goal-form').hidden, true);
  assert.equal($('room-goal-edit').hidden, false);
  $('room-goal-edit').click();
  $('room-goal-input').value = '<b>Second</b> goal';
  $('room-goal-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(() => $('room-goal-status').textContent === 'Goal updated.');
  assert.equal($('room-goal').textContent, '<b>Second</b> goal');
  assert.equal($('room-goal').querySelector('b'), null);
  assert.equal($('room-goal-form').hidden, true);
  await until(() => $('conversation').textContent.includes('Room goal updated: <b>Second</b> goal'));
  assert.equal((await client.listRooms()).rooms.find(item => item.id === room.id).goal, '<b>Second</b> goal');
  await app.rooms.select(other.id);
  assert.equal($('room-goal').textContent, 'No room purpose set.');
  assert.equal($('room-goal-status').textContent, '');
  await app.rooms.select(room.id);
  assert.equal($('room-goal').textContent, '<b>Second</b> goal');
});

// Wraps the real client so selected calls can be held after the hub responds.
function heldClient(client, methods) {
  const wrapped = Object.create(client);
  const held = [];
  const calls = Object.fromEntries(methods.map(name => [name, []]));
  wrapped.hold = { history: false, updateRoomGoal: false };
  for (const name of methods) {
    wrapped[name] = async (...args) => {
      calls[name].push(args);
      const result = await client[name](...args);
      if (!wrapped.hold[name]) return result;
      let release;
      held.push({ name, args, release: () => release() });
      await new Promise(resolve => { release = resolve; });
      return result;
    };
  }
  return { client: wrapped, held, calls };
}
const settle = async () => { for (let index = 0; index < 50; index++) await new Promise(setImmediate); };

test('a goal changed elsewhere refreshes the header and preserves an open draft', { timeout: 15000 }, async t => {
  const hub = await hubFor(t);
  const { client } = await browserClient(hub.url);
  const { client: remote } = await browserClient(hub.url);
  const room = await client.createRoom({ name: 'Remote goal', goal: 'Original' });
  await remote.joinRoom(room.id);
  const { document, window } = parseHTML(html);
  const app = await mountChatroom({ document, client }); t.after(() => app.destroy());
  const $ = id => document.getElementById(id);
  await app.rooms.select(room.id);
  await until(() => app.feed.getState().status === 'live');
  assert.equal($('room-goal').textContent, 'Original');
  await remote.updateRoomGoal(room.id, { goal: 'Remote update' });
  await until(() => $('room-goal').textContent === 'Remote update');
  assert.match($('conversation').textContent, /Room goal updated: Remote update/);
  $('room-goal-edit').click();
  $('room-goal-input').value = 'My unsaved draft';
  await remote.updateRoomGoal(room.id, { goal: 'Remote again' });
  await until(() => $('room-goal').textContent === 'Remote again');
  assert.equal($('room-goal-form').hidden, false);
  assert.equal($('room-goal-input').value, 'My unsaved draft');
  assert.equal($('room-goal-edit').hidden, true);
  $('room-goal-cancel').click();
  assert.equal($('room-goal').textContent, 'Remote again');
  assert.equal($('room-goal-edit').hidden, false);
  $('room-goal-edit').click();
  assert.equal($('room-goal-input').value, 'Remote again');
  void window;
});

test('late room metadata reads never apply to another room or over newer data', { timeout: 15000 }, async t => {
  const hub = await hubFor(t);
  const { client: real } = await browserClient(hub.url);
  const { client: remote } = await browserClient(hub.url);
  const roomA = await real.createRoom({ name: 'Room A', goal: 'A goal' });
  const roomB = await real.createRoom({ name: 'Room B', goal: 'B goal' });
  await remote.joinRoom(roomA.id);
  const { client, held, calls } = heldClient(real, ['history']);
  const { document, window } = parseHTML(html);
  const app = await mountChatroom({ document, client }); t.after(() => app.destroy());
  const $ = id => document.getElementById(id);
  await app.rooms.select(roomA.id);
  await until(() => app.feed.getState().status === 'live');
  client.hold.history = true;
  await remote.updateRoomGoal(roomA.id, { goal: 'A remote' });
  await until(() => held.length === 1);
  await app.rooms.select(roomB.id);
  assert.equal($('room-goal').textContent, 'B goal');
  held.shift().release(); await settle();
  assert.equal($('room-goal').textContent, 'B goal');
  assert.equal($('room-title').textContent, '# Room B');

  await app.rooms.select(roomA.id);
  await until(() => app.feed.getState().status === 'live');
  assert.equal($('room-goal').textContent, 'A remote');
  const before = calls.history.length;
  await remote.updateRoomGoal(roomA.id, { goal: 'Older remote read' });
  await until(() => held.length === 1);
  // The held read already captured "Older remote read"; a newer local save lands first.
  client.hold.history = false;
  $('room-goal-edit').click(); $('room-goal-input').value = 'Newest local save';
  $('room-goal-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(() => $('room-goal-status').textContent === 'Goal updated.');
  assert.equal($('room-goal').textContent, 'Newest local save');
  held.shift().release(); await settle();
  assert.equal($('room-goal').textContent, 'Newest local save');
  assert.ok(calls.history.length > before);
  assert.equal((await real.listRooms()).rooms.find(item => item.id === roomA.id).goal, 'Newest local save');
});

test('a delayed goal save response cannot overwrite a newer save after switching rooms', { timeout: 15000 }, async t => {
  const hub = await hubFor(t);
  const { client: real } = await browserClient(hub.url);
  const roomA = await real.createRoom({ name: 'Room A', goal: 'Original' });
  const roomB = await real.createRoom({ name: 'Room B' });
  const { client, held } = heldClient(real, ['updateRoomGoal']);
  const { document, window } = parseHTML(html);
  const app = await mountChatroom({ document, client }); t.after(() => app.destroy());
  const $ = id => document.getElementById(id);
  const save = text => {
    $('room-goal-edit').click(); $('room-goal-input').value = text;
    $('room-goal-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  };
  await app.rooms.select(roomA.id);
  client.hold.updateRoomGoal = true;
  save('First delayed save');
  await until(() => held.length === 1);
  client.hold.updateRoomGoal = false;
  await app.rooms.select(roomB.id);
  await app.rooms.select(roomA.id);
  assert.equal($('room-goal').textContent, 'First delayed save');
  assert.equal($('room-goal-form').hidden, true);
  save('Second newer save');
  await until(() => $('room-goal-status').textContent === 'Goal updated.');
  held.shift().release(); await settle();
  assert.equal($('room-goal').textContent, 'Second newer save');
  assert.equal($('room-goal-status').textContent, 'Goal updated.');
  assert.equal((await real.listRooms()).rooms.find(item => item.id === roomA.id).goal, 'Second newer save');
});

test('retrying an uncertain goal save replays its request and keeps the newer goal', { timeout: 15000 }, async t => {
  const hub = await hubFor(t);
  const { client: real } = await browserClient(hub.url);
  const { client: remote } = await browserClient(hub.url);
  const room = await real.createRoom({ name: 'Retry goal', goal: 'Original' });
  await remote.joinRoom(room.id);
  const client = Object.create(real);
  const requests = [];
  let loseResponse = true;
  client.updateRoomGoal = async (id, input, options) => {
    requests.push(input);
    const result = await real.updateRoomGoal(id, input, options);
    if (loseResponse) { loseResponse = false; throw Object.assign(new Error('Connection lost.'), { code: 'NETWORK_ERROR' }); }
    return result;
  };
  const { document, window } = parseHTML(html);
  const app = await mountChatroom({ document, client }); t.after(() => app.destroy());
  const $ = id => document.getElementById(id);
  await app.rooms.select(room.id);
  await until(() => app.feed.getState().status === 'live');
  $('room-goal-edit').click(); $('room-goal-input').value = 'Goal X';
  $('room-goal-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(() => $('room-goal-status').textContent === 'Goal not saved: Connection lost.');
  await until(() => $('room-goal').textContent === 'Goal X');
  await remote.updateRoomGoal(room.id, { goal: 'Goal Y' });
  await until(() => $('room-goal').textContent === 'Goal Y');
  assert.equal($('room-goal-input').value, 'Goal X');
  $('room-goal-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(() => $('room-goal-status').textContent === 'Goal updated.');
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].request_id, requests[0].request_id);
  assert.equal($('room-goal').textContent, 'Goal Y');
  assert.equal((await real.listRooms()).rooms[0].goal, 'Goal Y');
  assert.deepEqual((await real.history(room.id)).events.map(event => event.payload.text), ['Room goal updated: Goal X', 'Room goal updated: Goal Y']);
  // A changed edit is a new mutation with a new request identity.
  $('room-goal-edit').click(); $('room-goal-input').value = 'Goal Z';
  $('room-goal-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(() => $('room-goal').textContent === 'Goal Z');
  assert.notEqual(requests[2].request_id, requests[0].request_id);
});

test('a delayed save response does not revert a newer goal saved elsewhere in the same room', { timeout: 15000 }, async t => {
  const hub = await hubFor(t);
  const { client: real } = await browserClient(hub.url);
  const { client: remote } = await browserClient(hub.url);
  const room = await real.createRoom({ name: 'Same room race', goal: 'Original' });
  await remote.joinRoom(room.id);
  const { client, held } = heldClient(real, ['updateRoomGoal']);
  const { document, window } = parseHTML(html);
  const app = await mountChatroom({ document, client }); t.after(() => app.destroy());
  const $ = id => document.getElementById(id);
  await app.rooms.select(room.id);
  await until(() => app.feed.getState().status === 'live');
  client.hold.updateRoomGoal = true;
  $('room-goal-edit').click(); $('room-goal-input').value = 'Goal X';
  $('room-goal-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(() => held.length === 1);
  client.hold.updateRoomGoal = false;
  await remote.updateRoomGoal(room.id, { goal: 'Goal Y' });
  await until(() => $('room-goal').textContent === 'Goal Y');
  held.shift().release(); await settle();
  await until(() => $('room-goal-status').textContent === 'Goal updated.');
  await settle();
  assert.equal($('room-goal').textContent, 'Goal Y');
  assert.equal((await real.listRooms()).rooms[0].goal, 'Goal Y');
});

test('cancelling during a save keeps a reopened editor draft and converges to the committed goal', { timeout: 15000 }, async t => {
  const hub = await hubFor(t);
  const { client: real } = await browserClient(hub.url);
  const room = await real.createRoom({ name: 'Cancel race', goal: 'Original' });
  const { client, held } = heldClient(real, ['updateRoomGoal']);
  const { document, window } = parseHTML(html);
  const app = await mountChatroom({ document, client }); t.after(() => app.destroy());
  const $ = id => document.getElementById(id);
  await app.rooms.select(room.id);
  await until(() => app.feed.getState().status === 'live');
  client.hold.updateRoomGoal = true;
  $('room-goal-edit').click(); $('room-goal-input').value = 'Committed while cancelled';
  $('room-goal-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(() => held.length === 1);
  client.hold.updateRoomGoal = false;
  $('room-goal-cancel').click();
  assert.equal($('room-goal-form').hidden, true);
  $('room-goal-edit').click();
  $('room-goal-input').value = 'A new unsaved draft';
  held.shift().release(); await settle();
  await until(() => $('room-goal').textContent === 'Committed while cancelled');
  assert.equal($('room-goal-form').hidden, false);
  assert.equal($('room-goal-input').value, 'A new unsaved draft');
  assert.equal($('room-goal-input').disabled, false);
  assert.equal($('room-goal-save').disabled, false);
  assert.equal($('room-goal-edit').hidden, true);
  assert.equal((await real.listRooms()).rooms[0].goal, 'Committed while cancelled');
});
