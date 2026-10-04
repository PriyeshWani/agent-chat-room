import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RoomClient, ApiError } from '../src/shared/client.js';
import { Inputs, Outputs, ReceiveResult, Participant, Batch, History, JoinResult } from '../src/shared/schemas.js';
import { canonical } from '../src/shared/protocol.js';
import * as f from '../src/shared/fixtures.js';
import { createFixtureServer } from './helpers/fixture-server.js';

test('public schemas reject secrets, forged authors, and inconsistent room progress', () => {
  Participant.parse(f.agent);
  assert.equal(Participant.safeParse({ ...f.agent, token: 'private' }).success, false);
  assert.equal(Inputs.postMessage.safeParse({ request_id: 'r1', text: 'Hi', author_id: 'other' }).success, false);
  ReceiveResult.parse({ kind: 'timeout', room_id: f.room.id, acknowledged_through: 0 });
  ReceiveResult.parse({ kind: 'batch', batch: { ...f.batch, events: [] } });
  assert.equal(ReceiveResult.safeParse({ kind: 'timeout', batch: f.batch }).success, false);
  assert.equal(Inputs.receive.safeParse({ wait_ms: 20001 }).success, false);
  assert.equal(Batch.safeParse({ ...f.batch, scanned_through: 0 }).success, false);
  assert.equal(History.safeParse({ ...f.history, room: f.otherRoom }).success, false);
  assert.equal(JoinResult.safeParse({ room: f.room, history: f.history, membership: { ...f.membership, room_id: f.otherRoom.id } }).success, false);
  assert.equal(canonical({ b: 1, a: { c: 2 } }), canonical({ a: { c: 2 }, b: 1 }));
});

test('portable client consumes schema-valid fixtures for two distinct rooms', async t => {
  const fixture = await createFixtureServer(); t.after(() => fixture.close());
  const client = new RoomClient({ baseUrl: fixture.url });
  Outputs.health.parse(await client.health());
  const session = await client.agentSession({ mode: 'create', resume_token: 's'.repeat(40), name: 'API agent' });
  assert.equal(client.token, session.token);
  assert.equal((await client.listRooms()).rooms.length, 2);
  for (const room of [f.room, f.otherRoom]) {
    const joined = Outputs.joinRoom.parse(await client.joinRoom(room.id));
    assert.equal(joined.room.id, room.id);
    assert.equal((await client.history(room.id)).room.id, room.id);
    const message = await client.postMessage(room.id, { text: ' Hello ' });
    assert.equal(message.room_id, room.id); assert.equal(message.payload.text, 'Hello');
    assert.equal((await client.receiveEvents(room.id, { wait_ms: 0 })).kind, 'timeout');
    Outputs.leaveRoom.parse(await client.leaveRoom(room.id, { membership_epoch: joined.membership.epoch }));
  }
  assert.ok(fixture.calls.filter(call => call.path.startsWith('/rooms')).every(call => call.headers.authorization === `Bearer ${f.token}`));
  await assert.rejects(client.joinRoom('missing'), error => error.code === 'NOT_FOUND');
});

