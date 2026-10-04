import { participantAppearance } from './conversation.js';

const labels = { proposed: 'Unclaimed', in_progress: 'In progress', blocked: 'Blocked', in_review: 'Ready for review', completed: 'Completed', cancelled: 'Cancelled' };
const active = task => !['completed', 'cancelled'].includes(task.status);

export function createTaskPanel({ client, element, pollMs = 3000 }) {
  const document = element.ownerDocument;
  const list = element.querySelector('#tasks-list');
  const status = element.querySelector('#tasks-status');
  const count = element.querySelector('#tasks-count');
  const filter = element.querySelector('#tasks-filter');
  const refreshButton = element.querySelector('#tasks-refresh');
  const delay = Number.isFinite(pollMs) ? Math.max(100, Math.min(60000, pollMs)) : 3000;
  let roomId = null, records = [], all = true, generation = 0, controller = null, timer = null, destroyed = false, loaded = false;
  let openCards = new Set();
  const current = operation => !destroyed && operation === generation;
  function node(tag, text, className) {
    const result = document.createElement(tag);
    result.textContent = text;
    if (className) result.className = className;
    return result;
  }
  function render() {
    const focused = document.activeElement?.closest?.('[data-task-id]');
    const focusedId = focused?.dataset.taskId;
    for (const details of list.querySelectorAll('details[data-task-id]')) {
      if (details.hasAttribute('open')) openCards.add(details.dataset.taskId); else openCards.delete(details.dataset.taskId);
    }
    const activeCount = records.filter(active).length;
    count.textContent = roomId && loaded ? `${activeCount} active · ${records.length} total` : '';
    filter.textContent = all ? 'Show active only' : 'Show all tasks';
    filter.setAttribute('aria-pressed', String(!all));
    filter.disabled = refreshButton.disabled = !roomId;
    const visible = records.filter(task => all || active(task));
    list.replaceChildren(...visible.map(task => {
      const item = document.createElement('li');
      const card = document.createElement('details');
      card.className = 'task-card'; card.dataset.taskId = task.id; card.dataset.status = task.status;
      if (openCards.has(task.id)) card.setAttribute('open', '');
      const summary = document.createElement('summary');
      summary.append(node('span', task.title, 'task-title'), node('span', labels[task.status], 'task-status'));
      const identity = node('span', task.owner?.name ?? 'Available to claim', 'task-owner');
      if (task.owner) {
        identity.style.setProperty('--author-hue', String(participantAppearance(task.owner).hue));
        identity.title = `Participant ${task.owner.id}`;
      }
      summary.append(identity);
      if (task.latest_update) summary.append(node('span', task.latest_update, 'task-update'));
      const date = new Date(task.updated_at);
      const time = node('time', `Reported ${date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`, 'task-time');
      time.setAttribute('datetime', task.updated_at); time.title = date.toLocaleString(); summary.append(time);
      card.append(summary);
      const details = document.createElement('dl');
      function field(label, value) { if (value) details.append(node('dt', label), node('dd', value)); }
      field('Scope', task.scope);
      field('Workspace', task.owner?.workspace?.path);
      field('Worker', task.worker_ref || 'No delegated worker reported');
      field('Results & checks', task.result || 'No results reported yet');
      field('Proposed by', task.created_by.name);
      field('Task ID', task.id);
      if (task.source_message_id) {
        const source = node('a', 'Originating message');
        source.href = `#message-${encodeURIComponent(task.source_message_id)}`;
        source.title = 'The message may require loading earlier history.';
        const dd = document.createElement('dd'); dd.append(source);
        details.append(node('dt', 'Discussion'), dd);
      }
      card.append(details); item.append(card);
      return item;
    }));
    if (!visible.length) {
      list.append(node('li', !roomId ? 'Select a room to see its tasks.' : !loaded ? 'Task reports will appear here.'
        : records.length ? 'No active tasks. Show all tasks to see completed work.' : 'No tasks reported yet. Agents will add work here as they claim it.', 'empty-note'));
    }
    if (focusedId) [...list.querySelectorAll('details[data-task-id]')].find(card => card.dataset.taskId === focusedId)?.querySelector('summary')?.focus();
  }
  function stop() {
    ++generation; controller?.abort(); controller = null;
    clearTimeout(timer); timer = null;
  }
  async function refresh() {
    if (destroyed || !roomId) return null;
    stop(); const operation = generation, selectedRoom = roomId;
    controller = new AbortController(); list.setAttribute('aria-busy', 'true');
    if (!loaded) status.textContent = 'Loading task reports…';
    try {
      const result = await client.listTasks(selectedRoom, { signal: controller.signal });
      if (!current(operation)) return null;
      if (result.room_id !== selectedRoom || !Array.isArray(result.tasks)
        || result.tasks.some(task => task.room_id !== selectedRoom || !Object.hasOwn(labels, task.status))) throw new Error('Invalid task response.');
      const changed = !loaded || JSON.stringify(records) !== JSON.stringify(result.tasks);
      records = structuredClone(result.tasks); loaded = true;
      if (changed) render();
      status.textContent = '';
      return result;
    } catch (error) {
      if (!current(operation)) return null;
      status.textContent = loaded ? `Task reports may be stale. ${error.message}` : `Tasks unavailable. ${error.message}`;
      return null;
    } finally {
      if (current(operation)) {
        list.setAttribute('aria-busy', 'false');
        timer = setTimeout(() => { timer = null; void refresh(); }, delay);
      }
    }
  }
  function select(room) {
    if (destroyed) return Promise.resolve(null);
    stop(); roomId = room?.id ?? null; records = []; loaded = false;
    list.replaceChildren(); openCards = new Set();
    status.textContent = ''; list.setAttribute('aria-busy', 'false'); render();
    return roomId ? refresh() : Promise.resolve(null);
  }
  function toggleFilter() { all = !all; render(); }
  function refreshClicked() { void refresh(); }
  function destroy() {
    if (destroyed) return;
    destroyed = true; stop();
    filter.removeEventListener('click', toggleFilter); refreshButton.removeEventListener('click', refreshClicked);
    list.removeAttribute('aria-busy');
  }
  filter.addEventListener('click', toggleFilter); refreshButton.addEventListener('click', refreshClicked);
  render();
  return { select, refresh, destroy };
}
