import { Id } from '../../shared/schemas.js';
import { ApiError } from '../../shared/protocol.js';

export function createTaskRoutes({ sessions, tasks }) {
  return ({ request, path, method, body, url }) => {
    const match = /^\/api\/v1\/rooms\/([^/]+)\/tasks(?:\/(claim|update))?$/.exec(path);
    if (!match || !((method === 'GET' && !match[2]) || method === 'POST')) return undefined;
    const context = sessions.authenticate(request);
    let decoded;
    try { decoded = decodeURIComponent(match[1]); }
    catch { throw new ApiError('VALIDATION_ERROR', 'Invalid room identifier.'); }
    const roomId = Id.parse(decoded);
    if (url.search) throw new ApiError('VALIDATION_ERROR', 'Task queries do not accept parameters.');
    if (method === 'GET') return { schema: 'tasks', data: tasks.list(context, roomId) };
    return { schema: 'taskMutation', data: tasks[match[2] ?? 'create'](context, roomId, body) };
  };
}
