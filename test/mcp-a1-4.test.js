import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from '../src/mcp/connection.js';
import { RoomClient, ApiError } from '../src/shared/client.js';
import * as f from '../src/shared/fixtures.js';
import { createFixtureServer } from './helpers/fixture-server.js';
import { openDatabase } from '../src/hub/db.js';
import { createIdentityStore } from '../src/hub/identity-store.js';

const issued = { participant: f.agent, connection: { id: 'connection', generation: 1 }, token: f.token };
const expired = () => new ApiError('SESSION_EXPIRED', 'Expired.', { status: 401 });
const network = () => new ApiError('HUB_UNREACHABLE', 'Unavailable.', { status: 0, retryable: true });
function connection(t, client, extra = {}) {
  const result = createConnection({ client, profile: { name: 'Agent' }, resumeToken: 's'.repeat(40), heartbeatMs: 60000, retryMs: 1, maxRetries: 2, ...extra });
  t.after(() => result.close()); return result;
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5); }
  assert.ok(predicate(), 'Condition did not become true');
}

test('enrollment has a deadline and retries preserve the same issuance after timeout', async t => {
  const calls = [];
  const c = connection(t, {
    async agentSession(input, { signal }) {
      calls.push(structuredClone(input));
      if (calls.length === 1) await delay(1000, undefined, { signal });
      return issued;
    },
    async disconnect() {},
  }, { enrollmentTimeoutMs: 30 });
  await assert.rejects(c.start(), error => error.code === 'HUB_TIMEOUT' && error.retryable);
  assert.deepEqual(await c.start(), f.agent);
  assert.deepEqual(calls[0], calls[1]);
});

test('retry starts heartbeats when cancellation raced with successful enrollment', async t => {
  const controller = new AbortController();
  let beats = 0, cancelled = false;
  const c = connection(t, {
    async agentSession() { return issued; },
    async heartbeat() { beats++; return { ok: true }; },
    async disconnect() {},
  }, { heartbeatMs: 5, onState(state) {
    if (state.status === 'connected' && !cancelled) { cancelled = true; controller.abort(); }
  } });
  await assert.rejects(c.start({ signal: controller.signal }), /abort/i);
  assert.deepEqual(await c.start(), f.agent);
  await until(() => beats > 0);
});

test('real fixture enrollment is singleflight, retry body stable, and facade/state hide credentials', async t => {
  const fixture = await createFixtureServer({ handler: ({ path, calls, request }) => {
    if (path === '/sessions/agent' && calls.filter(call => call.path === path).length === 1) {
      request.socket.destroy(); return { handled: true };
    }
  } }); t.after(() => fixture.close());
  const states = [];
  const c = connection(t, new RoomClient({ baseUrl: fixture.url }), { onState: state => states.push(state) });
  assert.deepEqual(await Promise.all([c.start(), c.start(), c.start()]), [f.agent, f.agent, f.agent]);
  const calls = fixture.calls.filter(call => call.path === '/sessions/agent');
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].body, calls[1].body);
  assert.equal(c.client.token, undefined); assert.equal(c.client.agentSession, undefined);
  assert.ok(!JSON.stringify(states).includes(f.token)); assert.ok(!JSON.stringify(states).includes('s'.repeat(40)));
  assert.equal((await c.client.listRooms()).rooms.length, 2);
  await c.close(); assert.equal(c.getState().status, 'closed');
  assert.equal(fixture.calls.filter(call => call.path === '/sessions/disconnect').length, 1);
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/leave')).length, 0);
});

test('concurrent expiry shares resume and replays exact mutation input once', async t => {
  const resume = deferred(), calls = [], enrollments = [];
  let generation = 1;
  const c = connection(t, {
    async agentSession(input) { enrollments.push(structuredClone(input)); if (input.mode === 'resume') { await resume.promise; generation++; } return issued; },
    async postMessage(room, input) { calls.push({ room, input: structuredClone(input), generation }); if (generation === 1) throw expired(); return f.event; },
    async disconnect() {},
  });
  await c.start();
  const first = c.client.postMessage(f.room.id, { text: 'First' });
  const second = c.client.postMessage(f.room.id, { request_id: 'caller-id', text: 'Second' });
  await until(() => enrollments.length === 2); resume.resolve();
  await Promise.all([first, second]);
  assert.equal(enrollments.length, 2); assert.equal(enrollments[1].mode, 'resume');
  assert.notEqual(enrollments[0].request_id, enrollments[1].request_id);
  assert.equal(enrollments[0].resume_token, enrollments[1].resume_token);
  for (const text of ['First', 'Second']) {
    const matching = calls.filter(call => call.input.text === text);
    assert.equal(matching.length, 2); assert.deepEqual(matching[0].input, matching[1].input);
  }
  assert.equal(calls.find(call => call.input.text === 'Second').input.request_id, 'caller-id');
});

test('late expiry from an old generation does not create a second resume', async t => {
  const oldResponse = deferred(); let enrollments = 0, reads = 0;
  const c = connection(t, {
    async agentSession() { enrollments++; return issued; },
    async listRooms() { reads++; if (reads === 1) return oldResponse.promise; if (reads === 2) throw expired(); return { rooms: [] }; },
    async disconnect() {},
  });
  await c.start();
  const slow = c.client.listRooms(); await until(() => reads === 1);
  await c.client.listRooms(); oldResponse.reject(expired());
  await slow; assert.equal(enrollments, 2);
});

