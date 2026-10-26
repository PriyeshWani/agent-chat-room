import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openDatabase } from '../src/hub/db.js';
import { createIdentityStore } from '../src/hub/identity-store.js';
import { createRoomStore } from '../src/hub/room-store.js';
import { createEventStore } from '../src/hub/event-store.js';
import { createMutationStore } from '../src/hub/mutation-store.js';
import { temporaryDirectory } from './helpers/processes.js';
import { isRoomEvent } from '../src/shared/protocol.js';
import { RoomEvent } from '../src/shared/schemas.js';
import { createHub } from '../src/hub/main.js';
import { RoomClient } from '../src/shared/client.js';
import { browserClient } from './helpers/browser-client.js';

function stores(database) {
  const identity = createIdentityStore(database, { bootId: 'mentions-test' });
  const rooms = createRoomStore(database, { identity });
  return { identity, rooms, events: createEventStore(database, { identity, rooms }) };
}

test('mentions validate room membership, retain identity snapshots and replay the exact committed recipients', async t => {
  const filename = join(await temporaryDirectory(t), 'mentions.sqlite');
  const database = await openDatabase({ filename }); t.after(() => database.close());
  const s = stores(database);
  const human = s.identity.browserSession(); const context = s.identity.authenticate({ cookie: human.token });
  const room = s.rooms.create(context, { request_id: 'room', name: 'Design' });
  function agent(id, name) {
    const session = s.identity.agentSession({ request_id: id, mode: 'create', resume_token: id.repeat(32), name });
    const ctx = s.identity.authenticate({ bearer: session.token });
    return { ...session, context: ctx };
  }
  const first = agent('a', 'Same Name'), second = agent('b', 'Same Name'), outsider = agent('c', 'Outside');
  const membership = s.rooms.join(first.context, room.id, { request_id: 'join' }).membership;
  s.rooms.join(second.context, room.id, { request_id: 'join' });
  const input = { request_id: 'mention', text: '@Same Name review this', mention_ids: [second.participant.id, first.participant.id] };
  const posted = s.events.post(context, room.id, input);
  assert.deepEqual(posted.payload.mentions, [second, first].map(({ participant: { id, name, kind } }) => ({ id, name, kind })));
  assert.equal(isRoomEvent(posted), true); RoomEvent.parse(posted);
  assert.deepEqual(s.events.history(context, room.id).events, [posted]);
  for (const mention_ids of [[outsider.participant.id], ['missing'], [first.participant.id, first.participant.id]]) {
    assert.throws(() => s.events.post(context, room.id, { request_id: 'invalid', text: 'No', mention_ids }), error => error.code === 'VALIDATION_ERROR');
  }
  assert.equal(s.events.head(context, room.id), 1);
  assert.throws(() => s.events.post(context, room.id, { ...input, mention_ids: [first.participant.id] }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  s.rooms.leave(first.context, room.id, { request_id: 'leave', membership_epoch: membership.epoch });
  assert.deepEqual(s.events.post(context, room.id, input), posted); // Replay survives a recipient leaving.
  assert.throws(() => s.events.post(context, room.id, { ...input, request_id: 'new' }), error => error.code === 'VALIDATION_ERROR');
  database.db.prepare('UPDATE participants SET name=? WHERE id=?').run('Changed', second.participant.id);
  assert.deepEqual(s.events.history(context, room.id).events, [posted]);
  const ordinary = s.events.post(context, room.id, { request_id: 'plain', text: 'Ordinary' });
  assert.deepEqual(s.events.post(context, room.id, { request_id: 'plain', text: 'Ordinary', mention_ids: [] }), ordinary);
  database.close();
  const reopened = await openDatabase({ filename }); t.after(() => reopened.close());
  assert.deepEqual(stores(reopened).events.history(context, room.id).events, [posted, ordinary]);
  assert.equal(isRoomEvent({ ...posted, payload: { ...posted.payload, mentions: [{ id: null }] } }), false);
});

test('upgrading a version 1 database retains old messages and mutation replay without mention fields', async t => {
  const directory = await temporaryDirectory(t), filename = join(directory, 'old.sqlite');
  const migrationsDir = join(directory, 'migrations'); await mkdir(migrationsDir);
  await writeFile(join(migrationsDir, '001.mjs'), await readFile(new URL('../src/hub/migrations/001-foundation.js', import.meta.url)));
  const old = await openDatabase({ filename, migrationsDir }); t.after(() => old.close());
  const s = stores(old);
  const human = s.identity.browserSession(); const context = s.identity.authenticate({ cookie: human.token });
  const room = s.rooms.create(context, { request_id: 'room', name: 'Before upgrade' });
  const event = { id: 'legacy', room_id: room.id, sequence: 1, kind: 'message',
    author: { id: human.participant.id, name: human.participant.name, kind: 'human' },
    payload: { text: 'Kept intact', reply_to: null }, created_at: '2026-09-28T00:00:00.000Z' };
  old.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)').run(event.id, room.id, 1, event.author.id, event.author.name, 'human', event.payload.text, null, event.created_at);
  old.db.prepare('UPDATE rooms SET next_sequence=2 WHERE id=?').run(room.id);
  createMutationStore(old).record({ participantId: event.author.id, requestId: 'original', operation: 'postMessage', roomId: room.id, payload: event.payload }, event);
  old.close();
  const upgraded = await openDatabase({ filename }); t.after(() => upgraded.close());
  const next = stores(upgraded);
  assert.deepEqual(next.events.history(context, room.id).events, [event]);
  assert.deepEqual(next.events.post(context, room.id, { request_id: 'original', text: event.payload.text, mention_ids: [] }), event);
  assert.deepEqual(upgraded.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version), [1, 2, 3, 4, 5]);
});

test('older adapter JSON responses omit new fields without changing durable batches, history or acknowledgements', async t => {
  const hub = await createHub({ filename: ':memory:' }); t.after(() => hub.close());
  const human = await browserClient(hub.url);
  const room = await human.client.createRoom({ name: 'Compatibility' });
  const legacy = new RoomClient({ baseUrl: hub.url, fetchImpl(url, options) {
    const headers = new Headers(options.headers); headers.delete('X-Room-Features');
    return fetch(url, { ...options, headers });
  } });
  const session = await legacy.agentSession({ mode: 'create', resume_token: 'legacy-mentions-test-'.repeat(3), name: 'Older agent' });
  const joined = await legacy.joinRoom(room.id);
  const posted = await human.client.postMessage(room.id, { text: '@Older agent review this', mention_ids: [session.participant.id] });
  const plain = { ...posted, payload: { text: posted.payload.text, reply_to: null } };
  const batch = (await legacy.receiveEvents(room.id, { wait_ms: 0 })).batch;
  assert.deepEqual(batch.events, [plain]);
  assert.deepEqual((await legacy.history(room.id)).events, [plain]);
  assert.deepEqual((await legacy.joinRoom(room.id)).history.events, [plain]);
  const updated = new RoomClient({ baseUrl: hub.url, token: legacy.token });
  const richerBatch = (await updated.receiveEvents(room.id, { wait_ms: 0 })).batch;
  assert.equal(richerBatch.id, batch.id);
  assert.deepEqual(richerBatch.events, [posted]);
  await legacy.ackEvents(room.id, { batch_id: batch.id, membership_epoch: joined.membership.epoch });
  assert.equal((await updated.receiveEvents(room.id, { wait_ms: 0 })).kind, 'timeout');
  assert.deepEqual((await human.client.history(room.id)).events, [posted]);
});
