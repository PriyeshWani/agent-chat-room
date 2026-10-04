import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createParticipantPanel } from '../public/chatroom/participants.js';
import { RoomClient } from '../src/shared/client.js';
import { createFixtureServer } from './helpers/fixture-server.js';
import * as fixtures from '../src/shared/fixtures.js';

const html = readFileSync(new URL('../public/chatroom/index.html', import.meta.url), 'utf8');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(client, pollMs = 10) {
  const { document } = parseHTML(html);
  const list = document.getElementById('participants-list');
  const inspector = document.getElementById('inspector');
  const panel = createParticipantPanel({ client, list, inspector, pollMs });
  return { document, list, inspector, panel };
}
const status = (overrides = {}) => ({ ...fixtures.status, ...overrides });
async function until(predicate) {
  for (let i = 0; i < 30; i++) { if (predicate()) return; await Promise.resolve(); }
  assert.ok(predicate(), 'Controlled request did not settle');
}

test('participant identity, context, workspace and separate status dimensions render as literal text', async () => {
  const record = status({
    participant: { ...fixtures.agent, name: '<script>name</script>', runtime: '<b>runtime</b>', workspace: { path: '/repo/<img src=x>', branch: '<b>branch</b>' }, context: '<img src=x>\nContext line two' },
    connection: 'connected', delivery: 'idle', pending_count: 3,
    activity: { text: '<b>Reviewing</b>', reported_at: fixtures.createdAt },
  });
  const { panel, list } = setup({ listParticipants: async () => ({ participants: [record] }) });
  await panel.select(fixtures.room);
  assert.equal(list.querySelector('script, img, b'), null);
  for (const text of ['<script>name</script>', '<b>runtime</b>', '/repo/<img src=x>', '<b>branch</b>', 'Context line two', 'Connected', 'No receive call waiting', 'Queued events', '3', 'Last reported: <b>Reviewing</b>']) {
    assert.ok(list.textContent.includes(text), text);
  }
  assert.equal(list.querySelector('time').dateTime, fixtures.createdAt);
  assert.equal(list.querySelectorAll('button, select, input').length, 0);
  panel.destroy();
});

test('receiving, paused, unknown activity and missing metadata stay explicit without inferred work', async () => {
  const records = [status({ delivery: 'receiving', activity: null }), status({ participant: { ...fixtures.human }, connection: 'disconnected', delivery: 'paused', pending_count: 0, activity: null, last_seen_at: null })];
  const { panel, list } = setup({ listParticipants: async () => ({ participants: records }) });
  await panel.select(fixtures.room);
  assert.match(list.textContent, /Receiving room events/);
  assert.match(list.textContent, /Delivery paused/);
  assert.match(list.textContent, /Disconnected/);
  assert.match(list.textContent, /Activity unknown/);
  assert.match(list.textContent, /Human/);
  assert.match(list.textContent, /Not reported/);
  assert.match(list.textContent, /Unknown/);
  assert.doesNotMatch(list.textContent, /typing|idle agent|worker failed|read receipt/i);
  panel.destroy();
});

test('mounting, refresh and select(null) preserve inspector disclosure controls', async () => {
  const { panel, inspector, list, document } = setup({ listParticipants: async () => ({ participants: [status()] }) });
  const details = inspector.querySelector('details');
  const summary = inspector.querySelector('summary');
  details.open = false;
  await panel.select(fixtures.room); await panel.refresh();
  assert.equal(inspector.querySelector('details'), details);
  assert.equal(inspector.querySelector('summary'), summary);
  assert.equal(details.open, false);
  await panel.select(null);
  assert.equal(list.children.length, 0);
  assert.equal(document.getElementById('participants-empty').hidden, false);
  assert.match(document.getElementById('participants-empty').textContent, /Select a room/);
  panel.destroy();
  assert.equal(inspector.querySelector('summary'), summary);
});

test('failed refresh keeps copied data labeled last-known/stale and recovery restores current presentation', async () => {
  const record = status(); let fail = false;
  const { panel, list, inspector } = setup({ listParticipants: async () => {
    if (fail) throw Error('<img src=x> offline');
    return { participants: [record] };
  } });
  await panel.select(fixtures.room);
  record.participant = { ...record.participant, name: 'New upstream name' };
  fail = true; await panel.refresh();
  assert.match(inspector.textContent, /may be stale/);
  assert.match(list.textContent, /Connection \(last known\)/);
  assert.match(list.textContent, /Room delivery \(last known\)/);
  assert.match(list.textContent, /API agent/);
  assert.doesNotMatch(list.textContent, /New upstream name/);
  assert.equal(inspector.querySelector('img'), null);
  fail = false; await panel.refresh();
  assert.doesNotMatch(inspector.textContent, /stale|last known/);
  assert.match(list.textContent, /New upstream name/);
  panel.destroy();
});

