import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RoomClient, HubTransportError } from '../src/shared/client.js';
import { ApiError, failure } from '../src/shared/protocol.js';
import { startupErrorDetails } from '../src/mcp/startup-errors.js';
import { createHubSession } from '../src/mcp/hub-session.js';
import { createMcpServer } from '../src/mcp/server.js';

const marker = 'synthetic-private-transport-value';
const causedBy = code => new TypeError(marker, { cause: Object.assign(new Error(marker), { code }) });

test('transport diagnostics retain nested and aggregate codes while discarding raw error data', async () => {
  const cause = causedBy('ECONNREFUSED');
  cause.cause.errors = [causedBy('ENETUNREACH'), causedBy(marker), causedBy('ECONNREFUSED'), cause];
  const client = new RoomClient({ baseUrl: 'http://127.0.0.1:8787', fetchImpl: async () => { throw cause; } });
  await assert.rejects(client.listRooms(), error => {
    assert.ok(error instanceof HubTransportError);
    assert.equal(error.code, 'HUB_UNREACHABLE');
    assert.equal(error.retryable, true);
    assert.match(startupErrorDetails(error).message, /Transport codes: ECONNREFUSED, ENETUNREACH\./);
    assert.ok(!JSON.stringify(failure(error)).includes(marker));
    assert.ok(!error.stack.includes(marker));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('unknown transport codes and hub-supplied diagnostic text are not reflected', () => {
  const local = startupErrorDetails(new HubTransportError(causedBy(marker)));
  assert.match(local.message, /No recognized transport code/);
  assert.ok(!JSON.stringify(local).includes(marker));
  const remote = startupErrorDetails(new ApiError('HUB_UNREACHABLE', marker, { details: { code: marker } }));
  assert.ok(!JSON.stringify(remote).includes(marker));
  assert.ok(!remote.message.includes('Transport codes:'));
});

test('cancellation remains cancellation instead of a transport failure', async () => {
  const aborted = new DOMException('Cancelled', 'AbortError');
  const client = new RoomClient({ baseUrl: 'http://127.0.0.1:8787', fetchImpl: async () => { throw aborted; } });
  await assert.rejects(client.listRooms(), error => error === aborted);
});

test('join_room exposes a safe transport code through enrollment and the MCP response', async t => {
  // All HTTP calls are mocked; no live service or network policy is exercised.
  t.mock.method(globalThis, 'fetch', async () => { throw causedBy('ECONNREFUSED'); });
  const session = createHubSession({ env: {}, prepareConfig: async () => ({
    baseUrl: 'http://127.0.0.1:8787',
    profile: { name: 'Diagnostic fixture', runtime: 'Test', workspace: { path: '/sample' }, context: '' },
    resumeToken: 'synthetic-diagnostic-resume-token-0000', maxRetries: 0,
  }) });
  const server = createMcpServer({ client: session.client, connect: session.connect });
  const client = new Client({ name: 'transport-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); await session.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: 'join_room', arguments: { room_id: 'fixture-room' } });
  assert.equal(result.isError, true);
  const { error } = JSON.parse(result.content[0].text);
  assert.equal(error.code, 'HUB_UNREACHABLE');
  assert.equal(error.retryable, true);
  assert.match(error.message, /Transport codes: ECONNREFUSED\./);
  assert.ok(!JSON.stringify(result).includes(marker));
  await client.ping();
});
