import { Inputs } from '../../shared/schemas.js';
import { ApiError } from '../../shared/protocol.js';

export function createDeliveryRoutes({ sessions, deliveryService }) {
  return async function deliveryRoutes({ request, path, method, body, signal }) {
    if (method !== 'POST') return;
    const match = /^\/api\/v1\/rooms\/([^/]+)\/(receive|ack)$/.exec(path);
    if (!match) return;
    const context = sessions.authenticate(request);
    let roomId;
    try { roomId = decodeURIComponent(match[1]); }
    catch { throw new ApiError('VALIDATION_ERROR', 'Invalid room path.', { status: 400 }); }
    if (match[2] === 'receive') {
      const input = Inputs.receive.parse(body);
      return { data: await deliveryService.receive(context, roomId, input, { signal }), schema: 'receive' };
    }
    const input = Inputs.ack.parse(body);
    return { data: deliveryService.ack(context, roomId, input), schema: 'ack' };
  };
}
