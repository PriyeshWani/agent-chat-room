import { z } from 'zod';
import { Id, Sequence, Inputs, Outputs } from '../../shared/schemas.js';
import { ApiError, LIMITS, requestId } from '../../shared/protocol.js';

const jsonResult = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

export function registerRoomTools({ server, client, session, connect }) {
  let leaveAttempt = null;
  let mutationTail = Promise.resolve();
  const mutate = action => (input, signal) => {
    const pending = mutationTail.then(() => {
      signal.throwIfAborted();
      return action(input, signal);
    });
    mutationTail = pending.catch(() => {});
    return pending;
  };
  function register(name, description, inputSchema, output, action) {
    server.registerTool(name, { description, inputSchema }, async (input, { signal }) => {
      try {
        const data = await action(input, signal);
        const parsed = Outputs[output].safeParse(data);
        if (!parsed.success) throw new ApiError('INVALID_RESPONSE', 'The hub returned an invalid tool result.');
        return jsonResult(parsed.data);
      } catch (error) {
        // Only typed public errors cross this boundary; never serialize arbitrary
        // exceptions, validation payloads, or transport internals.
        const publicError = error instanceof ApiError
          ? { code: error.code, message: error.message, retryable: error.retryable === true }
          : signal.aborted
            ? { code: 'CANCELLED', message: 'The tool request was cancelled.', retryable: false }
            : { code: 'INTERNAL_ERROR', message: 'The tool could not complete this request.', retryable: false };
        return { ...jsonResult({ error: publicError }), isError: true };
      }
    });
  }
  function activeRoom() {
    if (!session.roomId || !session.membershipEpoch) {
      throw new ApiError('MEMBERSHIP_ENDED', 'Join a room before using this tool.', { status: 409 });
    }
    return session.roomId;
  }
  function validate(name, data) {
    const parsed = Outputs[name].safeParse(data);
    if (!parsed.success) throw new ApiError('INVALID_RESPONSE', 'The hub returned an invalid tool result.');
    return parsed.data;
  }

  register('list_rooms', 'List available rooms.', z.object({}).strict(), 'rooms',
    (_, signal) => client.listRooms({ signal }));
  register('join_room', 'Connect to a hub, join a room, and read its recent history. On first use supply hub_url and, for invited access, invite_token from the terminal user. Omitted values use the current connection or configured defaults. Use invite_token:null for local enrollment without an invitation. Never post invitations to the shared room. Leave the current room before changing hub or invitation.', z.object({
    room_id: Id,
    hub_url: z.string().min(1).max(2048).optional(),
    invite_token: Inputs.agentSession.shape.invite_token.nullable(),
  }).strict(), 'joinRoom',
    mutate(async ({ room_id, hub_url, invite_token }, signal) => {
      if (connect) session.participant = await connect({ hub_url, invite_token }, { signal, activeRoom: session.roomId });
      else if (hub_url !== undefined || invite_token !== undefined) {
        throw new ApiError('CONNECTION_OPTIONS_UNSUPPORTED', 'This adapter cannot select a hub or invitation.');
      }
      const data = validate('joinRoom', await client.joinRoom(room_id, {}, { signal }));
      if (data.room.id !== room_id || !data.membership.active) {
        throw new ApiError('INVALID_RESPONSE', 'The hub returned an invalid room membership.');
      }
      session.roomId = data.room.id;
      session.membershipEpoch = data.membership.epoch;
      return data;
    }));
  register('list_participants', 'List participants in the active room.', z.object({}).strict(), 'participants',
    (_, signal) => client.listParticipants(activeRoom(), { signal }));
  register('read_history', 'Read an ascending page of active-room history; before is exclusive.',
    z.object({ before: Sequence.optional(), limit: z.number().int().min(1).max(LIMITS.history).optional() }).strict(), 'history',
    (input, signal) => client.history(activeRoom(), { ...input, signal }));
  register('leave_room', 'Leave the active room.', z.object({}).strict(), 'leaveRoom',
    mutate(async (_, signal) => {
      const roomId = activeRoom();
      const epoch = session.membershipEpoch;
      if (!leaveAttempt || leaveAttempt.roomId !== roomId || leaveAttempt.epoch !== epoch) {
        leaveAttempt = { roomId, epoch, requestId: requestId() };
      }
      const data = validate('leaveRoom', await client.leaveRoom(roomId, {
        membership_epoch: epoch, request_id: leaveAttempt.requestId,
      }, { signal }));
      if (data.room_id !== roomId) throw new ApiError('INVALID_RESPONSE', 'The hub returned an invalid leave result.');
      // A delayed leave must not erase a newer join's local membership.
      if (session.roomId === roomId && session.membershipEpoch === epoch) {
        session.roomId = null;
        session.membershipEpoch = null;
      }
      leaveAttempt = null;
      return data;
    }));
}
