import { Inputs, Outputs } from '../../shared/schemas.js';
import { ApiError } from '../../shared/protocol.js';

const jsonResult = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
// A second text block keeps the JSON result unchanged for existing clients.
const CONTINUE_HINT = 'Keep participating: call receive_events again now. Stop only on terminal cancellation, a targeted human stop/leave request, or an unrecoverable error.';

export function registerDeliveryTools({ server, client, session }) {
  function register(name, description, inputSchema, output, action, matches, hint = () => null) {
    server.registerTool(name, { description, inputSchema }, async (input, { signal }) => {
      try {
        const roomId = session.roomId;
        const epoch = session.membershipEpoch;
        if (!roomId || !epoch) throw new ApiError('MEMBERSHIP_ENDED', 'Join a room before using this tool.', { status: 409 });
        const result = await action(roomId, epoch, input, signal);
        if (session.roomId !== roomId || session.membershipEpoch !== epoch) {
          throw new ApiError('MEMBERSHIP_ENDED', 'The room membership changed during this request.', { status: 409 });
        }
        const parsed = Outputs[output].safeParse(result);
        if (!parsed.success || !matches(parsed.data, roomId, epoch, input)) {
          throw new ApiError('INVALID_RESPONSE', 'The hub returned an invalid delivery result.');
        }
        const response = jsonResult(parsed.data);
        const next = hint(parsed.data);
        if (next) response.content.push({ type: 'text', text: next });
        return response;
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

  register('receive_events', 'Receive messages from humans and other agents as a pending batch, or a timeout in the active room. Consider useful peer questions and proposals without waiting for a human mention. Receiving never acknowledges a batch. After a timeout, call receive_events again immediately; a timeout is not a reason to stop.',
    Inputs.receive, 'receive',
    (roomId, _epoch, input, signal) => client.receiveEvents(roomId, input, { signal }),
    (data, roomId, epoch) => data.kind === 'timeout'
      ? data.room_id === roomId
      : data.batch.room_id === roomId && data.batch.membership_epoch === epoch,
    data => data.kind === 'timeout' ? CONTINUE_HINT : null);

  register('ack_events', 'Acknowledge an entire delivered batch. Reuse request_id when retrying the same acknowledgement. Then call receive_events again.',
    Inputs.ack.omit({ membership_epoch: true }), 'ack',
    (roomId, epoch, input, signal) => client.ackEvents(roomId, { ...input, membership_epoch: epoch }, { signal }),
    (data, roomId, _epoch, input) => data.room_id === roomId && data.batch_id === input.batch_id,
    () => CONTINUE_HINT);
}
