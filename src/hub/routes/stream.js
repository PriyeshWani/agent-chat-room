import { Id, Sequence } from '../../shared/schemas.js';
import { ApiError } from '../../shared/protocol.js';

export function createStreamRoutes({ sessions, browserStream }) {
  return ({ request, response, path, method, url, signal }) => {
    const match = /^\/api\/v1\/rooms\/([^/]+)\/stream$/.exec(path);
    if (!match || method !== 'GET') return undefined;
    const context = sessions.authenticate(request);
    let roomId;
    try { roomId = decodeURIComponent(match[1]); }
    catch { throw new ApiError('VALIDATION_ERROR', 'Invalid room identifier.'); }
    Id.parse(roomId);
    const values = url.searchParams.getAll('after');
    if (values.length > 1 || [...url.searchParams.keys()].some(key => key !== 'after') || (values.length && !/^(0|[1-9]\d*)$/.test(values[0]))) {
      throw new ApiError('VALIDATION_ERROR', 'Invalid stream cursor.');
    }
    const after = Sequence.parse(values.length ? Number(values[0]) : 0);
    return browserStream.stream(context, roomId, after, { response, signal });
  };
}
