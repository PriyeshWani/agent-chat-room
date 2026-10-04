import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventFeed } from '../public/chatroom/event-feed.js';
import * as fixtures from '../src/shared/fixtures.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const event = (sequence, room = fixtures.room, id = `event-${sequence}`) => ({
  ...fixtures.event, id, room_id: room.id, sequence,
  author: { ...fixtures.event.author }, payload: { text: `Message ${sequence}`, reply_to: null },
});
const join = (head = 0, events = [], room = fixtures.room, nextBefore = null) => ({
  room, membership: { ...fixtures.membership, room_id: room.id },
  history: { room, head_sequence: head, events, next_before: nextBefore },
});
function controlledStream() {
  const queued = [], waiting = [];
  let returns = 0;
  function deliver(value) { const waiter = waiting.shift(); if (waiter) value.error ? waiter.reject(value.error) : waiter.resolve(value); else queued.push(value); }
  return {
    next() {
      if (queued.length) { const value = queued.shift(); return value.error ? Promise.reject(value.error) : Promise.resolve(value); }
      const waiter = deferred(); waiting.push(waiter); return waiter.promise;
    },
    return() { returns++; return Promise.resolve({ done: true }); },
    [Symbol.asyncIterator]() { return this; },
    push(value) { deliver({ value, done: false }); },
    end() { deliver({ done: true }); },
    fail(error) { deliver({ error }); },
    get returns() { return returns; },
  };
}
function setup(options = {}) {
  const streams = [], snapshots = [], states = [];
  const client = {
    events(roomId, options) { const stream = controlledStream(); streams.push({ roomId, options, stream }); return stream; },
    ackEvents() { assert.fail('Browser feed must never acknowledge agent batches'); },
    ...options.client,
  };
  const feed = createEventFeed({ client, retryMs: 10, onEvents: events => snapshots.push(events), onState: state => states.push(state), ...options.callbacks });
  return { feed, streams, snapshots, states, client };
}
// Drain only already-scheduled Promise work from controlled iterators. No real
// time passes; timers advance exclusively via the test runner's mock clock.
async function until(predicate) {
  for (let i = 0; i < 50; i++) { if (predicate()) return; await Promise.resolve(); }
  assert.ok(predicate(), 'Controlled async operation did not settle');
}

test('select seeds copied history, opens from its head, and onOpen marks a quiet stream live', async () => {
  const { feed, streams, snapshots } = setup();
  const initial = join(3, [event(3), event(2)]);
  feed.select(initial);
  assert.equal(streams[0].options.after, 3);
  assert.equal(feed.getState().status, 'connecting');
  assert.deepEqual(snapshots.at(-1).map(value => value.sequence), [2, 3]);
  initial.history.events[0].payload.text = 'mutated input';
  snapshots.at(-1)[0].author.name = 'mutated callback';
  streams[0].options.onOpen(); assert.equal(feed.getState().status, 'live');
  streams[0].stream.push(event(4));
  await until(() => snapshots.at(-1).length === 3);
  assert.equal(snapshots.at(-1)[1].payload.text, 'Message 3');
  assert.equal(snapshots.at(-1)[0].author.name, fixtures.event.author.name);
  feed.destroy();
});

test('confirmed add does not skip unseen events when reconnecting after EOF', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { feed, streams, snapshots } = setup(); t.after(() => feed.destroy());
  feed.select(join(2, [event(2)]));
  feed.add(event(5)); streams[0].stream.push(event(3)); streams[0].stream.end();
  await until(() => feed.getState().status === 'reconnecting');
  t.mock.timers.tick(10); await until(() => streams.length === 2);
  assert.equal(streams[1].options.after, 3);
  streams[1].stream.push(event(4)); streams[1].stream.push(event(5)); streams[1].stream.end();
  await until(() => feed.getState().status === 'reconnecting' && snapshots.at(-1).length === 4);
  assert.deepEqual(snapshots.at(-1).map(value => value.sequence), [2, 3, 4, 5]);
  t.mock.timers.tick(10); await until(() => streams.length === 3);
  assert.equal(streams[2].options.after, 5);
});