test('default browser fetch keeps its global receiver for bootstrap and live events', async t => {
  const fixture = await createFixtureServer({ handler: ({ path, response }) => {
    if (path.endsWith('/stream')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(f.event)}\n\n`);
      return { handled: true };
    }
  } });
  t.after(() => fixture.close());
  const nativeFetch = globalThis.fetch;
  let calls = 0;
  // Node's fetch tolerates foreign receivers. Model the browser Web API's
  // receiver requirement so default-client coverage catches unbound calls.
  t.mock.method(globalThis, 'fetch', function (...args) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    calls++;
    return Reflect.apply(nativeFetch, globalThis, args);
  });
  const client = new RoomClient({ baseUrl: fixture.url });
  assert.deepEqual(await client.browserSession(), { participant: f.human });
  const events = [];
  for await (const event of client.events(f.room.id)) events.push(event);
  assert.deepEqual(events, [f.event]);
  assert.equal(calls, 2);
});

test('uncertain message transport retries preserve the request ID and complete body', async t => {
  let attempts = 0;
  const fixture = await createFixtureServer({ handler: ({ path, request }) => {
    if (path.endsWith('/messages') && attempts++ === 0) { request.socket.destroy(); return { handled: true }; }
  } }); t.after(() => fixture.close());
  const client = new RoomClient({ baseUrl: fixture.url });
  await client.postMessage(f.room.id, { text: 'Retry me' });
  const calls = fixture.calls.filter(call => call.path.endsWith('/messages'));
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].body, calls[1].body); assert.ok(calls[0].body.request_id);
});

test('semantic conflicts do not trigger reconnect or write retries', async t => {
  const fixture = await createFixtureServer({ handler: () => ({ error: new ApiError('SESSION_REPLACED', 'Use the replacement session.', { status: 409 }) }) });
  t.after(() => fixture.close());
  await assert.rejects(new RoomClient({ baseUrl: fixture.url }).listRooms(), error => error.code === 'SESSION_REPLACED');
  assert.equal(fixture.calls.length, 1);
});

test('aborted receive is not retried or implicitly acknowledged', async t => {
  let reached;
  const ready = new Promise(resolve => { reached = resolve; });
  const fixture = await createFixtureServer({ handler: ({ path, response }) => {
    if (path.endsWith('/receive')) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.flushHeaders(); reached(); return { handled: true }; }
  } }); t.after(() => fixture.close());
  const controller = new AbortController();
  const pending = new RoomClient({ baseUrl: fixture.url }).receiveEvents(f.room.id, {}, { signal: controller.signal });
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  await ready; controller.abort(); await rejected;
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/receive')).length, 1);
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/ack')).length, 0);
});

test('malformed envelopes become typed errors and body cancellation stays cancellation', async () => {
  const bad = new RoomClient({ baseUrl: 'http://fixture', fetchImpl: async () => new Response('null', { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(bad.health(), error => error.code === 'INVALID_RESPONSE');
  const abort = new DOMException('Cancelled', 'AbortError');
  const cancelled = new RoomClient({ baseUrl: 'http://fixture', fetchImpl: async () => ({ status: 200, json: async () => { throw abort; } }) });
  await assert.rejects(cancelled.health(), error => error === abort);
});

function streamClient(chunks) {
  const encoder = new TextEncoder();
  return new RoomClient({ baseUrl: 'http://fixture', fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); },
  }), { headers: { 'Content-Type': 'text/event-stream' } }) });
}

test('SSE parses split CRLF frames and skips comments', async () => {
  const chunks = [': heartbeat\r', '\n\r\nid: 1\r\nevent: room_event\r\ndata: ', JSON.stringify(f.event), '\r', '\n\r', '\n'];
  const events = [];
  for await (const event of streamClient(chunks).events(f.room.id)) events.push(event);
  assert.deepEqual(events, [f.event]);
});

test('SSE reports a validated open connection before a quiet room has events', async t => {
  const fixture = await createFixtureServer({ handler: ({ path, response }) => {
    if (path.endsWith('/stream')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.flushHeaders();
      return { handled: true };
    }
  } });
  t.after(() => fixture.close());
  const controller = new AbortController();
  let opened;
  const ready = new Promise(resolve => { opened = resolve; });
  const iterator = new RoomClient({ baseUrl: fixture.url }).events(f.room.id, { signal: controller.signal, onOpen: opened });
  const pending = iterator.next();
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  await ready;
  controller.abort();
  await rejected;
});

test('SSE rejects malformed, incomplete, foreign-room and oversized events', async () => {
  for (const data of ['null', '{', JSON.stringify({ room_id: f.room.id, sequence: 1 }), JSON.stringify({ ...f.event, room_id: f.otherRoom.id })]) {
    await assert.rejects(async () => { for await (const event of streamClient([`data: ${data}\n\n`]).events(f.room.id)) assert.fail(JSON.stringify(event)); }, error => error.code === 'INVALID_RESPONSE');
  }
  await assert.rejects(async () => { for await (const event of streamClient([`:${'x'.repeat(65537)}\n\n`]).events(f.room.id)) assert.fail(JSON.stringify(event)); }, error => error.code === 'INVALID_RESPONSE');
});
