import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openDatabase } from '../src/hub/db.js';
import { createIdentityStore } from '../src/hub/identity-store.js';
import { createRoomStore } from '../src/hub/room-store.js';
import { createEventStore } from '../src/hub/event-store.js';
import { createTaskStore } from '../src/hub/task-store.js';
import { Outputs } from '../src/shared/schemas.js';
import { temporaryDirectory } from './helpers/processes.js';

function stores(database, onChange) {
  const identity = createIdentityStore(database, { bootId: 'task-tests' });
  const rooms = createRoomStore(database, { identity });
  const events = createEventStore(database, { identity, rooms });
  return { identity, rooms, events, tasks: createTaskStore(database, { identity, rooms, events, onChange }) };
}
async function fixture(t, onChange) {
  const database = await openDatabase({ filename: ':memory:' }); t.after(() => database.close());
  const s = stores(database, onChange);
  const human = s.identity.browserSession();
  const context = s.identity.authenticate({ cookie: human.token });
  const room = s.rooms.create(context, { name: 'Team tasks', request_id: 'room' });
  const other = s.rooms.create(context, { name: 'Other', request_id: 'other' });
  function agent(name) {
    const session = s.identity.agentSession({ request_id: name, mode: 'create', resume_token: name.repeat(32), name,
      workspace: { path: `/workspace/${name}` } });
    const ctx = s.identity.authenticate({ bearer: session.token });
    s.rooms.join(ctx, room.id, { request_id: 'join' });
    return { participant: session.participant, context: ctx };
  }
  return { ...s, database, context, room, other, a: agent('Alice'), b: agent('Bob') };
}

