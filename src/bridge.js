import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const port = Number(process.env.CHAT_BRIDGE_PORT ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('CHAT_BRIDGE_PORT must be an integer between 0 and 65535.');
}

const messages = [];
const replies = [];
const events = new EventEmitter();
const closing = new AbortController();
let client = null;
let nextId = 1;
let waiting = 0;
let stopping = false;
let baseUrl;
const MAX_MESSAGES = 200;
const MAX_TEXT = 4000;

const mcp = new McpServer(
  { name: 'agent-chat-room', version: '0.1.0' },
  {
    instructions: 'This is a local two-way communication test. receive_message waits for browser input. '
      + 'Use send_message to send your answer back to the browser, passing in_reply_to for a reply. '
      + 'Keep next_after_id for subsequent receive calls. Empty results are a timeout, not a message. '
      + 'When the user asks you to keep listening, call receive_message again after each reply or empty timeout '
      + 'until the user stops or cancels the listening session. '
      + 'This server does not wake an idle agent; the agent must call receive_message.',
  },
);

function result(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function toolError(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function waitForInput(waitMs, signal) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      events.off('message', onMessage);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = () => finish();
    const onAbort = () => finish(new Error('Message wait cancelled.'));
    const timer = setTimeout(() => finish(), waitMs);
    events.on('message', onMessage);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

mcp.registerTool('receive_message', {
  description: 'Read browser messages after a cursor, optionally waiting up to 20 seconds. '
    + 'Returns messages, next_after_id, and timed_out. Does not delete messages.',
  inputSchema: {
    after_id: z.number().int().nonnegative().default(0),
    wait_ms: z.number().int().min(0).max(20000).default(20000),
  },
}, async ({ after_id, wait_ms }, extra) => {
  if (after_id >= nextId) return toolError('after_id is ahead of this bridge. Start with 0 after a restart.');
  const signal = AbortSignal.any([extra.signal, closing.signal]);
  waiting += 1;
  try {
    if (!messages.some((message) => message.id > after_id) && wait_ms > 0) {
      await waitForInput(wait_ms, signal);
    }
    signal.throwIfAborted();
    const unread = messages.filter((message) => message.id > after_id);
    for (const message of unread) message.delivered_at ??= new Date().toISOString();
    return result({
      messages: unread.map(({ id, text, created_at }) => ({ id, text, created_at })),
      next_after_id: unread.at(-1)?.id ?? after_id,
      timed_out: unread.length === 0,
    });
  } finally {
    waiting -= 1;
  }
});

mcp.registerTool('send_message', {
  description: 'Send a message to the local browser. Include in_reply_to to reply to a received message. '
    + 'This probe allows one reply per incoming message; retrying an identical reply is idempotent.',
  inputSchema: {
    text: z.string().trim().min(1).max(MAX_TEXT),
    in_reply_to: z.number().int().positive().optional(),
  },
}, async ({ text, in_reply_to }) => {
  if (in_reply_to && !messages.some((message) => message.id === in_reply_to)) {
    return toolError('No incoming message has that ID.');
  }
  const existing = in_reply_to && replies.find((reply) => reply.in_reply_to === in_reply_to);
  if (existing) {
    return existing.text === text ? result(existing) : toolError('That message already has a different reply.');
  }
  if (replies.length >= MAX_MESSAGES) return toolError('Probe reply limit reached. Restart to clear history.');
  const reply = { id: replies.length + 1, text, in_reply_to: in_reply_to ?? null, created_at: new Date().toISOString() };
  replies.push(reply);
  return result(reply);
});

mcp.server.oninitialized = () => {
  client = mcp.server.getClientVersion() ?? { name: 'unknown MCP client' };
  console.error(`MCP client connected: ${client.name}`);
};

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function handleHttp(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const actualPort = httpServer.address().port;
  const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
  if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: 'Use the localhost URL printed by the bridge.' });
  if (req.headers.origin && !allowedHosts.map((host) => `http://${host}`).includes(req.headers.origin)) {
    return json(res, 403, { error: 'Requests must come from this local page.' });
  }
  const pathname = new URL(req.url, baseUrl).pathname;
  if (req.method === 'GET' && assets.has(pathname)) {
    const [file, contentType] = assets.get(pathname);
    const content = await readFile(new URL(`../public/${file}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': contentType });
    return res.end(content);
  }
  if (req.method === 'GET' && pathname === '/api/state') {
    return json(res, 200, { client, waiting, messages, replies });
  }
  if (req.method === 'POST' && pathname === '/api/messages') {
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return json(res, 415, { error: 'Send application/json.' });
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 32768) return json(res, 413, { error: 'Message body too large.' });
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return json(res, 400, { error: 'Invalid JSON.' }); }
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > MAX_TEXT) return json(res, 400, { error: 'Enter between 1 and 4000 characters.' });
    if (messages.length >= MAX_MESSAGES) return json(res, 409, { error: 'Probe message limit reached. Restart to clear history.' });
    const message = { id: nextId++, text, created_at: new Date().toISOString(), delivered_at: null };
    messages.push(message);
    events.emit('message');
    return json(res, 201, message);
  }
  return json(res, 404, { error: 'Not found.' });
}

const httpServer = http.createServer((req, res) => {
  handleHttp(req, res).catch((error) => {
    console.error(`HTTP request failed: ${error.message}`);
    if (!res.headersSent) json(res, 500, { error: 'Request failed.' });
    else res.end();
  });
});

async function stop() {
  if (stopping) return;
  stopping = true;
  closing.abort();
  client = null;
  httpServer.close();
  httpServer.closeAllConnections();
  await mcp.close();
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
process.stdin.once('end', () => void stop());

try {
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  console.error(`Local MCP probe: ${baseUrl}`);
  await mcp.connect(new StdioServerTransport());
} catch (error) {
  console.error(`Bridge startup failed: ${error.message}`);
  await stop();
  process.exitCode = 1;
}
