import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHub } from '../src/hub/main.js';
import { createHubSession } from '../src/mcp/hub-session.js';
import { prepareAdapterConfig } from '../src/mcp/config.js';
import { ApiError } from '../src/shared/protocol.js';
import * as f from '../src/shared/fixtures.js';
import { browserClient } from './helpers/browser-client.js';
import { createFixtureServer } from './helpers/fixture-server.js';
import { connectMcp, temporaryDirectory } from './helpers/processes.js';

const entry = fileURLToPath(new URL('../src/mcp/main.js', import.meta.url));
function peer(t, env = {}) {
  return connectMcp(t, entry, { env: { ROOM_HUB_URL: undefined, ROOM_INVITE_TOKEN: undefined,
    ROOM_SESSION_FILE: undefined, ROOM_RESUME: undefined, CLAUDE_PROJECT_DIR: undefined,
    ROOM_WORKSPACE: process.cwd(), ...env } });
}

test('MCP starts through a symlinked entry file or checkout directory', { timeout: 10000 }, async t => {
  const dir = await temporaryDirectory(t);
  const fileAlias = join(dir, 'adapter.mjs');
  const repoAlias = join(dir, 'checkout');
  await symlink(entry, fileAlias);
  await symlink(fileURLToPath(new URL('../', import.meta.url)), repoAlias, 'dir');
  for (const path of [fileAlias, join(repoAlias, 'src/mcp/main.js')]) {
    const p = await connectMcp(t, path);
    assert.equal((await p.client.listTools()).tools.length, 12);
    await p.client.ping();
    assert.equal(p.stderr(), '');
  }
});
async function call(p, name, args = {}) {
  const result = await p.call(name, args);
  assert.ok(!result.isError, JSON.stringify(result.data));
  return result.data;
}
async function hub(t, name = 'Shared') {
  const server = await createHub({ filename: ':memory:', host: '127.0.0.1', lanHost: '192.168.50.10' });
  t.after(() => server.close());
  const human = await browserClient(server.url);
  const room = await human.client.createRoom({ name });
  const invitation = await human.client.createInvitation(room.id, { kind: 'agent' });
  return { server, human: human.client, room, invitation };
}

test('MCP initialization and tool discovery make no hub requests or session files', { timeout: 10000 }, async t => {
  const fixture = await createFixtureServer(); t.after(() => fixture.close());
  const file = join(await temporaryDirectory(t), 'session.json');
  const p = await peer(t, { ROOM_HUB_URL: fixture.url, ROOM_SESSION_FILE: file });
  const { tools } = await p.client.listTools();
  assert.equal(tools.length, 12);
  const joinTool = tools.find(tool => tool.name === 'join_room');
  assert.deepEqual(joinTool.inputSchema.required, ['room_id']);
  assert.ok(joinTool.inputSchema.properties.hub_url);
  assert.ok(joinTool.inputSchema.properties.invite_token);
  await p.client.ping();
  assert.equal(fixture.calls.length, 0);
  await assert.rejects(stat(file), error => error.code === 'ENOENT');
  await p.client.close();
  assert.equal(fixture.calls.length, 0);
});

test('a hub can start after MCP initialization and a supplied address corrects an invalid default', { timeout: 10000 }, async t => {
  const p = await peer(t, { ROOM_HUB_URL: 'invalid-default' });
  assert.equal((await p.client.listTools()).tools.length, 12);
  const s = await hub(t);
  const joined = await call(p, 'join_room', { room_id: s.room.id, hub_url: s.server.url });
  assert.equal(joined.room.id, s.room.id);
  assert.equal(p.stderr(), '');
});

