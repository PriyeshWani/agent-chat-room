import http from 'node:http';
import { once } from 'node:events';
import { API_PATH, success, failure, ApiError } from '../../src/shared/protocol.js';
import { Inputs, Outputs } from '../../src/shared/schemas.js';
import * as fixtures from '../../src/shared/fixtures.js';

/** Schema-valid scripted transport, not an alternative implementation of the hub.
 * handler receives { path, method, body, request, response, calls }; return
 * { data, schema, status? }, { error: ApiError }, or { handled: true } for streams.
 * Return undefined to use the deliberately static default fixture response.
 */
export async function createFixtureServer({ handler } = {}) {
  const calls = [];
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      let body = raw ? JSON.parse(raw) : undefined;
      const path = new URL(request.url, 'http://fixture.local').pathname.slice(API_PATH.length);
      const call = { path, method: request.method, body, request, response, calls };
      calls.push({ path, method: request.method, body, headers: request.headers });
      const custom = await handler?.(call);
      if (custom?.handled) return;
      if (custom?.error) throw custom.error;
      const roomMatch = /^\/rooms\/([^/]+)/.exec(path);
      const selectedRoom = roomMatch ? [fixtures.room, fixtures.otherRoom].find(room => room.id === decodeURIComponent(roomMatch[1])) : fixtures.room;
      if (!selectedRoom) throw new ApiError('NOT_FOUND', 'Unknown fixture room.', { status: 404 });
      const selectedHistory = selectedRoom.id === fixtures.room.id ? fixtures.history : { room: selectedRoom, events: [], head_sequence: 0, next_before: null };
      const selectedMembership = { ...fixtures.membership, room_id: selectedRoom.id, joined_sequence: selectedHistory.head_sequence, acknowledged_sequence: selectedHistory.head_sequence };
      let result = custom;
      if (!result) {
        if (path === '/health') result = { schema: 'health', data: { status: 'ok', version: '1' } };
        else if (path === '/sessions/agent') { body = Inputs.agentSession.parse(body); result = { schema: 'agentSession', data: { participant: fixtures.agent, connection: { id: 'connection-1', generation: 1 }, token: fixtures.token } }; }
        else if (path === '/sessions/browser') { response.setHeader('Set-Cookie', 'acr_session=fixture-browser; HttpOnly; SameSite=Strict; Path=/'); result = { schema: 'browserSession', data: { participant: fixtures.human } }; }
        else if (path === '/sessions/heartbeat' || path === '/sessions/disconnect') result = { schema: 'heartbeat', data: { ok: true } };
        else if (path === '/rooms' && request.method === 'GET') result = { schema: 'rooms', data: { rooms: [fixtures.room, fixtures.otherRoom] } };
        else if (path === '/rooms' && request.method === 'POST') { body = Inputs.createRoom.parse(body); result = { schema: 'createRoom', data: { ...fixtures.room, name: body.name, goal: body.goal ?? '' } }; }
        else if (path.endsWith('/join')) { body = Inputs.joinRoom.parse(body); result = { schema: 'joinRoom', data: { room: selectedRoom, membership: selectedMembership, history: selectedHistory } }; }
        else if (path.endsWith('/leave')) { body = Inputs.leaveRoom.parse(body); result = { schema: 'leaveRoom', data: { room_id: selectedRoom.id, left: true } }; }
        else if (path.endsWith('/history')) result = { schema: 'history', data: selectedHistory };
        else if (path.endsWith('/messages')) { body = Inputs.postMessage.parse(body); result = { schema: 'postMessage', data: { ...fixtures.event, room_id: selectedRoom.id, author: { id: fixtures.agent.id, name: fixtures.agent.name, kind: 'agent' }, payload: { text: body.text, reply_to: body.reply_to ?? null } } }; }
        else if (path.endsWith('/receive')) { body = Inputs.receive.parse(body); result = { schema: 'receive', data: { kind: 'timeout', room_id: selectedRoom.id, acknowledged_through: selectedHistory.head_sequence } }; }
        else if (path.endsWith('/ack')) { body = Inputs.ack.parse(body); result = { schema: 'ack', data: { room_id: selectedRoom.id, batch_id: body.batch_id, acknowledged_through: 1 } }; }
        else if (path.endsWith('/participants')) result = { schema: 'participants', data: { participants: [fixtures.status] } };
        else throw new ApiError('NOT_FOUND', 'No fixture for this route.', { status: 404 });
      }
      if (!result.schema || !Outputs[result.schema]) throw new Error('Fixture responses must name an output schema.');
      const data = Outputs[result.schema].parse(result.data);
      response.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(success(data)));
    } catch (error) {
      response.writeHead(error.status ?? 500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(failure(error)));
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`, calls,
    async close() { const closed = new Promise(resolve => server.close(resolve)); for (const socket of sockets) socket.destroy(); await closed; },
  };
}
