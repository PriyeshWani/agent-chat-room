import { randomUUID } from 'node:crypto';
import { Inputs } from '../shared/schemas.js';
import { ApiError } from '../shared/protocol.js';
import { createMutationStore } from './mutation-store.js';

const receiveInput = Inputs.receive.pick({ limit: true });
function parse(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError('VALIDATION_ERROR', 'Invalid delivery input.', { status: 400 });
  return parsed.data;
}
function invalidAck() { throw new ApiError('INVALID_ACK', 'Batch is not valid for this acknowledgement.', { status: 409 }); }
const publicBatch = row => ({
  id: row.id, room_id: row.room_id, membership_epoch: row.membership_epoch,
  events: JSON.parse(row.events_json), scanned_through: row.scanned_through,
});

export function createDeliveryStore(database, { identity, rooms, events, now = () => new Date().toISOString(), id = randomUUID }) {
  const { db, transaction } = database;
  const journal = createMutationStore(database);
  function membership(context, roomId, epoch) {
    const participant = identity.assertCurrent(context);
    if (participant.kind !== 'agent') throw new ApiError('FORBIDDEN', 'Agent membership is required.', { status: 403 });
    return rooms.requireMembership(context, roomId, { epoch });
  }
  function receive(context, roomId, raw = {}) {
    const { limit } = parse(receiveInput, raw);
    return transaction(() => {
      const member = membership(context, roomId);
      const pending = db.prepare("SELECT * FROM batches WHERE room_id=? AND participant_id=? AND membership_epoch=? AND status='pending'")
        .get(roomId, member.participant_id, member.epoch);
      if (pending) return { kind: 'batch', batch: publicBatch(pending) };
      let acknowledged = member.acknowledged_sequence;
      const timeout = () => ({ kind: 'timeout', room_id: roomId, acknowledged_through: acknowledged });
      if (member.paused) return timeout();
      let scanned, visible;
      for (;;) {
        scanned = events.after(context, roomId, { after: acknowledged, limit }).events;
        if (!scanned.length) return timeout();
        visible = scanned.filter(event => event.author.id !== member.participant_id);
        if (visible.length) break;
        // A self-only scan carries nothing to process: advance without a batch.
        acknowledged = scanned.at(-1).sequence;
        db.prepare('UPDATE memberships SET acknowledged_sequence=MAX(acknowledged_sequence,?) WHERE room_id=? AND participant_id=? AND epoch=?')
          .run(acknowledged, roomId, member.participant_id, member.epoch);
      }
      const batch = {
        id: id(), room_id: roomId, membership_epoch: member.epoch,
        events: visible, scanned_through: scanned.at(-1).sequence,
      };
      db.prepare('INSERT INTO batches VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(batch.id, roomId, member.participant_id, member.epoch, batch.scanned_through, JSON.stringify(batch.events), 'pending', now());
      return { kind: 'batch', batch };
    });
  }
  function ack(context, roomId, raw) {
    const input = parse(Inputs.ack, raw);
    return transaction(() => {
      const member = membership(context, roomId, input.membership_epoch);
      const { request_id, ...payload } = input;
      const key = { participantId: member.participant_id, requestId: request_id, operation: 'ackEvents', roomId, payload };
      const previous = journal.lookup(key);
      if (previous.found) return previous.result;
      const batch = db.prepare('SELECT * FROM batches WHERE id=?').get(input.batch_id);
      if (!batch || batch.room_id !== roomId || batch.participant_id !== member.participant_id) invalidAck();
      if (batch.membership_epoch !== member.epoch) {
        throw new ApiError('MEMBERSHIP_ENDED', 'The batch membership has ended.', { status: 409 });
      }
      if (batch.status !== 'pending' && batch.status !== 'acked') invalidAck();
      const result = { room_id: roomId, batch_id: batch.id, acknowledged_through: batch.scanned_through };
      if (batch.status === 'pending') {
        db.prepare('UPDATE memberships SET acknowledged_sequence=MAX(acknowledged_sequence,?) WHERE room_id=? AND participant_id=? AND epoch=?')
          .run(batch.scanned_through, roomId, member.participant_id, member.epoch);
        db.prepare("UPDATE batches SET status='acked' WHERE id=?").run(batch.id);
      }
      journal.record(key, result);
      return result;
    });
  }
  return { receive, ack };
}
