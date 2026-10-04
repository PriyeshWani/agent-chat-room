import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDatabase } from '../src/hub/db.js';
import { createIdentityStore } from '../src/hub/identity-store.js';
import { createRoomStore } from '../src/hub/room-store.js';
import { createEventStore } from '../src/hub/event-store.js';
import { createDeliveryStore } from '../src/hub/delivery-store.js';
import { Outputs } from '../src/shared/schemas.js';
import { temporaryDirectory } from './helpers/processes.js';

const fails = (fn, code) => assert.throws(fn, error => error.code === code && error.details === undefined);
const ackInput = (batch, request_id) => ({ request_id, batch_id: batch.id, membership_epoch: batch.membership_epoch });
async function setup(t) {
  const filename = join(await temporaryDirectory(t), 'delivery.sqlite');
  let counter = 0;
  const hooks = { id: () => `id-${++counter}`, now: () => '2026-09-27T00:00:00.000Z' };
  async function open(bootId = 'boot') {
    const database = await openDatabase({ filename });
    t.after(() => database.close());
    const identity = createIdentityStore(database, { bootId, ...hooks });
    const rooms = createRoomStore(database, { identity, ...hooks });
    const events = createEventStore(database, { identity, rooms, ...hooks });
    const delivery = createDeliveryStore(database, { identity, rooms, events, ...hooks });
    return { database, identity, rooms, events, delivery };
  }
  const s = await open();
  const browser = s.identity.browserSession();
  const human = s.identity.authenticate({ cookie: browser.token });
  const room = s.rooms.create(human, { request_id: 'room', name: 'Room' });
  const agents = ['a', 'b'].map(name => {
    const input = { mode: 'create', request_id: 'enroll', resume_token: name.repeat(32), name };
    const session = s.identity.agentSession(input);
    const context = s.identity.authenticate({ bearer: session.token });
    s.rooms.join(context, room.id, { request_id: 'join' });
    return { input, session, context };
  });
  return { ...s, human, room, agents, open };
}

test('agents progress independently, raw limits include self, and old ack results never reduce progress', async t => {
  const s = await setup(t);
  const [a, b] = s.agents.map(agent => agent.context);
  const one = s.events.post(s.human, s.room.id, { request_id: 'one', text: 'one' });
  s.events.post(a, s.room.id, { request_id: 'two', text: 'self' });
  const three = s.events.post(b, s.room.id, { request_id: 'three', text: 'three' });
  const aFirst = Outputs.receive.parse(s.delivery.receive(a, s.room.id, { limit: 2 })).batch;
  assert.deepEqual(aFirst.events, [one]);
  assert.equal(aFirst.scanned_through, 2);
  assert.equal(s.rooms.requireMembership(a, s.room.id).acknowledged_sequence, 0);
  const bFirst = s.delivery.receive(b, s.room.id).batch;
  assert.deepEqual(bFirst.events.map(event => event.sequence), [1, 2]);
  assert.equal(bFirst.scanned_through, 3);
  const firstAck = Outputs.ack.parse(s.delivery.ack(a, s.room.id, ackInput(aFirst, 'ack1')));
  assert.equal(firstAck.acknowledged_through, 2);
  assert.equal(s.rooms.requireMembership(b, s.room.id).acknowledged_sequence, 0);
  const aSecond = s.delivery.receive(a, s.room.id).batch;
  assert.deepEqual(aSecond.events, [three]);
  s.delivery.ack(a, s.room.id, ackInput(aSecond, 'ack2'));
  assert.equal(s.rooms.requireMembership(a, s.room.id).acknowledged_sequence, 3);
  assert.deepEqual(s.delivery.ack(a, s.room.id, ackInput(aFirst, 'ack1')), firstAck);
  assert.deepEqual(s.delivery.ack(a, s.room.id, ackInput(aFirst, 'ack-old-new-id')), firstAck);
  assert.equal(s.rooms.requireMembership(a, s.room.id).acknowledged_sequence, 3);
  fails(() => s.delivery.ack(a, s.room.id, ackInput(aSecond, 'ack1')), 'IDEMPOTENCY_CONFLICT');
  s.delivery.ack(b, s.room.id, ackInput(bFirst, 'ack1'));
  assert.deepEqual(Outputs.receive.parse(s.delivery.receive(a, s.room.id)), { kind: 'timeout', room_id: s.room.id, acknowledged_through: 3 });
  assert.equal(s.database.db.prepare('SELECT count(*) AS n FROM batches').get().n, 3);
});

