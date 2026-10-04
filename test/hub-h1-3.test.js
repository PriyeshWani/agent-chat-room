import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDatabase } from '../src/hub/db.js';
import { createIdentityStore } from '../src/hub/identity-store.js';
import { createRoomStore } from '../src/hub/room-store.js';
import { createEventStore } from '../src/hub/event-store.js';
import { Outputs } from '../src/shared/schemas.js';
import { temporaryDirectory } from './helpers/processes.js';

const fails = (fn, code) => assert.throws(fn, error => error.code === code && error.details === undefined);
async function setup(t) {
  const filename = join(await temporaryDirectory(t), 'events.sqlite');
  let counter = 0;
  const hooks = { id: () => `id-${++counter}`, now: () => '2026-09-27T00:00:00.000Z' };
  async function open(bootId = 'boot') {
    const database = await openDatabase({ filename });
    t.after(() => database.close());
    const identity = createIdentityStore(database, { bootId, ...hooks });
    const rooms = createRoomStore(database, { identity, ...hooks });
    const events = createEventStore(database, { identity, rooms, ...hooks });
    return { database, identity, rooms, events };
  }
  const stores = await open();
  const browser = stores.identity.browserSession();
  const context = stores.identity.authenticate({ cookie: browser.token });
  const room = stores.rooms.create(context, { request_id: 'create', name: 'Room' });
  return { ...stores, context, room, open, hooks };
}

test('independent SQLite connections allocate ordered room sequences and observe notifications only after commit', async t => {
  const s = await setup(t);
  const other = await s.open();
  const seen = [];
  const events = createEventStore(s.database, {
    identity: s.identity, rooms: s.rooms, ...s.hooks,
    onChange: roomId => seen.push(other.events.head(s.context, roomId)),
  });
  const first = Outputs.postMessage.parse(events.post(s.context, s.room.id, { request_id: 'one', text: ' first ' }));
  assert.equal(first.payload.text, 'first');
  assert.deepEqual(seen, [1]);
  assert.deepEqual(events.post(s.context, s.room.id, { request_id: 'one', text: 'first', reply_to: null }), first);
  assert.deepEqual(seen, [1]);
  const second = other.events.post(s.context, s.room.id, { request_id: 'two', text: 'second' });
  const third = events.post(s.context, s.room.id, { request_id: 'three', text: 'third' });
  assert.deepEqual([first.sequence, second.sequence, third.sequence], [1, 2, 3]);
  assert.deepEqual(seen, [1, 3]);
  const expected = [first, second, third];
  assert.deepEqual(other.events.after(s.context, s.room.id, { after: 0 }).events, expected);
  s.database.close();
  const reopened = await s.open();
  assert.deepEqual(reopened.events.post(s.context, s.room.id, { request_id: 'one', text: 'first' }), first);
  assert.deepEqual(reopened.events.history(s.context, s.room.id).events, expected);
});

test('reply targets stay in one room, several replies are allowed, and request conflicts do not append', async t => {
  const s = await setup(t);
  const otherRoom = s.rooms.create(s.context, { request_id: 'other-room', name: 'Other' });
  const parent = s.events.post(s.context, s.room.id, { request_id: 'parent', text: 'parent' });
  const reply1 = s.events.post(s.context, s.room.id, { request_id: 'reply1', text: 'first reply', reply_to: parent.id });
  const reply2 = s.events.post(s.context, s.room.id, { request_id: 'reply2', text: 'second reply', reply_to: parent.id });
  assert.equal(reply1.payload.reply_to, parent.id);
  assert.equal(reply2.payload.reply_to, parent.id);
  fails(() => s.events.post(s.context, otherRoom.id, { request_id: 'foreign', text: 'no', reply_to: parent.id }), 'VALIDATION_ERROR');
  fails(() => s.events.post(s.context, s.room.id, { request_id: 'missing', text: 'no', reply_to: 'missing' }), 'VALIDATION_ERROR');
  fails(() => s.events.post(s.context, s.room.id, { request_id: 'parent', text: 'changed' }), 'IDEMPOTENCY_CONFLICT');
  fails(() => s.events.post(s.context, otherRoom.id, { request_id: 'parent', text: 'parent' }), 'IDEMPOTENCY_CONFLICT');
  fails(() => s.events.post(s.context, s.room.id, { request_id: 'create', text: 'parent' }), 'IDEMPOTENCY_CONFLICT');
  assert.equal(s.events.head(s.context, s.room.id), 3);
  assert.equal(s.events.head(s.context, otherRoom.id), 0);
  assert.deepEqual(s.events.history(s.context, otherRoom.id).events, []);
  assert.equal(s.database.db.prepare("SELECT count(*) AS n FROM requests WHERE request_id IN ('foreign','missing')").get().n, 0);
});

