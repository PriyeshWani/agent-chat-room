// This module is shared unchanged by Node MCP adapters and the browser.
import { API_PATH, VERSION, ApiError, requestId, isRoomEvent } from './protocol.js';

// Preserve only known transport codes, never fetch messages, request bodies,
// URLs, proxy settings, or stack traces. Node may wrap codes in cause/errors.
const transportCodes = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN', 'EACCES', 'EPERM', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_DESTROYED',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export class HubTransportError extends ApiError {
  constructor(cause) {
    const codes = new Set(), seen = new Set(), pending = [cause];
    for (let count = 0; pending.length && count < 32; count++) {
      const item = pending.shift();
      if (!item || typeof item !== 'object' || seen.has(item)) continue;
      seen.add(item);
      if (transportCodes.has(item.code)) codes.add(item.code);
      if (item.cause) pending.push(item.cause);
      if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 16));
    }
    const diagnostic = codes.size ? `Transport codes: ${[...codes].join(', ')}.`
      : 'No recognized transport code was provided by the runtime.';
    super('HUB_UNREACHABLE', `Cannot reach the room hub. ${diagnostic}`, { status: 0, retryable: true });
  }
}

export class RoomClient {
  constructor({ baseUrl, token = null, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
    this.baseUrl = new URL(baseUrl ?? globalThis.location?.origin).href.replace(/\/$/, '');
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async request(path, { method = 'GET', body, signal, retries = 1 } = {}) {
    // Serialize once, including the caller's request ID, before a network retry.
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      let response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${API_PATH}${path}`, {
          method, signal, credentials: 'same-origin', redirect: 'error',
          headers: { Accept: 'application/json', 'X-Room-Features': 'mentions', ...(serialized === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
          body: serialized,
        });
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError') throw error;
        if (attempt < retries) continue;
        throw new HubTransportError(error);
      }
      let envelope;
      try { envelope = await response.json(); }
      catch (error) {
        if (signal?.aborted || error.name === 'AbortError') throw error;
        if (error instanceof TypeError && attempt < retries) continue;
        throw new ApiError('INVALID_RESPONSE', 'The hub returned an invalid JSON response.', { status: response.status });
      }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
        throw new ApiError('INVALID_RESPONSE', 'The hub returned an invalid response envelope.', { status: response.status });
      }
      if (envelope.version !== VERSION) throw new ApiError('VERSION_MISMATCH', 'The client and hub protocol versions differ.', { status: response.status });
      if (!response.ok) {
        const error = envelope.error;
        if (!error || typeof error.code !== 'string' || typeof error.message !== 'string') {
          throw new ApiError('INVALID_RESPONSE', 'The hub returned an invalid error response.', { status: response.status });
        }
        if (response.status === 503 && error.retryable === true && attempt < retries) continue;
        throw new ApiError(error.code, error.message, { status: response.status, retryable: error.retryable, details: error.details });
      }
      if (!Object.hasOwn(envelope, 'data')) throw new ApiError('INVALID_RESPONSE', 'The hub response has no result.', { status: response.status });
      return envelope.data;
    }
  }

  health(options) { return this.request('/health', options); }
  browserSession(options = {}) { return this.request('/sessions/browser', { ...options, method: 'POST', body: {} }); }
  joinBrowser(input, options = {}) { return this.request('/sessions/join', { ...options, method: 'POST', body: { request_id: requestId(), ...input } }); }
  createInvitation(roomId, input, options = {}) { return this.request(`/rooms/${encodeURIComponent(roomId)}/invitations`, { ...options, method: 'POST', body: { request_id: requestId(), ...input } }); }
  listInvitations(roomId, options) { return this.request(`/rooms/${encodeURIComponent(roomId)}/invitations`, options); }
  revokeInvitation(roomId, input, options = {}) { return this.request(`/rooms/${encodeURIComponent(roomId)}/invitations/revoke`, { ...options, method: 'POST', body: { request_id: requestId(), ...input } }); }
  async agentSession(input, options = {}) {
    const session = await this.request('/sessions/agent', { ...options, method: 'POST', body: { request_id: requestId(), ...input } });
    this.token = session.token;
    return session;
  }
  listRooms(options) { return this.request('/rooms', options); }
  createRoom(input, options = {}) { return this.request('/rooms', { ...options, method: 'POST', body: { request_id: requestId(), ...input } }); }
  joinRoom(roomId, input = {}, options = {}) { return this.request(`/rooms/${encodeURIComponent(roomId)}/join`, { ...options, method: 'POST', body: { request_id: requestId(), ...input } }); }
  updateRoomGoal(roomId, input, options = {}) { return this.request(`/rooms/${encodeURIComponent(roomId)}/goal`, { ...options, method: 'POST', body: { request_id: requestId(), ...input } }); }
  leaveRoom(roomId, input, options = {}) { return this.request(`/rooms/${encodeURIComponent(roomId)}/leave`, { ...options, method: 'POST', body: { request_id: requestId(), ...input } }); }
  history(roomId, { before, limit = 50, signal } = {}) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before !== undefined) query.set('before', String(before));
    return this.request(`/rooms/${encodeURIComponent(roomId)}/history?${query}`, { signal });
  }
  postMessage(roomId, input, options = {}) { return this.request(`/rooms/${encodeURIComponent(roomId)}/messages`, { ...options, method: 'POST', body: { request_id: requestId(), ...input } }); }
  receiveEvents(roomId, input = {}, options = {}) { return this.request(`/rooms/${encodeURIComponent(roomId)}/receive`, { ...options, method: 'POST', body: input, retries: 0 }); }
  ackEvents(roomId, input, options = {}) { return this.request(`/rooms/${encodeURIComponent(roomId)}/ack`, { ...options, method: 'POST', body: { request_id: requestId(), ...input } }); }
  listParticipants(roomId, options) { return this.request(`/rooms/${encodeURIComponent(roomId)}/participants`, options); }
  listTasks(roomId, options) { return this.request(`/rooms/${encodeURIComponent(roomId)}/tasks`, options); }
  createTask(roomId, input, options = {}) { return this.request(`/rooms/${encodeURIComponent(roomId)}/tasks`, { ...options, method: 'POST', body: { request_id: requestId(), ...input } }); }
  claimTask(roomId, input, options = {}) { return this.request(`/rooms/${encodeURIComponent(roomId)}/tasks/claim`, { ...options, method: 'POST', body: { request_id: requestId(), ...input } }); }
  updateTask(roomId, input, options = {}) { return this.request(`/rooms/${encodeURIComponent(roomId)}/tasks/update`, { ...options, method: 'POST', body: { request_id: requestId(), ...input } }); }
  heartbeat(input = {}, options = {}) { return this.request('/sessions/heartbeat', { ...options, method: 'POST', body: input }); }
  disconnect(options = {}) { return this.request('/sessions/disconnect', { ...options, method: 'POST', body: {} }); }

  async *events(roomId, { after = 0, signal, onOpen } = {}) {
    if (new URL(this.baseUrl).hostname.endsWith('.trycloudflare.com')) {
      // Quick Tunnels buffer SSE. Read finite pages with the same durable cursor.
      let cursor = after;
      for (;;) {
        let count = 0;
        for await (const event of this.eventStream(roomId, { after: cursor, signal, onOpen, poll: true })) {
          if (event.sequence !== cursor + 1) throw new ApiError('INVALID_RESPONSE', 'Polling returned a noncontiguous room event.');
          cursor = event.sequence;
          count++;
          yield event;
        }
        if (count === 100) continue;
        await new Promise((resolve, reject) => {
          if (signal?.aborted) { reject(signal.reason); return; }
          const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
          const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 1000);
          signal?.addEventListener('abort', abort, { once: true });
        });
      }
    }
    yield* this.eventStream(roomId, { after, signal, onOpen });
  }

  async *eventStream(roomId, { after = 0, signal, onOpen, poll = false } = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${API_PATH}/rooms/${encodeURIComponent(roomId)}/stream?after=${after}${poll ? '&poll=1' : ''}`, {
      signal, credentials: 'same-origin', redirect: 'error', headers: { Accept: 'text/event-stream', 'X-Room-Features': 'mentions', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
    });
    if (!response.ok) {
      let envelope;
      try { envelope = await response.json(); }
      catch (error) {
        if (signal?.aborted || error.name === 'AbortError') throw error;
        throw new ApiError('INVALID_RESPONSE', 'Invalid stream error response.', { status: response.status });
      }
      throw new ApiError(envelope?.error?.code ?? 'STREAM_ERROR', envelope?.error?.message ?? 'Room stream unavailable.', { status: response.status });
    }
    if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
      throw new ApiError('INVALID_RESPONSE', 'Expected a room event stream.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      signal?.throwIfAborted();
      onOpen?.();
      while (true) {
        signal?.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          if (boundary.index > 65536) throw new ApiError('INVALID_RESPONSE', 'Room event frame exceeds the size limit.');
          const frame = buffer.slice(0, boundary.index).replace(/\r/g, '');
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) {
            let event;
            try { event = JSON.parse(data); }
            catch { throw new ApiError('INVALID_RESPONSE', 'The hub returned invalid room event JSON.'); }
            if (!isRoomEvent(event) || event.room_id !== roomId) {
              throw new ApiError('INVALID_RESPONSE', 'The hub returned an invalid room event.');
            }
            yield event;
          }
        }
        if (buffer.length > 65536) throw new ApiError('INVALID_RESPONSE', 'Room event frame exceeds the size limit.');
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

export { ApiError, requestId };
