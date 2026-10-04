import { Inputs } from '../shared/schemas.js';
import { ApiError } from '../shared/protocol.js';

const aborted = () => new DOMException('Receive was cancelled.', 'AbortError');

export function createDeliveryService({ delivery, rooms, identity, changes }) {
  const waiters = new Map();
  let closed = false;
  const keyFor = (participantId, roomId) => JSON.stringify([participantId, roomId]);

  async function receive(context, roomId, raw = {}, { signal } = {}) {
    const parsed = Inputs.receive.safeParse(raw);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', 'Invalid receive input.', { status: 400 });
    if (closed || signal?.aborted) throw aborted();
    const participant = identity.assertCurrent(context);
    const member = rooms.requireMembership(context, roomId);
    const key = keyFor(participant.id, roomId);
    const existing = waiters.get(key);
    if (existing) {
      // A changed epoch/generation must release its obsolete waiter first.
      existing.check();
      if (waiters.has(key)) throw new ApiError('ALREADY_RECEIVING', 'A receive is already waiting for this membership.', { status: 409 });
    }
    const initial = delivery.receive(context, roomId, { limit: parsed.data.limit });
    if (initial.kind === 'batch' || parsed.data.wait_ms === 0) return initial;

    return new Promise((resolve, reject) => {
      let done = false;
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        changes.off('room', onRoom);
        changes.off('identity', onIdentity);
        signal?.removeEventListener('abort', onAbort);
        if (waiters.get(key) === waiter) waiters.delete(key);
      };
      const finish = (error, value) => {
        if (done) return;
        done = true;
        cleanup();
        if (error) reject(error); else resolve(value);
      };
      const check = (timeout = false) => {
        if (done) return;
        try {
          if (closed || signal?.aborted) throw aborted();
          identity.assertCurrent(context);
          rooms.requireMembership(context, roomId, { epoch: member.epoch });
          const result = delivery.receive(context, roomId, { limit: parsed.data.limit });
          if (result.kind === 'batch' || timeout) finish(null, result);
        } catch (error) { finish(error); }
      };
      const onRoom = changedRoom => { if (changedRoom === roomId) queueMicrotask(() => check()); };
      const onIdentity = changedParticipant => { if (changedParticipant === participant.id) queueMicrotask(() => check()); };
      const onAbort = () => finish(aborted());
      const waiter = { participantId: participant.id, roomId, check, cancel: onAbort };
      waiters.set(key, waiter);
      changes.on('room', onRoom);
      changes.on('identity', onIdentity);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => check(true), parsed.data.wait_ms);
      // Subscription precedes this durable recheck: a commit between the
      // initial scan and subscription cannot leave this receive asleep.
      check();
    });
  }
  function ack(context, roomId, input) {
    if (closed) throw aborted();
    return delivery.ack(context, roomId, input);
  }
  function isReceiving(participantId, roomId) { return waiters.has(keyFor(participantId, roomId)); }
  function close() {
    if (closed) return;
    closed = true;
    for (const waiter of [...waiters.values()]) waiter.cancel();
  }
  return { receive, ack, isReceiving, close };
}
