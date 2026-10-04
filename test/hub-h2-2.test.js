import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { openDatabase } from '../src/hub/db.js';
import { createIdentityStore } from '../src/hub/identity-store.js';
import { createLocalSession } from '../src/hub/local-session.js';
import { createSessionRoutes } from '../src/hub/routes/session.js';
import { createHttpServer } from '../src/hub/http-server.js';
import { Outputs } from '../src/shared/schemas.js';
import { temporaryDirectory } from './helpers/processes.js';

const enrollment = (request_id = 'create', rest = {}) => ({ request_id, mode: 'create', resume_token: 's'.repeat(40), name: 'Test agent', ...rest });
async function setup(t) {
  const database = await openDatabase({ filename: join(await temporaryDirectory(t), 'hub.sqlite') });
  t.after(() => database.close());
  const identity = createIdentityStore(database, { bootId: 'test-boot' });
  const touches = [], disconnects = [], notifications = [];
  const changes = new EventEmitter();
  changes.on('identity', id => {
    assert.ok(identity.getParticipant(id));
    notifications.push(id);
  });
  const sessions = createLocalSession({ identity, changes, presence: {
    touch: (context, input) => touches.push({ context, input }),
    disconnect: context => disconnects.push(context),
  } });
  const hub = await createHttpServer({ handlers: [createSessionRoutes({ sessions })] });
  t.after(() => hub.close());
  async function call(path, body = {}, headers = {}, method = 'POST') {
    const response = await fetch(hub.url + '/api/v1/sessions/' + path, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  return { database, identity, sessions, hub, call, touches, disconnects, notifications, changes };
}

test('browser bootstrap restores one human, keeps cookie private, and preserves other tabs', async t => {
  const s = await setup(t);
  assert.equal((await s.call('browser')).status, 403);
  const first = await s.call('browser', {}, { Origin: s.hub.url });
  assert.equal(first.status, 200); Outputs.browserSession.parse(first.data.data);
  const header = first.headers.get('set-cookie');
  assert.match(header, /^acr_session=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=\/$/);
  const cookie = header.split(';')[0];
  assert.ok(!JSON.stringify(first.data).includes(cookie.split('=')[1]));
  const second = await s.call('browser', {}, { Origin: s.hub.url });
  assert.deepEqual(second.data, first.data); assert.equal(second.headers.get('set-cookie'), header);
  assert.equal((await s.call('heartbeat', { activity: 'Reading' }, { Origin: s.hub.url, Cookie: cookie })).status, 200);
  assert.equal((await s.call('disconnect', {}, { Origin: s.hub.url, Cookie: cookie })).status, 200);
  assert.equal((await s.call('heartbeat', {}, { Origin: s.hub.url, Cookie: cookie })).status, 200);
  assert.equal(s.disconnects.length, 1);
});

test('agent enrollment retries, resume, fencing and disconnect use real durable identity', async t => {
  const s = await setup(t);
  const first = await s.call('agent', enrollment());
  assert.equal(first.status, 200); const agent = Outputs.agentSession.parse(first.data.data);
  assert.ok(!JSON.stringify(first.data).includes(enrollment().resume_token));
  assert.deepEqual((await s.call('agent', enrollment())).data, first.data);
  const old = { Authorization: `Bearer ${agent.token}` };
  assert.equal((await s.call('heartbeat', { activity: 'Working' }, old)).status, 200);
  assert.deepEqual(s.touches.at(-1).input, { activity: 'Working' });
  const context = s.sessions.authenticate({ headers: { authorization: old.Authorization } });
  assert.deepEqual(Object.keys(context).sort(), ['connection_id', 'generation', 'kind', 'participant']);
  const resumed = await s.call('agent', enrollment('resume', { mode: 'resume' }));
  const current = resumed.data.data;
  assert.equal(current.participant.id, agent.participant.id);
  assert.equal(current.connection.generation, agent.connection.generation + 1);
  assert.equal((await s.call('heartbeat', {}, old)).data.error.code, 'SESSION_REPLACED');
  assert.throws(() => s.sessions.heartbeat(context, {}), error => error.code === 'SESSION_REPLACED');
  const auth = { Authorization: `Bearer ${current.token}` };
  assert.deepEqual((await s.call('disconnect', {}, auth)).data.data, { ok: true });
  assert.equal((await s.call('heartbeat', {}, auth)).data.error.code, 'SESSION_EXPIRED');
  assert.equal(s.disconnects.length, 1);
  assert.deepEqual(s.notifications, Array(4).fill(agent.participant.id));
  assert.ok(s.touches.every(({ context }) => !Object.hasOwn(context, 'token')));
});

test('strict authentication rejects absent, malformed, mixed and duplicate credentials', async t => {
  const s = await setup(t);
  const agent = (await s.call('agent', enrollment())).data.data;
  const browser = await s.call('browser', {}, { Origin: s.hub.url });
  const cookie = browser.headers.get('set-cookie').split(';')[0];
  const bearer = `Bearer ${agent.token}`;
  const startTouches = s.touches.length;
  for (const headers of [
    {}, { Authorization: 'Basic invalid' }, { Authorization: 'Bearer' }, { Authorization: 'Bearer invalid' },
    { Authorization: `${bearer}, ${bearer}` }, { Authorization: bearer, Cookie: cookie },
    { Cookie: `${cookie}; ${cookie}` }, { Cookie: 'acr_session=' }, { Cookie: 'acr_session=%broken' },
  ]) {
    const response = await s.call('heartbeat', {}, { Origin: s.hub.url, ...headers });
    assert.equal(response.status, 401); assert.equal(response.data.error.code, 'UNAUTHENTICATED');
    assert.ok(!JSON.stringify(response.data).includes(agent.token));
  }
  for (const header of ['Authorization', 'Cookie']) {
    const value = header === 'Authorization' ? bearer : cookie;
    const status = await new Promise((resolve, reject) => {
      const req = http.request(s.hub.url + '/api/v1/sessions/heartbeat', {
        method: 'POST', headers: ['Host', new URL(s.hub.url).host, 'Origin', s.hub.url, 'Content-Type', 'application/json', header, value, header, value],
      }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      req.on('error', reject); req.end('{}');
    });
    assert.equal(status, 401);
  }
  assert.equal(s.touches.length, startTouches);
  assert.equal((await s.call('heartbeat', {}, { Origin: s.hub.url, Cookie: `other=value; ${cookie}` })).status, 200);
});

test('session routes reject forged fields, invalid bodies and unsupported methods', async t => {
  const s = await setup(t);
  const agent = (await s.call('agent', enrollment())).data.data;
  const headers = { Origin: s.hub.url, Authorization: `Bearer ${agent.token}` };
  for (const [path, body] of [['browser', { kind: 'agent' }], ['agent', enrollment('bad', { owner_id: 'forged' })],
    ['heartbeat', { activity: 'a'.repeat(501) }], ['disconnect', { participant_id: agent.participant.id }]]) {
    const response = await s.call(path, body, headers);
    assert.equal(response.status, 400); assert.equal(response.data.error.code, 'VALIDATION_ERROR');
  }
  for (const path of ['browser', 'agent', 'heartbeat', 'disconnect', 'unknown']) {
    assert.equal((await s.call(path, undefined, headers, 'GET')).status, 404);
  }
  assert.equal((await s.call('unknown', {}, headers)).status, 404);
  assert.equal((await s.call('heartbeat', {}, headers)).status, 200);
});

test('identity notifications follow commits and failed operations emit none; presence is optional', async t => {
  const s = await setup(t);
  const bare = createLocalSession({ identity: s.identity });
  const agent = bare.agentSession(enrollment());
  const context = bare.authenticate({ headers: { authorization: `Bearer ${agent.token}` } });
  assert.deepEqual(bare.heartbeat(context, {}), { ok: true });
  s.changes.on('identity', () => {
    assert.throws(() => s.identity.assertCurrent(context), error => error.code === 'SESSION_REPLACED');
  });
  const response = await s.call('agent', enrollment('resume', { mode: 'resume' }));
  assert.equal(response.status, 200); assert.equal(s.notifications.length, 1);
  assert.equal((await s.call('agent', enrollment('again'))).data.error.code, 'SESSION_EXISTS');
  assert.equal((await s.call('disconnect', {}, { Authorization: `Bearer ${agent.token}` })).data.error.code, 'SESSION_REPLACED');
  assert.equal(s.notifications.length, 1);
});