test('bad and used conversational invitations can be corrected in the same MCP session', { timeout: 15000 }, async t => {
  const s = await hub(t);
  const p = await peer(t);
  const input = { room_id: s.room.id, hub_url: s.server.url };
  const invalid = await p.call('join_room', { ...input, invite_token: 'invalid-invitation-'.repeat(3) });
  assert.equal(invalid.data.error.code, 'INVITE_INVALID');
  assert.equal((await p.client.listTools()).tools.length, 12);
  const joined = await call(p, 'join_room', { ...input, invite_token: s.invitation.token });
  const retry = await call(p, 'join_room', { ...input, invite_token: s.invitation.token });
  assert.equal(retry.membership.participant_id, joined.membership.participant_id);
  const question = await s.human.postMessage(s.room.id, { text: 'Can you review this?' });
  const received = await call(p, 'receive_events', { wait_ms: 0 });
  assert.deepEqual(received.batch.events, [question]);
  await call(p, 'ack_events', { request_id: 'ack-question', batch_id: received.batch.id });
  await call(p, 'post_message', { request_id: 'answer', text: 'I can review the changes.', reply_to: question.id });
  const otherRoom = await s.human.createRoom({ name: 'Not invited' });
  const denied = await p.call('join_room', { room_id: otherRoom.id });
  assert.equal(denied.data.error.code, 'FORBIDDEN');
  const history = await call(p, 'read_history');
  assert.equal(history.room.id, s.room.id);
  assert.ok(!JSON.stringify({ joined, retry, history, invalid }).includes(s.invitation.token));
  const second = await peer(t);
  const used = await second.call('join_room', { ...input, invite_token: s.invitation.token });
  assert.equal(used.data.error.code, 'INVITE_USED');
  const fresh = await s.human.createInvitation(s.room.id, { kind: 'agent' });
  assert.equal((await call(second, 'join_room', { ...input, invite_token: fresh.token })).room.id, s.room.id);
});

test('hub switches require leaving and do not carry configured invitations or resume identity across hubs', { timeout: 10000 }, async t => {
  const a = await createFixtureServer(), b = await createFixtureServer();
  t.after(() => a.close()); t.after(() => b.close());
  const invitation = 'synthetic-original-hub-invitation'.repeat(2);
  const p = await peer(t, { ROOM_HUB_URL: a.url, ROOM_INVITE_TOKEN: invitation });
  await call(p, 'join_room', { room_id: f.room.id });
  const conflict = await p.call('join_room', { room_id: f.room.id, hub_url: b.url });
  assert.equal(conflict.data.error.code, 'ACTIVE_ROOM_CONFLICT');
  assert.equal(b.calls.length, 0);
  await call(p, 'leave_room');
  await call(p, 'join_room', { room_id: f.room.id, hub_url: b.url });
  const aSession = a.calls.find(call => call.path === '/sessions/agent').body;
  const bSession = b.calls.find(call => call.path === '/sessions/agent').body;
  assert.equal(aSession.invite_token, invitation); assert.equal(bSession.invite_token, undefined);
  assert.notEqual(aSession.resume_token, bSession.resume_token);
  assert.ok(!JSON.stringify(b.calls).includes(invitation));
  assert.ok(!JSON.stringify(b.calls.find(call => call.path.endsWith('/join')).body).includes('invite'));
  await call(p, 'list_rooms');
  assert.equal(b.calls.at(-1).path, '/rooms');
});

test('an initial hub override omits the default invitation, and null explicitly clears a local default', { timeout: 10000 }, async t => {
  const a = await createFixtureServer(), b = await createFixtureServer();
  t.after(() => a.close()); t.after(() => b.close());
  const env = { ROOM_HUB_URL: a.url, ROOM_INVITE_TOKEN: 'synthetic-default-invitation'.repeat(2) };
  const p = await peer(t, env);
  await call(p, 'join_room', { room_id: f.room.id, hub_url: b.url });
  assert.equal(a.calls.length, 0);
  assert.equal(b.calls[0].body.invite_token, undefined);
  const local = await peer(t, env);
  await call(local, 'join_room', { room_id: f.room.id, invite_token: null });
  assert.equal(a.calls[0].body.invite_token, undefined);
});

