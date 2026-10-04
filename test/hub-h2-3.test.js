import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { openDatabase } from '../src/hub/db.js';
import { createIdentityStore } from '../src/hub/identity-store.js';
import { createRoomStore } from '../src/hub/room-store.js';
import { createEventStore } from '../src/hub/event-store.js';
import { createLocalSession } from '../src/hub/local-session.js';
import { createRoomRoutes } from '../src/hub/routes/rooms.js';
import { createMessageRoutes } from '../src/hub/routes/messages.js';
import { createHttpServer } from '../src/hub/http-server.js';
import { Outputs } from '../src/shared/schemas.js';
import { temporaryDirectory } from './helpers/processes.js';

async function setup(t) {
  const database = await openDatabase({ filename: join(await temporaryDirectory(t), 'hub.sqlite') });
  t.after(() => database.close());
  const identity = createIdentityStore(database, { bootId: 'test' });
  const rooms = createRoomStore(database, { identity });
  const posts = [], changes = [];
  const events = createEventStore(database, { identity, rooms, onChange: id => posts.push(id) });
  const human = identity.browserSession();
  const humanContext = identity.authenticate({ cookie: human.token });
  const enroll = name => identity.agentSession({ request_id: 'create', mode: 'create', resume_token: name.repeat(40), name });
  const a = enroll('A'), b = enroll('B');
  const sessions = createLocalSession({ identity });
  let changed = id => changes.push(id);
  const hub = await createHttpServer({ handlers: [
    createRoomRoutes({ sessions, rooms, events, onChange: id => changed(id) }), createMessageRoutes({ sessions, events }),
  ] });
  t.after(() => hub.close());
  async function call(path, { method = 'GET', body, agent = a, human: asHuman = false } = {}) {
    const response = await fetch(hub.url + '/api/v1' + path, {
      method, headers: { 'Content-Type': 'application/json', ...(asHuman ? { Origin: hub.url, Cookie: `acr_session=${human.token}` } : agent ? { Authorization: `Bearer ${agent.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, envelope: await response.json() };
  }
  const create = async name => (await call('/rooms', { method: 'POST', human: true, body: { request_id: `create-${name}`, name } })).envelope.data;
  const enter = (room, agent = a, request_id = 'join') => call(`/rooms/${room.id}/join`, { method: 'POST', agent, body: { request_id } });
  const post = (room, agent, request_id, text, reply_to) => call(`/rooms/${room.id}/messages`, { method: 'POST', agent, body: { request_id, text, ...(reply_to === undefined ? {} : { reply_to }) } });
  return { database, identity, rooms, events, humanContext, a, b, call, create, enter, post, posts, changes, setChanged: fn => { changed = fn; } };
}

test('room HTTP routes authenticate, create/replay, list, join, leave and isolate memberships', async t => {
  const s = await setup(t);
  assert.equal((await s.call('/rooms', { agent: null })).status, 401);
  const room = await s.create('first');
  assert.deepEqual(await s.create('first'), room);
  const other = await s.create('second');
  assert.equal((await s.call('/rooms')).envelope.data.rooms.length, 2);
  assert.equal((await s.call(`/rooms/${room.id}/history`)).status, 403);
  const joined = (await s.enter(room)).envelope.data;
  Outputs.joinRoom.parse(joined);
  assert.deepEqual(joined.history.events, []);
  assert.equal((await s.enter(other, s.a, 'conflicting-room')).envelope.error.code, 'ACTIVE_ROOM_CONFLICT');
  const leave = { request_id: 'leave', membership_epoch: joined.membership.epoch };
  const result = await s.call(`/rooms/${room.id}/leave`, { method: 'POST', body: leave });
  assert.deepEqual(result.envelope.data, { room_id: room.id, left: true });
  assert.equal((await s.call(`/rooms/${room.id}/history`)).status, 403);
  assert.equal((await s.enter(room)).envelope.error.code, 'MEMBERSHIP_ENDED');
  assert.equal((await s.enter(other, s.a, 'join-second')).status, 200);
  assert.ok(s.changes.includes(room.id)); assert.ok(s.changes.includes(other.id));
});

test('two authors may reply to one parent; retries are idempotent and room boundaries hold', async t => {
  const s = await setup(t);
  const room = await s.create('shared'), other = await s.create('private');
  await s.enter(room, s.a); await s.enter(room, s.b);
  const parent = (await s.post(room, s.a, 'parent', ' Question ')).envelope.data;
  assert.equal(parent.payload.text, 'Question'); assert.equal(parent.author.id, s.a.participant.id);
  const one = await s.post(room, s.a, 'reply-a', 'First', parent.id);
  const two = await s.post(room, s.b, 'reply-b', 'Second', parent.id);
  assert.equal(one.status, 200); assert.equal(two.status, 200);
  assert.notEqual(one.envelope.data.id, two.envelope.data.id);
  assert.deepEqual((await s.post(room, s.a, 'reply-a', 'First', parent.id)).envelope, one.envelope);
  assert.equal((await s.post(room, s.a, 'reply-a', 'Changed', parent.id)).envelope.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(s.posts.length, 3);
  assert.equal((await s.post(other, s.a, 'forbidden', 'No')).status, 403);
  const foreign = await s.call(`/rooms/${other.id}/messages`, { method: 'POST', human: true, body: { request_id: 'foreign', text: 'Invalid', reply_to: parent.id } });
  assert.equal(foreign.status, 400);
  const history = (await s.call(`/rooms/${room.id}/history?limit=2`)).envelope.data;
  assert.deepEqual(history.events.map(event => event.sequence), [2, 3]); assert.equal(history.next_before, 2);
  const older = (await s.call(`/rooms/${room.id}/history?before=2&limit=2`)).envelope.data;
  assert.deepEqual(older.events.map(event => event.sequence), [1]); assert.equal(older.next_before, null);
});

test('join history is bounded at the captured head even when a notification appends', async t => {
  const s = await setup(t);
  const room = await s.create('snapshot');
  for (let index = 1; index <= 55; index++) s.events.post(s.humanContext, room.id, { request_id: `m-${index}`, text: `Message ${index}` });
  s.setChanged(id => {
    assert.equal(s.rooms.requireMembership(s.identity.authenticate({ bearer: s.a.token }), id).active, true);
    s.events.post(s.humanContext, id, { request_id: 'after-join', text: 'After the snapshot' });
  });
  const response = await s.enter(room);
  assert.equal(response.status, 200);
  const joined = response.envelope.data;
  assert.equal(joined.membership.joined_sequence, 55);
  assert.equal(joined.history.head_sequence, 55);
  assert.equal(joined.history.events.length, 50);
  assert.equal(joined.history.events.at(-1).sequence, 55);
  assert.equal((await s.call(`/rooms/${room.id}/history`)).envelope.data.head_sequence, 56);
  s.setChanged(() => { throw new Error('Notification unavailable'); });
  assert.equal((await s.enter(room, s.a, 'another-join')).status, 200);
});

test('strict history queries, path IDs and message/room payloads reject forged inputs', async t => {
  const s = await setup(t);
  const room = await s.create('validation'); await s.enter(room);
  for (const query of ['before=1oops', 'before=-1', 'before=', 'before=1&before=2', 'limit=1&limit=2', 'limit=0', 'limit=101', 'limit=1.5', 'limit=1e2', 'before=9007199254740992', 'through=1']) {
    assert.equal((await s.call(`/rooms/${room.id}/history?${query}`)).status, 400, query);
  }
  for (const path of ['/rooms/%ZZ/history', `/rooms/${'x'.repeat(129)}/history`]) assert.equal((await s.call(path)).status, 400);
  for (const path of ['/rooms/%ZZ/messages', `/rooms/${'x'.repeat(129)}/messages`]) {
    assert.equal((await s.call(path, { method: 'POST', body: { request_id: 'invalid-id', text: 'Hi' } })).status, 400);
  }
  for (const [path, body] of [
    ['/rooms', { request_id: 'forged-room', name: 'forged', owner_id: 'fake' }],
    [`/rooms/${room.id}/join`, { request_id: 'forged-join', participant_id: 'fake' }],
    [`/rooms/${room.id}/messages`, { request_id: 'forged-author', text: 'Hi', author_id: 'fake' }],
  ]) assert.equal((await s.call(path, { method: 'POST', body })).status, 400);
  assert.equal((await s.call(`/rooms/${room.id}/messages`)).status, 404);
  assert.equal((await s.call(`/rooms/${room.id}/join`)).status, 404);
  assert.equal((await s.call(`/rooms/${room.id}/history`, { method: 'POST', body: {} })).status, 404);
});
