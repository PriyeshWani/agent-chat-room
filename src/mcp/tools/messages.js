import { Inputs, Outputs } from '../../shared/schemas.js';
import { ApiError } from '../../shared/protocol.js';

const jsonResult = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

export function registerMessageTools({ server, client, session }) {
  server.registerTool('post_message', {
    description: 'Post a message in the active room. To address participants, supply their IDs from list_participants in mention_ids and write @Name in the text. Mentions remain visible to everyone. Use distinct request IDs for separate messages and reuse the same ID when retrying a post.',
    inputSchema: Inputs.postMessage,
  }, async (input, { signal }) => {
    try {
      const roomId = session.roomId;
      if (!roomId || !session.membershipEpoch) {
        throw new ApiError('MEMBERSHIP_ENDED', 'Join a room before using this tool.', { status: 409 });
      }
      signal.throwIfAborted();
      const result = await client.postMessage(roomId, input, { signal });
      const parsed = Outputs.postMessage.safeParse(result);
      if (!parsed.success || parsed.data.room_id !== roomId || parsed.data.payload.reply_to !== input.reply_to
        || JSON.stringify(parsed.data.payload.mentions?.map(person => person.id) ?? []) !== JSON.stringify(input.mention_ids ?? [])) {
        throw new ApiError('INVALID_RESPONSE', 'The hub returned an invalid message result.');
      }
      // A committed event belongs to the captured room even if selection changed.
      return jsonResult(parsed.data);
    } catch (error) {
      const publicError = error instanceof ApiError
        ? { code: error.code, message: error.message, retryable: error.retryable === true }
        : signal.aborted
          ? { code: 'CANCELLED', message: 'The tool request was cancelled.', retryable: false }
          : { code: 'INTERNAL_ERROR', message: 'The tool could not complete this request.', retryable: false };
      return { ...jsonResult({ error: publicError }), isError: true };
    }
  });
}
