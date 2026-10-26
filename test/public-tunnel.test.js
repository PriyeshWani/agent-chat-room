import test from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/hub/main.js';
import { browserClient } from './helpers/browser-client.js';
import { lanBrowser, loopbackFetch } from './helpers/lan-client.js';
import { parseHubUrl, parsePublicUrl } from '../src/shared/hub-url.js';
import { RoomClient } from '../src/shared/client.js';

test('HTTPS tunnel keeps host enrollment local and enforces invited room access', async t => {
  const hub = await createHub({ filename: ':memory:', externalUrl: 'https://fixture.trycloudflare.com' });
  t.after(() => hub.close());
  const { client: host } = await browserClient(hub.url);
  const staleLocal = await loopbackFetch(`${hub.url}/api/v1/sessions/browser`, {
    method: 'POST', headers: { Origin: hub.url, 'Content-Type': 'application/json', Cookie: 'acr_session=stale' }, body: '{}' });
  assert.equal(staleLocal.status, 200);
  assert.equal((await staleLocal.json()).data.access.can_invite_people, true);
  const staleRemote = await loopbackFetch(`${hub.url}/api/v1/sessions/browser`, {
    method: 'POST', headers: { Host: 'fixture.trycloudflare.com', Origin: hub.publicUrl,
      'Content-Type': 'application/json', Cookie: 'acr_session=stale' }, body: '{}' });
  assert.equal(staleRemote.status, 401);
  const room = await host.createRoom({ name: 'Shared' });
  const privateRoom = await host.createRoom({ name: 'Private' });
  const guest = lanBrowser(hub);
  await assert.rejects(guest.browserSession(), e => e.code === 'JOIN_REQUIRED');
  await assert.rejects(guest.listRooms(), e => e.code === 'UNAUTHENTICATED');
  const invite = await host.createInvitation(room.id, { kind: 'human' });
  const joined = await guest.joinBrowser({ name: 'Visitor', invite_token: invite.token });
  assert.equal(joined.access.can_create_rooms, false);
  assert.equal(joined.access.public_url, hub.publicUrl);
  await guest.joinRoom(room.id);
  await assert.rejects(guest.history(privateRoom.id), e => e.code === 'FORBIDDEN');
  for (const headers of [
    { Host: new URL(hub.url).host, Origin: hub.url, 'X-Forwarded-For': '127.0.0.1' },
    { Host: 'fixture.trycloudflare.com', Origin: hub.url },
    { Host: 'foreign.example', Origin: 'https://foreign.example' },
  ]) {
    const response = await loopbackFetch(`${hub.url}/api/v1/sessions/browser`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 403);
  }
  const enrollment = await loopbackFetch(`${hub.url}/api/v1/sessions/agent`, {
    method: 'POST', headers: { Host: 'fixture.trycloudflare.com', 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'create', request_id: 'remote-agent', name: 'Remote', resume_token: 'x'.repeat(64) }) });
  assert.equal(enrollment.status, 401);
  assert.equal((await enrollment.json()).error.code, 'INVITE_REQUIRED');
});

test('public browser cookie is secure; finite polling catches up beyond one page and cancels', async t => {
  const hub = await createHub({ filename: ':memory:', externalUrl: 'https://fixture.trycloudflare.com' });
  t.after(() => hub.close());
  const { client: host } = await browserClient(hub.url);
  const room = await host.createRoom({ name: 'Polling' });
  const invite = await host.createInvitation(room.id, { kind: 'human' });
  let cookie = '';
  const paths = [];
  const guest = new RoomClient({ baseUrl: hub.publicUrl, fetchImpl: async (input, options = {}) => {
    const url = new URL(input); paths.push(url.pathname + url.search);
    const response = await loopbackFetch(hub.url + url.pathname + url.search, { ...options,
      headers: { ...options.headers, Host: url.host, Origin: url.origin, ...(cookie ? { Cookie: cookie } : {}) } });
    const issued = response.headers.get('set-cookie');
    if (issued) { assert.match(issued, /; Secure/); cookie = issued.split(';')[0]; }
    return response;
  } });
  await guest.joinBrowser({ name: 'Visitor', invite_token: invite.token });
  await guest.joinRoom(room.id); await host.joinRoom(room.id);
  for (let n = 0; n < 105; n++) await host.postMessage(room.id, { text: `Message ${n}` });
  const controller = new AbortController(); t.after(() => controller.abort());
  const stream = guest.events(room.id, { signal: controller.signal });
  for (let n = 1; n <= 105; n++) assert.equal((await stream.next()).value.sequence, n);
  assert.ok(paths.some(path => path.endsWith('after=100&poll=1')));
  const waiting = stream.next();
  controller.abort();
  await assert.rejects(waiting, e => e.name === 'AbortError');
  await host.revokeInvitation(room.id, { invitation_id: invite.invitation.id });
  await assert.rejects(guest.eventStream(room.id, { poll: true }).next(), e => e.code === 'FORBIDDEN');
});

test('remote hub URLs require HTTPS and a root URL without secrets', () => {
  assert.equal(parseHubUrl('https://fixture.trycloudflare.com').origin, 'https://fixture.trycloudflare.com');
  for (const url of ['http://fixture.trycloudflare.com', 'https://u:p@fixture.trycloudflare.com',
    'https://fixture.trycloudflare.com/path', 'https://fixture.trycloudflare.com/?token=x', 'https://127.0.0.1']) {
    assert.throws(() => parseHubUrl(url));
  }
  assert.throws(() => parsePublicUrl('http://127.0.0.1:8787'));
});
