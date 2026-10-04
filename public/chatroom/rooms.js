import { requestId } from './ids.js';

export function createRoomNavigation({ client, list, createButton, onSelect = () => {}, onState = () => {}, requestRoom }) {
  const document = list.ownerDocument;
  let state = { rooms: [], selectedRoomId: null, status: 'idle', error: null, operation: null };
  let generation = 0;
  let controller = null;
  let destroyed = false;
  let requestingRoom = false;
  let cancelForm = null;
  const creations = new Map();
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.className = 'empty-note';
  list.after(status);
  const empty = document.getElementById('rooms-empty');
  let renderedRooms = '';

  const getState = () => ({ ...state, rooms: state.rooms.map(room => ({ ...room })) });
  function render() {
    const signature = JSON.stringify(state.rooms);
    if (signature !== renderedRooms) {
      const focusedId = list.contains(document.activeElement) ? document.activeElement?.dataset.roomId : null;
      list.replaceChildren(...state.rooms.map(room => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.dataset.roomId = room.id;
        button.textContent = `# ${room.name}`;
        item.append(button);
        return item;
      }));
      renderedRooms = signature;
      if (focusedId) [...list.querySelectorAll('button')].find(button => button.dataset.roomId === focusedId)?.focus();
    }
    for (const button of list.querySelectorAll('button')) {
      if (button.dataset.roomId === state.selectedRoomId) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    list.setAttribute('aria-busy', String(state.status === 'loading'));
    if (empty) {
      empty.hidden = state.rooms.length > 0 || state.status !== 'ready';
      empty.textContent = 'No rooms yet. Create a room to get started.';
    }
    status.textContent = state.error?.message ?? (state.status === 'loading' ? 'Loading rooms…' : '');
    status.hidden = !status.textContent;
  }
  function emit(patch) {
    if (destroyed) return;
    state = { ...state, ...patch };
    render();
    onState(getState());
  }
  function begin(kind) {
    controller?.abort();
    controller = new AbortController();
    const operation = { generation: ++generation, signal: controller.signal };
    emit({ status: 'loading', error: null, operation: kind });
    return operation;
  }
  const current = operation => !destroyed && operation.generation === generation;
  function fail(operation, error) {
    if (current(operation)) emit({ status: 'error', error, operation: null });
    return null;
  }
  function addRoom(room) {
    const rooms = state.rooms.filter(item => item.id !== room.id);
    rooms.push({ ...room });
    return rooms;
  }
  async function join(roomId, operation) {
    if (!current(operation)) return null;
    const result = await client.joinRoom(roomId, {}, { signal: operation.signal });
    if (!current(operation)) return null;
    emit({ rooms: state.rooms.some(room => room.id === result.room.id) ? state.rooms : addRoom(result.room), selectedRoomId: result.room.id, status: 'ready', error: null, operation: null });
    // A state observer may synchronously start another selection or destroy us.
    if (!current(operation)) return null;
    onSelect(result);
    return result;
  }
  async function select(roomId) {
    if (destroyed) return null;
    const operation = begin('select');
    try { return await join(roomId, operation); }
    catch (error) { return fail(operation, error); }
  }
  async function refresh() {
    if (destroyed) return null;
    const operation = begin('refresh');
    try {
      if (!current(operation)) return null;
      const { rooms } = await client.listRooms({ signal: operation.signal });
      if (!current(operation)) return null;
      emit({ rooms: rooms.map(room => ({ ...room })) });
      if (!current(operation)) return null;
      if (!state.selectedRoomId && rooms.length) {
        emit({ operation: 'select' });
        return await join(rooms[0].id, operation);
      }
      emit({ status: 'ready', error: null, operation: null });
      return getState();
    } catch (error) { return fail(operation, error); }
  }
  async function create({ name, goal = '' }) {
    if (destroyed) return null;
    const payload = { name: name.trim(), goal };
    const key = JSON.stringify(payload);
    let creation = creations.get(key);
    if (creation?.pending) return creation.pending;
    if (!creation) {
      creation = { requestId: requestId(), room: null, pending: null };
      creations.set(key, creation);
    }
    const operation = begin('create');
    const pending = Promise.resolve().then(async () => {
      try {
        if (!current(operation)) return null;
        if (!creation.room) {
          creation.room = await client.createRoom({ ...payload, request_id: creation.requestId }, { signal: operation.signal });
        }
        if (!current(operation)) return null;
        emit({ rooms: addRoom(creation.room) });
        if (!current(operation)) return null;
        const result = await join(creation.room.id, operation);
        if (result) creations.delete(key);
        return result;
      } catch (error) {
        // Definitive rejection can start a fresh attempt. Transport/response
        // uncertainty and failed joins retain the original mutation identity.
        if (!creation.room && error.status >= 400 && error.status < 500
          && !['INVALID_RESPONSE', 'VERSION_MISMATCH'].includes(error.code)) creations.delete(key);
        return fail(operation, error);
      } finally { creation.pending = null; }
    });
    creation.pending = pending;
    return pending;
  }

  function defaultRequestRoom() {
    return new Promise(resolve => {
      const form = document.createElement('form');
      form.setAttribute('aria-label', 'Create a room');
      const heading = document.createElement('h3');
      heading.textContent = 'Create a room';
      const nameLabel = document.createElement('label');
      nameLabel.textContent = 'Room name';
      const name = document.createElement('input');
      name.name = 'name'; name.required = true; name.maxLength = 80;
      nameLabel.append(name);
      const goalLabel = document.createElement('label');
      goalLabel.textContent = 'Room purpose (optional)';
      const goal = document.createElement('textarea');
      goal.name = 'goal'; goal.maxLength = 500; goal.rows = 3;
      goalLabel.append(goal);
      const submit = document.createElement('button');
      submit.type = 'submit'; submit.textContent = 'Create room';
      const cancel = document.createElement('button');
      cancel.type = 'button'; cancel.textContent = 'Cancel';
      // Keep the form usable in the compact rail without adding global styles.
      form.style.display = 'grid'; form.style.gap = '12px';
      for (const label of [nameLabel, goalLabel]) { label.style.display = 'grid'; label.style.gap = '4px'; }
      name.style.minWidth = '0'; name.style.width = '100%';
      form.append(heading, nameLabel, goalLabel, submit, cancel);
      function finish(value) {
        form.removeEventListener('submit', submitForm);
        form.removeEventListener('keydown', escape);
        cancel.removeEventListener('click', cancelForm);
        form.remove(); cancelForm = null;
        if (!destroyed) createButton.focus();
        resolve(value);
      }
      function submitForm(event) {
        event.preventDefault();
        if (!name.value.trim()) { name.focus(); return; }
        finish({ name: name.value.trim(), goal: goal.value });
      }
      function escape(event) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(null); }
      }
      cancelForm = () => finish(null);
      cancel.addEventListener('click', cancelForm);
      form.addEventListener('submit', submitForm);
      form.addEventListener('keydown', escape);
      createButton.after(form);
      name.focus();
    });
  }
  async function requestCreate() {
    if (destroyed || requestingRoom) return;
    requestingRoom = true;
    const promptGeneration = generation;
    try {
      const input = await (requestRoom ?? defaultRequestRoom)();
      if (!destroyed && input) await create(input);
    } catch (error) {
      if (!destroyed && generation === promptGeneration) emit({ status: 'error', error, operation: null });
    } finally { requestingRoom = false; }
  }
  function selectClicked(event) {
    const button = event.target.closest('button[data-room-id]');
    if (button && list.contains(button)) void select(button.dataset.roomId);
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true; ++generation; controller?.abort();
    cancelForm?.();
    createButton.removeEventListener('click', requestCreate);
    list.removeEventListener('click', selectClicked);
    createButton.disabled = true;
    list.removeAttribute('aria-busy');
    status.remove();
  }
  createButton.disabled = false;
  createButton.addEventListener('click', requestCreate);
  list.addEventListener('click', selectClicked);
  render();
  return { refresh, select, create, getState, destroy };
}