test('gaps close the old iterator and replay from last contiguous stream sequence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { feed, streams, snapshots } = setup(); t.after(() => feed.destroy());
  feed.select(join(2, [event(2)]));
  streams[0].stream.push(event(4));
  await until(() => feed.getState().status === 'reconnecting');
  assert.equal(feed.getState().error.code, 'EVENT_GAP');
  assert.equal(streams[0].options.signal.aborted, true);
  assert.equal(streams[0].stream.returns, 1);
  t.mock.timers.tick(10); await until(() => streams.length === 2);
  assert.equal(streams[1].options.after, 2);
  streams[1].stream.push(event(3)); streams[1].stream.push(event(4)); streams[1].stream.push(event(5)); streams[1].stream.end();
  await until(() => snapshots.at(-1).length === 4 && feed.getState().status === 'reconnecting');
  t.mock.timers.tick(10); await until(() => streams.length === 3);
  assert.equal(streams[2].options.after, 5);
  assert.deepEqual(snapshots.at(-1).map(value => value.sequence), [2, 3, 4, 5]);
});

test('duplicate events are idempotent and conflicting sequence identities stop the feed', async () => {
  const { feed, streams, snapshots } = setup();
  feed.select(join(1, [event(1)]));
  feed.add(event(1)); streams[0].stream.push(event(1)); streams[0].stream.push(event(2));
  await until(() => snapshots.at(-1).length === 2);
  assert.deepEqual(snapshots.at(-1).map(value => value.id), ['event-1', 'event-2']);
  streams[0].stream.push(event(2, fixtures.room, 'different-id'));
  await until(() => feed.getState().status === 'error');
  assert.equal(feed.getState().error.code, 'INVALID_RESPONSE');
  feed.destroy();
});

test('room selection cancels old reads and ignores old events, errors and onOpen callbacks', async () => {
  const { feed, streams, snapshots } = setup();
  feed.select(join());
  const old = streams[0];
  feed.select(join(0, [], fixtures.otherRoom));
  assert.equal(old.options.signal.aborted, true);
  old.options.onOpen(); old.stream.push(event(1));
  streams[1].options.onOpen(); streams[1].stream.push(event(1, fixtures.otherRoom));
  await until(() => snapshots.at(-1).length === 1);
  assert.equal(feed.getState().roomId, fixtures.otherRoom.id);
  assert.equal(snapshots.at(-1)[0].room_id, fixtures.otherRoom.id);
  feed.add(event(5)); assert.equal(snapshots.at(-1).length, 1);
  feed.destroy();
});

test('select(null) clears the feed and cancels a pending reconnect timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { feed, streams, snapshots } = setup();
  feed.select(join(1, [event(1)])); streams[0].stream.end();
  await until(() => feed.getState().status === 'reconnecting');
  feed.select(null);
  assert.deepEqual(feed.getState(), { roomId: null, status: 'idle', error: null, nextBefore: null });
  assert.deepEqual(snapshots.at(-1), []);
  t.mock.timers.tick(1000); await Promise.resolve();
  assert.equal(streams.length, 1);
  feed.destroy();
});

test('transient failures retry after the bounded delay and fatal errors never spin', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { feed, streams } = setup(); t.after(() => feed.destroy());
  feed.select(join()); streams[0].stream.fail(Object.assign(Error('offline'), { status: 0, code: 'HUB_UNREACHABLE' }));
  await until(() => feed.getState().status === 'reconnecting');
  t.mock.timers.tick(9); await Promise.resolve(); assert.equal(streams.length, 1);
  t.mock.timers.tick(1); await until(() => streams.length === 2);
  streams[1].stream.fail(Object.assign(Error('expired'), { status: 401, code: 'SESSION_EXPIRED' }));
  await until(() => feed.getState().status === 'error');
  t.mock.timers.tick(1000); await Promise.resolve(); assert.equal(streams.length, 2);
  assert.equal(feed.getState().error.code, 'SESSION_EXPIRED');
});

test('version mismatch is fatal even without HTTP status', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { feed, streams } = setup();
  feed.select(join()); streams[0].stream.fail(Object.assign(Error('version'), { code: 'VERSION_MISMATCH' }));
  await until(() => feed.getState().status === 'error');
  t.mock.timers.tick(1000); await Promise.resolve(); assert.equal(streams.length, 1);
  feed.destroy();
});

