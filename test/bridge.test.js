import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const bridge = fileURLToPath(new URL('../src/bridge.js', import.meta.url));

async function eventually(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail('Condition did not become true within one second.');
}

async function start(t) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [bridge], env: { CHAT_BRIDGE_PORT: '0' }, stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = new Client({ name: 'sdk-test-client', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const url = stderr.match(/Local MCP probe: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  assert.ok(url, `Bridge must announce its loopback URL on stderr: ${stderr}`);
  const state = async () => (await fetch(`${url}/api/state`)).json();
  const post = async (text) => {
    const response = await fetch(`${url}/api/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    assert.equal(response.status, 201);
    return response.json();
  };
  const call = (name, args, options) => client.callTool({ name, arguments: args }, undefined, options);
  await eventually(async () => (await state()).client?.name === 'sdk-test-client');
  return { client, url, state, post, call };
}

function data(response) {
  assert.notEqual(response.isError, true, JSON.stringify(response));
  return JSON.parse(response.content[0].text);
}

test('HTTP → waiting MCP tool → MCP reply → HTTP, with a real child process', { timeout: 10000 }, async (t) => {
  const { client, state, post, call, url } = await start(t);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['receive_message', 'send_message']);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Local MCP round-trip/);
  assert.equal((await fetch(`${url}/app.js`)).status, 200);
  assert.equal((await fetch(`${url}/style.css`)).status, 200);

  const receiving = call('receive_message', { after_id: 0, wait_ms: 20000 });
  await eventually(async () => (await state()).waiting === 1);
  const sent = await post('Hello from the browser 👋');
  const received = data(await receiving);
  assert.equal(received.messages[0].text, sent.text);
  assert.equal(received.messages[0].id, sent.id);
  assert.equal(received.next_after_id, sent.id);
  assert.equal(received.timed_out, false);

  const reply = { text: 'Reply from the SDK test client (no model).', in_reply_to: sent.id };
  data(await call('send_message', reply));
  data(await call('send_message', reply));
  const observed = await state();
  assert.equal(observed.replies.length, 1, 'An identical retry must not duplicate the reply.');
  assert.equal(observed.replies[0].text, reply.text);
  assert.ok(observed.messages[0].delivered_at);
  assert.equal(observed.waiting, 0);
  assert.equal((await call('send_message', { ...reply, text: 'Different retry' })).isError, true);
});

test('queued messages, cursor replay, timeout, and independent outbound messages', { timeout: 10000 }, async (t) => {
  const { post, call, state } = await start(t);
  await post('First');
  await post('Second');
  const initial = data(await call('receive_message', { after_id: 0, wait_ms: 0 }));
  assert.deepEqual(initial.messages.map((message) => message.text), ['First', 'Second']);
  const replay = data(await call('receive_message', { after_id: 1, wait_ms: 0 }));
  assert.deepEqual(replay.messages.map((message) => message.text), ['Second']);
  const empty = data(await call('receive_message', { after_id: 2, wait_ms: 30 }));
  assert.deepEqual(empty, { messages: [], next_after_id: 2, timed_out: true });
  assert.equal((await call('receive_message', { after_id: 3, wait_ms: 0 })).isError, true);
  data(await call('send_message', { text: 'I can send before being asked.' }));
  assert.equal((await state()).replies[0].in_reply_to, null);
});

test('multiple round trips continue after a reply, a quiet timeout, and queued input', { timeout: 10000 }, async (t) => {
  const { post, call, state } = await start(t);
  let cursor = 0;
  for (let round = 1; round <= 3; round++) {
    // The next message can arrive while the client is waiting or between receive calls.
    if (round === 3) await post(`Question ${round}`);
    const pending = call('receive_message', { after_id: cursor, wait_ms: 20000 });
    if (round !== 3) {
      await eventually(async () => (await state()).waiting === 1);
      await post(`Question ${round}`);
    }
    const received = data(await pending);
    assert.equal(received.messages.length, 1, 'Previously answered messages must not be replayed.');
    const message = received.messages[0];
    assert.equal(message.text, `Question ${round}`);
    data(await call('send_message', { text: `Answer ${round}`, in_reply_to: message.id }));
    cursor = received.next_after_id;
    const quiet = data(await call('receive_message', { after_id: cursor, wait_ms: 30 }));
    assert.deepEqual(quiet, { messages: [], next_after_id: cursor, timed_out: true });
  }
  const observed = await state();
  assert.deepEqual(observed.replies.map((reply) => reply.text), ['Answer 1', 'Answer 2', 'Answer 3']);
  assert.deepEqual(observed.replies.map((reply) => reply.in_reply_to), observed.messages.map((message) => message.id));
});

test('cancelled tool waits are cleaned up and a subsequent receive works', { timeout: 10000 }, async (t) => {
  const { call, state, post } = await start(t);
  const abort = new AbortController();
  const receiving = call('receive_message', { wait_ms: 20000 }, { signal: abort.signal });
  const rejected = assert.rejects(receiving);
  await eventually(async () => (await state()).waiting === 1);
  abort.abort();
  await rejected;
  await eventually(async () => (await state()).waiting === 0);
  await post('After cancellation');
  assert.equal(data(await call('receive_message', { wait_ms: 0 })).messages[0].text, 'After cancellation');
});

test('invalid input cannot create messages or replies', { timeout: 10000 }, async (t) => {
  const { url, call, state } = await start(t);
  for (const [body, expected] of [['{', 400], ['null', 400], ['{"text":" "}', 400], [JSON.stringify({ text: 'x'.repeat(4001) }), 400]]) {
    const response = await fetch(`${url}/api/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.equal(response.status, expected);
  }
  const foreignOrigin = await fetch(`${url}/api/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
    body: JSON.stringify({ text: 'Do not enqueue' }),
  });
  assert.equal(foreignOrigin.status, 403);
  assert.equal((await fetch(`${url}/api/messages`, { method: 'POST', body: 'text' })).status, 415);
  assert.equal((await call('send_message', { text: 'Unknown reply', in_reply_to: 42 })).isError, true);
  assert.equal((await call('send_message', { text: ' ' })).isError, true);
  assert.equal((await call('receive_message', { wait_ms: 20001 })).isError, true);
  assert.equal((await state()).messages.length, 0);
  assert.equal((await state()).replies.length, 0);
});

test('closing the MCP client stops the local HTTP server', { timeout: 10000 }, async (t) => {
  const { client, url } = await start(t);
  await client.close();
  await assert.rejects(fetch(`${url}/api/state`));
});
