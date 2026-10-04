import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createRoomNavigation } from '../public/chatroom/rooms.js';
import { createDraftStore } from '../public/chatroom/drafts.js';
import { RoomClient } from '../src/shared/client.js';
import { createFixtureServer } from './helpers/fixture-server.js';
import * as fixtures from '../src/shared/fixtures.js';

const html = readFileSync(new URL('../public/chatroom/index.html', import.meta.url), 'utf8');
const roomA = { ...fixtures.room, name: '<img src=x onerror=alert(1)>' };
const roomB = fixtures.otherRoom;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function joined(room) {
  return { room, membership: { ...fixtures.membership, room_id: room.id, participant_id: fixtures.human.id }, history: { ...fixtures.history, room, events: [], head_sequence: 0 } };
}
function setup(client, options = {}) {
  const { document, window } = parseHTML(html);
  const list = document.getElementById('rooms-list');
  const createButton = document.getElementById('create-room-button');
  const selected = [], states = [];
  const nav = createRoomNavigation({ client, list, createButton, onSelect: result => selected.push(result), onState: state => states.push(state), ...options });
  return { document, window, list, createButton, selected, states, nav };
}

test('drafts isolate rooms, return copies, persist only text/reply, and clear independently', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const drafts = createDraftStore({ storage });
  assert.deepEqual(drafts.get('a'), { text: '', replyTo: null });
  const input = { text: 'First', replyTo: 'event-1', credential: 'never persist this' };
  drafts.set('a', input); input.text = 'mutated';
  drafts.set('b', { text: 'Second', replyTo: null });
  const copy = drafts.get('a'); copy.text = 'changed';
  assert.deepEqual(drafts.get('a'), { text: 'First', replyTo: 'event-1' });
  assert.deepEqual(createDraftStore({ storage }).get('a'), drafts.get('a'));
  assert.equal([...data.values()].some(value => value.includes('credential')), false);
  drafts.clear('a');
  assert.deepEqual(drafts.get('a'), { text: '', replyTo: null });
  assert.equal(drafts.get('b').text, 'Second');
  assert.equal(createDraftStore({ storage }).get('a').text, '');
});

test('malformed persistence and read/write/remove failures preserve in-memory drafts', () => {
  const storage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); }, removeItem() { throw Error('blocked'); } };
  const drafts = createDraftStore({ storage });
  assert.equal(drafts.get('a').text, '');
  drafts.set('a', { text: 'Retain me', replyTo: null });
  assert.equal(drafts.get('a').text, 'Retain me');
  drafts.clear('a'); assert.equal(drafts.get('a').text, '');
  for (const value of ['{', 'null', '{"text":5,"replyTo":null}', '{"text":"x"}']) {
    assert.deepEqual(createDraftStore({ storage: { getItem: () => value } }).get('a'), { text: '', replyTo: null });
  }
  const persisted = createDraftStore({ storage: { getItem: () => '{"text":"old","replyTo":null}', removeItem() { throw Error(); } } });
  assert.equal(persisted.get('a').text, 'old'); persisted.clear('a'); assert.equal(persisted.get('a').text, '');
});

test('list safely renders room names and auto-selects without replacing human identity or leaving', async () => {
  const calls = [];
  const client = { token: 'unchanged', listRooms: async () => ({ rooms: [roomA, roomB] }), joinRoom: async id => { calls.push(id); return joined(id === roomA.id ? roomA : roomB); }, leaveRoom() { assert.fail('Switching must not leave'); }, browserSession() { assert.fail('Must not recreate identity'); } };
  const { nav, list, selected, states, createButton } = setup(client);
  assert.equal(createButton.disabled, false);
  await nav.refresh();
  assert.equal(list.querySelector('img'), null);
  assert.equal(list.querySelector('button').textContent, `# ${roomA.name}`);
  assert.equal(list.querySelector('button').getAttribute('aria-current'), 'page');
  await nav.select(roomB.id);
  assert.deepEqual(calls, [roomA.id, roomB.id]);
  assert.equal(selected[1].membership.participant_id, fixtures.human.id);
  assert.equal(client.token, 'unchanged');
  assert.equal(states[0].status, 'loading');
  assert.equal(nav.getState().selectedRoomId, roomB.id);
  const snapshot = nav.getState(); snapshot.rooms[0].name = 'mutated';
  assert.equal(nav.getState().rooms[0].name, roomA.name);
  nav.destroy();
});

test('empty list is truthful and list failures are visible state', async () => {
  const client = { listRooms: async () => ({ rooms: [] }), joinRoom() { assert.fail('No empty auto-selection'); } };
  const { nav, document } = setup(client);
  await nav.refresh();
  assert.deepEqual(nav.getState(), { rooms: [], selectedRoomId: null, status: 'ready', error: null, operation: null });
  assert.equal(document.getElementById('rooms-empty').hidden, false);
  client.listRooms = async () => { throw Error('Hub unavailable'); };
  await nav.refresh();
  assert.equal(nav.getState().status, 'error');
  assert.match(document.body.textContent, /Hub unavailable/);
  nav.destroy();
});

