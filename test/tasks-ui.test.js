import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createTaskPanel } from '../public/chatroom/tasks.js';

const html = readFileSync(new URL('../public/chatroom/index.html', import.meta.url), 'utf8');
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function task(room, title = 'Test reported work') {
  return { id: 'task', room_id: room, title, scope: 'Bounded scope', status: 'in_progress', owner: { id: 'agent', name: 'Alice', kind: 'agent', workspace: null },
    created_by: { id: 'agent', name: 'Alice', kind: 'agent', workspace: null }, source_message_id: null, worker_ref: null,
    latest_update: 'Checking a fixture', result: '', version: 2, created_at: '2026-09-28T00:00:00.000Z', updated_at: '2026-09-28T00:00:00.000Z' };
}
function panel(t, client, pollMs = 60000) {
  const { document } = parseHTML(html);
  const element = document.getElementById('tasks-disclosure');
  const value = createTaskPanel({ client, element, pollMs }); t.after(() => value.destroy());
  return { ...value, element, $: id => document.getElementById(id) };
}

test('task room changes and teardown fence pending responses and abort their requests', async t => {
  const calls = [];
  const view = panel(t, { listTasks(room, { signal }) { const result = deferred(); calls.push({ room, signal, ...result }); return result.promise; } });
  const a = view.select({ id: 'a' }), b = view.select({ id: 'b' });
  assert.equal(calls[0].signal.aborted, true);
  calls[1].resolve({ room_id: 'b', tasks: [task('b', 'Current task')] }); await b;
  calls[0].resolve({ room_id: 'a', tasks: [task('a', 'Stale task')] }); await a;
  assert.match(view.element.textContent, /Current task/); assert.doesNotMatch(view.element.textContent, /Stale task/);
  const pending = view.refresh(); view.destroy();
  assert.equal(calls[2].signal.aborted, true);
  calls[2].resolve({ room_id: 'b', tasks: [task('b', 'Late task')] }); await pending;
  assert.doesNotMatch(view.element.textContent, /Late task/);
  assert.equal(await view.refresh(), null);
});

test('task failures retain last reports with a stale notice; refresh recovers and preserves open cards', async t => {
  let error = false;
  const view = panel(t, { async listTasks(room) {
    if (error) throw new Error('Hub disconnected');
    return { room_id: room, tasks: [task(room, '<img src=x> Literal task')] };
  } });
  await view.select({ id: 'a' });
  assert.equal(view.element.querySelector('img'), null);
  const card = view.element.querySelector('details'); card.setAttribute('open', '');
  await view.refresh(); assert.equal(view.element.querySelector('details'), card); // Unchanged polls preserve the DOM.
  error = true; await view.refresh();
  assert.match(view.$('tasks-status').textContent, /may be stale.*Hub disconnected/);
  assert.match(view.$('tasks-list').textContent, /Literal task/);
  error = false; await view.refresh();
  assert.equal(view.$('tasks-status').textContent, '');
  assert.ok(view.element.querySelector('details').hasAttribute('open'));
  await view.select(null);
  assert.match(view.$('tasks-list').textContent, /Select a room/);
  assert.equal(view.$('tasks-refresh').disabled, true);
});

test('task panel polls after completion, without overlapping requests, and stops on deselection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const view = panel(t, { listTasks(room) { const result = deferred(); calls.push({ room, ...result }); return result.promise; } }, 100);
  const first = view.select({ id: 'a' });
  t.mock.timers.tick(1000); assert.equal(calls.length, 1);
  calls[0].resolve({ room_id: 'a', tasks: [] }); await first;
  t.mock.timers.tick(100); assert.equal(calls.length, 2);
  t.mock.timers.tick(1000); assert.equal(calls.length, 2);
  calls[1].resolve({ room_id: 'a', tasks: [task('a')] }); await Promise.resolve(); await Promise.resolve();
  assert.match(view.$('tasks-list').textContent, /Test reported work/);
  await view.select(null); t.mock.timers.tick(1000); assert.equal(calls.length, 2);
});
