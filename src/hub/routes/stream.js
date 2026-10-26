import { Id, Sequence } from '../../shared/schemas.js';
import { ApiError } from '../../shared/protocol.js';

export function createStreamRoutes({ sessions, browserStream, events }) {
  return ({ request, response, path, method, url, signal }) => {
    const match = /^\/api\/v1\/rooms\/([^/]+)\/stream$/.exec(path);
    if (!match || method !== 'GET') return undefined;
    const context = sessions.authenticate(request);
    let roomId;
    try { roomId = decodeURIComponent(match[1]); }
    catch { throw new ApiError('VALIDATION_ERROR', 'Invalid room identifier.'); }
    Id.parse(roomId);
    const values = url.searchParams.getAll('after');
    const polling = url.searchParams.getAll('poll');
    if (polling.length > 1 || (polling.length && polling[0] !== '1')
      || values.length > 1 || [...url.searchParams.keys()].some(key => !['after', 'poll'].includes(key)) || (values.length && !/^(0|[1-9]\d*)$/.test(values[0]))) {
      throw new ApiError('VALIDATION_ERROR', 'Invalid stream cursor.');
    }
    const after = Sequence.parse(values.length ? Number(values[0]) : 0);
    if (polling.length) {
      // Finite event pages work through proxies that buffer open SSE streams.
      const page = events.after(context, roomId, { after, limit: 100 });
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(': connected\n\n' + page.events.map(event =>
        `id:${event.sequence}\nevent:room_event\ndata:${JSON.stringify(event)}\n\n`).join(''));
      return { handled: true };
    }
    return browserStream.stream(context, roomId, after, { response, signal });
  };
}