test('obsolete join success and errors are ignored, with prior HTTP aborted', async () => {
  const requests = [];
  const client = { joinRoom(id, input, { signal }) { const request = { id, signal, ...deferred() }; requests.push(request); return request.promise; } };
  const { nav, selected } = setup(client);
  const first = nav.select(roomA.id);
  const second = nav.select(roomB.id);
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve(joined(roomB)); await second;
  requests[0].resolve(joined(roomA)); await first;
  assert.deepEqual(selected.map(result => result.room.id), [roomB.id]);
  const old = nav.select(roomA.id);
  const latest = nav.select(roomB.id);
  requests[3].resolve(joined(roomB)); await latest;
  requests[2].reject(Error('obsolete')); await old;
  assert.equal(nav.getState().error, null);
  assert.equal(nav.getState().selectedRoomId, roomB.id);
  nav.destroy();
});

test('late refresh cannot replace a newer selection; destruction ignores pending callbacks', async () => {
  const listing = deferred(), pending = deferred();
  let signal;
  const { nav, selected, states } = setup({ listRooms: () => listing.promise, joinRoom: (id, _, options) => { signal = options.signal; return id === roomB.id ? Promise.resolve(joined(roomB)) : pending.promise; } });
  const refresh = nav.refresh(); await nav.select(roomB.id);
  listing.resolve({ rooms: [roomA] }); await refresh;
  assert.equal(nav.getState().rooms[0].id, roomB.id);
  const selection = nav.select(roomA.id); nav.destroy();
  const count = states.length;
  assert.equal(signal.aborted, true);
  pending.resolve(joined(roomA)); await selection;
  assert.equal(states.length, count);
  assert.equal(selected.length, 1);
  await nav.refresh(); await nav.select(roomA.id);
  assert.equal(states.length, count);
});

test('create retries uncertain outcomes with the same ID/payload and selects success', async () => {
  const inputs = [];
  const client = { createRoom: async input => { inputs.push(input); if (inputs.length === 1) throw Object.assign(Error('Network failure'), { status: 0 }); return roomA; }, joinRoom: async () => joined(roomA) };
  const { nav, selected } = setup(client);
  await nav.create({ name: ' New room ', goal: 'Purpose' });
  assert.equal(nav.getState().status, 'error');
  await nav.create({ name: 'New room', goal: 'Purpose' });
  assert.deepEqual(inputs[0], inputs[1]);
  assert.match(inputs[0].request_id, /^[0-9a-f-]{36}$/);
  assert.equal(nav.getState().selectedRoomId, roomA.id);
  assert.equal(nav.getState().rooms.length, 1);
  assert.equal(selected.length, 1);
  nav.destroy();
});

test('create success followed by join failure retries joining without creating again; duplicates surface', async () => {
  let creations = 0, joins = 0;
  const client = { createRoom: async () => { creations++; return roomA; }, joinRoom: async () => { if (++joins === 1) throw Error('Join failed'); return joined(roomA); } };
  const { nav } = setup(client);
  await nav.create({ name: 'One' }); await nav.create({ name: 'One' });
  assert.equal(creations, 1); assert.equal(joins, 2);
  client.createRoom = async () => { throw Object.assign(Error('Room name already exists'), { code: 'CONFLICT', status: 409 }); };
  await nav.create({ name: 'One' });
  assert.equal(nav.getState().error.code, 'CONFLICT');
  assert.equal(nav.getState().selectedRoomId, roomA.id);
  nav.destroy();
});

test('create completion after another selection does not steal the room', async () => {
  const creation = deferred();
  const { nav, selected } = setup({ createRoom: () => creation.promise, joinRoom: async id => joined(id === roomB.id ? roomB : roomA) });
  const creating = nav.create({ name: 'One' });
  await Promise.resolve();
  await nav.select(roomB.id);
  creation.resolve(roomA); await creating;
  assert.equal(nav.getState().selectedRoomId, roomB.id);
  assert.equal(selected.length, 1);
  nav.destroy();
});

test('default creation form labels fields, cancels with Escape, and removes itself on destroy', async () => {
  const { nav, document, window, createButton } = setup({ createRoom() { assert.fail('Cancel must not mutate'); } });
  createButton.dispatchEvent(new window.Event('click'));
  const form = document.querySelector('form[aria-label="Create a room"]');
  assert.ok(form);
  assert.equal(form.querySelectorAll('label').length, 2);
  const escape = new window.Event('keydown', { bubbles: true, cancelable: true }); escape.key = 'Escape';
  form.querySelector('input').dispatchEvent(escape);
  await Promise.resolve();
  assert.equal(form.isConnected, false);
  createButton.dispatchEvent(new window.Event('click'));
  assert.ok(document.querySelector('form[aria-label="Create a room"]'));
  nav.destroy();
  assert.equal(document.querySelector('form[aria-label="Create a room"]'), null);
  createButton.dispatchEvent(new window.Event('click'));
  assert.equal(document.querySelector('form[aria-label="Create a room"]'), null);
});

