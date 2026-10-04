import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createConversationView } from '../public/chatroom/conversation.js';
import { createComposer } from '../public/chatroom/composer.js';
import { createDraftStore } from '../public/chatroom/drafts.js';
import { RoomClient } from '../src/shared/client.js';
import { createFixtureServer } from './helpers/fixture-server.js';
import * as fixtures from '../src/shared/fixtures.js';

const html = readFileSync(new URL('../public/chatroom/index.html', import.meta.url), 'utf8');
const roomA = fixtures.room, roomB = fixtures.otherRoom;
const message = (id, sequence, text = id, replyTo = null) => ({ ...fixtures.event, id, sequence, author: { ...fixtures.event.author }, payload: { text, reply_to: replyTo } });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function dom() {
  const parsed = parseHTML(html);
  const element = parsed.document.getElementById('conversation');
  element.scrollTop = 0; element.scrollHeight = 100; element.clientHeight = 100;
  return { document: parsed.document, window: parsed.window, element };
}
function composer(client, options = {}) {
  const { document, window } = dom();
  const form = document.getElementById('composer');
  const input = document.getElementById('message-input');
  const sendButton = document.getElementById('send-button');
  const drafts = createDraftStore({ storage: null });
  const posted = [], errors = [], changes = [];
  const api = createComposer({ client, form, input, sendButton, drafts, onPosted: event => posted.push(event), onPending: items => changes.push(items), onError: error => errors.push(error), ...options });
  function type(text) { input.value = text; input.dispatchEvent(new window.Event('input')); }
  function submit() { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }
  function key(props = {}) {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.assign(event, { key: 'Enter', ...props }); input.dispatchEvent(event); return event;
  }
  return { document, window, form, input, sendButton, drafts, posted, errors, changes, api, type, submit, key };
}