test('history pages ascend and through retains a captured join head; raw after includes self posts', async t => {
  const s = await setup(t);
  const posted = [];
  for (let index = 1; index <= 5; index++) posted.push(s.events.post(s.context, s.room.id, { request_id: `post-${index}`, text: `message ${index}` }));
  const snapshot = s.rooms.join(s.context, s.room.id, { request_id: 'join' });
  posted.push(s.events.post(s.context, s.room.id, { request_id: 'later', text: 'later' }));
  const latest = Outputs.history.parse(s.events.history(s.context, s.room.id, { limit: 2 }));
  assert.deepEqual(latest.events, posted.slice(4));
  assert.equal(latest.head_sequence, 6);
  assert.equal(latest.next_before, 5);
  const middle = s.events.history(s.context, s.room.id, { before: latest.next_before, limit: 2 });
  assert.deepEqual(middle.events, posted.slice(2, 4));
  assert.equal(middle.next_before, 3);
  const oldest = s.events.history(s.context, s.room.id, { before: middle.next_before, limit: 2 });
  assert.deepEqual(oldest.events, posted.slice(0, 2));
  assert.equal(oldest.next_before, null);
  assert.deepEqual(s.events.history(s.context, s.room.id, { before: 0 }).events, []);
  const bounded = s.events.history(s.context, s.room.id, { through: snapshot.head_sequence });
  assert.equal(bounded.head_sequence, 5);
  assert.deepEqual(bounded.events, posted.slice(0, 5));
  Outputs.joinRoom.parse({ room: snapshot.room, membership: snapshot.membership, history: bounded });
  assert.deepEqual(s.events.history(s.context, s.room.id, { through: 0 }).events, []);
  assert.deepEqual(s.events.after(s.context, s.room.id, { after: 2, limit: 2, through: 5 }), { events: posted.slice(2, 4), head_sequence: 5 });
  assert.deepEqual(s.events.after(s.context, s.room.id, { after: 6 }), { events: [], head_sequence: 6 });
  for (const options of [{ before: -1 }, { before: 1.5 }, { limit: 0 }, { limit: 101 }, { through: 7 }, { through: -1 }, { through: Number.MAX_SAFE_INTEGER + 1 }]) {
    fails(() => s.events.history(s.context, s.room.id, options), 'VALIDATION_ERROR');
  }
  for (const options of [{}, { after: -1 }, { after: 7 }, { after: 4, through: 3 }, { after: 0, limit: 101 }]) {
    fails(() => s.events.after(s.context, s.room.id, options), 'VALIDATION_ERROR');
  }
});

