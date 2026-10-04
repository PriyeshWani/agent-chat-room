import { HubTransportError } from '../shared/client.js';

// Only fixed, local text and allowlisted transport codes reach diagnostics.
// Hub responses and validation errors
// may contain invitation values, session data, or user-supplied strings.
const errors = {
  HUB_UNREACHABLE: 'Cannot reach the room hub. Check hub_url or ROOM_HUB_URL and that the hub is running.',
  HUB_TIMEOUT: 'The hub did not finish enrollment in time. Check the hub address and try again.',
  INVALID_RESPONSE: 'The hub returned an invalid response. Check that ROOM_HUB_URL points to the chatroom hub.',
  VERSION_MISMATCH: 'The adapter and hub protocol versions differ. Use matching versions of the project.',
  INVITE_REQUIRED: 'The hub requires an agent invitation. Supply invite_token to join_room or configure ROOM_INVITE_TOKEN.',
  INVITE_INVALID: 'The agent invitation is invalid, expired, or revoked.',
  INVITE_USED: 'The agent invitation was already used. Use another invitation for a new agent session.',
  FORBIDDEN: 'The hub denied access to this agent.',
  HUB_MISMATCH: 'The saved session belongs to a different hub.',
  WORKSPACE_MISMATCH: 'Selected workspace differs from the saved session workspace.',
  SESSION_EXISTS: 'This agent session already exists. Resume it using its saved session file.',
  SESSION_REPLACED: 'This agent connection was replaced by another session.',
  EEXIST: 'ROOM_SESSION_FILE already exists. Use ROOM_RESUME=1 to resume it, or select a new session file.',
};
const stages = {
  HUB_URL: 'Invalid ROOM_HUB_URL. Use an HTTP root URL with 127.0.0.1 or a private LAN IPv4 address.',
  INVITATION: 'Invalid ROOM_INVITE_TOKEN format.',
  SESSION_SETTINGS: 'Invalid ROOM_RESUME or ROOM_SESSION_FILE. Resume requires a session file and ROOM_RESUME=1.',
  SESSION_READ: 'Could not read a valid saved session from ROOM_SESSION_FILE.',
  SESSION_WRITE: 'Could not create ROOM_SESSION_FILE. Check its parent directory and file permissions.',
  PROFILE: 'Invalid agent profile. Check ROOM_AGENT_NAME, ROOM_AGENT_RUNTIME, and ROOM_CONTEXT.',
  WORKSPACE: 'Workspace is missing, inaccessible, or not a directory. Check ROOM_WORKSPACE or the client project directory.',
};

export async function startupStep(stage, action) {
  try { return await action(); }
  catch (error) { error.adapterStartupStage = stage; throw error; }
}

export function startupErrorDetails(error) {
  const code = Object.hasOwn(errors, error?.code) ? error.code
    : Object.hasOwn(stages, error?.adapterStartupStage) ? error.adapterStartupStage : 'STARTUP_FAILED';
  const message = (error instanceof HubTransportError ? error.message : undefined) ?? errors[code] ?? stages[code]
    ?? 'Check the adapter configuration and the MCP client startup error.';
  return { code, message };
}

export function startupErrorMessage(error) {
  const { code, message } = startupErrorDetails(error);
  return `Room adapter failed to start [${code}]: ${message}\n`;
}
