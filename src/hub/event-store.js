import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Inputs, Sequence } from '../shared/schemas.js';
import { ApiError } from '../shared/protocol.js';
import { createMutationStore } from './mutation-store.js';

const historyInput = z.object({ before: Sequence.optional(), limit: z.number().int().min(1).max(100).default(50), through: Sequence.optional() }).strict();
const afterInput = z.object({ after: Sequence, limit: z.number().int().min(1).max(100).default(100), through: Sequence.optional() }).strict();
function invalid(message = 'Invalid event input.') { throw new ApiError('VALIDATION_ERROR', message, { status: 400 }); }
function parse(schema, input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) invalid();
  return parsed.data;
}
const mentionPayload = mentions => mentions.length ? { mentions } : {};
const eventFromRow = row => ({
  id: row.id, room_id: row.room_id, sequence: row.sequence, kind: 'message',
  author: { id: row.author_id, name: row.author_name, kind: row.author_kind },
  payload: { text: row.text, reply_to: row.reply_to, ...mentionPayload(JSON.parse(row.mentions_json)) }, created_at: row.created_at,
});

export function createEventStore(database, { identity, rooms, now = () => new Date().toISOString(), id = randomUUID, onChange = () => {} }) {
  const { db, transaction } = database;
  const journal = createMutationStore(database);
  function selectedHead(roomId, through) {
    const current = db.prepare('SELECT next_sequence FROM rooms WHERE id=?').get(roomId).next_sequence - 1;
    if (!Number.isSafeInteger(current) || current < 0) invalid('Room sequence is outside the supported range.');
    if (through !== undefined && through > current) invalid('History cutoff exceeds the room head.');
    return through ?? current;
  }
  function post(context, roomId, raw, { notify = true } = {}) {
    const input = parse(Inputs.postMessage, raw);
    let appended = false;
    const result = transaction(() => {
      rooms.requireMembership(context, roomId);
      const author = identity.assertCurrent(context);
      const { request_id, ...payload } = input;
      // Preserve the original mutation identity for clients that omit mentions.
      if (!payload.mention_ids?.length) delete payload.mention_ids;
      const key = { participantId: author.id, requestId: request_id, operation: 'postMessage', roomId, payload };
      const previous = journal.lookup(key);
      if (previous.found) return previous.result;
      const mentions = (input.mention_ids ?? []).map(participantId => {
        const target = db.prepare(`SELECT p.id,p.name,p.kind FROM participants p JOIN memberships m ON m.participant_id=p.id
          WHERE m.room_id=? AND m.participant_id=? AND m.active=1`).get(roomId, participantId);
        if (!target) invalid('Mention targets must be participants in this room.');
        return { ...target };
      });
      if (input.reply_to !== null && !db.prepare('SELECT id FROM events WHERE room_id=? AND id=?').get(roomId, input.reply_to)) {
        invalid('Reply target must be a message in this room.');
      }
      const sequence = selectedHead(roomId) + 1;
      // next_sequence must also remain exactly representable by the Node API.
      if (!Number.isSafeInteger(sequence + 1)) invalid('Room sequence is exhausted.');
      const event = {
        id: id(), room_id: roomId, sequence, kind: 'message',
        author: { id: author.id, name: author.name, kind: author.kind },
        payload: { text: input.text, reply_to: input.reply_to, ...mentionPayload(mentions) }, created_at: now(),
      };
      db.prepare('INSERT INTO events (id,room_id,sequence,author_id,author_name,author_kind,text,reply_to,created_at,mentions_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(event.id, roomId, sequence, author.id, author.name, author.kind, input.text, input.reply_to, event.created_at, JSON.stringify(mentions));
      db.prepare('UPDATE rooms SET next_sequence=? WHERE id=?').run(sequence + 1, roomId);
      journal.record(key, event);
      appended = true;
      return event;
    });
    if (appended && notify) {
      // Wakeups are best-effort hints. Delivery always rereads the durable log.
      try { Promise.resolve(onChange(roomId)).catch(() => {}); } catch { /* Commit remains successful. */ }
    }
    return result;
  }
  function history(context, roomId, raw = {}) {
    const { before, limit, through } = parse(historyInput, raw);
    return transaction(() => {
      rooms.requireMembership(context, roomId);
      const room = rooms.get(context, roomId);
      const head_sequence = selectedHead(roomId, through);
      const rows = db.prepare(`SELECT * FROM events WHERE room_id=? AND sequence<=?
        AND (? IS NULL OR sequence<?) ORDER BY sequence DESC LIMIT ?`)
        .all(roomId, head_sequence, before ?? null, before ?? null, limit + 1);
      const hasOlder = rows.length > limit;
      const page = rows.slice(0, limit).reverse();
      return { room, events: page.map(eventFromRow), head_sequence, next_before: hasOlder ? page[0].sequence : null };
    });
  }
  function head(context, roomId) {
    return transaction(() => { rooms.requireMembership(context, roomId); return selectedHead(roomId); });
  }
  function after(context, roomId, raw = {}) {
    const input = parse(afterInput, raw);
    return transaction(() => {
      rooms.requireMembership(context, roomId);
      const head_sequence = selectedHead(roomId, input.through);
      if (input.after > head_sequence) invalid('Event cursor exceeds the room head.');
      const rows = db.prepare('SELECT * FROM events WHERE room_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?')
        .all(roomId, input.after, head_sequence, input.limit);
      return { events: rows.map(eventFromRow), head_sequence };
    });
  }
  return { post, history, head, after };
}
