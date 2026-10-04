import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openDatabase } from '../src/hub/db.js';
import { createIdentityStore } from '../src/hub/identity-store.js';
import { createRoomStore } from '../src/hub/room-store.js';
import { createMutationStore } from '../src/hub/mutation-store.js';
import { ApiError } from '../src/shared/protocol.js';
import { Outputs, Participant, Membership } from '../src/shared/schemas.js';
import { temporaryDirectory } from './helpers/processes.js';

const timestamp = '2026-09-27T00:00:00.000Z';
const enrollment = (request_id = 'enroll', overrides = {}) => ({ request_id, mode: 'create', resume_token: 's'.repeat(32), name: 'Agent', ...overrides });
const errorCode = (fn, code, status = 409) => assert.throws(fn, error => {
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  assert.equal(error.details, undefined);
  return true;
});
async function setup(t) {
  const filename = join(await temporaryDirectory(t), 'hub.sqlite');
  let counter = 0;
  const hooks = { id: () => `id-${String(++counter).padStart(4, '0')}`, now: () => timestamp };
  const state = { filename };
  state.open = async (bootId = 'boot1') => {
    state.database = await openDatabase({ filename });
    t.after(() => state.database.close());
    state.identity = createIdentityStore(state.database, { bootId, ...hooks });
    state.rooms = createRoomStore(state.database, { identity: state.identity, ...hooks });
  };
  await state.open();
  return state;
}

test('browser and agent enrollment share one durable owner regardless of ordering', async t => {
  for (const browserFirst of [true, false]) {
    const s = await setup(t);
    const before = browserFirst ? s.identity.browserSession() : null;
    const agent = Outputs.agentSession.parse(s.identity.agentSession(enrollment()));
    const browser = s.identity.browserSession();
    Outputs.browserSession.parse({ participant: browser.participant });
    assert.equal(browser.participant.name, 'You');
    assert.equal(browser.participant.owner_id, agent.participant.owner_id);
    if (before) assert.deepEqual(before, browser);
    assert.deepEqual(s.identity.browserSession(), browser);
    assert.equal(s.database.db.prepare('SELECT count(*) AS n FROM owners').get().n, 1);
    const context = s.identity.authenticate({ cookie: browser.token });
    assert.deepEqual(s.identity.disconnect(context), { ok: true });
    assert.deepEqual(s.identity.authenticate({ cookie: browser.token }), context);
    errorCode(() => s.identity.authenticate({ bearer: 'invalid', cookie: browser.token }), 'UNAUTHENTICATED', 401);
    s.database.close();
    await s.open('boot2');
    assert.deepEqual(s.identity.browserSession(), browser);
    assert.deepEqual(s.identity.authenticate({ cookie: browser.token }), context);
    assert.equal(s.identity.getParticipant('missing'), null);
  }
});

