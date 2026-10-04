import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMcpServer } from '../src/mcp/server.js';
import { registerRoomTools } from '../src/mcp/tools/rooms.js';
import { ApiError } from '../src/shared/protocol.js';
import * as f from '../src/shared/fixtures.js';
import { createFixtureServer } from './helpers/fixture-server.js';
import { temporaryDirectory, connectMcp } from './helpers/processes.js';

async function adapter(t, fixture) {
  const directory = await temporaryDirectory(t);
  const entry = join(directory, 'entry.mjs');
  await writeFile(entry, `
    import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
    import { createMcpServer } from ${JSON.stringify(new URL('../src/mcp/server.js', import.meta.url).href)};
    import { RoomClient } from ${JSON.stringify(new URL('../src/shared/client.js', import.meta.url).href)};
    const client = new RoomClient({ baseUrl: process.env.FIXTURE_URL, token: process.env.FIXTURE_TOKEN });
    await createMcpServer({ client }).connect(new StdioServerTransport());
  `);
  return connectMcp(t, entry, { env: { FIXTURE_URL: fixture.url, FIXTURE_TOKEN: f.token } });
}

test('server factory gives registrars fresh shared state and explicit group composition', async () => {
  const sessions = [];
  const client = {};
  const registrar = context => { assert.equal(context.client, client); sessions.push(context.session); };
  const one = createMcpServer({ client, toolGroups: [registrar, registrar] });
  const two = createMcpServer({ client, toolGroups: [registrar] });
  assert.notEqual(one, two);
  assert.equal(sessions[0], sessions[1]);
  assert.notEqual(sessions[0], sessions[2]);
  assert.deepEqual(sessions[2], { roomId: null, membershipEpoch: null, participant: null });
  assert.equal(typeof registerRoomTools, 'function');
  await one.close(); await two.close();
});

test('SDK stdio room tools expose only public data and enforce active membership', { timeout: 15000 }, async t => {
  let historyQuery;
  const fixture = await createFixtureServer({ handler: ({ path, request }) => {
    if (path.endsWith('/history')) historyQuery = new URL(request.url, 'http://fixture').searchParams;
  } });
  t.after(() => fixture.close());
  const mcp = await adapter(t, fixture);
  const { tools } = await mcp.client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['join_room', 'leave_room', 'list_participants', 'list_rooms', 'read_history']);
  for (const name of ['list_participants', 'read_history', 'leave_room']) {
    const result = await mcp.call(name);
    assert.equal(result.isError, true);
    assert.equal(result.data.error.code, 'MEMBERSHIP_ENDED');
  }
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual((await mcp.call('list_rooms')).data, { rooms: [f.room, f.otherRoom] });
  const joined = await mcp.call('join_room', { room_id: f.room.id });
  assert.deepEqual(joined.data, { room: f.room, membership: f.membership, history: f.history });
  assert.deepEqual((await mcp.call('list_participants')).data, { participants: [f.status] });
  assert.deepEqual((await mcp.call('read_history', { before: 2, limit: 1 })).data, f.history);
  assert.equal(historyQuery.get('before'), '2'); assert.equal(historyQuery.get('limit'), '1');
  assert.equal((await mcp.call('leave_room')).data.left, true);
  const leave = fixture.calls.find(call => call.path.endsWith('/leave'));
  assert.equal(leave.body.membership_epoch, f.membership.epoch);
  assert.ok(leave.body.request_id);
  assert.equal((await mcp.call('read_history')).isError, true);
  assert.ok(fixture.calls.every(call => call.headers.authorization === `Bearer ${f.token}`));
  assert.ok(fixture.calls.every(call => !call.path.startsWith('/sessions')));
  assert.ok(!JSON.stringify(joined).includes(f.token));
  assert.equal(mcp.stderr(), '');
});

test('SDK rejects invalid tool arguments before HTTP', { timeout: 15000 }, async t => {
  const fixture = await createFixtureServer(); t.after(() => fixture.close());
  const mcp = await adapter(t, fixture);
  for (const [name, args] of [
    ['join_room', {}], ['join_room', { room_id: '' }], ['join_room', { room_id: f.room.id, token: 'private' }],
    ['read_history', { before: -1 }], ['read_history', { limit: 101 }], ['read_history', { limit: 1.5 }],
    ['list_rooms', { unexpected: true }],
  ]) {
    const result = await mcp.client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Input validation error/);
  }
  assert.equal(fixture.calls.length, 0);
});

