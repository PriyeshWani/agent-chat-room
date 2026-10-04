import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createHub } from '../src/hub/main.js';
import { browserClient } from './helpers/browser-client.js';
import { connectMcp } from './helpers/processes.js';
import { mountChatroom } from '../public/chatroom/app.js';
import { teamworkGuidance } from '../src/runtime/participation.js';

const entry = fileURLToPath(new URL('../src/mcp/main.js', import.meta.url));
const html = readFileSync(new URL('../public/chatroom/index.html', import.meta.url), 'utf8');
async function call(peer, tool, args = {}) {
  const response = await peer.call(tool, args);
  assert.ok(!response.isError, JSON.stringify(response.data));
  return response.data;
}

test('two real MCP agents contend for one task, exchange review evidence, and update the browser task board', { timeout: 15000 }, async t => {
  const hub = await createHub({ filename: ':memory:' }); t.after(() => hub.close());
  const human = await browserClient(hub.url);
  const room = await human.client.createRoom({ name: 'Work together' });
  const peer = name => connectMcp(t, entry, { env: { ROOM_HUB_URL: hub.url, ROOM_AGENT_NAME: name, ROOM_WORKSPACE: process.cwd() } });
  const alice = await peer('Alice'), bob = await peer('Bob');
  for (const agent of [alice, bob]) {
    assert.ok(agent.client.getInstructions().includes(teamworkGuidance));
    const beforeJoin = await agent.call('list_tasks', {});
    assert.equal(beforeJoin.data.error.code, 'MEMBERSHIP_ENDED');
    await call(agent, 'join_room', { room_id: room.id });
  }
  const question = await human.client.postMessage(room.id, { text: 'Try a loss-and-retry experiment and review it together.' });
  const created = await call(alice, 'create_task', { request_id: 'proposal', title: '<script>Retry experiment</script>',
    scope: 'Lose one response after commit; verify event count.', source_message_id: question.id });
  const claim = { request_id: 'claim', task_id: created.task.id, expected_version: 1 };
  const claims = await Promise.all([alice.call('claim_task', claim), bob.call('claim_task', claim)]);
  assert.equal(claims.filter(result => !result.isError).length, 1);
  const winnerIndex = claims.findIndex(result => !result.isError), winner = [alice, bob][winnerIndex], reviewer = [bob, alice][winnerIndex];
  const owned = claims[winnerIndex].data.task;
  assert.equal(claims[1 - winnerIndex].data.error.code, 'TASK_CLAIMED');
  const attempt = await reviewer.call('update_task', { request_id: 'unauthorized', task_id: owned.id, expected_version: 2, status: 'completed', latest_update: 'Done', result: 'Claim' });
  assert.equal(attempt.data.error.code, 'TASK_NOT_OWNER');

  const { document, window } = parseHTML(html);
  const app = await mountChatroom({ document, client: human.client }); t.after(() => app.destroy());
  await app.tasks.refresh();
  const $ = id => document.getElementById(id);
  assert.match($('tasks-list').textContent, /Retry experiment/);
  assert.equal($('tasks-list').querySelector('script'), null);
  assert.match($('tasks-count').textContent, /1 active · 1 total/);
  assert.match($('tasks-list').textContent, new RegExp(owned.owner.name));
  $('message-input').value = 'Draft stays here'; $('message-input').dispatchEvent(new window.Event('input'));
  $('tasks-list').querySelector('details').setAttribute('open', '');

  const reportInput = { request_id: 'report', task_id: owned.id, expected_version: 2, status: 'in_review',
    latest_update: 'Please review whether a different body conflicts.', worker_ref: 'worker-1',
    result: 'SDK experiment: dropped committed response, retried identical request, observed one event.' };
  const report = await call(winner, 'update_task', reportInput);
  assert.deepEqual(await call(winner, 'update_task', reportInput), report);
  const delivered = await call(reviewer, 'receive_events', { wait_ms: 0 });
  assert.ok(delivered.batch.events.some(event => event.id === report.event.id));
  await call(reviewer, 'ack_events', { request_id: 'ack', batch_id: delivered.batch.id });
  await call(reviewer, 'post_message', { request_id: 'review', text: 'The same request ID with a changed body must conflict; I checked that case.', reply_to: report.event.id });
  assert.equal((await call(reviewer, 'list_tasks')).tasks[0].status, 'in_review'); // Peer comment does not accept or finish the task.
  await app.tasks.refresh();
  assert.equal($('message-input').value, 'Draft stays here');
  assert.ok($('tasks-list').querySelector('details').hasAttribute('open'));
  assert.match($('tasks-list').textContent, /Ready for review/);
  assert.match($('tasks-list').textContent, /worker-1/);
  assert.match($('tasks-list').textContent, /observed one event/);
  assert.equal($('tasks-list').querySelector('a').getAttribute('href'), `#message-${question.id}`);
  await call(winner, 'update_task', { request_id: 'done', task_id: owned.id, expected_version: 3, status: 'completed', latest_update: 'Review feedback incorporated.' });
  await app.tasks.refresh();
  assert.match($('tasks-count').textContent, /0 active · 1 total/);
  $('tasks-filter').click(); assert.match($('tasks-list').textContent, /No active tasks/);
  $('tasks-filter').click(); assert.match($('tasks-list').textContent, /Completed/);

  const other = await human.client.createRoom({ name: 'Other tasks' });
  await app.rooms.select(other.id); await app.tasks.refresh();
  assert.doesNotMatch($('tasks-list').textContent, /Retry experiment/);
  assert.match($('tasks-list').textContent, /No tasks reported/);
  assert.equal((await human.client.listTasks(room.id)).tasks.length, 1);
  const events = (await human.client.history(room.id)).events;
  assert.equal(events.filter(event => event.payload.text.startsWith('Task ')).length, 4);
  assert.ok(events.some(event => event.payload.reply_to === report.event.id));
});

test('a lost committed task HTTP response retries without creating another task or milestone', async t => {
  const hub = await createHub({ filename: ':memory:' }); t.after(() => hub.close());
  const { client } = await browserClient(hub.url);
  const room = await client.createRoom({ name: 'Task retry' });
  const fetchImpl = client.fetchImpl;
  let lost = false; const bodies = [];
  client.fetchImpl = async (url, options) => {
    const response = await fetchImpl(url, options);
    if (new URL(url).pathname.endsWith('/tasks') && options.method === 'POST') {
      bodies.push(options.body);
      if (!lost) { lost = true; await response.arrayBuffer(); throw new TypeError('Test-owned lost committed response'); }
    }
    return response;
  };
  const result = await client.createTask(room.id, { title: 'Exactly once', scope: 'Test retry body stability.' });
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  assert.deepEqual((await client.listTasks(room.id)).tasks, [result.task]);
  assert.deepEqual((await client.history(room.id)).events, [result.event]);
});