test('author snapshots remain stable after resume and stale or nonmember contexts cannot replay', async t => {
  const s = await setup(t);
  const input = { mode: 'create', request_id: 'enroll', resume_token: 's'.repeat(32), name: 'Original' };
  const agent = s.identity.agentSession(input);
  const context = s.identity.authenticate({ bearer: agent.token });
  fails(() => s.events.history(context, s.room.id), 'FORBIDDEN');
  fails(() => s.events.post(context, s.room.id, { request_id: 'not-member', text: 'no' }), 'FORBIDDEN');
  s.rooms.join(context, s.room.id, { request_id: 'join' });
  const original = s.events.post({ ...context, participant: { ...context.participant, name: 'Forged' } }, s.room.id, { request_id: 'post', text: 'hello' });
  assert.equal(original.author.name, 'Original');
  const resumed = s.identity.agentSession({ ...input, mode: 'resume', request_id: 'resume', name: 'Renamed' });
  const current = s.identity.authenticate({ bearer: resumed.token });
  fails(() => s.events.post(context, s.room.id, { request_id: 'post', text: 'hello' }), 'SESSION_REPLACED');
  fails(() => s.events.after(context, s.room.id, { after: 0 }), 'SESSION_REPLACED');
  assert.deepEqual(s.events.post(current, s.room.id, { request_id: 'post', text: 'hello' }), original);
  const next = s.events.post(current, s.room.id, { request_id: 'next', text: 'new' });
  assert.equal(next.author.name, 'Renamed');
  assert.deepEqual(s.events.history(current, s.room.id).events, [original, next]);
  const membership = s.rooms.requireMembership(current, s.room.id);
  s.rooms.leave(current, s.room.id, { request_id: 'leave', membership_epoch: membership.epoch });
  fails(() => s.events.post(current, s.room.id, { request_id: 'post', text: 'hello' }), 'FORBIDDEN');
});

test('failed append rolls back allocation/journal and does not notify; failed notifications preserve success', async t => {
  const s = await setup(t);
  let notifications = 0;
  const events = createEventStore(s.database, { identity: s.identity, rooms: s.rooms, ...s.hooks, onChange() { notifications++; throw new Error('notification failed'); } });
  const first = events.post(s.context, s.room.id, { request_id: 'first', text: 'first' });
  assert.equal(notifications, 1);
  assert.deepEqual(events.post(s.context, s.room.id, { request_id: 'first', text: 'first' }), first);
  assert.equal(notifications, 1);
  const rejected = createEventStore(s.database, { identity: s.identity, rooms: s.rooms, ...s.hooks, onChange: () => Promise.reject(new Error('async notification failed')) });
  assert.equal(rejected.post(s.context, s.room.id, { request_id: 'second', text: 'second' }).sequence, 2);
  await new Promise(resolve => setImmediate(resolve));
  const broken = createEventStore(s.database, { identity: s.identity, rooms: s.rooms, ...s.hooks, id: () => { throw new Error('allocation failed'); }, onChange: () => notifications++ });
  assert.throws(() => broken.post(s.context, s.room.id, { request_id: 'failed', text: 'no' }), /allocation failed/);
  assert.equal(events.head(s.context, s.room.id), 2);
  assert.equal(notifications, 1);
  assert.equal(s.database.db.prepare("SELECT * FROM requests WHERE request_id='failed'").get(), undefined);
  s.database.db.exec(`CREATE TEMP TRIGGER reject_outcome BEFORE INSERT ON requests
    WHEN NEW.request_id='failed-journal' BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END`);
  assert.throws(() => events.post(s.context, s.room.id, { request_id: 'failed-journal', text: 'rollback' }), /injected journal failure/);
  assert.equal(events.head(s.context, s.room.id), 2);
  assert.equal(s.database.db.prepare('SELECT count(*) AS n FROM events').get().n, 2);
  assert.equal(notifications, 1);
  s.database.db.exec('DROP TRIGGER reject_outcome');
  s.database.db.prepare('UPDATE rooms SET next_sequence=? WHERE id=?').run(Number.MAX_SAFE_INTEGER, s.room.id);
  fails(() => events.post(s.context, s.room.id, { request_id: 'overflow', text: 'no' }), 'VALIDATION_ERROR');
  assert.equal(s.database.db.prepare("SELECT * FROM requests WHERE request_id='overflow'").get(), undefined);
  assert.equal(notifications, 1);
});
