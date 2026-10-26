import http from 'node:http';
import { ZodError } from 'zod';
import { Outputs } from '../shared/schemas.js';
import { ApiError, LIMITS, success, failure } from '../shared/protocol.js';
import { legacyMessageResult } from './client-compatibility.js';
import { privateIpv4 } from '../shared/hub-url.js';

export async function createHttpServer({ port = 0, lanHost = null, host = lanHost ? '0.0.0.0' : '127.0.0.1', handlers = [], assets, onError } = {}) {
  if (lanHost !== null && !privateIpv4(lanHost)) throw new TypeError('LAN host must be a private IPv4 address.');
  if (host !== '127.0.0.1' && !(lanHost && host === '0.0.0.0')) throw new TypeError('Use 127.0.0.1 for local mode or explicit LAN configuration.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid port.');
  const requests = new Set();
  const sockets = new Set();
  let authority, origin, publicUrl, allowedAuthorities, closing;
  const server = http.createServer(async (request, response) => {
    const controller = new AbortController();
    requests.add(controller);
    const abort = () => controller.abort();
    const cleanup = () => {
      requests.delete(controller);
      request.off('aborted', abort);
      response.off('close', closed);
      response.off('finish', cleanup);
    };
    const closed = () => { if (!response.writableFinished) abort(); cleanup(); };
    request.on('aborted', abort);
    response.on('close', closed);
    response.on('finish', cleanup);
    function send(status, envelope) {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(envelope));
    }
    try {
      const requestOrigin = `http://${request.headers.host}`;
      if (!allowedAuthorities.has(request.headers.host) || (request.headers.origin !== undefined && request.headers.origin !== requestOrigin)) {
        throw new ApiError('FORBIDDEN', 'Request Host or Origin is not allowed.', { status: 403 });
      }
      if (!request.url.startsWith('/') || request.url.startsWith('//')) throw new ApiError('VALIDATION_ERROR', 'Invalid request path.');
      const url = new URL(request.url, requestOrigin);
      const path = url.pathname;
      const method = request.method;
      let body;
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        if ((request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
          throw new ApiError('VALIDATION_ERROR', 'Mutations require application/json.');
        }
        const browserBootstrap = ['/api/v1/sessions/browser', '/api/v1/sessions/join'].includes(path);
        const agentBootstrap = method === 'POST' && path === '/api/v1/sessions/agent';
        if ((browserBootstrap || (!request.headers.authorization && !agentBootstrap)) && request.headers.origin !== requestOrigin) {
          throw new ApiError('FORBIDDEN', 'This mutation requires the matching page Origin.', { status: 403 });
        }
        if (Number(request.headers['content-length']) > LIMITS.bodyBytes) throw new ApiError('VALIDATION_ERROR', 'Request body exceeds the size limit.');
        const chunks = [];
        let size = 0;
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > LIMITS.bodyBytes) throw new ApiError('VALIDATION_ERROR', 'Request body exceeds the size limit.');
          chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new ApiError('VALIDATION_ERROR', 'Request body must contain valid JSON.'); }
      }
      const context = { request, response, url, path, method, body, signal: controller.signal };
      let result;
      if (path === '/api/v1/health' && method === 'GET') {
        result = { schema: 'health', data: { status: 'ok', version: '1' } };
      } else if (path === '/api/v1' || path.startsWith('/api/v1/')) {
        for (const handler of handlers) {
          result = await handler(context);
          if (result !== undefined) break;
        }
      } else if (assets) result = await assets(context);
      if (result?.handled) return;
      if (result === undefined) throw new ApiError('NOT_FOUND', 'No route matches this request.', { status: 404 });
      const schema = Object.hasOwn(Outputs, result?.schema ?? '') && Outputs[result.schema];
      const parsed = schema?.safeParse(result.data);
      if (!parsed?.success) throw new Error('Handler returned invalid output.');
      const supportsMentions = (request.headers['x-room-features'] ?? '').split(',').some(feature => feature.trim() === 'mentions');
      const data = request.headers.authorization && !supportsMentions ? legacyMessageResult(result.schema, parsed.data) : parsed.data;
      send(result.status ?? 200, success(data));
    } catch (error) {
      request.resume();
      let publicError;
      if (error instanceof ApiError) publicError = error;
      else if (error instanceof ZodError) publicError = new ApiError('VALIDATION_ERROR', 'Request input is invalid.');
      else {
        publicError = new ApiError('INTERNAL_ERROR', 'The hub could not complete this request.', { status: 500 });
        try { onError?.(error); } catch { /* Logging must not prevent a response. */ }
      }
      send(publicError.status, failure(publicError));
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  authority = `127.0.0.1:${server.address().port}`;
  origin = `http://${authority}`;
  publicUrl = lanHost ? `http://${lanHost}:${server.address().port}` : origin;
  allowedAuthorities = new Set([authority, new URL(publicUrl).host]);
  return {
    server, url: origin, publicUrl,
    close() {
      if (!closing) closing = new Promise(resolve => {
        for (const controller of requests) controller.abort();
        const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 500);
        server.close(() => { clearTimeout(timer); resolve(); });
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}
