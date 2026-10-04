// Use only Node built-ins so missing adapter dependencies are diagnosable too.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function checkMcp({
  entry = fileURLToPath(new URL('./main.js', import.meta.url)),
  cwd = process.cwd(), env = process.env, timeoutMs = 10000,
} = {}) {
  const child = spawn(process.execPath, [entry], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', output = '', phase = 'initialize', exit, timer;
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    exit = { code, signal }; resolve();
  }));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
  child.stdout.setEncoding('utf8');

  const result = await new Promise(resolve => {
    let finished = false, id = 1;
    const tools = [];
    function finish(ok, message) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok, phase, message, tools });
    }
    function send(message) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    }
    child.on('error', error => finish(false, `Could not launch adapter (${error.code ?? 'unknown error'}).`));
    child.stdin.on('error', error => finish(false, `Adapter input closed (${error.code ?? 'unknown error'}).`));
    child.stdout.on('error', error => finish(false, `Adapter output closed (${error.code ?? 'unknown error'}).`));
    child.once('close', () => finish(false, 'Adapter closed before tool discovery completed.'));
    child.stdout.on('data', chunk => {
      if (finished) return;
      output += chunk;
      if (output.length > 1024 * 1024) return finish(false, 'Adapter stdout exceeded the diagnostic limit.');
      let newline;
      while (!finished && (newline = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); }
        catch { return finish(false, 'Adapter wrote non-JSON output to MCP stdout.'); }
        if (!message || message.jsonrpc !== '2.0') return finish(false, 'Adapter returned an invalid JSON-RPC message.');
        if (message.id !== id) continue; // Ignore server notifications.
        if (message.error) return finish(false, 'Adapter returned a JSON-RPC error. See adapter stderr below.');
        if (phase === 'initialize') {
          if (!message.result?.protocolVersion || !message.result?.capabilities?.tools) {
            return finish(false, 'Adapter initialization did not advertise MCP tools.');
          }
          phase = 'tools/list';
          send({ method: 'notifications/initialized' });
          send({ id: ++id, method: 'tools/list', params: {} });
        } else {
          if (!Array.isArray(message.result?.tools) || message.result.tools.some(tool => typeof tool?.name !== 'string')) {
            return finish(false, 'Adapter returned an invalid tools list.');
          }
          tools.push(...message.result.tools.map(tool => tool.name));
          if (message.result.nextCursor) {
            send({ id: ++id, method: 'tools/list', params: { cursor: message.result.nextCursor } });
          } else {
            finish(tools.includes('join_room'), tools.includes('join_room')
              ? `MCP initialization succeeded; ${tools.length} tools available, including join_room.`
              : 'MCP initialized, but join_room is missing. Check the adapter path/version.');
          }
        }
      }
    });
    timer = setTimeout(() => finish(false, `Timed out after ${timeoutMs} ms waiting for ${phase}.`), timeoutMs);
    send({ id, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'agent-chat-room-startup-check', version: '1.0.0' },
    } });
  });

  // Only this diagnostic's child is stopped. Give normal EOF shutdown a chance.
  child.stdin.end();
  let terminate, kill, deadline;
  try {
    terminate = setTimeout(() => { if (!exit) child.kill('SIGTERM'); }, 500);
    kill = setTimeout(() => { if (!exit) child.kill('SIGKILL'); }, 1500);
    await Promise.race([closed, new Promise(resolve => { deadline = setTimeout(resolve, 2500); })]);
  } finally {
    clearTimeout(terminate); clearTimeout(kill); clearTimeout(deadline);
  }
  if (!exit) {
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
    result.ok = false;
    result.message += ' Adapter shutdown did not complete.';
  } else if (result.ok && (exit.code !== 0 || exit.signal)) {
    result.ok = false;
    result.message += ' Adapter did not shut down cleanly.';
  }
  return { ...result, stderr, exit };
}
