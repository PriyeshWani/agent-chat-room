import { requestId } from './ids.js';

const snapshot = person => ({ id: person.id, name: person.name, kind: person.kind });
const boundaryBefore = char => !char || /[\s([{"']/u.test(char);
const boundaryAfter = char => !char || !/[\p{L}\p{N}_]/u.test(char);

export function mentionRanges(text, people) {
  const candidates = [...people].sort((a, b) => b.name.length - a.name.length);
  const ranges = [];
  for (let start = text.indexOf('@'); start !== -1; start = text.indexOf('@', start + 1)) {
    if (!boundaryBefore(text[start - 1])) continue;
    const person = candidates.find(person => text.startsWith(`@${person.name}`, start)
      && boundaryAfter(text[start + person.name.length + 1]));
    if (person) {
      const end = start + person.name.length + 1;
      ranges.push({ start, end, person });
      start = end - 1;
    }
  }
  return ranges;
}

export function createMentionPicker({ client, input, form }) {
  const document = form.ownerDocument;
  const popup = document.createElement('div');
  popup.className = 'mention-picker'; popup.id = `mentions-${requestId()}`;
  popup.setAttribute('role', 'listbox'); popup.setAttribute('aria-label', 'Mention a room participant');
  popup.hidden = true;
  const targets = document.createElement('div'); targets.className = 'mention-targets'; targets.hidden = true;
  const status = document.createElement('span'); status.className = 'sr-only'; status.setAttribute('role', 'status');
  form.append(popup, targets, status);
  const attributes = ['aria-autocomplete', 'aria-controls', 'aria-expanded', 'aria-activedescendant'];
  const original = new Map(attributes.map(key => [key, input.getAttribute(key)]));
  input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-controls', popup.id);
  input.setAttribute('aria-expanded', 'false');
  let roomId = null, records = [], selected = [], matches = [], active = 0, queryKey = null;
  let generation = 0, controller = null, loadedAt = 0, error = null, destroyed = false, dismissed = false;

  function token() {
    if (!roomId || dismissed) return null;
    const caret = input.selectionStart ?? input.value.length;
    if ((input.selectionEnd ?? caret) !== caret) return null;
    const start = input.value.lastIndexOf('@', caret - 1);
    if (start < 0 || !boundaryBefore(input.value[start - 1])) return null;
    const query = input.value.slice(start + 1, caret);
    if (query.length > 80 || /[\r\n@]/u.test(query)) return null;
    // A completed, selected mention followed by whitespace is no longer a query.
    if (selected.some(person => query.startsWith(person.name + ' '))) return null;
    return { start, caret, query };
  }
  function getMentions() {
    const found = selected.filter(person => mentionRanges(input.value, [person]).length);
    const names = new Map();
    for (const { participant } of records) names.set(participant.name, (names.get(participant.name) ?? 0) + 1);
    const unique = records.map(record => record.participant).filter(person => names.get(person.name) === 1
      && !found.some(chosen => chosen.name === person.name));
    for (const { person } of mentionRanges(input.value, unique)) if (!found.some(chosen => chosen.id === person.id)) found.push(person);
    return found.map(snapshot);
  }
  function close() {
    popup.hidden = true; matches = []; queryKey = null;
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
  }
  function renderTargets() {
    const mentions = getMentions();
    targets.replaceChildren(); targets.hidden = !mentions.length;
    if (mentions.length) targets.append(document.createTextNode('Addressing '));
    for (const person of mentions) {
      const chip = document.createElement('span'); chip.className = 'mention-chip';
      chip.textContent = `@${person.name}`; chip.title = `${person.kind} · ${person.id}`;
      targets.append(chip);
    }
  }
  function render() {
    if (destroyed) return;
    renderTargets();
    const current = token();
    if (!current) { close(); return; }
    const key = `${current.start}:${current.query}`;
    if (queryKey !== key) active = 0;
    queryKey = key;
    matches = records.filter(({ participant }) => participant.name.toLocaleLowerCase().startsWith(current.query.toLocaleLowerCase())).slice(0, 10);
    if (!matches.length && mentionRanges(`@${current.query}`, records.map(record => record.participant)).length) { close(); return; }
    active = Math.min(active, Math.max(0, matches.length - 1));
    popup.replaceChildren(); popup.hidden = false; input.setAttribute('aria-expanded', 'true');
    if (!matches.length) {
      const message = document.createElement('p');
      message.textContent = controller ? 'Loading participants…' : error ? 'Could not load participants. Type @ again to retry.' : 'No matching participants';
      popup.append(message); input.removeAttribute('aria-activedescendant');
      return;
    }
    matches.forEach((record, index) => {
      const person = record.participant;
      const option = document.createElement('button'); option.type = 'button'; option.tabIndex = -1;
      option.id = `${popup.id}-${index}`; option.dataset.mentionIndex = String(index);
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(index === active));
      const name = document.createElement('strong'); name.textContent = `@${person.name}`;
      const detail = document.createElement('small');
      const duplicate = records.some(other => other.participant.id !== person.id && other.participant.name === person.name);
      detail.textContent = `${person.kind === 'agent' ? 'Agent' : 'Human'} · ${record.connection}${duplicate ? ` · ${person.id.slice(0, 8)}` : ''}`;
      option.title = [person.name, person.workspace?.path, person.id].filter(Boolean).join(' · ');
      option.append(name, detail); popup.append(option);
    });
    input.setAttribute('aria-activedescendant', `${popup.id}-${active}`);
    popup.children[active]?.scrollIntoView?.({ block: 'nearest' });
  }
  async function load() {
    if (!roomId || controller || typeof client.listParticipants !== 'function') return;
    const operation = generation;
    const request = new AbortController(); controller = request;
    try {
      const result = await client.listParticipants(roomId, { signal: request.signal });
      if (destroyed || operation !== generation) return;
      records = result.participants; error = null; loadedAt = Date.now();
    } catch (failure) {
      if (destroyed || operation !== generation) return;
      error = failure; loadedAt = Date.now();
    } finally {
      request.abort();
      if (!destroyed && operation === generation) { controller = null; render(); }
    }
  }
  function changed() {
    dismissed = false;
    selected = selected.filter(person => mentionRanges(input.value, [person]).length);
    if (token() && Date.now() - loadedAt > 5000) void load();
    render();
  }
  function choose(index) {
    const current = token(), person = matches[index]?.participant;
    if (!current || !person) return;
    const replacement = `@${person.name} `;
    const next = input.value.slice(0, current.start) + replacement + input.value.slice(current.caret);
    if (next.length > input.maxLength && input.maxLength > 0) { status.textContent = 'Mention would exceed the message length limit.'; return; }
    if (!selected.some(chosen => chosen.id === person.id)) selected.push(snapshot(person));
    input.value = next;
    input.focus();
    input.setSelectionRange?.(current.start + replacement.length, current.start + replacement.length);
    input.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
    dismissed = true; close(); renderTargets();
    status.textContent = `Mentioned ${person.name}.`;
  }
  function keydown(event) {
    if (event.isComposing || event.keyCode === 229 || popup.hidden) return false;
    if (event.key === 'Escape') { event.preventDefault(); dismissed = true; close(); return true; }
    if (!matches.length) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); active = (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      render(); return true;
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') { event.preventDefault(); choose(active); return true; }
    return false;
  }
  function setRoom(room, mentions = []) {
    ++generation; controller?.abort(); controller = null;
    roomId = room?.id ?? null; records = []; selected = mentions.map(snapshot); loadedAt = 0; error = null; dismissed = true;
    close(); renderTargets();
    if (roomId) void load();
  }
  function clicked(event) {
    const option = event.target.closest('[data-mention-index]');
    if (option && popup.contains(option)) choose(Number(option.dataset.mentionIndex));
  }
  function keepFocus(event) { event.preventDefault(); }
  function moved() { render(); }
  function outside(event) { if (!form.contains(event.target)) { dismissed = true; close(); } }
  popup.addEventListener('pointerdown', keepFocus); popup.addEventListener('click', clicked);
  input.addEventListener('click', moved); input.addEventListener('keyup', moved);
  document.addEventListener('pointerdown', outside);
  function destroy() {
    destroyed = true; ++generation; controller?.abort();
    popup.removeEventListener('pointerdown', keepFocus); popup.removeEventListener('click', clicked);
    input.removeEventListener('click', moved); input.removeEventListener('keyup', moved);
    document.removeEventListener('pointerdown', outside);
    for (const [key, value] of original) if (value === null) input.removeAttribute(key); else input.setAttribute(key, value);
    popup.remove(); targets.remove(); status.remove();
  }
  return { setRoom, changed, keydown, getMentions, close, destroy };
}
