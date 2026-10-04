import { Inputs, Outputs } from '../shared/schemas.js';
import { ApiError, requestId } from '../shared/protocol.js';

function waitFor(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function createConnection({ client, profile, resumeToken, inviteToken, mode = 'create', heartbeatMs = 10000, retryMs = 250, maxRetries = 4, enrollmentTimeoutMs = 10000, onState = () => {} }) {
  let issuance = Inputs.agentSession.parse({ ...profile, mode, resume_token: resumeToken, request_id: requestId(), ...(inviteToken ? { invite_token: inviteToken } : {}) });
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || !Number.isSafeInteger(retryMs) || retryMs < 0
    || !Number.isSafeInteger(maxRetries) || maxRetries < 0
    || !Number.isSafeInteger(enrollmentTimeoutMs) || enrollmentTimeoutMs < 1) throw new TypeError('Invalid connection timing.');
  const lifetime = new AbortController();
  let state = { status: 'idle', participant: null, error: null };
  let flight = null, started = false, version = 0, timer, closing, terminal, issuancePending = true;
  const getState = () => structuredClone(state);
  function update(status, error = null) {
    if (state.status === 'closed' || (state.status === 'replaced' && status !== 'closed')) return;
    state = { ...state, status, error: error ? {
      code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR',
      message: error instanceof ApiError ? error.message : 'The connection could not complete this request.',
      retryable: error instanceof ApiError && error.retryable === true,
    } : null };
    try { onState(getState()); } catch { /* Observers cannot alter connection control flow. */ }
  }
  function fence(error) {
    terminal = error;
    update('replaced', error);
    clearTimeout(timer);
    lifetime.abort(error);
  }
  function assertOpen() { if (terminal) throw terminal; lifetime.signal.throwIfAborted(); }
  const backoff = (attempt, signal) => sleep(Math.min(retryMs * 2 ** attempt, 5000), signal);
  const transient = error => error instanceof ApiError && error.retryable === true;
  async function issue(signal) {
    for (let attempt = 0; ; attempt++) {
      assertOpen(); signal.throwIfAborted();
      try {
        const raw = await waitFor(client.agentSession(issuance, { signal }), signal);
        assertOpen(); signal.throwIfAborted();
        const parsed = Outputs.agentSession.safeParse(raw);
        if (!parsed.success) throw new ApiError('INVALID_RESPONSE', 'Invalid agent enrollment response.');
        state.participant = parsed.data.participant;
        version++; started = true; issuancePending = false;
        update('connected');
        return structuredClone(state.participant);
      } catch (error) {
        assertOpen(); signal.throwIfAborted();
        if (error.code === 'SESSION_REPLACED') { fence(error); throw error; }
        const expiredIssuance = error.code === 'SESSION_EXPIRED';
        if (attempt >= maxRetries || (!transient(error) && !expiredIssuance)) { update('reconnecting', error); throw error; }
        // An expired create replay proves the binding exists, but its old
        // issuance cannot return a usable connection after a hub restart.
        if (expiredIssuance) issuance = { ...issuance, mode: 'resume', request_id: requestId() };
        update('reconnecting', error);
        await backoff(attempt, signal);
      }
    }
  }
  function enroll(recover = false, callerSignal) {
    assertOpen();
    if (flight) return flight;
    if (recover && !issuancePending) { issuance = { ...issuance, mode: 'resume', request_id: requestId() }; issuancePending = true; }
    update(started || recover ? 'reconnecting' : 'connecting');
    const deadline = AbortSignal.timeout(enrollmentTimeoutMs);
    const signal = AbortSignal.any([lifetime.signal, deadline, ...(callerSignal ? [callerSignal] : [])]);
    flight = issue(signal).catch(error => {
      if (deadline.aborted && !lifetime.signal.aborted && !callerSignal?.aborted) {
        error = new ApiError('HUB_TIMEOUT', 'The hub did not finish enrollment in time.', { status: 0, retryable: true });
      }
      update('reconnecting', error);
      throw error;
    }).finally(() => { flight = null; });
    return flight;
  }
  function schedule() {
    if (!started || lifetime.signal.aborted || timer) return;
    timer = setTimeout(async () => {
      timer = null;
      try { await facade.heartbeat(); } catch { /* State/error handling belongs to invoke. */ }
      finally { schedule(); }
    }, heartbeatMs);
    timer.unref?.();
  }
  async function start({ signal } = {}) {
    assertOpen();
    signal?.throwIfAborted();
    if (started) return structuredClone(state.participant);
    const pending = enroll(false, signal);
    // A caller can cancel just as enrollment commits. Keep that established
    // connection alive, without scheduling from ordinary heartbeat invocations.
    try { return await (signal ? waitFor(pending, signal) : pending); }
    finally { schedule(); }
  }
  async function invoke(action, callerSignal) {
    assertOpen();
    const signal = callerSignal ? AbortSignal.any([lifetime.signal, callerSignal]) : lifetime.signal;
    signal.throwIfAborted();
    await waitFor(start({ signal }), signal);
    let recovered = false, failures = 0;
    for (;;) {
      signal.throwIfAborted();
      if (flight) await waitFor(flight, signal);
      const observed = version;
      try {
        const result = await waitFor(Promise.resolve().then(() => { signal.throwIfAborted(); return action(signal); }), signal);
        assertOpen();
        update('connected');
        return result;
      } catch (error) {
        assertOpen(); signal.throwIfAborted();
        if (error.code === 'SESSION_REPLACED') { fence(error); throw error; }
        if (error.code === 'SESSION_EXPIRED' && !recovered) {
          recovered = true;
          if (observed === version) await waitFor(enroll(true, signal), signal);
          continue;
        }
        if (!transient(error) || failures >= maxRetries) { if (transient(error)) update('reconnecting', error); throw error; }
        update('reconnecting', error);
        await backoff(failures++, signal);
      }
    }
  }
  const facade = {};
  for (const name of ['listRooms', 'disconnect']) facade[name] = (options = {}) => invoke(signal => client[name]({ ...options, signal }), options.signal);
  facade.listParticipants = (room, options = {}) => invoke(signal => client.listParticipants(room, { ...options, signal }), options.signal);
  facade.listTasks = (room, options = {}) => invoke(signal => client.listTasks(room, { ...options, signal }), options.signal);
  facade.history = (room, options = {}) => {
    const saved = { ...options };
    return invoke(signal => client.history(room, { ...saved, signal }), options.signal);
  };
  facade.heartbeat = (input = {}, options = {}) => {
    const saved = structuredClone(input);
    return invoke(signal => client.heartbeat(saved, { ...options, signal }), options.signal);
  };
  for (const name of ['joinRoom', 'leaveRoom', 'postMessage', 'ackEvents', 'receiveEvents', 'createTask', 'claimTask', 'updateTask']) facade[name] = (room, input = {}, options = {}) => {
    const saved = structuredClone(name === 'receiveEvents' ? input : { ...input, request_id: input.request_id === undefined ? requestId() : input.request_id });
    return invoke(signal => client[name](room, saved, { ...options, signal }), options.signal);
  };
  facade.createRoom = (input, options = {}) => {
    const saved = structuredClone({ ...input, request_id: input.request_id === undefined ? requestId() : input.request_id });
    return invoke(signal => client.createRoom(saved, { ...options, signal }), options.signal);
  };
  function close() {
    if (closing) return closing;
    const shouldDisconnect = started && !terminal;
    clearTimeout(timer); timer = null;
    update('closed');
    lifetime.abort(new DOMException('Connection closed.', 'AbortError'));
    closing = (async () => {
      if (!shouldDisconnect) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 500);
      try { await waitFor(Promise.resolve().then(() => client.disconnect({ signal: controller.signal, retries: 0 })), controller.signal); }
      catch { /* Disconnect is best-effort; hub presence expires separately. */ }
      finally { clearTimeout(timeout); }
    })();
    return closing;
  }
  return { client: facade, start, close, getState };
}