test('issuance retries normalize input, fence replacement and expiry, and preserve private credentials', async t => {
  const s = await setup(t);
  const initialInput = enrollment('enroll', { name: ' Agent ' });
  const initial = s.identity.agentSession(initialInput);
  const context = s.identity.authenticate({ bearer: initial.token });
  assert.deepEqual(s.identity.agentSession(enrollment('enroll', { runtime: 'unknown', workspace: null, context: '' })), initial);
  errorCode(() => s.identity.agentSession(enrollment('enroll', { name: 'Other' })), 'IDEMPOTENCY_CONFLICT');
  errorCode(() => s.identity.agentSession(enrollment('enroll', { mode: 'resume' })), 'IDEMPOTENCY_CONFLICT');
  errorCode(() => s.identity.agentSession(enrollment('new-create')), 'SESSION_EXISTS');
  errorCode(() => s.identity.agentSession(enrollment('unknown', { mode: 'resume', resume_token: 'u'.repeat(32) })), 'UNAUTHENTICATED', 401);
  const sameName = s.identity.agentSession(enrollment('other', { resume_token: 't'.repeat(32) }));
  assert.notEqual(sameName.participant.id, initial.participant.id);
  const resumeInput = enrollment('resume', { mode: 'resume', name: 'Renamed', workspace: { path: '/project', branch: 'main' }, context: 'work' });
  const resumed = Outputs.agentSession.parse(s.identity.agentSession(resumeInput));
  assert.equal(resumed.participant.id, initial.participant.id);
  assert.equal(resumed.connection.generation, initial.connection.generation + 1);
  assert.notEqual(resumed.token, initial.token);
  assert.equal(resumed.participant.name, 'Renamed');
  errorCode(() => s.identity.assertCurrent(context), 'SESSION_REPLACED');
  errorCode(() => s.identity.authenticate({ bearer: initial.token }), 'SESSION_REPLACED');
  errorCode(() => s.identity.agentSession(initialInput), 'SESSION_REPLACED');
  assert.deepEqual(s.identity.agentSession(resumeInput), resumed);
  const current = s.identity.authenticate({ bearer: resumed.token });
  // Only stored identity fields authorize; a cached descriptive name is not authoritative.
  assert.equal(s.identity.assertCurrent({ ...current, participant: { ...current.participant, name: 'Spoof' } }).name, 'Renamed');
  errorCode(() => s.identity.assertCurrent({ ...current, participant: { ...current.participant, owner_id: 'fake' } }), 'UNAUTHENTICATED', 401);
  const publicJson = JSON.stringify([current, resumed.participant]);
  for (const privateValue of [initialInput.resume_token, resumed.token, 'resume_hash', 'token_hash']) assert.ok(!publicJson.includes(privateValue));
  const stored = s.database.db.prepare('SELECT payload_json FROM session_requests WHERE request_id=?').get('enroll').payload_json;
  assert.ok(!stored.includes(initialInput.resume_token));
  assert.ok(!resumed.token.startsWith('id-'));
  s.identity.disconnect(current);
  errorCode(() => s.identity.agentSession(resumeInput), 'SESSION_EXPIRED', 401);
  errorCode(() => s.identity.assertCurrent(current), 'SESSION_EXPIRED', 401);
  const next = s.identity.agentSession({ ...resumeInput, request_id: 'resume-after-close' });
  s.identity.disconnect(s.identity.authenticate({ bearer: next.token }));
  errorCode(() => s.identity.agentSession({ ...resumeInput, request_id: 'resume-after-close' }), 'SESSION_EXPIRED', 401);
});

test('closed create issuance never replays a dead token and validation errors redact input', async t => {
  const s = await setup(t);
  const created = s.identity.agentSession(enrollment());
  s.identity.disconnect(s.identity.authenticate({ bearer: created.token }));
  errorCode(() => s.identity.agentSession(enrollment()), 'SESSION_EXPIRED', 401);
  Outputs.agentSession.parse(s.identity.agentSession(enrollment('resume', { mode: 'resume' })));
  errorCode(() => s.identity.agentSession({ ...enrollment(), name: '', unexpected: 'secret-input' }), 'VALIDATION_ERROR', 400);
  assert.throws(() => createIdentityStore(s.database, { bootId: '' }), /bootId/);
});

