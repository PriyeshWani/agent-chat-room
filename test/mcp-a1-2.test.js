import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
    import { registerRoomTools } from ${JSON.stringify(new URL('../src/mcp/tools/rooms.js', import.meta.url).href)};
    import { registerDeliveryTools } from ${JSON.stringify(new URL('../src/mcp/tools/delivery.js', import.meta.url).href)};
    import { RoomClient } from ${JSON.stringify(new URL('../src/shared/client.js', import.meta.url).href)};
    const client = new RoomClient({ baseUrl: process.env.FIXTURE_URL, token: process.env.FIXTURE_TOKEN });
    await createMcpServer({ client, toolGroups: [registerRoomTools, registerDeliveryTools] }).connect(new StdioServerTransport());
  `);
  return connectMcp(t, entry, { env: { FIXTURE_URL: fixture.url, FIXTURE_TOKEN: f.token } });
}

const ackInput = { request_id: 'ack-request-1', batch_id: f.batch.id };
const timeout = { kind: 'timeout', room_id: f.room.id, acknowledged_through: 1 };

test('delivery tools require membership and enforce public argument schemas', { timeout: 15000 }, async t => {
  const fixture = await createFixtureServer(); t.after(() => fixture.close());
  const mcp = await adapter(t, fixture);
  const { tools } = await mcp.client.listTools();
  assert.ok(tools.some(tool => tool.name === 'receive_events'));
  assert.deepEqual(tools.find(tool => tool.name === 'ack_events').inputSchema.required.sort(), ['batch_id', 'request_id']);
  for (const [name, input] of [['receive_events', {}], ['ack_events', ackInput]]) {
    const result = await mcp.call(name, input);
    assert.equal(result.isError, true); assert.equal(result.data.error.code, 'MEMBERSHIP_ENDED');
  }
  for (const [name, input] of [
    ['receive_events', { wait_ms: -1 }], ['receive_events', { wait_ms: 20001 }], ['receive_events', { limit: 0 }],
    ['receive_events', { limit: 101 }], ['receive_events', { room_id: f.room.id }],
    ['ack_events', { batch_id: f.batch.id }], ['ack_events', { ...ackInput, membership_epoch: 'forged' }],
  ]) {
    const result = await mcp.client.callTool({ name, arguments: input });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /Input validation error/);
  }
  assert.equal(fixture.calls.length, 0);
});

test('timeouts, empty progress and visible batches pass unchanged without implicit ack', { timeout: 15000 }, async t => {
  let result = timeout;
  const fixture = await createFixtureServer({ handler: ({ path }) => path.endsWith('/receive')
    ? { schema: 'receive', data: result } : undefined }); t.after(() => fixture.close());
  const mcp = await adapter(t, fixture);
  await mcp.call('join_room', { room_id: f.room.id });
  const quiet = await mcp.call('receive_events');
  assert.deepEqual(quiet.data, timeout);
  // Clients that truncate server instructions still see the loop continue.
  assert.equal(quiet.content.length, 2);
  assert.match(quiet.content[1].text, /call receive_events again/);
  assert.deepEqual(fixture.calls.at(-1).body, { wait_ms: 20000, limit: 50 });
  result = { kind: 'batch', batch: { ...f.batch, events: [], scanned_through: 7 } };
  const progress = await mcp.call('receive_events', { wait_ms: 0, limit: 1 });
  assert.deepEqual(progress.data, result);
  assert.equal(progress.content.length, 1);
  assert.deepEqual(fixture.calls.at(-1).body, { wait_ms: 0, limit: 1 });
  result = { kind: 'batch', batch: f.batch };
  assert.deepEqual((await mcp.call('receive_events')).data, result);
  assert.deepEqual((await mcp.call('receive_events')).data, result);
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/ack')).length, 0);
  assert.equal(mcp.stderr(), '');
});

test('ack forwards captured epoch and caller request ID through HTTP and external retries', { timeout: 15000 }, async t => {
  let attempts = 0;
  const fixture = await createFixtureServer({ handler: ({ path, request }) => {
    if (path.endsWith('/ack') && attempts++ === 0) { request.socket.destroy(); return { handled: true }; }
  } }); t.after(() => fixture.close());
  const mcp = await adapter(t, fixture);
  await mcp.call('join_room', { room_id: f.room.id });
  const expected = { room_id: f.room.id, batch_id: f.batch.id, acknowledged_through: 1 };
  const acked = await mcp.call('ack_events', ackInput);
  assert.deepEqual(acked.data, expected);
  assert.match(acked.content[1].text, /call receive_events again/);
  assert.deepEqual((await mcp.call('ack_events', ackInput)).data, expected);
  const calls = fixture.calls.filter(call => call.path.endsWith('/ack'));
  assert.equal(calls.length, 3);
  for (const call of calls) assert.deepEqual(call.body, { ...ackInput, membership_epoch: f.membership.epoch });
});

test('semantic delivery failures preserve typed codes and do not retry', { timeout: 15000 }, async t => {
  let code = 'INVALID_ACK';
  let retryable = false;
  const fixture = await createFixtureServer({ handler: ({ path }) => {
    if (path.endsWith('/ack') || path.endsWith('/receive')) {
      return { error: new ApiError(code, 'Public delivery failure.', { status: retryable ? 503 : 409, retryable, details: { token: f.token } }) };
    }
  } }); t.after(() => fixture.close());
  const mcp = await adapter(t, fixture);
  await mcp.call('join_room', { room_id: f.room.id });
  for (const next of ['INVALID_ACK', 'MEMBERSHIP_ENDED', 'SESSION_REPLACED']) {
    code = next;
    const result = await mcp.call('ack_events', ackInput);
    assert.equal(result.isError, true);
    assert.deepEqual(result.data, { error: { code, message: 'Public delivery failure.', retryable: false } });
    assert.ok(!JSON.stringify(result).includes(f.token));
  }
  code = 'ALREADY_RECEIVING';
  assert.equal((await mcp.call('receive_events')).data.error.code, code);
  code = 'HUB_BUSY'; retryable = true;
  const transient = await mcp.call('receive_events');
  assert.equal(transient.isError, true);
  assert.deepEqual(transient.data.error, { code, message: 'Public delivery failure.', retryable: true });
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/ack')).length, 3);
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/receive')).length, 2);
});

test('delivery outputs reject foreign room, epoch, batch and malformed or private fields', { timeout: 15000 }, async t => {
  let result;
  const fixture = await createFixtureServer({ handler: ({ path, response }) => {
    if (path.endsWith('/receive') || path.endsWith('/ack')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ version: '1', data: result }));
      return { handled: true };
    }
  } }); t.after(() => fixture.close());
  const mcp = await adapter(t, fixture);
  await mcp.call('join_room', { room_id: f.room.id });
  for (const invalid of [
    { ...timeout, room_id: f.otherRoom.id },
    { kind: 'batch', batch: { ...f.batch, events: [], room_id: f.otherRoom.id } },
    { kind: 'batch', batch: { ...f.batch, membership_epoch: 'old-epoch' } },
    { kind: 'batch', batch: { ...f.batch, token: f.token } },
    { kind: 'batch', batch: { ...f.batch, scanned_through: -1 } },
  ]) {
    result = invalid;
    const response = await mcp.call('receive_events');
    assert.equal(response.isError, true); assert.equal(response.data.error.code, 'INVALID_RESPONSE');
    assert.ok(!JSON.stringify(response).includes(f.token));
  }
  for (const invalid of [
    { room_id: f.otherRoom.id, batch_id: f.batch.id, acknowledged_through: 1 },
    { room_id: f.room.id, batch_id: 'wrong-batch', acknowledged_through: 1 },
    { room_id: f.room.id, batch_id: f.batch.id, acknowledged_through: 1, token: f.token },
  ]) {
    result = invalid;
    assert.equal((await mcp.call('ack_events', ackInput)).data.error.code, 'INVALID_RESPONSE');
  }
});

for (const tool of ['receive_events', 'ack_events']) {
  test(`${tool} cancellation reaches HTTP without extra delivery writes`, { timeout: 15000 }, async t => {
    let reached, disconnected;
    const ready = new Promise(resolve => { reached = resolve; });
    const closed = new Promise(resolve => { disconnected = resolve; });
    const suffix = tool === 'receive_events' ? '/receive' : '/ack';
    const fixture = await createFixtureServer({ handler: ({ path, response }) => {
      if (path.endsWith(suffix)) {
        response.on('close', disconnected);
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders();
        reached(); return { handled: true };
      }
    } }); t.after(() => fixture.close());
    const mcp = await adapter(t, fixture);
    await mcp.call('join_room', { room_id: f.room.id });
    const controller = new AbortController();
    const pending = mcp.call(tool, tool === 'receive_events' ? {} : ackInput, { signal: controller.signal });
    const rejected = assert.rejects(pending, /abort|cancel/i);
    await ready; controller.abort(); await rejected; await closed;
    assert.equal(fixture.calls.length, 2);
  });

  test(`${tool} rejects a completion after leave and rejoin into a new epoch`, { timeout: 15000 }, async t => {
    let reached, release, epoch = f.membership.epoch;
    const ready = new Promise(resolve => { reached = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    const suffix = tool === 'receive_events' ? '/receive' : '/ack';
    const fixture = await createFixtureServer({ handler: async ({ path }) => {
      if (path.endsWith('/join')) return { schema: 'joinRoom', data: { room: f.room, membership: { ...f.membership, epoch }, history: f.history } };
      if (path.endsWith(suffix)) {
        reached(); await released;
        return tool === 'receive_events'
          ? { schema: 'receive', data: timeout }
          : { schema: 'ack', data: { room_id: f.room.id, batch_id: f.batch.id, acknowledged_through: 1 } };
      }
    } }); t.after(() => fixture.close());
    const mcp = await adapter(t, fixture);
    await mcp.call('join_room', { room_id: f.room.id });
    const pending = mcp.call(tool, tool === 'receive_events' ? {} : ackInput);
    await ready;
    await mcp.call('leave_room'); epoch = 'new-epoch';
    await mcp.call('join_room', { room_id: f.room.id });
    release();
    const response = await pending;
    assert.equal(response.isError, true); assert.equal(response.data.error.code, 'MEMBERSHIP_ENDED');
  });
}
