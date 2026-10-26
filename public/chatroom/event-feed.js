const copyEvent = event => ({ ...event, author: { ...event.author }, payload: { ...event.payload,
  ...(event.payload.mentions ? { mentions: event.payload.mentions.map(person => ({ ...person })) } : {}) } });
const invalid = message => Object.assign(new Error(message), { code: 'INVALID_RESPONSE' });
const fatal = error => error?.code === 'INVALID_RESPONSE' || error?.code === 'VERSION_MISMATCH'
  || (error?.status >= 400 && error?.status < 500);

export function createEventFeed({ client, onEvents = () => {}, onState = () => {}, onStreamEvent = () => {}, retryMs = 1000 }) {
  const delay = Number.isFinite(retryMs) ? Math.max(1, Math.min(30000, retryMs)) : 1000;
  let session = null;
  let destroyed = false;
  let state = { roomId: null, status: 'idle', error: null, nextBefore: null };
  const getState = () => ({ ...state });
  const current = value => !destroyed && session === value;
  function emit(value, patch) {
    if (!current(value)) return;
    state = { ...state, ...patch }; onState(getState());
  }
  function streamState(value, status, error = null) {
    if (!current(value)) return;
    value.streamStatus = status; value.streamError = error;
    emit(value, { status, error });
  }
  function publish(value) {
    if (current(value)) onEvents([...value.events.values()]
      .sort((a, b) => a.sequence - b.sequence).map(copyEvent));
  }
  function insert(value, event) {
    if (!event || event.room_id !== value.roomId || typeof event.id !== 'string'
      || !Number.isSafeInteger(event.sequence) || event.sequence < 1) throw invalid('Invalid room event.');
    const previous = value.events.get(event.id);
    const sequenceId = value.sequences.get(event.sequence);
    if ((previous && previous.sequence !== event.sequence) || (sequenceId && sequenceId !== event.id)) {
      throw invalid('Conflicting room event identity or sequence.');
    }
    if (previous) return false;
    value.events.set(event.id, copyEvent(event)); value.sequences.set(event.sequence, event.id);
    return true;
  }
  function cancel(value) {
    if (!value) return;
    value.streamController?.abort(); value.pageController?.abort();
    if (value.timer !== null) clearTimeout(value.timer);
    value.wake?.(false); value.timer = null; value.wake = null;
  }
  function pause(value) {
    return new Promise(resolve => {
      if (!current(value)) { resolve(false); return; }
      value.wake = resolve;
      value.timer = setTimeout(() => {
        value.timer = null; value.wake = null; resolve(current(value));
      }, delay);
    });
  }
  // Stop our loop even if an injected transport ignores AbortSignal. Attach both
  // fulfillment/rejection handlers so a late next() result cannot escape.
  function next(iterator, signal) {
    return new Promise((resolve, reject) => {
      function aborted() { cleanup(); resolve({ done: true }); }
      function cleanup() { signal.removeEventListener('abort', aborted); }
      if (signal.aborted) { resolve({ done: true }); return; }
      signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(() => signal.aborted ? { done: true } : iterator.next()).then(
        result => { cleanup(); resolve(result); },
        error => { cleanup(); reject(error); },
      );
    });
  }
  function closeIterator(iterator) {
    // Async generators may wait for an outstanding next() before return().
    // Do not let that prevent a new room from starting immediately.
    try { Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* Already closed. */ }
  }
  async function run(value) {
    while (current(value)) {
      const controller = new AbortController();
      value.streamController = controller;
      let iterator;
      let error = null;
      try {
        iterator = client.events(value.roomId, {
          after: value.cursor, signal: controller.signal,
          onOpen: () => {
            if (current(value) && !controller.signal.aborted) streamState(value, 'live');
          },
        })[Symbol.asyncIterator]();
        while (current(value) && !controller.signal.aborted) {
          const result = await next(iterator, controller.signal);
          if (!current(value) || controller.signal.aborted) return;
          if (result.done) break;
          const event = result.value;
          const changed = insert(value, event);
          if (event.sequence > value.cursor) value.observed.add(event.sequence);
          const gap = event.sequence > value.cursor + 1;
          while (value.observed.delete(value.cursor + 1)) value.cursor++;
          if (changed) publish(value);
          if (!current(value)) return;
          if (changed) onStreamEvent(copyEvent(event));
          if (!current(value)) return;
          if (gap) {
            error = Object.assign(new Error('Room events arrived out of order; replaying the missing events.'), { code: 'EVENT_GAP' });
            break;
          }
          streamState(value, 'live');
        }
      } catch (caught) { error = caught; }
      finally { controller.abort(); closeIterator(iterator); }
      if (!current(value)) return;
      if (fatal(error)) { streamState(value, 'error', error); return; }
      streamState(value, 'reconnecting', error);
      if (!await pause(value)) return;
    }
  }
  function select(joinResult) {
    if (destroyed) return getState();
    cancel(session);
    const value = {
      roomId: joinResult?.room.id ?? null, cursor: joinResult?.history.head_sequence ?? 0,
      events: new Map(), sequences: new Map(), observed: new Set(),
      streamController: null, pageController: null, page: null, timer: null, wake: null,
      streamStatus: joinResult ? 'connecting' : 'idle', streamError: null,
    };
    session = value;
    state = { roomId: value.roomId, status: value.streamStatus, error: null, nextBefore: joinResult?.history.next_before ?? null };
    try {
      for (const event of joinResult?.history.events ?? []) insert(value, event);
    } catch (error) {
      value.events.clear(); value.sequences.clear();
      streamState(value, 'error', error); publish(value); return getState();
    }
    emit(value, {}); publish(value);
    if (joinResult && current(value)) void run(value);
    return getState();
  }
  function add(event) {
    const value = session;
    if (!value || !current(value) || event.room_id !== value.roomId) return;
    try { if (insert(value, event)) publish(value); }
    catch (error) { cancel(value); streamState(value, 'error', error); }
    // Posting confirms this event, not any intervening events. Only run() may
    // advance the stream cursor or its contiguous observed-sequence set.
  }
  function loadOlder() {
    const value = session;
    if (!value || !current(value) || !value.roomId || state.nextBefore === null) return Promise.resolve(null);
    if (value.page) return value.page;
    const before = state.nextBefore;
    const controller = new AbortController(); value.pageController = controller;
    value.page = Promise.resolve().then(async () => {
      try {
        if (!current(value)) return null;
        const history = await client.history(value.roomId, { before, signal: controller.signal });
        if (!current(value) || controller.signal.aborted) return null;
        if (history.room.id !== value.roomId) throw invalid('History belongs to another room.');
        let changed = false;
        for (const event of history.events) changed = insert(value, event) || changed;
        emit(value, { nextBefore: history.next_before, status: value.streamStatus, error: value.streamError });
        if (changed) publish(value);
        return history;
      } catch (error) {
        if (current(value) && !controller.signal.aborted) emit(value, { status: 'error', error });
        return null;
      } finally { value.page = null; }
    });
    return value.page;
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true; cancel(session); session = null;
  }
  return { select, add, loadOlder, getState, destroy };
}
