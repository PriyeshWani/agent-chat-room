import { Inputs } from '../shared/schemas.js';
import { ApiError } from '../shared/protocol.js';

export function createPresenceService({ identity, rooms, events, deliveryService, now = Date.now, ttlMs = 30000 }) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be positive.');
  const seen = new Map();
  let closed = false;
  const sameConnection = (a, b) => a.connection_id === b.connection_id && a.generation === b.generation;
  function touch(context, raw = {}) {
    const parsed = Inputs.heartbeat.safeParse(raw);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', 'Invalid presence input.', { status: 400 });
    const participant = identity.assertCurrent(context);
    if (closed) return;
    const time = now();
    const previous = seen.get(participant.id);
    const activity = parsed.data.activity === undefined
      ? (previous && sameConnection(previous.context, context) ? previous.activity : null)
      : { text: parsed.data.activity, at: time };
    seen.set(participant.id, {
      context: { participant, connection_id: context.connection_id, generation: context.generation, kind: participant.kind },
      at: time, activity,
    });
  }
  function disconnect(context) {
    // The session facade calls this after durable disconnect, so an agent's
    // context is already expired. A late old-generation disconnect cannot
    // remove a newer connection's observation.
    const previous = seen.get(context.participant.id);
    if (previous && sameConnection(previous.context, context)) seen.delete(context.participant.id);
  }
  function list(context, roomId) {
    const members = rooms.listMembers(context, roomId);
    const head = events.head(context, roomId);
    const time = now();
    return { participants: members.map(({ participant, membership }) => {
      let observation = seen.get(participant.id);
      if (observation) {
        try { identity.assertCurrent(observation.context); }
        catch (error) {
          if (!(error instanceof ApiError) || !['UNAUTHENTICATED', 'SESSION_REPLACED', 'SESSION_EXPIRED'].includes(error.code)) throw error;
          seen.delete(participant.id);
          observation = null;
        }
      }
      const fresh = observation && time - observation.at < ttlMs;
      const activity = fresh && observation.activity && time - observation.activity.at < ttlMs
        ? { text: observation.activity.text, reported_at: new Date(observation.activity.at).toISOString() } : null;
      return {
        participant,
        connection: fresh ? 'connected' : 'disconnected',
        delivery: membership.paused ? 'paused' : deliveryService.isReceiving(participant.id, roomId) ? 'receiving' : 'idle',
        pending_count: participant.kind === 'agent' ? Math.max(0, head - membership.acknowledged_sequence) : 0,
        activity,
        last_seen_at: fresh ? new Date(observation.at).toISOString() : null,
      };
    }) };
  }
  function close() { closed = true; seen.clear(); }
  return { touch, disconnect, list, close };
}
