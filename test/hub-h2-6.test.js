import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { openDatabase } from '../src/hub/db.js';
import { createIdentityStore } from '../src/hub/identity-store.js';
import { createRoomStore } from '../src/hub/room-store.js';
import { createEventStore } from '../src/hub/event-store.js';
import { createLocalSession } from '../src/hub/local-session.js';
import { createBrowserStream } from '../src/hub/browser-stream.js';
import { createStreamRoutes } from '../src/hub/routes/stream.js';
import { createHttpServer } from '../src/hub/http-server.js';
import { RoomClient } from '../src/shared/client.js';
import { temporaryDirectory } from './helpers/processes.js';

async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5); }
  assert.ok(predicate(), 'Condition did not become true');
}
async function setup(t, { heartbeatMs = 15000 } = {}) {
  const database = await openDatabase({ filename: join(await temporaryDirectory(t), 'hub.sqlite') });
  t.after(() => database.close());
  const identity = createIdentityStore(database, { bootId: 'test' });
  const rooms = createRoomStore(database, { identity });
  const changes = new EventEmitter();
  const events = createEventStore(database, { identity, rooms, onChange: id => changes.emit('room', id) });
  const human = identity.browserSession(), context = identity.authenticate({ cookie: human.token });
  const room = rooms.create(context, { request_id: 'room', name: 'Main' });
  const other = rooms.create(context, { request_id: 'other', name: 'Other' });
  const agentInput = { request_id: 'enroll', mode: 'create', resume_token: 's'.repeat(40), name: 'Agent' };
  const agent = identity.agentSession(agentInput);
  const agentContext = identity.authenticate({ bearer: agent.token });
  rooms.join(agentContext, room.id, { request_id: 'join' });
  const browserStream = createBrowserStream({ events, rooms, identity, changes, heartbeatMs });
  t.after(() => browserStream.close());
  const sessions = createLocalSession({ identity });
  const hub = await createHttpServer({ handlers: [createStreamRoutes({ sessions, browserStream })] });
  t.after(() => hub.close());
  const client = new RoomClient({ baseUrl: hub.url, fetchImpl: (url, options) => fetch(url, {
    ...options, headers: { ...options.headers, Cookie: `acr_session=${human.token}` },
  }) });
  let next = 0;
  const post = (selected = room, author = context) => events.post(author, selected.id, { request_id: `message-${++next}`, text: `Message ${next}` });
  return { database, identity, rooms, changes, events, context, room, other, agent, agentInput, agentContext, browserStream, hub, client, post };
}

test('actual HTTP/shared SSE client replays and follows own/peer posts without advancing agent cursors', { timeout: 5000 }, async t => {
  const s = await setup(t);
  s.post(); const second = s.post(); s.post(s.other);
  const before = s.rooms.requireMembership(s.agentContext, s.room.id).acknowledged_sequence;
  const controller = new AbortController(); t.after(() => controller.abort());
  const iterator = s.client.events(s.room.id, { after: 1, signal: controller.signal });
  assert.deepEqual((await iterator.next()).value, second);
  const pending = iterator.next();
  const peer = s.post(s.room, s.agentContext);
  assert.deepEqual((await pending).value, peer);
  const own = s.post();
  assert.deepEqual((await iterator.next()).value, own);
  assert.equal(s.rooms.requireMembership(s.agentContext, s.room.id).acknowledged_sequence, before);
  assert.equal(s.database.db.prepare('SELECT count(*) AS n FROM batches').get().n, 0);
  const waiting = iterator.next(); const rejected = assert.rejects(waiting, /abort/i);
  controller.abort(); await rejected;
  await until(() => s.changes.listenerCount('room') === 0);
  assert.equal(s.changes.listenerCount('identity'), 0);
});

test('route rejects malformed, repeated and ahead cursors before starting SSE', async t => {
  const s = await setup(t);
  for (const query of ['after=-1', 'after=', 'after=1oops', 'after=1.5', 'after=1&after=2', 'after=9007199254740992', 'after=1', 'other=0']) {
    const response = await fetch(`${s.hub.url}/api/v1/rooms/${s.room.id}/stream?${query}`, { headers: { Authorization: `Bearer ${s.agent.token}` } });
    assert.equal(response.status, 400, query); assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
  }
  const forbidden = await fetch(`${s.hub.url}/api/v1/rooms/${s.other.id}/stream`, { headers: { Authorization: `Bearer ${s.agent.token}` } });
  assert.equal(forbidden.status, 403);
  assert.equal(s.changes.listenerCount('room'), 0);
});

