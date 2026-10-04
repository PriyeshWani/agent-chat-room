import assert from 'node:assert/strict';
import http from 'node:http';
import { access } from 'node:fs/promises';
import { test } from 'node:test';
import { Inputs } from '../src/shared/schemas.js';
import { ApiError, LIMITS } from '../src/shared/protocol.js';
import { createHttpServer } from '../src/hub/http-server.js';
import { createStaticAssets } from '../src/hub/static-assets.js';

async function shell(t, options = {}) {
  const hub = await createHttpServer(options);
  t.after(() => hub.close());
  return hub;
}
function request(hub, path, { method = 'GET', headers = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(hub.url, { path, method, headers }, res => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      res.on('error', reject);
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}
const health = { schema: 'health', data: { status: 'ok', version: '1' } };

test('shell binds a free loopback port and serves only exact health method/path', async t => {
  await assert.rejects(createHttpServer({ host: 'localhost' }), /127\.0\.0\.1/);
  for (const port of [-1, 65536, 1.5, '0']) await assert.rejects(createHttpServer({ port }), /port/);
  const hub = await shell(t);
  assert.match(hub.url, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
  const result = await request(hub, '/api/v1/health');
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.text), { version: '1', data: health.data });
  for (const path of ['/api/v1/missing', '/api/v1/health/']) assert.equal((await request(hub, path)).status, 404);
  assert.equal((await request(hub, '/api/v1/health', { method: 'OPTIONS' })).status, 404);
  const post = await request(hub, '/api/v1/health', { method: 'POST', headers: { Origin: hub.url, 'Content-Type': 'application/json' }, chunks: ['{}'] });
  assert.equal(post.status, 404);
});

test('Host and Origin rules apply before handlers; bootstrap exemptions do not authenticate', async t => {
  let calls = 0;
  const hub = await shell(t, { handlers: [() => { calls++; return health; }] });
  for (const headers of [{ Host: 'unlisted.local' }, { Origin: 'http://unlisted.local' }]) {
    const result = await request(hub, '/api/v1/injected', { headers });
    assert.equal(result.status, 403); assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(calls, 0);
  const mutation = (path, headers) => request(hub, path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, chunks: ['{}'] });
  assert.equal((await mutation('/api/v1/injected')).status, 403);
  assert.equal((await mutation('/api/v1/injected', { Origin: hub.url })).status, 200);
  assert.equal((await mutation('/api/v1/injected', { Authorization: 'Bearer synthetic' })).status, 200);
  assert.equal((await mutation('/api/v1/sessions/browser', { Authorization: 'Bearer synthetic' })).status, 403);
  assert.equal((await mutation('/api/v1/sessions/browser', { Origin: hub.url })).status, 200);
  assert.equal((await mutation('/api/v1/sessions/agent')).status, 200);
  assert.equal(calls, 4);
});

test('injected handlers are sequential and receive parsed context and bounded JSON', async t => {
  const seen = [];
  const hub = await shell(t, { handlers: [context => { seen.push('first'); assert.ok(context.signal instanceof AbortSignal); }, context => {
    seen.push(context.body); assert.equal(context.path, '/api/v1/injected'); assert.equal(context.url.searchParams.get('q'), '1');
    return health;
  }, () => { assert.fail('Must stop after first result'); }] });
  const send = (chunks, headers = {}) => request(hub, '/api/v1/injected?q=1', {
    method: 'POST', headers: { Origin: hub.url, 'Content-Type': 'application/json; charset=utf-8', ...headers }, chunks,
  });
  assert.equal((await send(['{"ok":', 'true}'])).status, 200);
  assert.deepEqual(seen, ['first', { ok: true }]);
  const fullBody = JSON.stringify('a'.repeat(LIMITS.bodyBytes - 2));
  assert.equal((await send([fullBody])).status, 200);
  for (const response of [await send(['{']), await send(['{}'], { 'Content-Type': 'text/plain' }),
    await send(['x'.repeat(LIMITS.bodyBytes + 1)]),
    await send([JSON.stringify('é'.repeat(LIMITS.bodyBytes / 2))]),
    await send(['x'.repeat(LIMITS.bodyBytes + 1)], { 'Content-Length': String(LIMITS.bodyBytes + 1) })]) {
    assert.equal(response.status, 400); assert.equal(JSON.parse(response.text).error.code, 'VALIDATION_ERROR');
  }
  assert.equal(seen.length, 4);
});

test('output validation and error translation keep implementation details private', async t => {
  let outcome = () => ({ schema: 'health', data: { status: 'broken' } });
  const logged = [];
  const hub = await shell(t, { onError: error => logged.push(error), handlers: [() => outcome()] });
  for (const action of [() => ({ schema: 'health', data: { status: 'broken' } }), () => { throw new Error('private SQL secret'); }, () => ({ schema: 'missing', data: {} })]) {
    outcome = action;
    const response = await request(hub, '/api/v1/injected');
    assert.equal(response.status, 500); assert.equal(JSON.parse(response.text).error.code, 'INTERNAL_ERROR');
    assert.ok(!response.text.includes('private SQL secret'));
  }
  assert.equal(logged.length, 3);
  outcome = () => Inputs.joinRoom.parse({ request_id: '' });
  assert.equal((await request(hub, '/api/v1/injected')).status, 400);
  outcome = () => { throw new ApiError('ALREADY_RECEIVING', 'Already waiting.', { status: 409, retryable: false }); };
  const typed = await request(hub, '/api/v1/injected');
  assert.equal(typed.status, 409);
  assert.deepEqual(JSON.parse(typed.text).error, { code: 'ALREADY_RECEIVING', message: 'Already waiting.', retryable: false });
});

test('static assets use exact public allowlist, MIME, HEAD, and conservative caching', async t => {
  const hub = await shell(t, { assets: createStaticAssets() });
  for (const [path, mime] of [['/', 'text/html'], ['/index.html', 'text/html'], ['/style.css', 'text/css'], ['/theme.js', 'text/javascript'], ['/shared/client.js', 'text/javascript'], ['/shared/protocol.js', 'text/javascript']]) {
    const result = await request(hub, path);
    assert.equal(result.status, 200); assert.ok(result.headers['content-type'].startsWith(mime));
    assert.equal(result.headers['x-content-type-options'], 'nosniff'); assert.equal(result.headers['cache-control'], 'no-cache');
    const head = await request(hub, path, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.text, ''); assert.equal(head.headers['content-length'], result.headers['content-length']);
  }
  for (const path of ['/shared/schemas.js', '/shared/fixtures.js', '/node_modules/zod/index.js', '/public/index.html', '/unknown.js', '/a/../theme.js', '/%74heme.js']) {
    assert.equal((await request(hub, path)).status, 404, path);
  }
  assert.equal((await request(hub, '/theme.js', { method: 'OPTIONS' })).status, 404);
  // These allowlisted modules may land in later packets. Until then there is
  // no fallback to the unrelated legacy public/app.js.
  let appExists = true;
  try { await access(new URL('../public/chatroom/app.js', import.meta.url)); }
  catch (error) { if (error.code === 'ENOENT') appExists = false; else throw error; }
  assert.equal((await request(hub, '/app.js')).status, appExists ? 200 : 404);
});

test('stream signal survives GET completion and aborts on client disconnect', { timeout: 5000 }, async t => {
  let signal, aborted;
  const cancelled = new Promise(resolve => { aborted = resolve; });
  const hub = await shell(t, { handlers: [context => {
    signal = context.signal; signal.addEventListener('abort', aborted, { once: true });
    context.response.writeHead(200, { 'Content-Type': 'text/event-stream' }); context.response.write(': ready\n\n');
    return { handled: true };
  }] });
  const req = http.get(hub.url + '/api/v1/stream');
  req.on('error', () => {});
  const res = await new Promise(resolve => req.once('response', resolve));
  await new Promise(resolve => res.once('data', resolve));
  assert.equal(signal.aborted, false);
  req.destroy(); await cancelled;
  assert.equal(signal.aborted, true);
});

test('hub close aborts active responses, bounds uncooperative sockets, and is idempotent', { timeout: 5000 }, async t => {
  let signal;
  const hub = await shell(t, { handlers: [context => {
    signal = context.signal;
    context.response.writeHead(200); context.response.write('waiting');
    return { handled: true };
  }] });
  const req = http.get(hub.url + '/api/v1/stream'); req.on('error', () => {});
  const res = await new Promise(resolve => req.once('response', resolve));
  res.on('error', () => {}); res.resume();
  const start = Date.now();
  const first = hub.close(); assert.equal(hub.close(), first);
  assert.equal(signal.aborted, true);
  await first;
  assert.ok(Date.now() - start < 2000);
  assert.equal(hub.server.listening, false);
});