test('failed join and leave retain current room, and servers do not share session state', { timeout: 15000 }, async t => {
  let failLeave = true;
  const fixture = await createFixtureServer({ handler: ({ path }) => {
    if (path === `/rooms/${f.otherRoom.id}/join`) return { error: new ApiError('ACTIVE_ROOM_CONFLICT', 'Leave the current room first.', { status: 409 }) };
    if (path.endsWith('/leave') && failLeave) return { error: new ApiError('SESSION_REPLACED', 'The session was replaced.', { status: 409 }) };
  } }); t.after(() => fixture.close());
  const mcp = await adapter(t, fixture);
  await mcp.call('join_room', { room_id: f.room.id });
  assert.equal((await mcp.call('join_room', { room_id: f.otherRoom.id })).data.error.code, 'ACTIVE_ROOM_CONFLICT');
  const failed = await mcp.call('leave_room');
  assert.deepEqual(failed.data, { error: { code: 'SESSION_REPLACED', message: 'The session was replaced.', retryable: false } });
  assert.equal((await mcp.call('read_history')).data.room.id, f.room.id);
  const other = await adapter(t, fixture);
  assert.equal((await other.call('read_history')).isError, true);
  failLeave = false;
  await mcp.call('leave_room');
  assert.equal((await mcp.call('list_participants')).isError, true);
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/leave')).length, 2);
});

test('malformed and credential-bearing outputs fail closed without changing membership', { timeout: 15000 }, async t => {
  let malformed = true;
  const fixture = await createFixtureServer({ handler: ({ path, response }) => {
    if (path.endsWith('/join') && malformed) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ version: '1', data: { room: f.room, membership: f.membership, history: f.history, token: f.token } }));
      return { handled: true };
    }
  } }); t.after(() => fixture.close());
  const mcp = await adapter(t, fixture);
  const result = await mcp.call('join_room', { room_id: f.room.id });
  assert.equal(result.isError, true); assert.equal(result.data.error.code, 'INVALID_RESPONSE');
  assert.ok(!JSON.stringify(result).includes(f.token));
  assert.equal((await mcp.call('read_history')).data.error.code, 'MEMBERSHIP_ENDED');
  malformed = false;
  assert.equal((await mcp.call('join_room', { room_id: f.room.id })).data.room.id, f.room.id);
});

test('SDK cancellation aborts the underlying HTTP request', { timeout: 15000 }, async t => {
  let reached, disconnected;
  const ready = new Promise(resolve => { reached = resolve; });
  const closed = new Promise(resolve => { disconnected = resolve; });
  const fixture = await createFixtureServer({ handler: ({ path, response }) => {
    if (path === '/rooms') {
      response.on('close', disconnected);
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders();
      reached(); return { handled: true };
    }
  } }); t.after(() => fixture.close());
  const mcp = await adapter(t, fixture);
  const controller = new AbortController();
  const pending = mcp.call('list_rooms', {}, { signal: controller.signal });
  const rejected = assert.rejects(pending, /abort|cancel/i);
  await ready; controller.abort(); await rejected; await closed;
  assert.equal(fixture.calls.length, 1);
});

test('overlapping join and leave are ordered so a delayed join cannot restore a left room', { timeout: 15000 }, async t => {
  let reached, release;
  const ready = new Promise(resolve => { reached = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  const fixture = await createFixtureServer({ handler: async ({ path }) => {
    if (path.endsWith('/join')) { reached(); await released; }
  } }); t.after(() => fixture.close());
  const mcp = await adapter(t, fixture);
  const joining = mcp.call('join_room', { room_id: f.room.id });
  await ready;
  const leaving = mcp.call('leave_room');
  release();
  assert.equal((await joining).data.room.id, f.room.id);
  assert.equal((await leaving).data.left, true);
  assert.equal((await mcp.call('read_history')).data.error.code, 'MEMBERSHIP_ENDED');
  assert.deepEqual(fixture.calls.map(call => call.path), [`/rooms/${f.room.id}/join`, `/rooms/${f.room.id}/leave`]);
});

test('uncertain committed leave reuses its request ID across tool calls and clears selection on replay', { timeout: 15000 }, async t => {
  let committedId, leaveCalls = 0;
  const fixture = await createFixtureServer({ handler: ({ path, body, request }) => {
    if (!path.endsWith('/leave')) return;
    leaveCalls++;
    if (!committedId) committedId = body.request_id;
    if (body.request_id !== committedId) return { error: new ApiError('FORBIDDEN', 'Membership is already inactive.', { status: 403 }) };
    // The same outcome is durable, but both attempts in the first HTTP call
    // lose their responses. The next tool invocation must replay this ID.
    if (leaveCalls <= 2) { request.socket.destroy(); return { handled: true }; }
    return { schema: 'leaveRoom', data: { room_id: f.room.id, left: true } };
  } }); t.after(() => fixture.close());
  const mcp = await adapter(t, fixture);
  await mcp.call('join_room', { room_id: f.room.id });
  const uncertain = await mcp.call('leave_room');
  assert.equal(uncertain.isError, true); assert.equal(uncertain.data.error.code, 'HUB_UNREACHABLE');
  assert.equal((await mcp.call('leave_room')).data.left, true);
  assert.equal((await mcp.call('read_history')).data.error.code, 'MEMBERSHIP_ENDED');
  const attempts = fixture.calls.filter(call => call.path.endsWith('/leave'));
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every(call => call.body.request_id === committedId));
  const previousId = committedId;
  committedId = undefined;
  await mcp.call('join_room', { room_id: f.room.id });
  assert.equal((await mcp.call('leave_room')).data.left, true);
  assert.notEqual(committedId, previousId);
});