test('history pagination merges old events without changing stream cursor or interrupting live events', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = deferred(); const requests = [];
  const { feed, streams, snapshots } = setup({ client: { history: (roomId, options) => { requests.push({ roomId, options }); return page.promise; } } });
  t.after(() => feed.destroy());
  feed.select(join(4, [event(4)], fixtures.room, 4)); streams[0].options.onOpen();
  const older = feed.loadOlder(); assert.equal(feed.loadOlder(), older);
  await until(() => requests.length === 1);
  assert.equal(requests[0].options.before, 4);
  streams[0].stream.push(event(5)); await until(() => snapshots.at(-1).length === 2);
  page.resolve({ room: fixtures.room, events: [event(2), event(3), event(4)], head_sequence: 5, next_before: 2 }); await older;
  assert.deepEqual(snapshots.at(-1).map(value => value.sequence), [2, 3, 4, 5]);
  assert.equal(feed.getState().nextBefore, 2); assert.equal(feed.getState().status, 'live');
  streams[0].stream.end(); await until(() => feed.getState().status === 'reconnecting');
  t.mock.timers.tick(10); await until(() => streams.length === 2);
  assert.equal(streams[1].options.after, 5);
});

test('pagination completion or failure after switching rooms cannot alter the new room', async () => {
  for (const reject of [false, true]) {
    const page = deferred(); let signal;
    const { feed, snapshots } = setup({ client: { history: (_, options) => { signal = options.signal; return page.promise; } } });
    feed.select(join(4, [event(4)], fixtures.room, 4));
    const older = feed.loadOlder(); await until(() => signal);
    feed.select(join(1, [event(1, fixtures.otherRoom)], fixtures.otherRoom));
    assert.equal(signal.aborted, true);
    if (reject) page.reject(Error('obsolete failure'));
    else page.resolve({ room: fixtures.room, events: [event(2)], head_sequence: 4, next_before: 2 });
    await older;
    assert.equal(feed.getState().error, null);
    assert.equal(feed.getState().nextBefore, null);
    assert.equal(snapshots.at(-1)[0].room_id, fixtures.otherRoom.id);
    feed.destroy();
  }
});

test('history errors retain current events and allow an explicit retry', async () => {
  let calls = 0;
  const { feed, snapshots } = setup({ client: { history: async () => {
    if (++calls === 1) throw Error('History unavailable');
    return { room: fixtures.room, events: [event(1)], head_sequence: 2, next_before: null };
  } } });
  feed.select(join(2, [event(2)], fixtures.room, 2));
  await feed.loadOlder();
  assert.equal(feed.getState().status, 'error'); assert.equal(snapshots.at(-1).length, 1);
  assert.equal(feed.getState().nextBefore, 2);
  await feed.loadOlder(); assert.equal(snapshots.at(-1).length, 2);
  assert.equal(feed.getState().error, null);
  await feed.loadOlder(); assert.equal(calls, 2);
  feed.destroy();
});

test('destroy cancels reconnect timer and fences late iterator callbacks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { feed, streams, snapshots, states } = setup();
  feed.select(join()); streams[0].stream.end();
  await until(() => feed.getState().status === 'reconnecting');
  feed.destroy(); const counts = [snapshots.length, states.length];
  t.mock.timers.tick(1000); await Promise.resolve();
  streams[0].options.onOpen(); feed.select(join()); feed.add(event(1));
  await feed.loadOlder();
  assert.equal(streams.length, 1);
  assert.deepEqual([snapshots.length, states.length], counts);
});

test('a conflicting confirmed event during backoff cancels the scheduled retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { feed, streams } = setup();
  feed.select(join(1, [event(1)])); streams[0].stream.end();
  await until(() => feed.getState().status === 'reconnecting');
  feed.add(event(1, fixtures.room, 'conflict'));
  assert.equal(feed.getState().status, 'error');
  t.mock.timers.tick(1000); await Promise.resolve();
  assert.equal(streams.length, 1);
  feed.destroy();
});

test('retry delay is bounded away from zero and capped at thirty seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [retryMs, expected] of [[0, 1], [1000000, 30000]]) {
    const streams = [];
    const feed = createEventFeed({ client: { events() { const stream = controlledStream(); streams.push(stream); return stream; } }, retryMs });
    feed.select(join()); streams[0].end();
    await until(() => feed.getState().status === 'reconnecting');
    t.mock.timers.tick(expected - 1); await Promise.resolve(); assert.equal(streams.length, 1);
    t.mock.timers.tick(1); await until(() => streams.length === 2);
    feed.destroy();
  }
});
