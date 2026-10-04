import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createComposer } from '../public/chatroom/composer.js';
import { createConversationView } from '../public/chatroom/conversation.js';
import { createDraftStore } from '../public/chatroom/drafts.js';
import { mentionRanges } from '../public/chatroom/mentions.js';
import * as f from '../src/shared/fixtures.js';

const html = readFileSync(new URL('../public/chatroom/index.html', import.meta.url), 'utf8');
const status = person => ({ ...f.status, participant: person, connection: 'connected' });
const response = people => ({ participants: people.map(status) });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate() && Date.now() < deadline) await new Promise(setImmediate);
  assert.ok(predicate(), 'UI did not settle');
}
function setup(t, client, drafts = createDraftStore({ storage: null })) {
  const { document, window } = parseHTML(html);
  const form = document.getElementById('composer'), input = document.getElementById('message-input');
  input.setSelectionRange = (start, end) => { input.selectionStart = start; input.selectionEnd = end; };
  const api = createComposer({ client, form, input, sendButton: document.getElementById('send-button'), drafts });
  t.after(() => api.destroy());
  function type(value) { input.value = value; input.setSelectionRange(value.length, value.length); input.dispatchEvent(new window.Event('input')); }
  function key(key, props = {}) {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.assign(event, { key, ...props }); input.dispatchEvent(event); return event;
  }
  const options = () => [...form.querySelectorAll('[role="option"]')];
  return { document, window, form, input, api, drafts, type, key, options };
}

test('keyboard autocomplete selects humans and agents with spaces without sending on selection', async t => {
  const posts = [];
  const ui = setup(t, { listParticipants: async () => response([f.human, f.agent, f.peer]),
    postMessage: async (_, input) => { posts.push(input); return f.event; } });
  ui.api.setRoom(f.room); ui.type('@');
  await until(() => ui.options().length === 3);
  ui.key('ArrowDown');
  assert.equal(ui.key('Enter').defaultPrevented, true);
  assert.equal(ui.input.value, '@API agent '); assert.equal(posts.length, 0);
  ui.type(ui.input.value + 'please review with @Rev');
  assert.equal(ui.options().length, 1);
  assert.equal(ui.key('Tab').defaultPrevented, true);
  assert.equal(ui.input.value, '@API agent please review with @Review agent ');
  assert.equal(ui.key('Enter', { shiftKey: true }).defaultPrevented, false);
  ui.key('Enter'); await until(() => ui.api.getPending().length === 0);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].mention_ids, [f.agent.id, f.peer.id]);
  assert.equal(ui.input.value, '');
  assert.equal(ui.form.querySelector('.mention-targets').hidden, true);
  ui.type('@You'); await until(() => ui.options().length === 1);
  ui.key('Enter'); ui.type(ui.input.value + 'hello'); ui.key('Enter');
  await until(() => posts.length === 2);
  assert.deepEqual(posts[1].mention_ids, [f.human.id]);
});

test('duplicate names retain the explicitly chosen ID across room switches and stored drafts; deletion removes addressing', async t => {
  const twins = [{ ...f.agent, name: 'Twin' }, { ...f.peer, name: 'Twin' }];
  const memory = new Map(); const storage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
  const drafts = createDraftStore({ storage });
  const ui = setup(t, { listParticipants: async () => response(twins) }, drafts);
  ui.api.setRoom(f.room); ui.type('@Tw'); await until(() => ui.options().length === 2);
  assert.match(ui.options()[1].textContent, new RegExp(f.peer.id.slice(0, 8)));
  ui.options()[1].dispatchEvent(new ui.window.Event('click', { bubbles: true }));
  ui.type(ui.input.value + 'review');
  assert.deepEqual(drafts.get(f.room.id).mentions.map(person => person.id), [f.peer.id]);
  ui.api.setRoom(f.otherRoom); assert.equal(ui.input.value, '');
  ui.api.setRoom(f.room); assert.equal(ui.input.value, '@Twin review');
  assert.deepEqual(createDraftStore({ storage }).get(f.room.id).mentions.map(person => person.id), [f.peer.id]);
  const copied = drafts.get(f.room.id); copied.mentions[0].id = 'mutated';
  assert.equal(drafts.get(f.room.id).mentions[0].id, f.peer.id);
  ui.type('review'); assert.equal(drafts.get(f.room.id).mentions, undefined);
  // Standalone mentions open autocomplete; an @ embedded in a word does not.
  ui.type('@Twin'); assert.equal(ui.form.querySelector('.mention-picker').hidden, false);
  ui.type('prefix@Twin'); assert.equal(ui.form.querySelector('.mention-picker').hidden, true);
});