test('room creation is atomic, owner scoped, sorted, and single-active-room for agents', async t => {
  const s = await setup(t);
  const browser = s.identity.browserSession();
  const human = s.identity.authenticate({ cookie: browser.token });
  const agent = s.identity.agentSession(enrollment());
  const context = s.identity.authenticate({ bearer: agent.token });
  assert.deepEqual(s.rooms.list(context), { rooms: [] });
  const first = Outputs.createRoom.parse(s.rooms.create(context, { request_id: 'create', name: ' First ' }));
  assert.deepEqual(s.rooms.create(context, { request_id: 'create', name: 'First', goal: '' }), first);
  const member = Membership.parse(s.rooms.requireMembership(context, first.id));
  assert.equal(member.joined_sequence, 0);
  const roomCount = s.database.db.prepare('SELECT count(*) AS n FROM rooms').get().n;
  errorCode(() => s.rooms.create(context, { request_id: 'failed', name: 'Second' }), 'ACTIVE_ROOM_CONFLICT');
  assert.equal(s.database.db.prepare('SELECT count(*) AS n FROM rooms').get().n, roomCount);
  assert.equal(s.database.db.prepare("SELECT * FROM requests WHERE request_id='failed'").get(), undefined);
  const second = s.rooms.create(human, { request_id: 'second', name: 'Second' });
  errorCode(() => s.rooms.join(context, second.id, { request_id: 'join-second' }), 'ACTIVE_ROOM_CONFLICT');
  errorCode(() => s.rooms.create(human, { request_id: 'duplicate-name', name: 'First' }), 'ROOM_NAME_CONFLICT');
  s.rooms.join(human, first.id, { request_id: 'join-first' });
  assert.deepEqual(Outputs.rooms.parse(s.rooms.list(human)).rooms, [first, second]);
  const members = s.rooms.listMembers(human, first.id);
  assert.equal(members.length, 2);
  assert.deepEqual(members.map(item => item.participant.id), members.map(item => item.participant.id).sort());
  for (const item of members) { Participant.parse(item.participant); Membership.parse(item.membership); }
  assert.deepEqual(s.rooms.get(context, second.id), second);
  errorCode(() => s.rooms.requireMembership(context, second.id), 'FORBIDDEN', 403);
  errorCode(() => s.rooms.listMembers(context, second.id), 'FORBIDDEN', 403);
  errorCode(() => s.rooms.get(context, 'missing'), 'NOT_FOUND', 404);
  errorCode(() => s.rooms.create(human, { request_id: 'invalid', name: ' ' }), 'VALIDATION_ERROR', 400);
  s.database.db.exec("INSERT INTO owners VALUES ('foreign','Foreign','2026-09-28T00:00:00.000Z')");
  s.database.db.exec("INSERT INTO participants VALUES ('foreign-human','foreign','human','Foreign',NULL,NULL,'','2026-09-28T00:00:00.000Z')");
  const foreign = { participant: s.identity.getParticipant('foreign-human'), connection_id: null, generation: 0, kind: 'human' };
  errorCode(() => s.rooms.get(foreign, first.id), 'FORBIDDEN', 403);
  errorCode(() => s.rooms.list(foreign), 'FORBIDDEN', 403);
});

