import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';
import { toolGroups } from './tools/index.js';
import { createHubSession } from './hub-session.js';
import { startupErrorMessage } from './startup-errors.js';
export { prepareAdapterConfig } from './config.js';

export async function startAdapter({ env = process.env, input = process.stdin, output = process.stdout } = {}) {
  const connection = createHubSession({ env });
  let server, closing, stopping = false;
  const stop = () => { stopping = true; close().catch(() => { process.stderr.write('Adapter shutdown failed.\n'); process.exitCode = 1; }); };
  function close() {
    if (!closing) closing = Promise.resolve().then(async () => {
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      input.off('end', stop); input.off('close', stop); input.off('error', stop);
      await Promise.all([server?.close(), connection.close()]);
    });
    return closing;
  }
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  input.on('end', stop); input.on('close', stop); input.on('error', stop);
  try {
    server = createMcpServer({ client: connection.client,
      connect: connection.connect, toolGroups });
    server.server.onclose = stop;
    await server.connect(new StdioServerTransport(input, output));
    if (input.readableEnded || input.destroyed) await close();
    return { close };
  } catch (error) { await close(); if (stopping) return { close }; throw error; }
}

async function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    // Node resolves module symlinks, but argv can retain the launcher's alias.
    // Compare canonical paths so a symlinked checkout does not silently exit.
    const [modulePath, entryPath] = await Promise.all([
      realpath(fileURLToPath(import.meta.url)), realpath(resolve(process.argv[1])),
    ]);
    return modulePath === entryPath;
  } catch { return false; } // Importing from eval/stdin need not have an entry file.
}

if (await isEntrypoint()) {
  try { await startAdapter(); }
  catch (error) {
    process.stderr.write(startupErrorMessage(error));
    process.exitCode = 1;
  }
}
