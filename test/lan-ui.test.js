import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createHub } from '../src/hub/main.js';
import { browserClient } from './helpers/browser-client.js';
import { lanBrowser } from './helpers/lan-client.js';
import { mountChatroom } from '../public/chatroom/app.js';
import { requestId } from '../src/shared/protocol.js';

const html = readFileSync(new URL('../public/chatroom/index.html', import.meta.url), 'utf8');
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise(setImmediate);
  assert.ok(predicate(), 'UI did not settle');
}
async function tab(t, client) {
  const { document, window } = parseHTML(html);
  const app = await mountChatroom({ document, client }); t.after(() => app.destroy());
  return { document, window, app, $: id => document.getElementById(id) };
}

test('host creates an invitation, a named visitor joins through the actual UI, and visitor generates an agent code', { timeout: 15000 }, async t => {
  const hub = await createHub({ filename: ':memory:', lanHost: '192.168.50.10', host: '127.0.0.1' }); t.after(() => hub.close());
  const { client } = await browserClient(hub.url);
  const room = await client.createRoom({ name: 'LAN discussion' });
  const host = await tab(t, client);
  assert.equal(host.$('share-room').hidden, false);
  host.$('invite-label').value = '<img src=x> Sam'; host.$('invite-human').click();
  await until(() => !host.$('invite-result').hidden);
  const link = new URL(host.$('invite-output').value);
  assert.equal(link.origin, hub.publicUrl);
  assert.equal(link.search, '');
  const token = new URLSearchParams(link.hash.slice(1)).get('invite');
  await until(() => host.$('invitations-list').textContent.includes('Sam'));
  assert.equal(host.$('invitations-list').querySelector('img'), null);
  const guestClient = lanBrowser(hub), visitor = await tab(t, guestClient);
  assert.equal(visitor.$('join-panel').hidden, false);
  visitor.$('join-name').value = 'Sam'; visitor.$('join-code').value = token;
  visitor.$('join-form').dispatchEvent(new visitor.window.Event('submit', { cancelable: true }));
  await until(() => visitor.$('human-identity').textContent === 'You: Sam');
  await until(() => visitor.$('room-title').textContent === '# LAN discussion');
  assert.equal(visitor.$('join-panel').hidden, true);
  assert.equal(visitor.$('join-code').value, '');
  assert.equal(visitor.$('create-room-button').disabled, true);
  assert.equal(visitor.$('invite-human').hidden, true);
  assert.match(visitor.$('agent-command').textContent, /--invite$/);
  visitor.$('invite-agent').click();
  await until(() => !visitor.$('invite-result').hidden);
  const agentCode = visitor.$('invite-output').value;
  assert.ok(agentCode.length >= 32);
  assert.match(visitor.$('invite-launch').textContent, /--invite$/);
  assert.ok(!visitor.$('invite-launch').textContent.includes(agentCode));
  visitor.$('message-input').value = 'A named contribution';
  visitor.$('message-input').dispatchEvent(new visitor.window.Event('input'));
  visitor.$('composer').dispatchEvent(new visitor.window.Event('submit', { cancelable: true }));
  await until(() => host.$('conversation').textContent.includes('A named contribution'));
  assert.equal(host.$('conversation').querySelector('.message--own'), null);
  assert.match(host.$('conversation').textContent, /Sam/);
  await host.app.accessPanel.refresh();
  const revoke = [...host.$('invitations-list').querySelectorAll('li')].find(item => item.textContent.includes('Sam')).querySelector('button');
  revoke.click(); await until(() => host.$('invite-status').textContent === 'Access revoked.');
  await assert.rejects(guestClient.postMessage(room.id, { text: 'Denied' }), error => error.code === 'FORBIDDEN');
  assert.equal(host.$('invite-result').hidden, true);
});

test('room switching hides the previous invitation and fences a late invitation response', { timeout: 10000 }, async t => {
  const hub = await createHub({ filename: ':memory:', lanHost: '192.168.50.10', host: '127.0.0.1' }); t.after(() => hub.close());
  const { client } = await browserClient(hub.url);
  const a = await client.createRoom({ name: 'A' }), b = await client.createRoom({ name: 'B' });
  const ui = await tab(t, client); await ui.app.rooms.select(a.id);
  const original = client.createInvitation.bind(client);
  let release, created;
  client.createInvitation = async (room, input) => {
    created = await original(room, input);
    await new Promise(resolve => { release = resolve; }); return created;
  };
  ui.$('invite-human').click(); await until(() => Boolean(release));
  await ui.app.rooms.select(b.id); release(); await new Promise(setImmediate);
  assert.equal(ui.$('invite-result').hidden, true);
  assert.equal(ui.$('invite-output').value, '');
  assert.ok(!ui.document.documentElement.textContent.includes(created.token));
});

test('browser controls work with secure random values when randomUUID is unavailable on HTTP LAN pages', async t => {
  // Simulate the browser capability on an ordinary HTTP LAN origin.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
  Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis.crypto, 'randomUUID', descriptor); else delete globalThis.crypto.randomUUID; });
  const ids = new Set(Array.from({ length: 30 }, requestId));
  assert.equal(ids.size, 30);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const hub = await createHub({ filename: ':memory:' }); t.after(() => hub.close());
  const { client } = await browserClient(hub.url), ui = await tab(t, client);
  await ui.app.rooms.create({ name: 'HTTP browser' });
  ui.$('message-input').value = 'Random fallback works'; ui.$('message-input').dispatchEvent(new ui.window.Event('input'));
  ui.$('composer').dispatchEvent(new ui.window.Event('submit', { cancelable: true }));
  await until(() => ui.$('conversation').textContent.includes('Random fallback works') && ui.app.composer.getPending().length === 0);
});
