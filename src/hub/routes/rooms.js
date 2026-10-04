import { Id, Inputs, Sequence } from '../../shared/schemas.js';
import { ApiError, LIMITS } from '../../shared/protocol.js';

function roomId(segment) {
  let decoded;
  try { decoded = decodeURIComponent(segment); }
  catch { throw new ApiError('VALIDATION_ERROR', 'Invalid room identifier.'); }
  return Id.parse(decoded);
}
function historyQuery(search) {
  const input = {};
  for (const [key, value] of search) {
    if (!['before', 'limit'].includes(key) || Object.hasOwn(input, key) || !/^(0|[1-9]\d*)$/.test(value)) {
      throw new ApiError('VALIDATION_ERROR', 'Invalid history query.');
    }
    const number = Sequence.parse(Number(value));
    if (key === 'limit' && (number < 1 || number > LIMITS.history)) throw new ApiError('VALIDATION_ERROR', 'Invalid history page size.');
    input[key] = number;
  }
  return input;
}

export function createRoomRoutes({ sessions, rooms, events, onChange = () => {} }) {
  function notify(id) {
    // Committed mutations remain successful when an optional wakeup fails.
    try { Promise.resolve(onChange(id)).catch(() => {}); } catch { /* Durable state is authoritative. */ }
  }
  return ({ request, path, method, body, url }) => {
    if (path === '/api/v1/rooms') {
      if (method !== 'GET' && method !== 'POST') return undefined;
      const context = sessions.authenticate(request);
      if (method === 'GET') return { schema: 'rooms', data: rooms.list(context) };
      const data = rooms.create(context, Inputs.createRoom.parse(body));
      notify(data.id);
      return { schema: 'createRoom', data };
    }
    const match = /^\/api\/v1\/rooms\/([^/]+)\/(join|leave|history)$/.exec(path);
    if (!match || method !== (match[2] === 'history' ? 'GET' : 'POST')) return undefined;
    const context = sessions.authenticate(request);
    const id = roomId(match[1]);
    if (match[2] === 'history') return { schema: 'history', data: events.history(context, id, historyQuery(url.searchParams)) };
    if (match[2] === 'leave') {
      const data = rooms.leave(context, id, Inputs.leaveRoom.parse(body));
      notify(id);
      return { schema: 'leaveRoom', data };
    }
    const joined = rooms.join(context, id, Inputs.joinRoom.parse(body));
    notify(id);
    const history = events.history(context, id, { through: joined.head_sequence });
    return { schema: 'joinRoom', data: { room: joined.room, membership: joined.membership, history } };
  };
}
