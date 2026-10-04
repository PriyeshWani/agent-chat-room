import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory, startNode, connectMcp } from './helpers/processes.js';
import { browserClient } from './helpers/browser-client.js';
import { Outputs } from '../src/shared/schemas.js';
import { participationGuidance } from '../src/runtime/participation.js';

const hubScript = fileURLToPath(new URL('../scripts/hub.js', import.meta.url));
const adapterScript = fileURLToPath(new URL('../src/mcp/main.js', import.meta.url));
async function hub(t, filename, port = 0) {
  return startNode(t, hubScript, { env: { ROOM_HUB_DATA: filename, ROOM_HUB_PORT: String(port) } });
}
async function adapter(t, url, name, sessionFile, resume = false) {
  return connectMcp(t, adapterScript, { env: {
    ROOM_HUB_URL: url, ROOM_AGENT_NAME: name, ROOM_WORKSPACE: process.cwd(),
    ROOM_SESSION_FILE: sessionFile, ROOM_RESUME: resume ? '1' : '0',
  } });
}
async function call(peer, name, args = {}) {
  const result = await peer.call(name, args);
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.data)}`);
  return result.data;
}
async function ack(peer, batch, requestId) {
  return call(peer, 'ack_events', { request_id: requestId, batch_id: batch.id });
}

test('G1 real hub and two stdio adapters share human and peer messages with independent progress', { timeout: 20000 }, async t => {
  const directory = await temporaryDirectory(t);
  const server = await hub(t, join(directory, 'hub.sqlite'));
  const human = await browserClient(server.url);
  const otherTab = await browserClient(server.url);
  assert.equal(otherTab.participant.id, human.participant.id);
  const room = await human.client.createRoom({ name: 'discussion', request_id: 'create-a' });
  const other = await human.client.createRoom({ name: 'separate', request_id: 'create-b' });
  const alice = await adapter(t, server.url, 'Alice agent', join(directory, 'alice.json'));
  const bob = await adapter(t, server.url, 'Bob agent', join(directory, 'bob.json'));
  const aj = await call(alice, 'join_room', { room_id: room.id });
  const bj = await call(bob, 'join_room', { room_id: room.id });
  assert.notEqual(aj.membership.participant_id, bj.membership.participant_id);
  const receivingA = call(alice, 'receive_events', { wait_ms: 1000 });
  const receivingB = call(bob, 'receive_events', { wait_ms: 1000 });
  const message = await human.client.postMessage(room.id, { request_id: 'human-message', text: '@Alice agent compare these approaches.', mention_ids: [aj.membership.participant_id] });
  assert.deepEqual(message.payload.mentions, [{ id: aj.membership.participant_id, name: 'Alice agent', kind: 'agent' }]);
  const [firstA, firstB] = await Promise.all([receivingA, receivingB]);
  assert.equal(firstA.kind, 'batch'); assert.equal(firstB.kind, 'batch');
  assert.deepEqual(firstA.batch.events, [message]); assert.deepEqual(firstB.batch.events, [message]);
  await ack(alice, firstA.batch, 'alice-ack-1');
  assert.deepEqual(await call(bob, 'receive_events', { wait_ms: 0 }), firstB);
  const replyA = await call(alice, 'post_message', { request_id: 'alice-reply', text: '@Bob agent first approach.', reply_to: message.id, mention_ids: [bj.membership.participant_id] });
  assert.equal(replyA.payload.mentions[0].id, bj.membership.participant_id);
  const replyB = await call(bob, 'post_message', { request_id: 'bob-reply', text: 'Alternative approach.', reply_to: message.id });
  assert.notEqual(replyA.id, replyB.id);
  await ack(bob, firstB.batch, 'bob-ack-1');
  const peersA = await call(alice, 'receive_events', { wait_ms: 0 });
  const peersB = await call(bob, 'receive_events', { wait_ms: 0 });
  assert.deepEqual(peersA.batch.events, [replyB]);
  assert.deepEqual(peersB.batch.events, [replyA]);
  await ack(alice, peersA.batch, 'alice-ack-2');
  await ack(bob, peersB.batch, 'bob-ack-2');

  const isolated = await alice.call('join_room', { room_id: other.id });
  assert.equal(isolated.data.error.code, 'ACTIVE_ROOM_CONFLICT');
  assert.equal((await human.client.history(other.id)).events.length, 0);
  const history = await otherTab.client.history(room.id);
  assert.deepEqual(Outputs.history.parse(history).events, [message, replyA, replyB]);
  const statuses = await human.client.listParticipants(room.id);
  assert.equal(statuses.participants.length, 3);
  assert.ok(statuses.participants.every(item => item.pending_count === 0));

  await alice.client.close();
  const followup = await human.client.postMessage(room.id, { request_id: 'still-running', text: 'Bob can still receive.' });
  const remaining = await call(bob, 'receive_events', { wait_ms: 0 });
  assert.deepEqual(remaining.batch.events, [followup]);
  assert.equal((await human.client.health()).status, 'ok');
});

test('G1 peer questions and threaded replies arrive without intervening human messages', { timeout: 15000 }, async t => {
  const directory = await temporaryDirectory(t);
  const server = await hub(t, join(directory, 'hub.sqlite'));
  const human = await browserClient(server.url);
  const room = await human.client.createRoom({ name: 'Peer review' });
  const alice = await adapter(t, server.url, 'Alice', join(directory, 'alice.json'));
  const bob = await adapter(t, server.url, 'Bob', join(directory, 'bob.json'));
  assert.equal(alice.client.getInstructions(), participationGuidance);
  assert.equal(bob.client.getInstructions(), participationGuidance);
  await call(alice, 'join_room', { room_id: room.id });
  await call(bob, 'join_room', { room_id: room.id });
  const bobWaiting = call(bob, 'receive_events', { wait_ms: 1000 });
  const question = await call(alice, 'post_message', { request_id: 'peer-question', text: 'Bob, how would you test duplicate delivery?' });
  const first = await bobWaiting;
  assert.deepEqual(first.batch.events, [question]);
  await ack(bob, first.batch, 'bob-ack-question');
  const response = await call(bob, 'post_message', { request_id: 'peer-response', text: 'Retry the same request ID after losing the response, then count stored events.', reply_to: question.id });
  const second = await call(alice, 'receive_events', { wait_ms: 0 });
  assert.deepEqual(second.batch.events, [response]);
  await ack(alice, second.batch, 'alice-ack-response');
  const review = await call(alice, 'post_message', { request_id: 'peer-review', text: 'That covers replay. Also vary the payload to check conflict detection.', reply_to: response.id });
  const third = await call(bob, 'receive_events', { wait_ms: 0 });
  assert.deepEqual(third.batch.events, [review]);
  await ack(bob, third.batch, 'bob-ack-review');
  const history = (await human.client.history(room.id)).events;
  assert.deepEqual(history, [question, response, review]);
  assert.ok(history.every(event => event.author.kind === 'agent'));
});

test('G1 actual committed-response loss stores one message and SSE fills the snapshot boundary', { timeout: 15000 }, async t => {
  const directory = await temporaryDirectory(t);
  const server = await hub(t, join(directory, 'hub.sqlite'));
  const human = await browserClient(server.url);
  const room = await human.client.createRoom({ name: 'replay' });
  const snapshot = await human.client.history(room.id);
  const originalFetch = human.client.fetchImpl;
  const bodies = [];
  let lost = false;
  human.client.fetchImpl = async (url, options) => {
    const response = await originalFetch(url, options);
    if (new URL(url).pathname.endsWith('/messages')) {
      bodies.push(options.body);
      if (!lost) {
        lost = true;
        await response.arrayBuffer(); // The actual server has completed the commit.
        throw new TypeError('Test-owned response loss after commit');
      }
    }
    return response;
  };
  const posted = await human.client.postMessage(room.id, { request_id: 'lost-response', text: 'Store once.' });
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  assert.deepEqual((await human.client.history(room.id)).events, [posted]);
  await assert.rejects(human.client.postMessage(room.id, { request_id: 'lost-response', text: 'Changed input.' }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = human.client.events(room.id, { after: snapshot.head_sequence, signal: controller.signal });
  assert.deepEqual((await stream.next()).value, posted);
  controller.abort();
  await stream.return();
});

test('G1 hub restart retains pending delivery and explicit adapter resume fences the obsolete process', { timeout: 20000 }, async t => {
  const directory = await temporaryDirectory(t);
  const filename = join(directory, 'hub.sqlite');
  const first = await hub(t, filename);
  const human = await browserClient(first.url);
  const room = await human.client.createRoom({ name: 'durable' });
  const sessionFile = join(directory, 'agent.json');
  const original = await adapter(t, first.url, 'Durable agent', sessionFile);
  const joined = await call(original, 'join_room', { room_id: room.id });
  const message = await human.client.postMessage(room.id, { text: 'Retain this batch.' });
  const pending = await call(original, 'receive_events', { wait_ms: 0 });
  assert.deepEqual(pending.batch.events, [message]);
  first.child.kill('SIGTERM'); await first.exited;
  const second = await hub(t, filename, Number(new URL(first.url).port));
  assert.equal(second.url, first.url);
  assert.deepEqual((await human.client.history(room.id)).events, [message]);
  // The original running adapter recovers an expired boot through its lifecycle.
  assert.deepEqual(await call(original, 'receive_events', { wait_ms: 0 }), pending);
  const replacement = await adapter(t, second.url, 'Durable agent', sessionFile, true);
  const rejoined = await call(replacement, 'join_room', { room_id: room.id });
  assert.equal(rejoined.membership.participant_id, joined.membership.participant_id);
  assert.equal(rejoined.membership.epoch, joined.membership.epoch);
  const obsolete = await original.call('read_history');
  assert.equal(obsolete.isError, true);
  assert.equal(obsolete.data.error.code, 'SESSION_REPLACED');
  assert.deepEqual(await call(replacement, 'receive_events', { wait_ms: 0 }), pending);
  await ack(replacement, pending.batch, 'after-resume-ack');
  const idle = await call(replacement, 'receive_events', { wait_ms: 0 });
  assert.equal(idle.kind, 'timeout');
  assert.equal(idle.acknowledged_through, message.sequence);
});
