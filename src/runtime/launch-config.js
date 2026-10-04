import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildParticipationInstructions } from './participation.js';
import { parseHubUrl } from '../shared/hub-url.js';

const defaultAdapter = fileURLToPath(new URL('../mcp/main.js', import.meta.url));
function string(value, name, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\0') || !value.isWellFormed()) throw new TypeError(`Invalid ${name}.`);
  return value;
}
function options(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('Unknown launch option.');
}

export function buildLaunchConfig(input, runtime = {}) {
  options(input, ['workspace', 'roomId', 'name', 'hubUrl', 'context', 'sessionFile', 'resume', 'command']);
  options(runtime, ['nodePath', 'adapterPath']);
  const { workspace, roomId, name, hubUrl, context = '', sessionFile, resume = false, command = 'codex' } = input;
  const cwd = resolve(string(workspace, 'workspace'));
  if (!statSync(cwd).isDirectory()) throw new TypeError('Workspace must be a directory.');
  string(roomId, 'room ID');
  string(name, 'name');
  string(context, 'context', { empty: true });
  string(command, 'command');
  if (typeof resume !== 'boolean' || (resume && sessionFile === undefined)) throw new TypeError('Resume requires a session file.');
  const url = parseHubUrl(string(hubUrl, 'hub URL'));
  const nodePath = resolve(string(runtime.nodePath ?? process.execPath, 'Node executable'));
  const adapterPath = resolve(string(runtime.adapterPath ?? defaultAdapter, 'adapter path'));
  const env = {
    ROOM_HUB_URL: url.origin, ROOM_AGENT_NAME: name, ROOM_WORKSPACE: cwd, ROOM_CONTEXT: context,
  };
  if (sessionFile !== undefined) env.ROOM_SESSION_FILE = resolve(string(sessionFile, 'session file'));
  if (resume) env.ROOM_RESUME = '1';
  // Match the original probe's single inline TOML table. Replace the whole
  // server entry, including its command and environment, in this invocation.
  // scripts/chat.js sets cwd when spawning, so no client-specific -C is needed.
  const environment = Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ');
  const config = `{ command = ${JSON.stringify(nodePath)}, args = [${JSON.stringify(adapterPath)}], env = { ${environment} }, env_vars = ["ROOM_INVITE_TOKEN"], startup_timeout_sec = 30, tool_timeout_sec = 30, required = true }`;
  // The installed codex wrapper invokes Declawd with --codex and suppresses
  // extra startup output. Explicit --command declawd keeps that output visible.
  const args = [...(basename(command) === 'declawd' ? ['--codex'] : []), '-c', `mcp_servers.agent_chat_room=${config}`];
  args.push(buildParticipationInstructions({ roomId, name, workspace: cwd }));
  return { command: command.includes('/') ? resolve(command) : command, args, cwd };
}