test('join snapshots, progress and pending batches survive duplicates/resume; leave and rejoin fence epochs', async t => {
  const s = await setup(t);
  const agent = s.identity.agentSession(enrollment());
  let context = s.identity.authenticate({ bearer: agent.token });
  const room = s.rooms.create(context, { request_id: 'create', name: 'Room' });
  const joined = s.rooms.join(context, room.id, { request_id: 'join' });
  const epoch = joined.membership.epoch;
  s.database.transaction(() => {
    s.database.db.prepare('INSERT INTO events (id,room_id,sequence,author_id,author_name,author_kind,text,reply_to,created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('event1', room.id, 1, agent.participant.id, 'Agent', 'agent', 'message', null, timestamp);
    s.database.db.prepare('UPDATE rooms SET next_sequence=2 WHERE id=?').run(room.id);
    s.database.db.prepare('UPDATE memberships SET paused=1 WHERE room_id=? AND participant_id=?').run(room.id, agent.participant.id);
    s.database.db.prepare('INSERT INTO batches VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('batch1', room.id, agent.participant.id, epoch, 1, '[]', 'pending', timestamp);
  });
  assert.deepEqual(s.rooms.join(context, room.id, { request_id: 'join' }), joined);
  const fresh = s.rooms.join(context, room.id, { request_id: 'fresh-join' });
  assert.equal(fresh.head_sequence, 1);
  assert.equal(fresh.membership.epoch, epoch);
  assert.equal(fresh.membership.paused, true);
  assert.equal(fresh.membership.acknowledged_sequence, 0);
  s.database.close();
  await s.open('boot2');
  errorCode(() => s.identity.authenticate({ bearer: agent.token }), 'SESSION_EXPIRED', 401);
  errorCode(() => s.identity.agentSession(enrollment()), 'SESSION_EXPIRED', 401);
  errorCode(() => s.rooms.create(context, { request_id: 'create', name: 'Room' }), 'SESSION_EXPIRED', 401);
  const resumed = s.identity.agentSession(enrollment('resume', { mode: 'resume' }));
  errorCode(() => s.rooms.join(context, room.id, { request_id: 'join' }), 'SESSION_REPLACED');
  context = s.identity.authenticate({ bearer: resumed.token });
  assert.deepEqual(s.rooms.create(context, { request_id: 'create', name: 'Room' }), room);
  assert.deepEqual(s.rooms.join(context, room.id, { request_id: 'join' }), joined);
  assert.equal(s.database.db.prepare("SELECT status FROM batches WHERE id='batch1'").get().status, 'pending');
  const leaveInput = { request_id: 'leave', membership_epoch: epoch };
  const left = Outputs.leaveRoom.parse(s.rooms.leave(context, room.id, leaveInput));
  assert.deepEqual(s.rooms.leave(context, room.id, leaveInput), left);
  assert.equal(s.database.db.prepare("SELECT status FROM batches WHERE id='batch1'").get().status, 'invalidated');
  errorCode(() => s.rooms.leave(context, room.id, { ...leaveInput, request_id: 'different-leave' }), 'FORBIDDEN', 403);
  errorCode(() => s.rooms.join(context, room.id, { request_id: 'join' }), 'MEMBERSHIP_ENDED');
  errorCode(() => s.rooms.create(context, { request_id: 'create', name: 'Room' }), 'MEMBERSHIP_ENDED');
  s.database.close();
  await s.open('boot2');
  assert.deepEqual(s.rooms.leave(context, room.id, leaveInput), left);
  const rejoined = s.rooms.join(context, room.id, { request_id: 'rejoin' });
  assert.notEqual(rejoined.membership.epoch, epoch);
  assert.equal(rejoined.membership.joined_sequence, 1);
  assert.equal(rejoined.membership.acknowledged_sequence, 1);
  assert.equal(rejoined.membership.paused, false);
  errorCode(() => s.rooms.leave(context, room.id, leaveInput), 'MEMBERSHIP_ENDED');
  errorCode(() => s.rooms.leave(context, room.id, { ...leaveInput, request_id: 'stale-leave' }), 'MEMBERSHIP_ENDED');
  errorCode(() => s.rooms.requireMembership(context, room.id, { epoch }), 'MEMBERSHIP_ENDED');
  assert.equal(s.rooms.requireMembership(context, room.id).epoch, rejoined.membership.epoch);
  assert.equal(s.database.db.prepare("SELECT membership_epoch FROM batches WHERE id='batch1'").get().membership_epoch, epoch);
});

test('durable journal rejects reuse across operation, room and payload without overwriting outcomes', async t => {
  const s = await setup(t);
  const browser = s.identity.browserSession();
  const context = s.identity.authenticate({ cookie: browser.token });
  const room = s.rooms.create(context, { request_id: 'first', name: 'Room' });
  const other = s.rooms.create(context, { request_id: 'other', name: 'Other' });
  errorCode(() => s.rooms.create(context, { request_id: 'first', name: 'Different' }), 'IDEMPOTENCY_CONFLICT');
  errorCode(() => s.rooms.join(context, room.id, { request_id: 'first' }), 'IDEMPOTENCY_CONFLICT');
  const joined = s.rooms.join(context, room.id, { request_id: 'join' });
  errorCode(() => s.rooms.join(context, other.id, { request_id: 'join' }), 'IDEMPOTENCY_CONFLICT');
  const journal = createMutationStore(s.database);
  const key = { participantId: browser.participant.id, requestId: 'journal', operation: 'test', roomId: room.id, payload: { z: 2, a: { y: 1, x: 0 }, request_id: 'excluded' } };
  s.database.transaction(() => {
    assert.deepEqual(journal.lookup(key), { found: false });
    journal.record(key, { a: 1, b: 2 });
    journal.record({ ...key, payload: { a: { x: 0, y: 1 }, z: 2 } }, { b: 2, a: 1 });
    errorCode(() => journal.record(key, { a: 3 }), 'IDEMPOTENCY_CONFLICT');
  });
  s.database.close();
  await s.open('boot2');
  assert.deepEqual(s.rooms.join(context, room.id, { request_id: 'join' }), joined);
  assert.deepEqual(createMutationStore(s.database).lookup(key), { found: true, result: { a: 1, b: 2 } });
  errorCode(() => s.rooms.create(context, { request_id: 'first', name: 'Different' }), 'IDEMPOTENCY_CONFLICT');
});
