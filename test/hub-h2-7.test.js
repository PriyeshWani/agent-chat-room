import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { RoomClient } from '../src/shared/client.js';
import { createHub } from '../src/hub/main.js';
import { temporaryDirectory, startNode } from './helpers/processes.js';

const entry = new URL('../scripts/hub.js', import.meta.url).pathname;
function browserClient(url, existingCookie) {
  let cookie = existingCookie;
  const client = new RoomClient({ baseUrl: url, fetchImpl: async (input, options = {}) => {
    const response = await fetch(input, { ...options, headers: { ...options.headers, Origin: url, ...(cookie ? { Cookie: cookie } : {}) } });
    const issued = response.headers.get('set-cookie');
    if (issued) cookie = issued.split(';')[0];
    return response;
  } });
  return { client, cookie: () => cookie };
}
async function receiving(browser, roomId, participantId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await browser.listParticipants(roomId);
    if (result.participants.some(item => item.participant.id === participantId && item.delivery === 'receiving')) return;
  }
  assert.fail('Receive did not become active.');
}
async function stop(process, signal = 'SIGTERM') {
  process.child.kill(signal);
  const [code, receivedSignal] = await process.exited;
  assert.equal(code, 0);
  assert.equal(receivedSignal, null);
}

test('real process composes bootstrap, rooms, messages, batches, SSE, restart and clean signal shutdown', { timeout: 20000 }, async t => {
  const filename = join(await temporaryDirectory(t), 'nested', 'hub.sqlite');
  const env = { ROOM_HUB_PORT: '0', ROOM_HUB_DATA: filename };
  const process = await startNode(t, entry, { env });
  const browser = browserClient(process.url);
  const human = await browser.client.browserSession();
  assert.equal(human.participant.kind, 'human');
  assert.ok(browser.cookie().startsWith('acr_session='));
  assert.deepEqual(await browser.client.browserSession(), human);
  assert.equal((await browser.client.health()).status, 'ok');
  const page = await fetch(process.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /conversation/);
  const shared = await fetch(`${process.url}/shared/client.js`);
  assert.equal(shared.status, 200);
  assert.match(shared.headers.get('content-type'), /javascript/);
  await shared.arrayBuffer();
  const room = await browser.client.createRoom({ request_id: 'create', name: 'Integration' });
  assert.deepEqual(await browser.client.createRoom({ request_id: 'create', name: 'Integration' }), room);
  const agent = new RoomClient({ baseUrl: process.url });
  const enrollment = { request_id: 'enroll', mode: 'create', resume_token: 's'.repeat(32), name: 'Integration agent' };
  const session = await agent.agentSession(enrollment);
  const joined = await agent.joinRoom(room.id, { request_id: 'join' });
  assert.equal(joined.history.head_sequence, 0);
  const controller = new AbortController();
  const stream = browser.client.events(room.id, { after: 0, signal: controller.signal });
  const streamed = stream.next();
  const pending = agent.receiveEvents(room.id, { wait_ms: 20000 });
  await receiving(browser.client, room.id, session.participant.id);
  const message = await browser.client.postMessage(room.id, { request_id: 'post', text: 'hello from browser' });
  assert.deepEqual((await streamed).value, message);
  assert.deepEqual(await browser.client.postMessage(room.id, { request_id: 'post', text: 'hello from browser' }), message);
  const batch = await pending;
  assert.deepEqual(batch.batch.events, [message]);
  const acknowledgement = { request_id: 'ack', batch_id: batch.batch.id, membership_epoch: batch.batch.membership_epoch };
  assert.equal((await agent.ackEvents(room.id, acknowledgement)).acknowledged_through, 1);
  const reply = await agent.postMessage(room.id, { request_id: 'reply', text: 'agent reply', reply_to: message.id });
  assert.deepEqual((await stream.next()).value, reply);
  controller.abort();
  await stream.return();
  const retained = await agent.receiveEvents(room.id, { wait_ms: 0 });
  assert.equal(retained.kind, 'batch');
  assert.deepEqual(retained.batch.events, []);
  assert.equal(retained.batch.scanned_through, 2);
  assert.equal((await browser.client.history(room.id)).events.length, 2);
  assert.equal((await browser.client.listRooms()).rooms.length, 1);
  await stop(process);
  assert.equal((process.output().match(/ROOM_HUB_READY /g) ?? []).length, 1);
  assert.ok(!process.output().includes(enrollment.resume_token));
  assert.ok(!process.output().includes(session.token));

  const restarted = await startNode(t, entry, { env });
  const restoredBrowser = browserClient(restarted.url, browser.cookie());
  assert.deepEqual(await restoredBrowser.client.browserSession(), human);
  const restored = new RoomClient({ baseUrl: restarted.url, token: session.token });
  await assert.rejects(restored.listRooms(), { code: 'SESSION_EXPIRED' });
  const statuses = await restoredBrowser.client.listParticipants(room.id);
  const stale = statuses.participants.find(item => item.participant.id === session.participant.id);
  assert.equal(stale.connection, 'disconnected');
  assert.equal(stale.activity, null);
  const resumed = await restored.agentSession({ ...enrollment, mode: 'resume', request_id: 'resume' });
  assert.equal(resumed.participant.id, session.participant.id);
  assert.equal(resumed.connection.generation, session.connection.generation + 1);
  assert.deepEqual(await restored.receiveEvents(room.id, { wait_ms: 0 }), retained);
  await restored.ackEvents(room.id, { request_id: 'ack-retained', batch_id: retained.batch.id, membership_epoch: retained.batch.membership_epoch });
  assert.deepEqual((await restoredBrowser.client.history(room.id)).events, [message, reply]);
  const waiting = restored.receiveEvents(room.id, { wait_ms: 20000 }).then(() => 'resolved', () => 'cancelled');
  await receiving(restoredBrowser.client, room.id, resumed.participant.id);
  let opened;
  const ready = new Promise(resolve => { opened = resolve; });
  const live = restoredBrowser.client.events(room.id, { after: 2, onOpen: opened });
  const streaming = live.next().then(() => 'ended', () => 'cancelled');
  await ready;
  await stop(restarted, 'SIGINT');
  assert.equal(await waiting, 'cancelled');
  assert.ok(['ended', 'cancelled'].includes(await streaming));
  await live.return();
});

test('import-safe factory closes idempotently and releases resources after construction failure', { timeout: 10000 }, async t => {
  const filename = join(await temporaryDirectory(t), 'hub.sqlite');
  const first = await createHub({ filename });
  t.after(() => first.close());
  const port = Number(new URL(first.url).port);
  await assert.rejects(createHub({ filename, port }), { code: 'EADDRINUSE' });
  await assert.rejects(createHub({ filename, bootId: '' }), /bootId/);
  const close = first.close();
  assert.equal(first.close(), close);
  await close;
  const reopened = await createHub({ filename, port });
  assert.equal((await new RoomClient({ baseUrl: reopened.url }).health()).status, 'ok');
  await reopened.close();
});
