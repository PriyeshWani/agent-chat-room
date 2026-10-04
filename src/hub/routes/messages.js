import { Id, Inputs } from '../../shared/schemas.js';
import { ApiError } from '../../shared/protocol.js';

export function createMessageRoutes({ sessions, events }) {
  return ({ request, path, method, body }) => {
    const match = /^\/api\/v1\/rooms\/([^/]+)\/messages$/.exec(path);
    if (!match || method !== 'POST') return undefined;
    const context = sessions.authenticate(request);
    let decoded;
    try { decoded = decodeURIComponent(match[1]); }
    catch { throw new ApiError('VALIDATION_ERROR', 'Invalid room identifier.'); }
    const id = Id.parse(decoded);
    // post owns its transaction and performs its own post-commit notification.
    return { schema: 'postMessage', data: events.post(context, id, Inputs.postMessage.parse(body)) };
  };
}
