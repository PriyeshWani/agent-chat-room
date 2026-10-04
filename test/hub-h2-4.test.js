import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { openDatabase } from '../src/hub/db.js';
import { createIdentityStore } from '../src/hub/identity-store.js';
import { createRoomStore } from '../src/hub/room-store.js';
import { createEventStore } from '../src/hub/event-store.js';
import { createDeliveryStore } from '../src/hub/delivery-store.js';
import { createDeliveryService } from '../src/hub/delivery-service.js';
import { createDeliveryRoutes } from '../src/hub/routes/delivery.js';
import { createLocalSession } from '../src/hub/local-session.js';
import { createHttpServer } from '../src/hub/http-server.js';
import { temporaryDirectory } from './helpers/processes.js';

async function setup(t, changes = new EventEmitter()) {
  const database = await openDatabase({ filename: join(await temporaryDirectory(t), 'waits.sqlite') });
  t.after(() => database.close());
  const identity = createIdentityStore(database, { bootId: 'boot' });
  const rooms = createRoomStore(database, { identity });
  const events = createEventStore(database, { identity, rooms, onChange: roomId => changes.emit('room', roomId) });
  const delivery = createDeliveryStore(database, { identity, rooms, events });
  const service = createDeliveryService({ delivery, rooms, identity, changes });
  t.after(() => service.close());
  const sessions = createLocalSession({ identity, changes });
  const browser = identity.browserSession();
  const human = identity.authenticate({ cookie: browser.token });
  const room = rooms.create(human, { request_id: 'room', name: 'Room' });
  const input = { mode: 'create', request_id: 'enroll', resume_token: 's'.repeat(32), name: 'Agent' };
  const agent = sessions.agentSession(input);
  const context = identity.authenticate({ bearer: agent.token });
  rooms.join(context, room.id, { request_id: 'join' });
  return { database, identity, rooms, events, delivery, service, sessions, human, room, input, agent, context, changes };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
const noListeners = changes => {
  assert.equal(changes.listenerCount('room'), 0);
  assert.equal(changes.listenerCount('identity'), 0);
};

test('one waiter wakes on a durable post, filters unrelated hints, and acknowledgement delegates', async t => {
  const s = await setup(t);
  const waiting = s.service.receive(s.context, s.room.id, { wait_ms: 20000 });
  assert.equal(s.service.isReceiving(s.agent.participant.id, s.room.id), true);
  await assert.rejects(s.service.receive(s.context, s.room.id, { wait_ms: 0 }), { code: 'ALREADY_RECEIVING' });
  let settled = false;
  waiting.then(() => { settled = true; });
  s.changes.emit('room', 'unrelated');
  s.changes.emit('identity', 'unrelated');
  await turn();
  assert.equal(settled, false);
  const event = s.events.post(s.human, s.room.id, { request_id: 'post', text: 'hello' });
  const received = await waiting;
  assert.deepEqual(received.batch.events, [event]);
  assert.equal(s.service.isReceiving(s.agent.participant.id, s.room.id), false);
  noListeners(s.changes);
  assert.deepEqual(await s.service.receive(s.context, s.room.id, { wait_ms: 20000 }), received);
  const ack = s.service.ack(s.context, s.room.id, { request_id: 'ack', membership_epoch: received.batch.membership_epoch, batch_id: received.batch.id });
  assert.equal(ack.acknowledged_through, 1);
  noListeners(s.changes);
});

test('subscribe then recheck catches a write in the initial scan/subscription gap', async t => {
  const changes = new EventEmitter();
  const s = await setup(t, changes);
  let injected = false;
  const on = changes.on;
  changes.on = function (event, listener) {
    if (event === 'room' && !injected) {
      injected = true;
      // This notification occurs before the listener is actually attached.
      s.events.post(s.human, s.room.id, { request_id: 'gap-post', text: 'gap' });
    }
    return on.call(this, event, listener);
  };
  const received = await s.service.receive(s.context, s.room.id, { wait_ms: 20000 });
  assert.equal(received.kind, 'batch');
  assert.equal(received.batch.events[0].payload.text, 'gap');
  noListeners(changes);
});

test('timeouts differ from aborts and both clean up without advancing progress', async t => {
  const s = await setup(t);
  const immediate = await s.service.receive(s.context, s.room.id, { wait_ms: 0 });
  assert.deepEqual(immediate, { kind: 'timeout', room_id: s.room.id, acknowledged_through: 0 });
  // One short real timer verifies timeout wiring; state transitions below use signals.
  assert.deepEqual(await s.service.receive(s.context, s.room.id, { wait_ms: 1 }), immediate);
  noListeners(s.changes);
  const controller = new AbortController();
  const waiting = s.service.receive(s.context, s.room.id, {}, { signal: controller.signal });
  const rejected = assert.rejects(waiting, { name: 'AbortError' });
  controller.abort();
  await rejected;
  noListeners(s.changes);
  assert.equal(s.service.isReceiving(s.agent.participant.id, s.room.id), false);
  await assert.rejects(s.service.receive(s.context, s.room.id, {}, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(s.rooms.requireMembership(s.context, s.room.id).acknowledged_sequence, 0);
  assert.equal(s.database.db.prepare('SELECT count(*) AS n FROM batches').get().n, 0);
  await assert.rejects(s.service.receive(s.context, s.room.id, { wait_ms: -1 }), { code: 'VALIDATION_ERROR' });
});

test('leave/rejoin and replacement fence captured contexts and release obsolete waiters', async t => {
  const s = await setup(t);
  const pending = s.service.receive(s.context, s.room.id, {});
  const ended = assert.rejects(pending, { code: 'MEMBERSHIP_ENDED' });
  const member = s.rooms.requireMembership(s.context, s.room.id);
  s.rooms.leave(s.context, s.room.id, { request_id: 'leave', membership_epoch: member.epoch });
  s.rooms.join(s.context, s.room.id, { request_id: 'rejoin' });
  s.changes.emit('room', s.room.id);
  await ended;
  noListeners(s.changes);
  const oldWait = s.service.receive(s.context, s.room.id, {});
  const replaced = assert.rejects(oldWait, { code: 'SESSION_REPLACED' });
  const resumed = s.sessions.agentSession({ ...s.input, mode: 'resume', request_id: 'resume' });
  const current = s.identity.authenticate({ bearer: resumed.token });
  // Starting the current receive before queued wakeups run releases the old one.
  const controller = new AbortController();
  const currentWait = s.service.receive(current, s.room.id, {}, { signal: controller.signal });
  const cancelled = assert.rejects(currentWait, { name: 'AbortError' });
  await replaced;
  assert.equal(s.service.isReceiving(current.participant.id, s.room.id), true);
  controller.abort();
  await cancelled;
  noListeners(s.changes);
  const closingWait = s.service.receive(current, s.room.id, {});
  const expired = assert.rejects(closingWait, { code: 'SESSION_EXPIRED' });
  s.sessions.disconnect(current);
  await expired;
  noListeners(s.changes);
});

test('shutdown cancels waiters and a committed batch remains available after cancellation', async t => {
  const s = await setup(t);
  const controller = new AbortController();
  const pending = s.service.receive(s.context, s.room.id, {}, { signal: controller.signal });
  s.events.post(s.human, s.room.id, { request_id: 'post', text: 'durable' });
  const batch = await pending;
  controller.abort();
  assert.deepEqual(s.delivery.receive(s.context, s.room.id), batch);
  s.service.ack(s.context, s.room.id, { request_id: 'ack', membership_epoch: batch.batch.membership_epoch, batch_id: batch.batch.id });
  const waiting = s.service.receive(s.context, s.room.id, {});
  const rejected = assert.rejects(waiting, { name: 'AbortError' });
  s.service.close();
  s.service.close();
  await rejected;
  noListeners(s.changes);
  await assert.rejects(s.service.receive(s.context, s.room.id, {}), { name: 'AbortError' });
});

test('delivery routes use actual HTTP authentication, validation, outputs and shell cancellation', async t => {
  const s = await setup(t);
  const route = createDeliveryRoutes({ sessions: s.sessions, deliveryService: s.service });
  const server = await createHttpServer({ handlers: [route] });
  t.after(() => server.close());
  const url = `${server.url}/api/v1/rooms/${s.room.id}`;
  const headers = { authorization: `Bearer ${s.agent.token}`, 'content-type': 'application/json' };
  const post = (path, body) => fetch(`${url}/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  let response = await post('receive', { wait_ms: 0 });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.kind, 'timeout');
  response = await post('receive', { wait_ms: -1 });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
  response = await fetch(`${url}/receive`, { headers });
  assert.equal(response.status, 404);
  await response.arrayBuffer();
  s.events.post(s.human, s.room.id, { request_id: 'http-post', text: 'http' });
  response = await post('receive', { wait_ms: 0 });
  const { data } = await response.json();
  response = await post('ack', { request_id: 'http-ack', batch_id: data.batch.id, membership_epoch: data.batch.membership_epoch });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.acknowledged_through, 1);
  // Exercise the handler's signal forwarding deterministically with a shell-shaped context.
  const controller = new AbortController();
  const waiting = route({ request: { headers, rawHeaders: [] }, method: 'POST', path: `/api/v1/rooms/${s.room.id}/receive`, body: {}, signal: controller.signal });
  const cancelled = assert.rejects(waiting, { name: 'AbortError' });
  controller.abort();
  await cancelled;
  noListeners(s.changes);
});
