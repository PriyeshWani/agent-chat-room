import { ApiError, canonical } from '../shared/protocol.js';

const conflict = () => { throw new ApiError('IDEMPOTENCY_CONFLICT', 'Request ID already has a different outcome.', { status: 409 }); };

export function createMutationStore(database) {
  const { db } = database;
  function encoded(key) {
    const { request_id: ignored, ...input } = key.payload;
    return canonical({ room_id: key.roomId, input });
  }
  function lookup(key) {
    const row = db.prepare('SELECT operation, payload_json, result_json FROM requests WHERE participant_id=? AND request_id=?')
      .get(key.participantId, key.requestId);
    if (!row) return { found: false };
    if (row.operation !== key.operation || row.payload_json !== encoded(key)) conflict();
    return { found: true, result: JSON.parse(row.result_json) };
  }
  function record(key, result) {
    const previous = lookup(key);
    if (previous.found) {
      if (canonical(previous.result) !== canonical(result)) conflict();
      return;
    }
    db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?)')
      .run(key.participantId, key.requestId, key.operation, encoded(key), canonical(result));
  }
  return { lookup, record };
}