test('pending snapshots replay exactly across writes, independent connections, pause, reopen and generation replacement', async t => {
  const s = await setup(t);
  const a = s.agents[0];
  s.events.post(s.human, s.room.id, { request_id: 'one', text: 'one' });
  const initial = s.delivery.receive(a.context, s.room.id, { limit: 1 });
  assert.equal(typeof initial.then, 'undefined');
  s.events.post(s.human, s.room.id, { request_id: 'two', text: 'two' });
  assert.deepEqual(s.delivery.receive(a.context, s.room.id, { limit: 100 }), initial);
  const other = await s.open();
  assert.deepEqual(other.delivery.receive(a.context, s.room.id), initial);
  s.database.db.prepare('UPDATE memberships SET paused=1 WHERE room_id=? AND participant_id=?').run(s.room.id, a.session.participant.id);
  assert.deepEqual(s.delivery.receive(a.context, s.room.id), initial);
  s.database.close();
  other.database.close();
  const reopened = await s.open('next-boot');
  fails(() => reopened.delivery.receive(a.context, s.room.id), 'SESSION_EXPIRED');
  const resumed = reopened.identity.agentSession({ ...a.input, mode: 'resume', request_id: 'resume' });
  const current = reopened.identity.authenticate({ bearer: resumed.token });
  fails(() => reopened.delivery.receive(a.context, s.room.id), 'SESSION_REPLACED');
  fails(() => reopened.delivery.ack(a.context, s.room.id, ackInput(initial.batch, 'ack')), 'SESSION_REPLACED');
  assert.deepEqual(reopened.delivery.receive(current, s.room.id), initial);
  reopened.delivery.ack(current, s.room.id, ackInput(initial.batch, 'ack'));
  assert.deepEqual(reopened.delivery.receive(current, s.room.id), { kind: 'timeout', room_id: s.room.id, acknowledged_through: 1 });
  reopened.database.db.prepare('UPDATE memberships SET paused=0 WHERE room_id=? AND participant_id=?').run(s.room.id, a.session.participant.id);
  const next = reopened.delivery.receive(current, s.room.id).batch;
  assert.deepEqual(next.events.map(event => event.sequence), [2]);
  assert.notEqual(next.id, initial.batch.id);
});

test('self-only progress creates an empty durable batch while idle and paused receives create nothing', async t => {
  const s = await setup(t);
  const a = s.agents[0].context;
  assert.equal(s.delivery.receive(a, s.room.id).kind, 'timeout');
  assert.equal(s.database.db.prepare('SELECT count(*) AS n FROM batches').get().n, 0);
  s.events.post(a, s.room.id, { request_id: 'self', text: 'self' });
  const received = Outputs.receive.parse(s.delivery.receive(a, s.room.id));
  assert.equal(received.kind, 'batch');
  assert.deepEqual(received.batch.events, []);
  assert.equal(received.batch.scanned_through, 1);
  assert.equal(s.rooms.requireMembership(a, s.room.id).acknowledged_sequence, 0);
  s.delivery.ack(a, s.room.id, ackInput(received.batch, 'ack'));
  assert.equal(s.rooms.requireMembership(a, s.room.id).acknowledged_sequence, 1);
  s.database.db.prepare('UPDATE memberships SET paused=1 WHERE room_id=? AND participant_id=?').run(s.room.id, a.participant.id);
  s.events.post(s.human, s.room.id, { request_id: 'new', text: 'new' });
  assert.deepEqual(s.delivery.receive(a, s.room.id), { kind: 'timeout', room_id: s.room.id, acknowledged_through: 1 });
  assert.equal(s.database.db.prepare('SELECT count(*) AS n FROM batches').get().n, 1);
});