test('dynamic enrollment persists the selected hub, supports invitation correction and resumes without a code', { timeout: 10000 }, async t => {
  const s = await hub(t);
  const file = join(await temporaryDirectory(t), 'session.json');
  const env = { ROOM_SESSION_FILE: file };
  const p = await peer(t, env);
  const input = { room_id: s.room.id, hub_url: s.server.url };
  assert.equal((await p.call('join_room', { ...input, invite_token: 'invalid-invitation-'.repeat(3) })).data.error.code, 'INVITE_INVALID');
  const savedBefore = await readFile(file, 'utf8');
  const joined = await call(p, 'join_room', { ...input, invite_token: s.invitation.token });
  assert.equal(await readFile(file, 'utf8'), savedBefore);
  assert.equal(JSON.parse(savedBefore).hubUrl, s.server.url);
  assert.ok(!savedBefore.includes(s.invitation.token));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await call(p, 'leave_room');
  const target = await createFixtureServer(); t.after(() => target.close());
  const switched = await p.call('join_room', { room_id: f.room.id, hub_url: target.url });
  assert.equal(switched.data.error.code, 'HUB_MISMATCH'); assert.equal(target.calls.length, 0);
  const fresh = await s.human.createInvitation(s.room.id, { kind: 'agent' });
  assert.equal((await p.call('join_room', { ...input, invite_token: fresh.token })).data.error.code, 'SESSION_AUTH_CONFLICT');
  await p.client.close();
  const resumed = await peer(t, { ...env, ROOM_RESUME: '1' });
  const rejoined = await call(resumed, 'join_room', input);
  assert.equal(rejoined.membership.participant_id, joined.membership.participant_id);
});

test('cancelling initial enrollment aborts HTTP and retains issuance for a later retry', { timeout: 10000 }, async t => {
  let reached, disconnected, shouldHang = true;
  const ready = new Promise(resolve => { reached = resolve; });
  const ended = new Promise(resolve => { disconnected = resolve; });
  const fixture = await createFixtureServer({ handler: ({ path, response }) => {
    if (path === '/sessions/agent' && shouldHang) {
      response.on('close', disconnected);
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders();
      reached(); return { handled: true };
    }
  } }); t.after(() => fixture.close());
  const p = await peer(t, { ROOM_HUB_URL: fixture.url });
  const controller = new AbortController();
  const pending = p.call('join_room', { room_id: f.room.id }, { signal: controller.signal });
  const rejected = assert.rejects(pending, /abort|cancel/i);
  await ready; controller.abort(); await rejected; await ended;
  shouldHang = false;
  await call(p, 'join_room', { room_id: f.room.id });
  const attempts = fixture.calls.filter(call => call.path === '/sessions/agent');
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[0].body, attempts[1].body);
});

test('missing invitation is a tool error and the user can supply it on retry', { timeout: 10000 }, async t => {
  const invitation = 'synthetic-conversation-invitation'.repeat(2);
  const fixture = await createFixtureServer({ handler: ({ path, body }) => {
    if (path === '/sessions/agent' && body.invite_token !== invitation) {
      return { error: new ApiError('INVITE_REQUIRED', 'An invitation is required.', { status: 401 }) };
    }
  } }); t.after(() => fixture.close());
  const p = await peer(t, { ROOM_HUB_URL: fixture.url });
  assert.equal((await p.call('join_room', { room_id: f.room.id })).data.error.code, 'INVITE_REQUIRED');
  assert.equal((await call(p, 'join_room', { room_id: f.room.id, invite_token: invitation })).room.id, f.room.id);
});

test('cancellation during session-file preparation permits a corrected invitation without overwriting the file', async t => {
  const fixture = await createFixtureServer(); t.after(() => fixture.close());
  const file = join(await temporaryDirectory(t), 'session.json');
  let prepared, release;
  const ready = new Promise(resolve => { prepared = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const session = createHubSession({ env: { ROOM_WORKSPACE: process.cwd(), ROOM_SESSION_FILE: file },
    prepareConfig: async env => {
      const config = await prepareAdapterConfig(env);
      prepared(); await resume;
      return config;
    },
  }); t.after(() => session.close());
  const controller = new AbortController();
  const pending = session.connect({ hub_url: fixture.url, invite_token: 'first-invitation-'.repeat(3) }, { signal: controller.signal });
  const cancelled = assert.rejects(pending, /abort/i);
  await ready;
  const saved = await readFile(file, 'utf8');
  controller.abort(); release(); await cancelled;
  assert.equal(fixture.calls.length, 0);
  const replacement = 'corrected-invitation-'.repeat(3);
  await session.connect({ hub_url: fixture.url, invite_token: replacement });
  assert.equal(fixture.calls[0].body.invite_token, replacement);
  assert.equal(await readFile(file, 'utf8'), saved);
});