test('resume expiry rotates issuance ID within bounded retry while create/network retry preserves it', async t => {
  const enrollments = []; let reads = 0;
  const c = connection(t, {
    async agentSession(input) {
      enrollments.push(structuredClone(input));
      if (enrollments.length === 1) throw network();
      if (enrollments.length === 3) throw expired();
      return issued;
    },
    async listRooms() { if (++reads === 1) throw expired(); return { rooms: [] }; },
    async disconnect() {},
  });
  await c.start(); await c.client.listRooms();
  assert.deepEqual(enrollments[0], enrollments[1]);
  assert.equal(enrollments[2].mode, 'resume'); assert.equal(enrollments[3].mode, 'resume');
  assert.notEqual(enrollments[2].request_id, enrollments[3].request_id);
  assert.equal(c.getState().status, 'connected');
});

test('lost committed create followed by hub restart resumes the durable binding within budget', async t => {
  const database = await openDatabase({ filename: ':memory:' });
  t.after(() => database.close());
  let identity = createIdentityStore(database, { bootId: 'before-restart' });
  const enrollments = [];
  let committed, current;
  const c = connection(t, {
    async agentSession(input) {
      enrollments.push(structuredClone(input));
      const result = identity.agentSession(input);
      if (enrollments.length === 1) {
        committed = result;
        identity = createIdentityStore(database, { bootId: 'after-restart' });
        throw network(); // The first binding committed, but its response was lost.
      }
      current = result;
      return result;
    },
    async disconnect() { identity.disconnect(identity.authenticate({ bearer: current.token })); },
  });
  const participant = await c.start();
  assert.equal(enrollments.length, 3);
  assert.deepEqual(enrollments[0], enrollments[1]);
  assert.equal(enrollments[2].mode, 'resume');
  assert.notEqual(enrollments[2].request_id, enrollments[0].request_id);
  assert.equal(enrollments[2].resume_token, enrollments[0].resume_token);
  assert.equal(participant.id, committed.participant.id);
  assert.equal(current.connection.generation, committed.connection.generation + 1);
  assert.equal(identity.authenticate({ bearer: current.token }).participant.id, participant.id);
  assert.equal(database.db.prepare('SELECT count(*) AS n FROM participants').get().n, 1);
  assert.equal(c.getState().status, 'connected');
  await c.close();
});

test('transient operations retry within budget, semantic errors do not, caller cancellation stops backoff', async t => {
  let calls = 0, semantic = false;
  const c = connection(t, {
    async agentSession() { return issued; },
    async listRooms() { calls++; throw semantic ? new ApiError('FORBIDDEN', 'Denied.', { status: 403 }) : network(); },
    async disconnect() {},
  }, { retryMs: 10 });
  await assert.rejects(c.client.listRooms(), error => error.code === 'HUB_UNREACHABLE');
  assert.equal(calls, 3); assert.equal(c.getState().status, 'reconnecting');
  semantic = true;
  await assert.rejects(c.client.listRooms(), error => error.code === 'FORBIDDEN'); assert.equal(calls, 4);
  semantic = false;
  const controller = new AbortController();
  const pending = c.client.listRooms({ signal: controller.signal });
  const rejected = assert.rejects(pending, /abort/i);
  await until(() => calls === 5); controller.abort(); await rejected;
  await delay(30); assert.equal(calls, 5);
});

test('replacement terminally fences all pending operations without resume or disconnecting replacement', async t => {
  const blocked = deferred(); let enrollments = 0, calls = 0, disconnects = 0;
  const c = connection(t, {
    async agentSession() { enrollments++; return issued; },
    async listRooms() { if (++calls === 1) return blocked.promise; throw new ApiError('SESSION_REPLACED', 'Replaced.', { status: 409 }); },
    async disconnect() { disconnects++; },
  });
  await c.start();
  const waiting = c.client.listRooms();
  const rejected = assert.rejects(waiting, error => error.code === 'SESSION_REPLACED');
  await until(() => calls === 1);
  await assert.rejects(c.client.listRooms(), error => error.code === 'SESSION_REPLACED');
  await rejected;
  assert.equal(c.getState().status, 'replaced');
  await assert.rejects(c.start(), error => error.code === 'SESSION_REPLACED');
  assert.equal(enrollments, 1);
  blocked.resolve({ rooms: [] });
  await c.close(); assert.equal(disconnects, 0);
});

test('heartbeat is non-overlapping, survives transient errors, and close cancels work', { timeout: 5000 }, async t => {
  const blocked = deferred(); let beats = 0, concurrent = 0, maximum = 0, lastSignal;
  const c = connection(t, {
    async agentSession() { return issued; },
    async heartbeat(_input, { signal }) {
      beats++; concurrent++; maximum = Math.max(maximum, concurrent); lastSignal = signal;
      try { if (beats === 1) throw network(); await blocked.promise; return { ok: true }; }
      finally { concurrent--; }
    },
    async disconnect() {},
  }, { heartbeatMs: 5, maxRetries: 0 });
  await c.start(); await until(() => beats === 2);
  await delay(25); assert.equal(beats, 2); assert.equal(maximum, 1);
  const closing = c.close(); assert.equal(c.close(), closing); await closing;
  assert.equal(lastSignal.aborted, true); assert.equal(c.getState().status, 'closed');
  blocked.resolve(); await delay(20); assert.equal(beats, 2);
});

test('close cancels issuance and cannot publish late connected state; hanging disconnect is bounded', { timeout: 5000 }, async t => {
  const issuedLater = deferred(); const states = [];
  const c = connection(t, { agentSession: () => issuedLater.promise }, { onState: state => states.push(state.status) });
  const starting = c.start(); const rejected = assert.rejects(starting, /closed/i);
  await c.close(); await rejected;
  issuedLater.resolve(issued); await delay(5);
  assert.equal(c.getState().status, 'closed'); assert.ok(!states.includes('connected'));
  const d = connection(t, { async agentSession() { return issued; }, disconnect: () => new Promise(() => {}) });
  await d.start(); const before = Date.now(); await d.close(); assert.ok(Date.now() - before < 1500);
});