test('unknown, foreign, invalidated and ended-epoch acks fail without changing the active epoch', async t => {
  const s = await setup(t);
  const [a, b] = s.agents.map(agent => agent.context);
  s.events.post(s.human, s.room.id, { request_id: 'one', text: 'one' });
  const first = s.delivery.receive(a, s.room.id).batch;
  const foreign = s.delivery.receive(b, s.room.id).batch;
  fails(() => s.delivery.ack(a, s.room.id, { ...ackInput(first, 'unknown'), batch_id: 'missing' }), 'INVALID_ACK');
  fails(() => s.delivery.ack(a, s.room.id, ackInput(foreign, 'foreign')), 'MEMBERSHIP_ENDED');
  fails(() => s.delivery.ack(a, s.room.id, { ...ackInput(first, 'foreign-current'), batch_id: foreign.id }), 'INVALID_ACK');
  fails(() => s.delivery.ack(a, s.room.id, ackInput(first, 'join')), 'IDEMPOTENCY_CONFLICT');
  fails(() => s.delivery.receive(s.human, s.room.id), 'FORBIDDEN');
  fails(() => s.delivery.ack(s.human, s.room.id, ackInput(first, 'human')), 'FORBIDDEN');
  for (const input of [{ limit: 0 }, { limit: 101 }, { limit: 1.1 }, { wait_ms: 1 }]) fails(() => s.delivery.receive(a, s.room.id, input), 'VALIDATION_ERROR');
  fails(() => s.delivery.ack(a, s.room.id, { ...ackInput(first, 'arbitrary'), sequence: 100 }), 'VALIDATION_ERROR');
  s.database.db.prepare("UPDATE batches SET status='invalidated' WHERE id=?").run(first.id);
  fails(() => s.delivery.ack(a, s.room.id, ackInput(first, 'invalidated')), 'INVALID_ACK');
  const replacement = s.delivery.receive(a, s.room.id).batch;
  const acked = s.delivery.ack(a, s.room.id, ackInput(replacement, 'ack'));
  s.events.post(s.human, s.room.id, { request_id: 'two', text: 'two' });
  const pending = s.delivery.receive(a, s.room.id).batch;
  s.rooms.leave(a, s.room.id, { request_id: 'leave', membership_epoch: first.membership_epoch });
  assert.equal(s.database.db.prepare('SELECT status FROM batches WHERE id=?').get(pending.id).status, 'invalidated');
  s.rooms.join(a, s.room.id, { request_id: 'rejoin' });
  const current = s.rooms.requireMembership(a, s.room.id);
  fails(() => s.delivery.ack(a, s.room.id, ackInput(replacement, 'ack')), 'MEMBERSHIP_ENDED');
  fails(() => s.delivery.ack(a, s.room.id, { ...ackInput(pending, 'old-batch'), membership_epoch: current.epoch }), 'MEMBERSHIP_ENDED');
  assert.equal(current.acknowledged_sequence, 2);
  assert.equal(acked.acknowledged_through, 1);
  assert.equal(s.rooms.requireMembership(a, s.room.id).acknowledged_sequence, 2);
});

test('ack journal failure rolls back both batch state and cursor; successful ack survives reopen', async t => {
  const s = await setup(t);
  const a = s.agents[0].context;
  s.events.post(s.human, s.room.id, { request_id: 'one', text: 'one' });
  const batch = s.delivery.receive(a, s.room.id).batch;
  s.database.db.exec(`CREATE TEMP TRIGGER reject_ack BEFORE INSERT ON requests
    WHEN NEW.request_id='ack' BEGIN SELECT RAISE(ABORT, 'injected ack failure'); END`);
  assert.throws(() => s.delivery.ack(a, s.room.id, ackInput(batch, 'ack')), /injected ack failure/);
  assert.equal(s.rooms.requireMembership(a, s.room.id).acknowledged_sequence, 0);
  assert.equal(s.database.db.prepare('SELECT status FROM batches WHERE id=?').get(batch.id).status, 'pending');
  s.database.db.exec('DROP TRIGGER reject_ack');
  const result = s.delivery.ack(a, s.room.id, ackInput(batch, 'ack'));
  s.database.close();
  const reopened = await s.open();
  assert.deepEqual(reopened.delivery.ack(a, s.room.id, ackInput(batch, 'ack')), result);
  assert.deepEqual(reopened.delivery.ack(a, s.room.id, ackInput(batch, 'ack-new')), result);
  assert.equal(reopened.rooms.requireMembership(a, s.room.id).acknowledged_sequence, 1);
});
