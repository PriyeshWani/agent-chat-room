import { Id } from '../../shared/schemas.js';
import { ApiError } from '../../shared/protocol.js';

export function createInvitationRoutes({ sessions, rooms, access, invitationEmail }) {
  return async ({ request, path, method, body }) => {
    const match = /^\/api\/v1\/rooms\/([^/]+)\/invitations(?:\/(revoke|email))?$/.exec(path);
    if (!access || !match || !((method === 'GET' && !match[2]) || method === 'POST')) return undefined;
    let roomId;
    try { roomId = Id.parse(decodeURIComponent(match[1])); }
    catch { throw new ApiError('VALIDATION_ERROR', 'Invalid room identifier.'); }
    const context = sessions.authenticate(request);
    rooms.requireMembership(context, roomId);
    if (method === 'GET') return { schema: 'invitations', data: access.list(context, roomId) };
    if (match[2] === 'email') return { schema: 'emailInvitation', data: await invitationEmail.send(context, roomId, body) };
    if (match[2]) return { schema: 'revokeInvitation', data: access.revoke(context, roomId, body) };
    return { schema: 'createInvitation', data: access.create(context, roomId, body) };
  };
}
