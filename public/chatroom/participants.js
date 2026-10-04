import { participantAppearance } from './conversation.js';

export function createParticipantPanel({ client, list, inspector, pollMs = 5000 }) {
  const document = list.ownerDocument;
  const delay = Number.isFinite(pollMs) ? Math.max(1, Math.min(60000, pollMs)) : 5000;
  const placeholder = inspector.querySelector('#participants-empty');
  const status = document.createElement('p');
  status.className = 'empty-note'; status.setAttribute('role', 'status');
  list.before(status);
  let roomId = null;
  let records = [];
  let generation = 0;
  let controller = null;
  let timer = null;
  let destroyed = false;
  const current = operation => !destroyed && generation === operation;

  function node(tag, text) {
    const element = document.createElement(tag);
    element.textContent = text;
    return element;
  }
  function timestamp(value) {
    if (!value) return node('span', 'Unknown');
    const time = node('time', value); time.dateTime = value; return time;
  }
  function render(stale = false) {
    list.replaceChildren(...records.map(record => {
      const person = record.participant;
      const item = document.createElement('li');
      item.dataset.participantId = person.id;
      item.style.paddingBlock = '16px';
      item.style.borderBottom = '1px solid var(--line)';
      const heading = node('h3', person.name);
      heading.style.margin = '0 0 4px'; heading.style.fontSize = '14px';
      const identity = document.createElement('div');
      identity.className = 'participant-identity';
      const appearance = participantAppearance(person);
      identity.style.setProperty('--author-hue', String(appearance.hue));
      const avatar = node('span', appearance.initials);
      avatar.className = `participant-avatar${person.kind === 'human' ? ' participant-avatar--human' : ''}`;
      avatar.setAttribute('aria-hidden', 'true');
      const label = document.createElement('div');
      label.append(heading, node('p', person.kind === 'human' ? 'Human' : 'Agent'));
      identity.append(avatar, label);
      item.append(identity);
      const details = document.createElement('dl');
      details.style.margin = '12px 0 0';
      function field(label, value) {
        const term = node('dt', label); term.style.color = 'var(--muted)'; term.style.fontSize = '11px';
        const description = document.createElement('dd');
        description.style.margin = '0 0 10px'; description.style.whiteSpace = 'pre-wrap';
        description.append(typeof value === 'string' ? document.createTextNode(value) : value);
        details.append(term, description);
      }
      field('Runtime', person.runtime || 'Not reported');
      field('Workspace', person.workspace?.path || 'Not reported');
      if (person.workspace?.branch) field('Branch', person.workspace.branch);
      field('Context', person.context || 'Not reported');
      const suffix = stale ? ' (last known)' : '';
      const connections = { connected: 'Connected', disconnected: 'Disconnected' };
      const delivery = { receiving: 'Receiving room events', idle: 'No receive call waiting', paused: 'Delivery paused' };
      field(`Connection${suffix}`, connections[record.connection] ?? 'Unknown');
      field(`Room delivery${suffix}`, delivery[record.delivery] ?? 'Unknown');
      field(`Queued events${suffix}`, Number.isSafeInteger(record.pending_count) ? String(record.pending_count) : 'Unknown');
      field('Activity', record.activity ? `Last reported: ${record.activity.text}` : 'Activity unknown');
      if (record.activity) field('Activity reported at', timestamp(record.activity.reported_at));
      field('Last seen', timestamp(record.last_seen_at));
      item.append(details);
      return item;
    }));
    if (placeholder) {
      placeholder.hidden = records.length > 0;
      placeholder.textContent = roomId ? 'No participants in this room.' : 'Select a room to view participants.';
    }
  }
  function stop() {
    ++generation;
    controller?.abort(); controller = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function schedule(operation) {
    if (!current(operation) || !roomId) return;
    timer = setTimeout(() => { timer = null; void refresh(); }, delay);
  }
  async function refresh() {
    if (destroyed || !roomId) return null;
    stop();
    const operation = generation;
    const selectedRoom = roomId;
    controller = new AbortController();
    list.setAttribute('aria-busy', 'true');
    status.textContent = records.length ? 'Refreshing participant status…' : 'Loading participants…';
    if (placeholder && !records.length) placeholder.hidden = true;
    try {
      const result = await client.listParticipants(selectedRoom, { signal: controller.signal });
      if (!current(operation)) return null;
      records = result.participants.map(record => ({
        ...record, participant: { ...record.participant, workspace: record.participant.workspace ? { ...record.participant.workspace } : null },
        activity: record.activity ? { ...record.activity } : null,
      }));
      render(); status.textContent = '';
      return result;
    } catch (error) {
      if (!current(operation)) return null;
      render(true);
      status.textContent = records.length
        ? `Participant data may be stale. Could not refresh: ${error.message ?? 'Unknown error'}`
        : `Participant status unavailable: ${error.message ?? 'Unknown error'}`;
      if (placeholder && !records.length) placeholder.hidden = true;
      return null;
    } finally {
      if (current(operation)) { list.setAttribute('aria-busy', 'false'); schedule(operation); }
    }
  }
  function select(roomOrNull) {
    if (destroyed) return Promise.resolve(null);
    stop(); roomId = roomOrNull?.id ?? null; records = [];
    status.textContent = ''; list.setAttribute('aria-busy', 'false'); render();
    return roomId ? refresh() : Promise.resolve(null);
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true; stop(); status.remove(); list.removeAttribute('aria-busy');
  }
  render();
  return { select, refresh, destroy };
}