test('initial failure does not claim an empty participant list; successful empty result does', async () => {
  let fail = true;
  const { panel, inspector, document } = setup({ listParticipants: async () => { if (fail) throw Error('unavailable'); return { participants: [] }; } });
  await panel.select(fixtures.room);
  assert.match(inspector.textContent, /Participant status unavailable/);
  assert.equal(document.getElementById('participants-empty').hidden, true);
  fail = false; await panel.refresh();
  assert.equal(document.getElementById('participants-empty').hidden, false);
  assert.match(document.getElementById('participants-empty').textContent, /No participants/);
  panel.destroy();
});

test('old-room success and error cannot replace the newly selected room', async () => {
  for (const reject of [false, true]) {
    const old = deferred(); const requests = [];
    const { panel, list, inspector } = setup({ listParticipants: (id, options) => {
      requests.push({ id, signal: options.signal });
      return id === fixtures.room.id ? old.promise : Promise.resolve({ participants: [status({ participant: fixtures.peer })] });
    } });
    const first = panel.select(fixtures.room);
    await panel.select(fixtures.otherRoom);
    assert.equal(requests[0].signal.aborted, true);
    if (reject) old.reject(Error('obsolete')); else old.resolve({ participants: [status()] });
    await first;
    assert.match(list.textContent, /Review agent/);
    assert.doesNotMatch(inspector.textContent, /API agent|obsolete/);
    panel.destroy();
  }
});

test('a newer manual refresh aborts and fences an older same-room request', async () => {
  const requests = [];
  const { panel, list } = setup({ listParticipants: (_, { signal }) => { const request = { ...deferred(), signal }; requests.push(request); return request.promise; } });
  const first = panel.select(fixtures.room); const second = panel.refresh();
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve({ participants: [status({ participant: fixtures.peer })] }); await second;
  requests[0].resolve({ participants: [status()] }); await first;
  assert.match(list.textContent, /Review agent/); assert.doesNotMatch(list.textContent, /API agent/);
  panel.destroy();
});

test('polls are scheduled after completion, never overlap, and stop on select(null)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [];
  const { panel } = setup({ listParticipants: (_, { signal }) => { const request = { ...deferred(), signal }; requests.push(request); return request.promise; } });
  const first = panel.select(fixtures.room);
  t.mock.timers.tick(100); assert.equal(requests.length, 1);
  requests[0].resolve({ participants: [] }); await first;
  t.mock.timers.tick(9); assert.equal(requests.length, 1);
  t.mock.timers.tick(1); assert.equal(requests.length, 2);
  t.mock.timers.tick(100); assert.equal(requests.length, 2);
  requests[1].resolve({ participants: [] }); await until(() => requests[1].signal.aborted === false);
  await panel.select(null);
  assert.equal(requests[1].signal.aborted, true);
  t.mock.timers.tick(100); assert.equal(requests.length, 2);
  panel.destroy();
});

test('polling recovers after failure and destroy cancels scheduled requests', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const { panel, inspector } = setup({ listParticipants: async () => { if (++calls === 1) throw Error('offline'); return { participants: [status()] }; } });
  await panel.select(fixtures.room); assert.match(inspector.textContent, /unavailable/);
  t.mock.timers.tick(10); await until(() => inspector.textContent.includes('API agent'));
  assert.equal(calls, 2);
  panel.destroy(); t.mock.timers.tick(100); assert.equal(calls, 2);
});

test('destroy aborts active HTTP and late results cannot mutate DOM', async () => {
  const response = deferred(); let signal;
  const { panel, list } = setup({ listParticipants: (_, options) => { signal = options.signal; return response.promise; } });
  const selecting = panel.select(fixtures.room); panel.destroy();
  assert.equal(signal.aborted, true);
  response.resolve({ participants: [status()] }); await selecting;
  assert.equal(list.children.length, 0);
  await panel.refresh(); await panel.select(fixtures.otherRoom); assert.equal(list.children.length, 0);
});

test('participant panel consumes the real shared client fixture response shape', async t => {
  const fixture = await createFixtureServer(); t.after(() => fixture.close());
  const { panel, list } = setup(new RoomClient({ baseUrl: fixture.url })); t.after(() => panel.destroy());
  await panel.select(fixtures.room);
  assert.match(list.textContent, /API agent/);
  assert.match(list.textContent, /No receive call waiting/);
  assert.match(list.textContent, /Activity unknown/);
  assert.equal(fixture.calls[0].path, `/rooms/${fixtures.room.id}/participants`);
});
