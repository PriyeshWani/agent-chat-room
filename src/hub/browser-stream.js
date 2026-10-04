import { Sequence } from '../shared/schemas.js';
import { ApiError } from '../shared/protocol.js';

const MAX_BUFFER_BYTES = 65536;
const MAX_BLOCKED_MS = 30000;

export function createBrowserStream({ events, rooms, identity, changes, heartbeatMs = 15000 }) {
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) throw new TypeError('Invalid heartbeat interval.');
  const active = new Set();
  let closed = false;
  function stream(context, roomId, after, { response, signal }) {
    if (closed) throw new ApiError('SESSION_EXPIRED', 'The stream service is closed.', { status: 401 });
    Sequence.parse(after);
    signal.throwIfAborted();
    identity.assertCurrent(context);
    const epoch = rooms.requireMembership(context, roomId).epoch;
    if (after > events.head(context, roomId)) throw new ApiError('VALIDATION_ERROR', 'Stream cursor exceeds the room head.');
    let cursor = after, stopped = false, pumping = false, again = false, blockedAt = null, timer;
    function cleanup() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      active.delete(stop);
      changes.off('room', roomChanged);
      changes.off('identity', identityChanged);
      signal.removeEventListener('abort', stop);
      response.off('drain', drain);
      response.off('close', cleanup);
      response.off('finish', cleanup);
      response.off('error', stop);
    }
    function stop() { cleanup(); if (!response.destroyed) response.destroy(); }
    function current() {
      identity.assertCurrent(context);
      rooms.requireMembership(context, roomId, { epoch });
    }
    function write(frame) {
      if (response.writableLength + Buffer.byteLength(frame) > MAX_BUFFER_BYTES) { stop(); return false; }
      const writable = response.write(frame);
      if (!writable) blockedAt = Date.now();
      return writable;
    }
    function pump() {
      if (stopped) return;
      if (pumping) { again = true; return; }
      pumping = true;
      try {
        do {
          again = false;
          current();
          if (blockedAt !== null) break;
          const page = events.after(context, roomId, { after: cursor, limit: 100 });
          for (const event of page.events) {
            current();
            const writable = write(`id:${event.sequence}\nevent:room_event\ndata:${JSON.stringify(event)}\n\n`);
            cursor = event.sequence;
            if (!writable || stopped) break;
          }
          if (blockedAt !== null || stopped) break;
          if (page.events.length === 100) again = true;
        } while (again && !stopped);
      } catch { stop(); }
      finally { pumping = false; }
    }
    function roomChanged(id) { if (id === roomId) pump(); }
    function identityChanged(id) { if (id === context.participant.id) pump(); }
    function drain() { blockedAt = null; pump(); }
    changes.on('room', roomChanged);
    changes.on('identity', identityChanged);
    signal.addEventListener('abort', stop, { once: true });
    response.on('drain', drain);
    response.on('close', cleanup);
    response.on('finish', cleanup);
    response.on('error', stop);
    active.add(stop);
    try {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no',
      });
      write(': connected\n\n');
      if (stopped) return { handled: true };
      timer = setInterval(() => {
        if (stopped) return;
        try {
          current();
          if (blockedAt !== null) { if (Date.now() - blockedAt >= MAX_BLOCKED_MS) stop(); }
          else { pump(); if (!stopped && blockedAt === null) write(': heartbeat\n\n'); }
        } catch { stop(); }
      }, heartbeatMs);
      timer.unref?.();
      pump();
    } catch (error) { stop(); throw error; }
    return { handled: true };
  }
  return { stream, close() { closed = true; for (const stop of [...active]) stop(); } };
}
