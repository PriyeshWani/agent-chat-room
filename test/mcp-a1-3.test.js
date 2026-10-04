import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError } from '../src/shared/protocol.js';
import * as f from '../src/shared/fixtures.js';
import { createFixtureServer } from './helpers/fixture-server.js';
import { temporaryDirectory, connectMcp } from './helpers/processes.js';

async function adapter(t, fixture) {
  const entry = join(await temporaryDirectory(t), 'entry.mjs');
  await writeFile(entry, `
    import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
    import { createMcpServer } from ${JSON.stringify(new URL('../src/mcp/server.js', import.meta.url).href)};
    import { registerRoomTools } from ${JSON.stringify(new URL('../src/mcp/tools/rooms.js', import.meta.url).href)};
    import { registerMessageTools } from ${JSON.stringify(new URL('../src/mcp/tools/messages.js', import.meta.url).href)};
    import { RoomClient } from ${JSON.stringify(new URL('../src/shared/client.js', import.meta.url).href)};
    const client = new RoomClient({ baseUrl: process.env.FIXTURE_URL, token: process.env.FIXTURE_TOKEN });
    await createMcpServer({ client, toolGroups: [registerRoomTools, registerMessageTools] }).connect(new StdioServerTransport());
  `);
  return connectMcp(t, entry, { env: { FIXTURE_URL: fixture.url, FIXTURE_TOKEN: f.token } });
}

test('publishing requires active membership and an explicit caller request ID', { timeout: 15000 }, async t => {
  const fixture = await createFixtureServer(); t.after(() => fixture.close());
  const mcp = await adapter(t, fixture);
  const { tools } = await mcp.client.listTools();
  assert.deepEqual(tools.find(tool => tool.name === 'post_message').inputSchema.required.sort(), ['request_id', 'text']);
  const missing = await mcp.call('post_message', { request_id: 'post', text: 'hi' });
  assert.equal(missing.data.error.code, 'MEMBERSHIP_ENDED');
  for (const input of [{ text: 'hi' }, { request_id: 'post', text: ' ' }, { request_id: 'post', text: 'hi', room_id: f.room.id }]) {
    const result = await mcp.client.callTool({ name: 'post_message', arguments: input });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Input validation error/);
  }
  assert.equal(fixture.calls.length, 0);
});

test('two replies to the same parent retain separate IDs and uncertain retries preserve normalized bodies', { timeout: 15000 }, async t => {
  let attempts = 0;
  const fixture = await createFixtureServer({ handler: ({ path, request }) => {
    if (path.endsWith('/messages') && attempts++ === 0) { request.socket.destroy(); return { handled: true }; }
  } }); t.after(() => fixture.close());
  const mcp = await adapter(t, fixture);
  await mcp.call('join_room', { room_id: f.room.id });
  const one = { request_id: 'reply1', text: ' first reply ', reply_to: f.event.id };
  const first = await mcp.call('post_message', one);
  assert.equal(first.isError, undefined);
  assert.equal(first.data.room_id, f.room.id);
  assert.equal(first.data.payload.text, 'first reply');
  assert.equal(first.data.payload.reply_to, f.event.id);
  assert.deepEqual((await mcp.call('post_message', one)).data, first.data);
  const two = { request_id: 'reply2', text: 'second reply', reply_to: f.event.id };
  const second = await mcp.call('post_message', two);
  assert.equal(second.data.payload.reply_to, f.event.id);
  const calls = fixture.calls.filter(call => call.path.endsWith('/messages'));
  assert.equal(calls.length, 4);
  for (const call of calls.slice(0, 3)) assert.deepEqual(call.body, { ...one, text: 'first reply' });
  assert.deepEqual(calls[3].body, two);
  assert.equal(mcp.stderr(), '');
});

test('typed conflicts are public and untrusted output fields or attribution are rejected', { timeout: 15000 }, async t => {
  let result = { error: new ApiError('IDEMPOTENCY_CONFLICT', 'Request conflict.', { status: 409, details: { token: f.token } }) };
  const fixture = await createFixtureServer({ handler: ({ path, response }) => {
    if (!path.endsWith('/messages')) return;
    if (result.error) return result;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ version: '1', data: result }));
    return { handled: true };
  } }); t.after(() => fixture.close());
  const mcp = await adapter(t, fixture);
  await mcp.call('join_room', { room_id: f.room.id });
  const input = { request_id: 'post', text: 'text' };
  const conflict = await mcp.call('post_message', input);
  assert.deepEqual(conflict.data, { error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Request conflict.', retryable: false } });
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/messages')).length, 1);
  assert.ok(!JSON.stringify(conflict).includes(f.token));
  for (const invalid of [
    { ...f.event, room_id: f.otherRoom.id },
    { ...f.event, payload: { ...f.event.payload, reply_to: 'unexpected-parent' } },
    { ...f.event, token: f.token },
    { ...f.event, author: { ...f.event.author, token: f.token } },
    { ...f.event, sequence: -1 },
  ]) {
    result = invalid;
    const output = await mcp.call('post_message', input);
    assert.equal(output.isError, true);
    assert.equal(output.data.error.code, 'INVALID_RESPONSE');
    assert.ok(!JSON.stringify(output).includes(f.token));
  }
});

test('cancellation reaches HTTP without an extra post', { timeout: 15000 }, async t => {
  let reached, disconnected;
  const ready = new Promise(resolve => { reached = resolve; });
  const closed = new Promise(resolve => { disconnected = resolve; });
  const fixture = await createFixtureServer({ handler: ({ path, response }) => {
    if (path.endsWith('/messages')) {
      response.on('close', disconnected);
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders();
      reached(); return { handled: true };
    }
  } }); t.after(() => fixture.close());
  const mcp = await adapter(t, fixture);
  await mcp.call('join_room', { room_id: f.room.id });
  const controller = new AbortController();
  const pending = mcp.call('post_message', { request_id: 'cancelled-post', text: 'text' }, { signal: controller.signal });
  const rejected = assert.rejects(pending, /abort|cancel/i);
  await ready; controller.abort(); await rejected; await closed;
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/messages')).length, 1);
});

test('a committed post returns its original room after selection changes while sending', { timeout: 15000 }, async t => {
  let reached, release;
  const ready = new Promise(resolve => { reached = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  const committed = { ...f.event, payload: { text: 'original room', reply_to: null } };
  const fixture = await createFixtureServer({ handler: async ({ path }) => {
    if (path.endsWith('/messages')) {
      reached(); await released;
      return { schema: 'postMessage', data: committed };
    }
  } }); t.after(() => fixture.close());
  const mcp = await adapter(t, fixture);
  await mcp.call('join_room', { room_id: f.room.id });
  const pending = mcp.call('post_message', { request_id: 'post', text: 'original room' });
  await ready;
  await mcp.call('leave_room');
  await mcp.call('join_room', { room_id: f.otherRoom.id });
  release();
  const result = await pending;
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.data, committed);
  const posts = fixture.calls.filter(call => call.path.endsWith('/messages'));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, `/rooms/${f.room.id}/messages`);
});
