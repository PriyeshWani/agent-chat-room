import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { openDatabase } from '../src/hub/db.js';
import { createIdentityStore } from '../src/hub/identity-store.js';
import { createRoomStore } from '../src/hub/room-store.js';
import { createAccessStore } from '../src/hub/access-store.js';
import { createLocalSession } from '../src/hub/local-session.js';
import { prepareAdapterConfig } from '../src/mcp/main.js';
import { buildLaunchConfig } from '../src/runtime/launch-config.js';
import { RoomClient } from '../src/shared/client.js';
import { parseHubUrl, privateIpv4 } from '../src/shared/hub-url.js';
import { temporaryDirectory } from './helpers/processes.js';

test('invitation expiry limits redemption, revocation ends grants, and remote socket cannot bootstrap host identity', async t => {
  const database = await openDatabase({ filename: ':memory:' }); t.after(() => database.close());
  const identity = createIdentityStore(database, { bootId: 'boundary-test' });
  let time = '2026-09-28T00:00:00.000Z';
  const access = createAccessStore(database, { identity, now: () => time });
  const rooms = createRoomStore(database, { identity, access });
  const local = identity.browserSession(), context = identity.authenticate({ cookie: local.token });
  const room = rooms.create(context, { name: 'Expiry', request_id: 'create' });
  const expired = access.create(context, room.id, { kind: 'human', request_id: 'expires', expires_in_minutes: 1 });
  time = '2026-09-28T00:02:00.000Z';
  assert.throws(() => access.joinBrowser({ name: 'No', request_id: 'no', invite_token: expired.token }), error => error.code === 'INVITE_INVALID');
  const valid = access.create(context, room.id, { kind: 'human', request_id: 'valid', expires_in_minutes: 1 });
  const input = { name: 'Sam', request_id: 'join', invite_token: valid.token };
  const visitor = access.joinBrowser(input);
  time = '2026-09-29T00:00:00.000Z';
  assert.equal(access.canAccess(visitor.participant, room.id), true);
  assert.deepEqual(access.joinBrowser(input), visitor);
  access.revoke(context, room.id, { request_id: 'revoke', invitation_id: valid.invitation.id });
  assert.equal(access.canAccess(visitor.participant, room.id), false);
  assert.throws(() => access.joinBrowser(input), error => error.code === 'INVITE_INVALID');
  const sessions = createLocalSession({ identity, access, publicUrl: () => 'http://192.168.50.10:60413' });
  assert.throws(() => sessions.browserSession({ headers: { host: '127.0.0.1:60413', 'x-forwarded-for': '127.0.0.1' },
    socket: { remoteAddress: '192.168.50.20' } }), error => error.code === 'JOIN_REQUIRED');
});

test('LAN URL validation and saved sessions keep enrollment tied to the selected hub', async t => {
  for (const ip of ['10.0.0.192', '172.16.0.1', '172.31.255.254', '192.168.1.1']) assert.equal(privateIpv4(ip), true);
  // RFC 5737 reserves TEST-NET-3 for examples; no live service is needed to
  // exercise non-private address rejection.
  for (const ip of ['0.0.0.0', '127.0.0.1', '203.0.113.1', '192.168.999.1', 'example.com']) assert.equal(privateIpv4(ip), false);
  for (const url of ['http://example.com', 'http://203.0.113.1', 'http://0.0.0.0', 'http://192.168.1.1/path', 'http://u:p@192.168.1.1', 'http://192.168.1.1/?token=x']) assert.throws(() => parseHubUrl(url));
  const workspace = await temporaryDirectory(t), session = join(workspace, 'session.json');
  const env = { ROOM_WORKSPACE: workspace, ROOM_HUB_URL: 'http://192.168.1.1:60413', ROOM_SESSION_FILE: session, ROOM_INVITE_TOKEN: 'synthetic-code-'.repeat(4) };
  const config = await prepareAdapterConfig(env);
  assert.equal(config.inviteToken, env.ROOM_INVITE_TOKEN);
  const saved = await readFile(session, 'utf8');
  assert.ok(!saved.includes(env.ROOM_INVITE_TOKEN));
  assert.equal(JSON.parse(saved).hubUrl, env.ROOM_HUB_URL);
  await assert.rejects(prepareAdapterConfig({ ...env, ROOM_RESUME: '1', ROOM_HUB_URL: 'http://192.168.1.2:60413' }), error => error.code === 'HUB_MISMATCH');
  assert.equal(await readFile(session, 'utf8'), saved);
  const resumed = await prepareAdapterConfig({ ...env, ROOM_RESUME: '1', ROOM_INVITE_TOKEN: undefined });
  assert.equal(resumed.resumeToken, config.resumeToken);
  const old = JSON.parse(saved); delete old.hubUrl; await writeFile(session, JSON.stringify(old));
  await assert.rejects(prepareAdapterConfig({ ...env, ROOM_RESUME: '1' }), error => error.code === 'HUB_MISMATCH');
  const launch = buildLaunchConfig({ roomId: 'room', name: 'Remote agent', workspace, hubUrl: env.ROOM_HUB_URL });
  assert.ok(launch.args[1].includes('env_vars = ["ROOM_INVITE_TOKEN"]'));
  assert.ok(!launch.args.includes('--yolo'));
  assert.ok(launch.args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg) + 1, 0) < 2048);
});

test('enrollment rejects HTTP redirects rather than forwarding the invitation or resume payload', async t => {
  let received = 0;
  async function server(handler) {
    const value = http.createServer(handler);
    await new Promise(resolve => value.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => value.close(resolve)));
    return `http://127.0.0.1:${value.address().port}`;
  }
  const target = await server((request, response) => { received++; request.resume(); response.end('{}'); });
  const source = await server((request, response) => { request.resume(); response.writeHead(307, { Location: `${target}/redirected` }); response.end(); });
  const client = new RoomClient({ baseUrl: source });
  await assert.rejects(client.agentSession({ mode: 'create', name: 'Fixture', resume_token: 'synthetic'.repeat(8), invite_token: 'synthetic-invitation'.repeat(3) }), error => error.code === 'HUB_UNREACHABLE');
  assert.equal(received, 0);
});
