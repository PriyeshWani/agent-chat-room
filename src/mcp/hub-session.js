import { RoomClient } from '../shared/client.js';
import { ApiError } from '../shared/protocol.js';
import { Inputs } from '../shared/schemas.js';
import { parseHubUrl } from '../shared/hub-url.js';
import { prepareAdapterConfig } from './config.js';
import { createConnection } from './connection.js';
import { startupStep, startupErrorDetails } from './startup-errors.js';

// MCP startup only constructs this controller. No hub requests or session-file
// writes occur until a room tool needs a connection.
export function createHubSession({ env = process.env, prepareConfig = prepareAdapterConfig } = {}) {
  const defaults = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('ROOM_') || key === 'CLAUDE_PROJECT_DIR'));
  let config, connection, lastEnrollmentError, closed = false, closing;
  let selectionTail = Promise.resolve();
  const assertOpen = signal => {
    if (closed) throw new DOMException('Adapter closed.', 'AbortError');
    signal?.throwIfAborted();
  };

  async function select(input, { signal, activeRoom } = {}) {
    assertOpen(signal);
    const baseUrl = await startupStep('HUB_URL', () => parseHubUrl(
      input.hub_url ?? config?.baseUrl ?? defaults.ROOM_HUB_URL ?? 'http://127.0.0.1:8787',
    ).origin);
    const sameHub = config?.baseUrl === baseUrl;
    let inviteToken;
    if (input.invite_token !== undefined) inviteToken = input.invite_token === null ? undefined : input.invite_token.trim();
    else if (sameHub) inviteToken = config.inviteToken;
    else {
      // A configured invitation belongs to its configured hub. A conversational
      // hub override must never carry that invitation to a different server.
      let defaultHub;
      try { defaultHub = parseHubUrl(defaults.ROOM_HUB_URL ?? 'http://127.0.0.1:8787').origin; } catch { /* A supplied valid hub can correct the default. */ }
      if (baseUrl === defaultHub) inviteToken = defaults.ROOM_INVITE_TOKEN?.trim();
    }
    const changed = config && (!sameHub || inviteToken !== config.inviteToken);
    if (changed) {
      if (activeRoom) throw new ApiError('ACTIVE_ROOM_CONFLICT', 'Leave the current room before changing the hub or invitation.');
      const persistent = defaults.ROOM_SESSION_FILE !== undefined;
      if (persistent && !sameHub) throw new ApiError('HUB_MISMATCH', 'The saved session belongs to a different hub.');
      if (persistent && connection && (connection.getState().participant || !['INVITE_INVALID', 'INVITE_REQUIRED', 'INVITE_USED'].includes(lastEnrollmentError))) {
        throw new ApiError('SESSION_AUTH_CONFLICT', 'A saved identity cannot change invitations after enrollment or an uncertain attempt. Use a separate adapter session file.');
      }
      // Validate before disconnecting or changing the selection.
      await validateInvitation(inviteToken);
      await connection?.close();
      connection = undefined;
      if (persistent) config = { ...config, inviteToken };
      else config = undefined;
      assertOpen(signal);
    }
    if (!config) {
      config = await prepareConfig({ ...defaults, ROOM_HUB_URL: baseUrl, ROOM_INVITE_TOKEN: inviteToken });
    }
    assertOpen(signal);
    if (!connection) {
      connection = createConnection({ ...config, client: new RoomClient({ baseUrl: config.baseUrl }) });
    }
    try {
      await connection.start({ signal });
      lastEnrollmentError = undefined;
    } catch (error) {
      lastEnrollmentError = error.code;
      if (signal?.aborted || closed) throw error;
      const safe = startupErrorDetails(error);
      throw new ApiError(safe.code === 'STARTUP_FAILED' ? 'CONNECTION_FAILED' : safe.code,
        safe.message, { retryable: error.retryable === true });
    }
    return connection;
  }

  function ensure(input = {}, options = {}) {
    const pending = selectionTail.then(() => select(input, options)).catch(error => {
      if (error instanceof ApiError || options.signal?.aborted || closed) throw error;
      const safe = startupErrorDetails(error);
      throw new ApiError(safe.code, safe.message);
    });
    selectionTail = pending.catch(() => {});
    return pending;
  }

  const client = {};
  for (const method of ['listRooms', 'listParticipants', 'history', 'joinRoom', 'leaveRoom', 'postMessage',
    'receiveEvents', 'ackEvents', 'listTasks', 'createTask', 'claimTask', 'updateTask']) {
    client[method] = async (...args) => {
      const selected = await ensure({}, { signal: args.at(-1)?.signal });
      return selected.client[method](...args);
    };
  }
  async function connect(input, options) {
    const selected = await ensure(input, options);
    return selected.getState().participant;
  }
  function close() {
    if (!closing) {
      closed = true;
      closing = Promise.resolve(connection?.close());
    }
    return closing;
  }
  return { client, connect, close };
}

async function validateInvitation(inviteToken) {
  // Match prepareAdapterConfig without generating an identity or writing a file.
  await startupStep('INVITATION', () => {
    if (!Inputs.agentSession.shape.invite_token.safeParse(inviteToken).success) throw new Error('Invalid agent invitation.');
  });
}
