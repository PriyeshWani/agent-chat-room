import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const bridge = fileURLToPath(new URL('../src/bridge.js', import.meta.url));
const port = process.env.CHAT_BRIDGE_PORT ?? '8787';
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error('CHAT_BRIDGE_PORT must be between 1 and 65535 for the Codex demo.');
}

// Per-run MCP configuration; preserves the client's configured permissions and other servers.
const config = '{ command = ' + JSON.stringify(process.execPath)
  + ', args = [' + JSON.stringify(bridge) + ']'
  + ', env = { CHAT_BRIDGE_PORT = ' + JSON.stringify(port) + ' }'
  + ', tool_timeout_sec = 30, required = true }';
const prompt = 'Run a continuous local conversation using the agent_chat_room MCP tools. '
  + 'Start with after_id=0. Call receive_message with that cursor and wait_ms=20000. '
  + 'For each received browser message, answer it using send_message with its id as in_reply_to. '
  + 'After handling the batch, advance after_id to the returned next_after_id and call receive_message again. '
  + 'After an empty timeout, call receive_message again with the same cursor without posting a timeout message. '
  + 'Keep this receive/reply loop running across multiple messages and quiet periods; do not finish after a reply '
  + 'or after a fixed number of waits. Stop when the user asks you to stop listening in the browser or terminal, '
  + 'or cancels the run. A browser message containing exactly /stop is also a stop request: acknowledge it '
  + 'with send_message, then finish without starting another receive call or handling later messages in that batch. '
  + 'If a tool fails, report the error and stop instead of retrying indefinitely. '
  + 'Do not change project files for this test. '
  + 'The browser page is at http://127.0.0.1:' + port + '.';

console.log(`Codex will start the MCP bridge at http://127.0.0.1:${port}`);
console.log('Open that URL once the MCP server is ready, then send a message.');
console.log('Codex is instructed to keep listening. Send /stop in the browser to finish.');
const child = spawn('codex', ['-c', '--yolo', `mcp_servers.agent_chat_room=${config}`, prompt], {
  cwd: root, stdio: 'inherit', shell: false,
});
child.once('error', (error) => {
  console.error(`Could not launch Codex: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (code) console.error(`Codex exited with code ${code}. If the MCP bridge never started, check the Codex/Declawd launcher first.`);
  process.exitCode = signal ? 1 : (code ?? 1);
});