test('injected room request cancellation does not mutate; destroyed prompt completion is ignored', async () => {
  const input = deferred();
  let requests = 0;
  const { nav, window, createButton } = setup({ createRoom() { assert.fail('Must not create'); } }, { requestRoom: () => { requests++; return input.promise; } });
  createButton.dispatchEvent(new window.Event('click'));
  createButton.dispatchEvent(new window.Event('click'));
  assert.equal(requests, 1);
  nav.destroy(); input.resolve({ name: 'Too late', goal: '' });
  await Promise.resolve();
  const cancelled = setup({ createRoom() { assert.fail('Cancelled'); } }, { requestRoom: async () => null });
  cancelled.createButton.dispatchEvent(new cancelled.window.Event('click'));
  await Promise.resolve();
  assert.equal(cancelled.nav.getState().status, 'idle');
  cancelled.nav.destroy();
});

test('shared RoomClient fixture works through the room navigation seams', async t => {
  const fixture = await createFixtureServer();
  t.after(() => fixture.close());
  const { nav } = setup(new RoomClient({ baseUrl: fixture.url }));
  t.after(() => nav.destroy());
  await nav.refresh();
  assert.equal(nav.getState().rooms.length, 2);
  assert.equal(nav.getState().selectedRoomId, fixtures.room.id);
  await nav.create({ name: 'Created through client', goal: 'Verify exact shapes' });
  assert.equal(nav.getState().status, 'ready');
});

test('operation distinguishes list refresh from actual selection before its I/O', async () => {
  let ui;
  const operations = [];
  ui = setup({ listRooms: async () => ({ rooms: [roomA] }), joinRoom: async () => {
    assert.equal(ui.nav.getState().status, 'loading');
    assert.equal(ui.nav.getState().operation, 'select');
    return joined(roomA);
  } }, { onState: state => operations.push(state.operation) });
  await ui.nav.refresh();
  assert.deepEqual(operations, ['refresh', 'refresh', 'select', null]);
  operations.length = 0;
  await ui.nav.refresh();
  assert.deepEqual(operations, ['refresh', 'refresh', null]);
  assert.equal(ui.selected.length, 1);
  ui.nav.destroy();
});

test('refresh overlapping create fences selection and an uncertain retry reuses the original ID', async () => {
  const mutation = deferred();
  const inputs = [];
  const { nav, selected } = setup({
    createRoom(input) { inputs.push(input); return inputs.length === 1 ? mutation.promise : Promise.resolve(roomA); },
    listRooms: async () => ({ rooms: [roomB] }),
    joinRoom: async id => joined(id === roomA.id ? roomA : roomB),
  });
  const creating = nav.create({ name: 'One', goal: 'Original scope' });
  assert.equal(nav.getState().operation, 'create');
  await Promise.resolve();
  await nav.refresh();
  mutation.reject(Error('Lost response')); await creating;
  assert.equal(nav.getState().status, 'ready');
  assert.deepEqual(selected.map(result => result.room.id), [roomB.id]);
  await nav.create({ name: 'One', goal: 'Original scope' });
  assert.deepEqual(inputs[0], inputs[1]);
  assert.deepEqual(selected.map(result => result.room.id), [roomB.id, roomA.id]);
  nav.destroy();
});

test('synchronous transport errors remain retryable and observers can destroy before I/O', async () => {
  const inputs = [];
  const ui = setup({ createRoom(input) { inputs.push(input); throw Error('sync failure'); } });
  await ui.nav.create({ name: 'One' }); await ui.nav.create({ name: 'One' });
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs[0], inputs[1]);
  ui.nav.destroy();
  let another;
  another = setup({ joinRoom() { assert.fail('Destroyed before I/O'); } }, { onState() { another.nav.destroy(); } });
  await another.nav.select(roomA.id);
});

test('default creation form submits exact input and closes before selecting its result', async () => {
  const posted = deferred();
  const { nav, document, window, createButton } = setup({
    createRoom: async input => { posted.resolve(input); return roomA; },
    joinRoom: async () => joined(roomA),
  });
  createButton.dispatchEvent(new window.Event('click'));
  const form = document.querySelector('form[aria-label="Create a room"]');
  form.querySelector('input').value = '  Named room  ';
  form.querySelector('textarea').value = 'A shared purpose';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const input = await posted.promise;
  assert.equal(input.name, 'Named room'); assert.equal(input.goal, 'A shared purpose');
  assert.equal(form.isConnected, false);
  nav.destroy();
});