class Writable extends EventEmitter {
  writableLength = 0;
  destroyed = false;
  frames = [];
  block = false;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(frame) {
    this.frames.push(frame);
    if (this.block && frame.startsWith('id:')) { this.writableLength += Buffer.byteLength(frame); return false; }
    return true;
  }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
  drain() { this.writableLength = 0; this.block = false; this.emit('drain'); }
}

test('replay closes the head/subscription gap and resumes durable pages after backpressure', async t => {
  const s = await setup(t);
  for (let i = 0; i < 105; i++) s.post();
  let inserted = false;
  const originalHead = s.events.head;
  const stream = createBrowserStream({ ...s, events: { ...s.events, head(...args) {
    const head = originalHead(...args);
    if (!inserted) { inserted = true; s.post(); }
    return head;
  } } }); t.after(() => stream.close());
  const response = new Writable(); response.block = true;
  const controller = new AbortController();
  stream.stream(s.context, s.room.id, 0, { response, signal: controller.signal });
  assert.equal(response.frames.filter(frame => frame.startsWith('id:')).length, 1);
  for (let i = 0; i < 4; i++) s.post();
  assert.equal(response.frames.filter(frame => frame.startsWith('id:')).length, 1);
  response.drain();
  const sequences = response.frames.filter(frame => frame.startsWith('id:')).map(frame => Number(/^id:(\d+)/.exec(frame)[1]));
  assert.deepEqual(sequences, Array.from({ length: 110 }, (_, i) => i + 1));
  controller.abort();
  assert.equal(s.changes.listenerCount('room'), 0);
  assert.equal(response.listenerCount('drain'), 0);
});

test('captured epoch and current connection end streams on leave/rejoin and replacement', async t => {
  const s = await setup(t);
  const response = new Writable();
  s.browserStream.stream(s.agentContext, s.room.id, 0, { response, signal: new AbortController().signal });
  const membership = s.rooms.requireMembership(s.agentContext, s.room.id);
  s.rooms.leave(s.agentContext, s.room.id, { request_id: 'leave', membership_epoch: membership.epoch });
  s.rooms.join(s.agentContext, s.room.id, { request_id: 'rejoin' });
  s.changes.emit('room', s.room.id);
  assert.equal(response.destroyed, true);
  const replacement = new Writable();
  s.browserStream.stream(s.agentContext, s.room.id, 0, { response: replacement, signal: new AbortController().signal });
  s.identity.agentSession({ ...s.agentInput, request_id: 'resume', mode: 'resume' });
  s.changes.emit('identity', s.agent.participant.id);
  assert.equal(replacement.destroyed, true);
  assert.equal(s.changes.listenerCount('room'), 0);
  assert.equal(s.changes.listenerCount('identity'), 0);
});

test('heartbeat comments revalidate idle streams; close and oversized writable clean resources', { timeout: 5000 }, async t => {
  const s = await setup(t, { heartbeatMs: 10 });
  const response = new Writable();
  s.browserStream.stream(s.context, s.room.id, 0, { response, signal: new AbortController().signal });
  await until(() => response.frames.includes(': heartbeat\n\n'));
  const member = s.rooms.requireMembership(s.context, s.room.id);
  s.rooms.leave(s.context, s.room.id, { request_id: 'leave', membership_epoch: member.epoch });
  await until(() => response.destroyed);
  assert.equal(s.changes.listenerCount('room'), 0);
  const oversized = new Writable(); oversized.writableLength = 65536;
  s.browserStream.stream(s.agentContext, s.room.id, 0, { response: oversized, signal: new AbortController().signal });
  assert.equal(oversized.destroyed, true);
  const open = new Writable();
  s.browserStream.stream(s.agentContext, s.room.id, 0, { response: open, signal: new AbortController().signal });
  s.browserStream.close(); s.browserStream.close();
  assert.equal(open.destroyed, true);
  assert.equal(s.changes.listenerCount('identity'), 0);
});