test('task ownership, revisions and mutation retries retain one task and one milestone per change', async t => {
  let notifications = 0;
  const s = await fixture(t, () => notifications++);
  const source = s.events.post(s.context, s.room.id, { request_id: 'question', text: 'Can we reproduce the retry race?' });
  const input = { request_id: 'create', title: 'Reproduce retry race', scope: 'Test response loss only.', source_message_id: source.id };
  const created = s.tasks.create(s.a.context, s.room.id, input);
  Outputs.taskMutation.parse(created);
  assert.equal(created.task.status, 'proposed'); assert.equal(created.task.owner, null);
  assert.equal(created.event.payload.reply_to, source.id);
  assert.deepEqual(s.tasks.create(s.a.context, s.room.id, input), created);
  assert.equal(notifications, 1);
  assert.throws(() => s.tasks.create(s.a.context, s.room.id, { ...input, title: 'Changed' }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  const claimInput = { request_id: 'claim', task_id: created.task.id, expected_version: 1 };
  const claimed = s.tasks.claim(s.a.context, s.room.id, claimInput);
  assert.equal(claimed.task.owner.id, s.a.participant.id); assert.equal(claimed.task.version, 2);
  assert.deepEqual(claimed.task.owner.workspace, { path: '/workspace/Alice' });
  assert.throws(() => s.tasks.claim(s.b.context, s.room.id, claimInput), error => error.code === 'TASK_CLAIMED');
  const update = { request_id: 'report', task_id: created.task.id, expected_version: 2,
    status: 'in_review', latest_update: 'Peer review requested for timeout handling.', worker_ref: 'worker-actual-42',
    result: 'Reproduced the lost response; retry stored one event. Ran node --test test/retry.test.js.' };
  const reported = s.tasks.update(s.a.context, s.room.id, update);
  assert.equal(reported.task.version, 3); assert.equal(reported.task.worker_ref, 'worker-actual-42');
  assert.deepEqual(s.tasks.update(s.a.context, s.room.id, update), reported);
  assert.deepEqual(s.tasks.claim(s.a.context, s.room.id, claimInput), claimed); // Stable result even after later work.
  assert.equal(notifications, 3);
  assert.equal(s.events.head(s.context, s.room.id), 4);
  assert.deepEqual(s.tasks.list(s.b.context, s.room.id).tasks, [reported.task]);
  Outputs.tasks.parse(s.tasks.list(s.b.context, s.room.id));
});

test('task writes enforce membership, source room, ownership, versions and evidence before final states', async t => {
  const s = await fixture(t);
  const foreign = s.events.post(s.context, s.other.id, { request_id: 'foreign', text: 'Other room' });
  assert.throws(() => s.tasks.create(s.a.context, s.room.id, { request_id: 'bad', title: 'No', scope: 'No', source_message_id: foreign.id }), error => error.code === 'VALIDATION_ERROR');
  assert.throws(() => s.tasks.list(s.a.context, s.other.id));
  const { task } = s.tasks.create(s.a.context, s.room.id, { request_id: 'create', title: 'Bounded test', scope: 'Scope' });
  assert.throws(() => s.tasks.claim(s.a.context, s.room.id, { request_id: 'spoof', task_id: task.id, expected_version: 1, owner_id: s.b.participant.id }), error => error.code === 'VALIDATION_ERROR');
  s.tasks.claim(s.a.context, s.room.id, { request_id: 'claim', task_id: task.id, expected_version: 1 });
  const update = { request_id: 'update', task_id: task.id, expected_version: 2, status: 'in_progress', latest_update: 'Checking' };
  assert.throws(() => s.tasks.update(s.b.context, s.room.id, update), error => error.code === 'TASK_NOT_OWNER');
  assert.throws(() => s.tasks.update(s.context, s.other.id, update), error => error.code === 'TASK_NOT_FOUND');
  assert.throws(() => s.tasks.update(s.a.context, s.room.id, { ...update, expected_version: 1 }), error => error.code === 'TASK_CONFLICT');
  for (const status of ['in_review', 'completed']) assert.throws(() => s.tasks.update(s.a.context, s.room.id, { ...update, status }), error => error.code === 'VALIDATION_ERROR');
  assert.equal(s.events.head(s.context, s.room.id), 2);
  const blocked = s.tasks.update(s.a.context, s.room.id, { ...update, status: 'blocked', latest_update: 'Waiting for a fixture.' });
  assert.equal(blocked.task.status, 'blocked');
  assert.throws(() => s.tasks.update(s.a.context, s.room.id, { ...update, request_id: 'blocked-done', expected_version: 3, status: 'completed', result: 'Claim' }), error => error.code === 'TASK_TRANSITION');
  const resumed = s.tasks.update(s.a.context, s.room.id, { ...update, request_id: 'resume', expected_version: 3, worker_ref: null });
  const done = s.tasks.update(s.a.context, s.room.id, { ...update, request_id: 'finish', expected_version: resumed.task.version,
    status: 'completed', result: 'Ran the fixture, 2 assertions passed.' });
  assert.throws(() => s.tasks.update(s.a.context, s.room.id, { ...update, request_id: 'restart', expected_version: done.task.version }), error => error.code === 'TASK_TRANSITION');
  const membership = s.rooms.requireMembership(s.a.context, s.room.id);
  s.rooms.leave(s.a.context, s.room.id, { request_id: 'leave', membership_epoch: membership.epoch });
  assert.throws(() => s.tasks.list(s.a.context, s.room.id));
  assert.equal(s.tasks.list(s.context, s.room.id).tasks[0].status, 'completed');
});

test('failure after task and event writes rolls both back and does not emit a wakeup', async t => {
  let notifications = 0;
  const s = await fixture(t, () => notifications++);
  const { task } = s.tasks.create(s.a.context, s.room.id, { request_id: 'create', title: 'Atomic work', scope: 'Check commits' });
  s.database.db.exec(`CREATE TRIGGER fail_task_journal BEFORE INSERT ON requests WHEN NEW.operation='claimTask'
    BEGIN SELECT RAISE(ABORT, 'test journal failure'); END`);
  const claim = { request_id: 'claim', task_id: task.id, expected_version: 1 };
  assert.throws(() => s.tasks.claim(s.a.context, s.room.id, claim), /test journal failure/);
  assert.equal(s.events.head(s.context, s.room.id), 1); assert.equal(notifications, 1);
  assert.deepEqual(s.tasks.list(s.context, s.room.id).tasks, [task]);
  s.database.db.exec('DROP TRIGGER fail_task_journal');
  assert.equal(s.tasks.claim(s.a.context, s.room.id, claim).task.version, 2);
  assert.equal(notifications, 2);
});

test('v2 upgrade preserves messages; tasks, versions and exact retry results survive reopening', async t => {
  const directory = await temporaryDirectory(t), filename = join(directory, 'hub.sqlite'), migrationsDir = join(directory, 'old');
  await mkdir(migrationsDir);
  for (const name of ['001-foundation', '002-mentions']) await writeFile(join(migrationsDir, `${name}.mjs`), await readFile(new URL(`../src/hub/migrations/${name}.js`, import.meta.url)));
  const old = await openDatabase({ filename, migrationsDir }); t.after(() => old.close());
  const before = stores(old); const human = before.identity.browserSession(); const context = before.identity.authenticate({ cookie: human.token });
  const room = before.rooms.create(context, { request_id: 'room', name: 'Preserved room' });
  const message = before.events.post(context, room.id, { request_id: 'message', text: 'Existing discussion' });
  old.close();
  const next = await openDatabase({ filename }); t.after(() => next.close());
  const s = stores(next);
  assert.deepEqual(s.events.history(context, room.id).events, [message]);
  assert.deepEqual(s.tasks.list(context, room.id).tasks, []);
  const input = { request_id: 'new-task', title: 'Resume task', scope: 'Check persisted results.', source_message_id: message.id };
  const result = s.tasks.create(context, room.id, input);
  next.close();
  const reopened = await openDatabase({ filename }); t.after(() => reopened.close());
  const after = stores(reopened);
  assert.deepEqual(after.tasks.list(context, room.id).tasks, [result.task]);
  assert.deepEqual(after.tasks.create(context, room.id, input), result);
  assert.deepEqual(after.events.history(context, room.id).events, [message, result.event]);
});