test('uncertain retries keep original mention IDs while later edits retain their own draft recipients', async t => {
  const posts = [];
  const ui = setup(t, { listParticipants: async () => response([f.agent, f.peer]), postMessage: async (_, input) => {
    posts.push(input); if (posts.length === 1) throw Error('Uncertain transport failure'); return f.event;
  } });
  ui.api.setRoom(f.room); ui.type('@API'); await until(() => ui.options().length === 1);
  ui.key('Enter'); ui.type(ui.input.value + 'original'); ui.key('Enter');
  await until(() => ui.api.getPending()[0]?.status === 'failed');
  const request = ui.api.getPending()[0].requestId;
  ui.type('@Review'); ui.key('Enter'); ui.type(ui.input.value + 'new draft');
  await ui.api.retry(request);
  assert.deepEqual(posts[1], posts[0]); assert.deepEqual(posts[0].mention_ids, [f.agent.id]);
  assert.deepEqual(ui.drafts.get(f.room.id).mentions.map(person => person.id), [f.peer.id]);
  assert.equal(ui.input.value, '@Review agent new draft');
});

test('stale participant lookup cannot populate a different room; Escape and IME do not choose or send', async t => {
  const a = deferred(), b = deferred();
  const ui = setup(t, { listParticipants: id => id === f.room.id ? a.promise : b.promise });
  ui.api.setRoom(f.room); ui.type('@'); ui.api.setRoom(f.otherRoom); ui.type('@');
  a.resolve(response([f.agent])); await new Promise(setImmediate);
  assert.equal(ui.options().length, 0);
  b.resolve(response([f.peer])); await until(() => ui.options().length === 1);
  ui.key('Enter', { isComposing: true }); assert.equal(ui.input.value, '@');
  ui.key('Escape'); assert.equal(ui.form.querySelector('.mention-picker').hidden, true);
  ui.type('@Review'); assert.equal(ui.options().length, 1);
  ui.api.destroy();
  assert.equal(ui.form.querySelector('.mention-picker'), null);
  assert.equal(ui.input.getAttribute('aria-controls'), null);
});

test('mention matching avoids email and name prefixes; rendering keeps literal text and stable recipient identity', () => {
  const ann = { ...f.agent, name: 'Ann' }, lee = { ...f.peer, name: 'Ann Lee' };
  assert.deepEqual(mentionRanges('@Ann Lee, @Ann! mail@Ann @Anna', [ann, lee]).map(range => range.person.id), [lee.id, ann.id]);
  const { document } = parseHTML(html), element = document.getElementById('conversation');
  element.scrollTop = 0; element.scrollHeight = 100; element.clientHeight = 100;
  const view = createConversationView({ element }); view.setViewer(f.human);
  const target = { id: f.human.id, name: '<img src=x>', kind: 'human' };
  const event = { ...f.event, author: { id: f.agent.id, name: f.agent.name, kind: 'agent' },
    payload: { text: '@<img src=x> please review', reply_to: null, mentions: [target] } };
  view.setEvents([event]); target.name = 'mutated';
  assert.equal(element.querySelector('img'), null);
  assert.equal(element.querySelector('.mention-text').textContent, '@<img src=x>');
  assert.ok(element.querySelector('.message--mentioned'));
  assert.equal(element.querySelector('[data-mentioned-id]').dataset.mentionedId, f.human.id);
  const copy = view.getEvents(); copy[0].payload.mentions[0].name = 'changed copy';
  assert.equal(view.getEvents()[0].payload.mentions[0].name, '<img src=x>');
  view.setViewer({ ...f.human, id: 'different-person' });
  assert.equal(element.querySelector('.message--mentioned'), null);
  view.destroy();
});