test('conversation renders literal attributed text, sorts and deduplicates immutable event copies', () => {
  const { element } = dom();
  const view = createConversationView({ element });
  const first = message('one', 1, '<img src=x onerror=alert(1)>\nsecond line');
  first.author.name = '<script>author</script>';
  const second = message('two', 2);
  view.setEvents([second, first, second]);
  first.payload.text = 'changed externally';
  view.addEvents([message('two', 2, 'duplicate'), message('three', 3)]);
  assert.deepEqual(view.getEvents().map(event => event.id), ['one', 'two', 'three']);
  assert.deepEqual([...element.children].map(node => node.dataset.eventId), ['one', 'two', 'three']);
  assert.equal(element.querySelector('img, script'), null);
  assert.match(element.textContent, /<script>author<\/script>/);
  assert.match(element.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(element.textContent, /Human/);
  assert.equal(element.querySelector('time').dateTime, first.created_at);
  const copy = view.getEvents(); copy[0].payload.text = 'mutated'; copy[0].author.name = 'mutated';
  assert.notEqual(view.getEvents()[0].payload.text, 'mutated');
  assert.notEqual(view.getEvents()[0].author.name, 'mutated');
  view.destroy();
});

test('viewer identity distinguishes own messages from agents and other humans across history updates', () => {
  const { element } = dom();
  const view = createConversationView({ element });
  const own = message('own', 1);
  const fromAgent = { ...message('agent', 2), author: { ...fixtures.agent } };
  const fromPeer = { ...message('peer', 3), author: { ...fixtures.peer } };
  const otherHuman = { ...message('other-human', 4), author: { ...fixtures.human, id: 'another-human', name: 'Other human' } };
  view.setEvents([own, fromAgent, fromPeer, otherHuman]);
  assert.equal(element.querySelector('.message--own'), null);
  view.setViewer(fixtures.human);
  assert.equal(element.querySelectorAll('.message--own').length, 1);
  assert.equal(element.querySelector('.message--own').dataset.eventId, 'own');
  const agent = element.querySelector('[data-event-id="agent"]');
  const peer = element.querySelector('[data-event-id="peer"]');
  assert.ok(agent.classList.contains('message--agent'));
  assert.equal(agent.querySelector('.participant-avatar').textContent, 'AA');
  assert.equal(peer.querySelector('.participant-avatar').textContent, 'RA');
  assert.notEqual(agent.style.getPropertyValue('--author-hue'), peer.style.getPropertyValue('--author-hue'));
  assert.equal(agent.querySelector('.message-role').textContent, 'Agent');
  assert.equal(agent.querySelector('.participant-avatar').getAttribute('aria-hidden'), 'true');
  const hue = agent.style.getPropertyValue('--author-hue');
  view.clear();
  view.setEvents([fromPeer, fromAgent, own]);
  assert.equal(element.querySelector('[data-event-id="agent"]').style.getPropertyValue('--author-hue'), hue);
  assert.equal(element.querySelector('.message--own').dataset.eventId, 'own');
  view.setPending([{ requestId: 'sending-own', text: 'Pending', status: 'sending' }]);
  assert.ok(element.querySelector('[data-request-id]').classList.contains('message--own'));
  view.destroy();
});

test('reply references link known parents, show unknown IDs, and callbacks receive independent copies', () => {
  const { element, window } = dom();
  let reply;
  const view = createConversationView({ element, onReply: event => { reply = event; } });
  view.setEvents([message('child', 2, 'Reply', 'parent'), message('unknown', 3, 'Another reply', '<missing>')]);
  assert.match(element.textContent, /In reply to message parent/);
  assert.match(element.textContent, /In reply to message <missing>/);
  view.addEvents([message('parent', 1)]);
  assert.equal(element.querySelector('a').getAttribute('href'), '#message-parent');
  assert.equal(element.querySelector('.message-reply-preview').textContent, 'parent');
  element.querySelector('button[data-reply-id="child"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(reply.id, 'child'); reply.payload.text = 'mutated';
  assert.equal(view.getEvents()[1].payload.text, 'Reply');
  view.destroy();
});

test('pending and failed messages remain distinct from committed events and retry uses request identity', () => {
  const { element, window } = dom();
  let retried = 0;
  const view = createConversationView({ element });
  view.setEvents([message('committed', 1)]);
  view.setPending([{ requestId: 'req-1', roomId: roomA.id, text: '<b>pending</b>', replyTo: null, status: 'sending' }]);
  assert.match(element.textContent, /Sending · unconfirmed/);
  assert.equal(element.querySelectorAll('[data-event-id]').length, 1);
  assert.equal(view.getEvents().length, 1);
  view.setPending([{ requestId: 'req-1', roomId: roomA.id, text: '<b>pending</b>', replyTo: 'committed', status: 'failed', error: Error('<img src=x>'), retry: () => retried++ }]);
  assert.match(element.textContent, /Send failed · unconfirmed/);
  assert.equal(element.querySelector('b, img'), null);
  element.querySelector('[data-retry-id]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(retried, 1);
  view.setPending([]);
  assert.equal(element.querySelector('[data-request-id]'), null);
  view.clear(); assert.equal(element.children.length, 0); assert.deepEqual(view.getEvents(), []);
  view.destroy(); view.addEvents([message('late', 2)]); assert.equal(element.children.length, 0);
});

test('scroll logic preserves older-reading anchor and follows additions only near the end', () => {
  const { element } = dom();
  const view = createConversationView({ element });
  view.setEvents([message('two', 2), message('three', 3)]);
  element.scrollHeight = 1000; element.clientHeight = 200; element.scrollTop = 300;
  element.getBoundingClientRect = () => ({ top: 0 });
  const anchor = element.firstElementChild;
  anchor.getBoundingClientRect = () => ({ top: element.firstElementChild === anchor ? 10 : 110, bottom: 150 });
  view.addEvents([message('one', 1)]);
  assert.equal(element.scrollTop, 400);
  // A new event below the anchored messages must not move the viewport.
  element.firstElementChild.getBoundingClientRect = () => ({ top: -100, bottom: -1 });
  view.addEvents([message('four', 4)]);
  assert.equal(element.scrollTop, 400);
  element.scrollTop = 780;
  view.addEvents([message('five', 5)]);
  assert.equal(element.scrollTop, 1000);
  view.destroy();
});

test('composer restores room-specific drafts and literal reply previews; no room disables input', () => {
  const ui = composer({});
  assert.equal(ui.input.disabled, true);
  ui.api.setRoom(roomA); ui.type('Draft A');
  const event = message('reply-a', 1, '<img src=x>'); event.author.name = '<b>Name</b>';
  ui.api.setReply(event);
  assert.equal(ui.form.querySelector('img, b'), null);
  assert.match(ui.form.textContent, /<img src=x>/);
  ui.api.setRoom(roomB); ui.type('Draft B');
  ui.api.setRoom(roomA);
  assert.equal(ui.input.value, 'Draft A');
  assert.equal(ui.drafts.get(roomA.id).replyTo, 'reply-a');
  ui.form.querySelector('button').dispatchEvent(new ui.window.Event('click'));
  assert.equal(ui.drafts.get(roomA.id).replyTo, null);
  ui.api.setRoom(null); assert.equal(ui.input.disabled, true); assert.equal(ui.sendButton.disabled, true);
  ui.api.setRoom(roomB); assert.equal(ui.input.value, 'Draft B');
  ui.api.destroy();
});

test('Enter submits once; Shift+Enter, IME and whitespace do not submit', () => {
  const request = deferred(); const calls = [];
  const ui = composer({ postMessage: (...args) => { calls.push(args); return request.promise; } });
  ui.api.setRoom(roomA); ui.type('   '); ui.key(); assert.equal(calls.length, 0);
  ui.type('Hello');
  assert.equal(ui.key({ shiftKey: true }).defaultPrevented, false);
  assert.equal(ui.key({ isComposing: true }).defaultPrevented, false);
  assert.equal(ui.key({ keyCode: 229 }).defaultPrevented, false);
  ui.input.dispatchEvent(new ui.window.Event('compositionstart'));
  ui.key(); ui.submit(); assert.equal(calls.length, 0);
  ui.input.dispatchEvent(new ui.window.Event('compositionend'));
  assert.equal(ui.key().defaultPrevented, true);
  ui.submit(); ui.key(); assert.equal(calls.length, 1);
  assert.equal(ui.sendButton.disabled, true);
  assert.equal(calls[0][0], roomA.id); assert.equal(calls[0][1].text, 'Hello');
  ui.api.destroy(); request.resolve(message('sent', 1));
});

test('successful send removes pending, posts confirmed event and clears only submitted draft', async () => {
  const completion = deferred(), posted = deferred();
  const ui = composer({ postMessage: () => completion.promise }, { onPosted: posted.resolve });
  ui.api.setRoom(roomA); ui.type('  Hello  '); ui.api.setReply(message('parent', 1)); ui.submit();
  const [pending] = ui.api.getPending();
  assert.equal(pending.status, 'sending'); assert.equal(pending.text, 'Hello');
  assert.equal(pending.replyTo, 'parent'); assert.match(pending.requestId, /^[0-9a-f-]{36}$/);
  const event = message('posted', 2, 'Hello', 'parent');
  completion.resolve(event); assert.equal(await posted.promise, event);
  assert.deepEqual(ui.api.getPending(), []);
  assert.equal(ui.input.value, ''); assert.deepEqual(ui.drafts.get(roomA.id), { text: '', replyTo: null });
  ui.api.destroy();
});

test('retry retains failed request ID, room and payload despite draft edits and room changes', async () => {
  const failed = deferred(); const inputs = [];
  const ui = composer({ postMessage: async (roomId, payload) => {
    inputs.push({ roomId, payload });
    if (inputs.length === 1) throw Error('Cannot reach hub');
    return message('posted', 2, payload.text, payload.reply_to);
  } }, { onError: failed.resolve });
  ui.api.setRoom(roomA); ui.type('Original'); ui.api.setReply(message('parent', 1)); ui.submit();
  await failed.promise;
  const [pending] = ui.api.getPending();
  assert.equal(pending.status, 'failed');
  pending.text = 'External mutation';
  ui.type('New draft'); ui.api.setReply(null); ui.api.setRoom(roomB); ui.type('Other room');
  await ui.api.retry(pending.requestId);
  assert.deepEqual(inputs[0], inputs[1]);
  assert.equal(inputs[1].payload.text, 'Original');
  assert.equal(ui.drafts.get(roomA.id).text, 'New draft');
  assert.equal(ui.input.value, 'Other room');
  assert.equal(ui.posted.length, 1);
  ui.api.destroy();
});

test('room switching permits parallel sends and late success never clears another room', async () => {
  const requests = new Map(); const firstPosted = deferred(), secondPosted = deferred();
  const ui = composer({ postMessage: (roomId, _, { signal }) => { const request = { ...deferred(), signal }; requests.set(roomId, request); return request.promise; } }, { onPosted: event => (event.room_id === roomA.id ? firstPosted : secondPosted).resolve(event) });
  ui.api.setRoom(roomA); ui.type('A'); ui.submit();
  ui.api.setRoom(roomB); ui.type('B'); ui.submit();
  assert.equal(ui.api.getPending().length, 2);
  assert.equal(requests.get(roomA.id).signal.aborted, false);
  requests.get(roomA.id).resolve(message('a', 1, 'A')); await firstPosted.promise;
  assert.equal(ui.input.value, 'B'); assert.equal(ui.drafts.get(roomB.id).text, 'B');
  assert.equal(ui.api.getPending()[0].roomId, roomB.id);
  requests.get(roomB.id).resolve({ ...message('b', 1, 'B'), room_id: roomB.id }); await secondPosted.promise;
  assert.equal(ui.input.value, '');
  ui.api.destroy();
});

test('edits including edit-and-revert after submission protect the newer draft', async () => {
  for (const finalText of ['New draft', 'Original']) {
    const completion = deferred(), posted = deferred();
    const ui = composer({ postMessage: () => completion.promise }, { onPosted: posted.resolve });
    ui.api.setRoom(roomA); ui.type('Original'); ui.submit();
    ui.type('An intermediate edit'); ui.type(finalText);
    completion.resolve(message('sent', 1, 'Original')); await posted.promise;
    assert.equal(ui.input.value, finalText); assert.equal(ui.drafts.get(roomA.id).text, finalText);
    ui.api.destroy();
  }
});

test('pending updates include every room; duplicate retry cannot send concurrently', async () => {
  const failed = deferred(), attempt = deferred(); let calls = 0;
  const ui = composer({ postMessage: async () => { if (++calls === 1) throw Error('uncertain'); return attempt.promise; } }, { onError: failed.resolve });
  ui.api.setRoom(roomA); ui.type('A'); ui.submit(); await failed.promise;
  const id = ui.api.getPending()[0].requestId;
  const retry = ui.api.retry(id); await ui.api.retry(id);
  assert.equal(calls, 2);
  assert.equal(ui.changes.at(-1)[0].status, 'sending');
  ui.api.destroy(); attempt.resolve(message('late', 1)); await retry;
  assert.equal(ui.posted.length, 0);
});

test('destroy aborts sends, removes listeners, saves draft and ignores late success or error', async () => {
  for (const failure of [false, true]) {
    const completion = deferred(); let signal, calls = 0;
    const ui = composer({ postMessage: (_, __, options) => { calls++; signal = options.signal; return completion.promise; } });
    ui.api.setRoom(roomA); ui.type('Keep draft'); ui.submit(); ui.api.destroy();
    assert.equal(signal.aborted, true);
    ui.submit(); ui.key(); assert.equal(calls, 1);
    if (failure) completion.reject(Error('late')); else completion.resolve(message('late', 1));
    await completion.promise.catch(() => {});
    assert.equal(ui.posted.length, 0); assert.equal(ui.errors.length, 0);
    assert.equal(ui.drafts.get(roomA.id).text, 'Keep draft');
  }
});

test('conversation destroy detaches reply handlers', () => {
  const { element, window } = dom(); let replies = 0;
  const view = createConversationView({ element, onReply: () => replies++ });
  view.setEvents([message('one', 1)]); view.destroy();
  element.querySelector('button').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(replies, 0);
});

test('composer posts through the shared RoomClient fixture without inventing event shapes', async t => {
  const fixture = await createFixtureServer(); t.after(() => fixture.close());
  const posted = deferred();
  const ui = composer(new RoomClient({ baseUrl: fixture.url }), { onPosted: posted.resolve });
  t.after(() => ui.api.destroy());
  ui.api.setRoom(roomA); ui.type('Fixture message'); ui.submit();
  const event = await posted.promise;
  assert.equal(event.room_id, roomA.id); assert.equal(event.payload.text, 'Fixture message');
  assert.equal(event.author.id, fixtures.agent.id);
  assert.equal(ui.api.getPending().length, 0);
});

test('definitive validation rejection preserves editable draft and permits a corrected fresh mutation', async () => {
  const failed = deferred(), posted = deferred();
  const inputs = [];
  const ui = composer({ postMessage: async (_, payload) => {
    inputs.push(payload);
    if (inputs.length === 1) throw Object.assign(Error('Message exceeds 4000 characters.'), { status: 400, code: 'VALIDATION_ERROR' });
    return message('corrected', 1, payload.text);
  } }, { onError: failed.resolve, onPosted: posted.resolve });
  assert.equal(ui.input.getAttribute('maxlength'), '4000');
  ui.api.setRoom(roomA);
  // A restored/programmatic draft can exceed the browser's typing limit.
  ui.type('x'.repeat(4001)); ui.submit(); await failed.promise;
  assert.deepEqual(ui.api.getPending(), []);
  assert.equal(ui.input.value.length, 4001);
  assert.equal(ui.drafts.get(roomA.id).text.length, 4001);
  assert.equal(ui.form.querySelector('[role="alert"]').hidden, false);
  assert.match(ui.form.querySelector('[role="alert"]').textContent, /4000/);
  ui.type('Corrected message');
  assert.equal(ui.sendButton.disabled, false);
  ui.submit(); await posted.promise;
  assert.notEqual(inputs[0].request_id, inputs[1].request_id);
  assert.equal(inputs[1].text, 'Corrected message');
  assert.equal(ui.input.value, '');
  assert.equal(ui.form.querySelector('[role="alert"]').hidden, true);
  ui.api.destroy();
});

test('authorization rejection unlocks draft but malformed 4xx responses retain uncertain retry identity', async () => {
  for (const code of ['FORBIDDEN', 'INVALID_RESPONSE', 'VERSION_MISMATCH']) {
    const failed = deferred();
    const ui = composer({ postMessage: async () => { throw Object.assign(Error(code), { status: 403, code }); } }, { onError: failed.resolve });
    ui.api.setRoom(roomA); ui.type('Keep editable'); ui.submit(); await failed.promise;
    assert.equal(ui.drafts.get(roomA.id).text, 'Keep editable');
    assert.equal(ui.api.getPending().length, code === 'FORBIDDEN' ? 0 : 1);
    assert.equal(ui.sendButton.disabled, code !== 'FORBIDDEN');
    ui.api.destroy();
  }
});
