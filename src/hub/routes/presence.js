import { ApiError } from '../../shared/protocol.js';

export function createPresenceRoutes({ sessions, presence }) {
  return function presenceRoutes({ request, path, method }) {
    if (method !== 'GET') return;
    const match = /^\/api\/v1\/rooms\/([^/]+)\/participants$/.exec(path);
    if (!match) return;
    const context = sessions.authenticate(request);
    let roomId;
    try { roomId = decodeURIComponent(match[1]); }
    catch { throw new ApiError('VALIDATION_ERROR', 'Invalid room path.', { status: 400 }); }
    return { data: presence.list(context, roomId), schema: 'participants' };
  };
}
