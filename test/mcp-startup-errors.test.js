import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { temporaryDirectory, connectMcp } from './helpers/processes.js';

const entry = fileURLToPath(new URL('../src/mcp/main.js', import.meta.url));
async function runFailure(t, overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('ROOM_') || key === 'CLAUDE_PROJECT_DIR') delete env[key];
  const peer = await connectMcp(t, entry, { env: { ...env, ...overrides } });
  assert.equal((await peer.client.listTools()).tools.length, 12);
  const result = await peer.call('join_room', { room_id: 'diagnostic-room' });
  assert.equal(result.isError, true);
  assert.equal(peer.stderr(), '');
  await peer.client.ping();
  return result.data.error;
}

test('configuration failures appear as tool errors while MCP stays available', { timeout: 10000 }, async t => {
  const dir = await temporaryDirectory(t);
  const marker = 'synthetic-private-value';
  const saved = join(dir, 'existing.json');
  await writeFile(saved, marker);
  for (const [overrides, code] of [
    [{ ROOM_HUB_URL: marker }, 'HUB_URL'],
    [{ ROOM_INVITE_TOKEN: marker }, 'INVITATION'],
    [{ ROOM_WORKSPACE: join(dir, marker) }, 'WORKSPACE'],
    [{ ROOM_RESUME: '1' }, 'SESSION_SETTINGS'],
    [{ ROOM_RESUME: '1', ROOM_SESSION_FILE: saved }, 'SESSION_READ'],
    [{ ROOM_SESSION_FILE: saved }, 'EEXIST'],
    [{ ROOM_SESSION_FILE: join(dir, marker, 'missing.json') }, 'SESSION_WRITE'],
    [{ ROOM_AGENT_NAME: '' }, 'PROFILE'],
  ]) {
    const error = await runFailure(t, { ROOM_WORKSPACE: dir, ...overrides });
    assert.equal(error.code, code);
    assert.ok(!JSON.stringify(error).includes(marker), 'Diagnostics must omit private values.');
  }
});

test('hub enrollment errors retain known codes but never echo hub-supplied text', { timeout: 10000 }, async t => {
  const marker = 'synthetic-private-hub-message';
  let errorCode = 'INVITE_INVALID';
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(403, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ version: '1', error: { code: errorCode, message: marker, retryable: false } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { ROOM_HUB_URL: `http://127.0.0.1:${server.address().port}`, ROOM_WORKSPACE: process.cwd() };
  for (const [remoteCode, diagnosticCode] of [['INVITE_INVALID', 'INVITE_INVALID'], [marker, 'CONNECTION_FAILED']]) {
    errorCode = remoteCode;
    const error = await runFailure(t, env);
    assert.equal(error.code, diagnosticCode);
    assert.ok(!JSON.stringify(error).includes(marker));
  }
});

test('interrupted hub enrollment returns a retryable HUB_UNREACHABLE tool error', { timeout: 10000 }, async t => {
  const server = createServer((request, response) => { request.resume(); response.destroy(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const error = await runFailure(t, { ROOM_HUB_URL: `http://127.0.0.1:${server.address().port}`, ROOM_WORKSPACE: process.cwd() });
  assert.equal(error.code, 'HUB_UNREACHABLE'); assert.equal(error.retryable, true);
});
