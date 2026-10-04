import { randomUUID } from 'node:crypto';
import { Id, Inputs } from '../shared/schemas.js';
import { ApiError } from '../shared/protocol.js';
import { createMutationStore } from './mutation-store.js';

function fail(code, message, status = 409) { throw new ApiError(code, message, { status }); }
function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) fail('VALIDATION_ERROR', 'Invalid room input.', 400);
  return result.data;
}
const publicRoom = row => ({ id: row.id, name: row.name, goal: row.goal, created_at: row.created_at });
const publicMembership = row => ({ ...row, active: Boolean(row.active), paused: Boolean(row.paused) });

export function createRoomStore(database, { identity, access, now = () => new Date().toISOString(), id = randomUUID }) {
  const { db, transaction } = database;
  const journal = createMutationStore(database);
  function authorize(context, roomId) {
    const participant = identity.assertCurrent(context);
    if (access) { access.authorize(participant, roomId); return participant; }
    if (participant.owner_id !== identity.localOwner()) fail('FORBIDDEN', 'Room access is not permitted.', 403);
    return participant;
  }
  function roomRow(roomId) {
    const row = db.prepare('SELECT * FROM rooms WHERE id=?').get(parse(Id, roomId));
    if (!row) fail('NOT_FOUND', 'Room was not found.', 404);
    return row;
  }
  const memberRow = (roomId, participantId) => db.prepare('SELECT * FROM memberships WHERE room_id=? AND participant_id=?').get(roomId, participantId);
  function checkActiveRoom(participant, roomId) {
    if (participant.kind === 'agent' && db.prepare('SELECT room_id FROM memberships WHERE participant_id=? AND active=1 AND room_id<>?').get(participant.id, roomId)) {
      fail('ACTIVE_ROOM_CONFLICT', 'Leave the active room before joining another.');
    }
  }
  function keyFor(participant, input, operation, roomId) {
    const { request_id, ...payload } = input;
    return { participantId: participant.id, requestId: request_id, operation, roomId, payload };
  }
  function replayEpoch(roomId, participantId, epoch, active) {
    const member = memberRow(roomId, participantId);
    if (!member || member.epoch !== epoch || Boolean(member.active) !== active) {
      fail('MEMBERSHIP_ENDED', 'The membership for this request has ended.');
    }
  }
  function joinAtHead(participant, room) {
    let member = memberRow(room.id, participant.id);
    if (!member?.active) {
      checkActiveRoom(participant, room.id);
      const head = room.next_sequence - 1;
      db.prepare(`INSERT INTO memberships VALUES (?, ?, ?, 1, ?, ?, 0)
        ON CONFLICT(room_id,participant_id) DO UPDATE SET epoch=excluded.epoch,active=1,
        joined_sequence=excluded.joined_sequence,acknowledged_sequence=excluded.acknowledged_sequence,paused=0`)
        .run(room.id, participant.id, id(), head, head);
      member = memberRow(room.id, participant.id);
    }
    return { room: publicRoom(room), membership: publicMembership(member), head_sequence: room.next_sequence - 1 };
  }
  function list(context) {
    return transaction(() => {
      const participant = authorize(context);
      return { rooms: db.prepare('SELECT * FROM rooms ORDER BY created_at,id').all()
        .filter(room => !access || access.canAccess(participant, room.id)).map(publicRoom) };
    });
  }
  function get(context, roomId) {
    return transaction(() => { authorize(context, roomId); return publicRoom(roomRow(roomId)); });
  }
  function create(context, raw) {
    const input = parse(Inputs.createRoom, raw);
    return transaction(() => {
      const participant = authorize(context);
      if (access && !access.isHost(participant)) fail('FORBIDDEN', 'Only the host can create rooms.', 403);
      const key = keyFor(participant, input, 'createRoom', null);
      const previous = journal.lookup(key);
      if (previous.found) {
        roomRow(previous.result.room.id);
        replayEpoch(previous.result.room.id, participant.id, previous.result.epoch, true);
        return previous.result.room;
      }
      const roomId = id();
      checkActiveRoom(participant, roomId);
      if (db.prepare('SELECT id FROM rooms WHERE name=?').get(input.name)) fail('ROOM_NAME_CONFLICT', 'A room with that name already exists.');
      db.prepare('INSERT INTO rooms(id,name,goal,created_at) VALUES (?, ?, ?, ?)').run(roomId, input.name, input.goal, now());
      const joined = joinAtHead(participant, roomRow(roomId));
      journal.record(key, { room: joined.room, epoch: joined.membership.epoch });
      return joined.room;
    });
  }
  function join(context, roomId, raw) {
    const input = parse(Inputs.joinRoom, raw);
    return transaction(() => {
      const participant = authorize(context, roomId);
      const room = roomRow(roomId);
      const key = keyFor(participant, input, 'joinRoom', room.id);
      const previous = journal.lookup(key);
      if (previous.found) {
        replayEpoch(room.id, participant.id, previous.result.membership.epoch, true);
        return previous.result;
      }
      const result = joinAtHead(participant, room);
      journal.record(key, result);
      return result;
    });
  }
  function leave(context, roomId, raw) {
    const input = parse(Inputs.leaveRoom, raw);
    return transaction(() => {
      const participant = authorize(context, roomId);
      const room = roomRow(roomId);
      const key = keyFor(participant, input, 'leaveRoom', room.id);
      const previous = journal.lookup(key);
      if (previous.found) {
        replayEpoch(room.id, participant.id, previous.result.epoch, false);
        return previous.result.output;
      }
      const member = memberRow(room.id, participant.id);
      if (member && member.epoch !== input.membership_epoch) fail('MEMBERSHIP_ENDED', 'The membership epoch has ended.');
      if (!member?.active) fail('FORBIDDEN', 'Active membership is required.', 403);
      db.prepare('UPDATE memberships SET active=0 WHERE room_id=? AND participant_id=?').run(room.id, participant.id);
      db.prepare("UPDATE batches SET status='invalidated' WHERE room_id=? AND participant_id=? AND membership_epoch=? AND status='pending'")
        .run(room.id, participant.id, member.epoch);
      const output = { room_id: room.id, left: true };
      journal.record(key, { output, epoch: member.epoch });
      return output;
    });
  }
  function requireMembership(context, roomId, { epoch } = {}) {
    return transaction(() => {
      const participant = authorize(context, roomId);
      const room = roomRow(roomId);
      if (epoch !== undefined) parse(Id, epoch);
      const member = memberRow(room.id, participant.id);
      if (member && epoch !== undefined && epoch !== member.epoch) fail('MEMBERSHIP_ENDED', 'The membership epoch has ended.');
      if (!member?.active) fail('FORBIDDEN', 'Active membership is required.', 403);
      return publicMembership(member);
    });
  }
  function listMembers(context, roomId) {
    return transaction(() => {
      requireMembership(context, roomId);
      return db.prepare('SELECT * FROM memberships WHERE room_id=? AND active=1 ORDER BY participant_id').all(roomId)
        .map(member => ({ participant: identity.getParticipant(member.participant_id), membership: publicMembership(member) }))
        .filter(record => !access || access.canAccess(record.participant, roomId));
    });
  }
  return { list, get, create, join, leave, requireMembership, listMembers };
}
