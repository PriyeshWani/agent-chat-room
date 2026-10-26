import { randomUUID } from 'node:crypto';
import { Inputs } from '../shared/schemas.js';
import { ApiError } from '../shared/protocol.js';
import { createMutationStore } from './mutation-store.js';

// Credentials remain in the hub process. There is no sender without explicit
// enablement, and no configurable endpoint that could receive the API key.
export function createEmailSender({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (env.ROOM_EMAIL_ENABLED !== '1') return null;
  const key = env.ROOM_EMAIL_API_KEY;
  const from = env.ROOM_EMAIL_FROM;
  if (!key || !from || /[\r\n]/.test(from) || !from.includes('@')) {
    throw new TypeError('Email requires ROOM_EMAIL_API_KEY and ROOM_EMAIL_FROM.');
  }
  return {
    async send(message, idempotencyKey) {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(15000), redirect: 'error',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text }),
      });
      // A timeout, server error, or invalid response may follow a successful
      // submission. Never expose provider bodies or claim delivery to an inbox.
      if (!response.ok) return { status: response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429 ? 'failed' : 'unknown' };
      const result = await response.json();
      return { status: typeof result?.id === 'string' && result.id ? 'accepted' : 'unknown' };
    },
  };
}

export function createInvitationEmail({ database, access, rooms, publicUrl, sender,
  now = () => new Date().toISOString() }) {
  const { db, transaction } = database;
  const journal = createMutationStore(database);
  const flights = new Map();
  function result(row) {
    const invite = db.prepare('SELECT expires_at FROM invitations WHERE id=?').get(row.invitation_id);
    return { invitation_id: row.invitation_id, status: row.status === 'sending' ? 'unknown' : row.status, expires_at: invite.expires_at };
  }
  function send(context, roomId, raw) {
    const input = Inputs.emailInvitation.parse(raw);
    const person = access.requireHuman(context, roomId);
    rooms.requireMembership(context, roomId);
    if (!sender) throw new ApiError('EMAIL_NOT_CONFIGURED', 'Email sending is not enabled. Share an invitation link instead.', { status: 409 });
    const origin = new URL(publicUrl());
    if (origin.protocol !== 'https:') throw new ApiError('EMAIL_PUBLIC_URL_REQUIRED', 'Email invitations require a public HTTPS hub URL.', { status: 409 });
    const row = transaction(() => {
      const key = { participantId: person.id, requestId: input.request_id, operation: 'emailInvitation', roomId, payload: input };
      const previous = journal.lookup(key);
      if (previous.found) return db.prepare('SELECT * FROM invitation_emails WHERE id=?').get(previous.result.id);
      const since = new Date(Date.parse(now()) - 3600000).toISOString();
      // Per-owner quota prevents reconnects from bypassing the sender limit.
      const count = db.prepare(`SELECT COUNT(*) AS n FROM invitation_emails e JOIN participants p ON p.id=e.participant_id
        WHERE p.owner_id=? AND e.created_at>=?`).get(person.owner_id, since).n;
      if (count >= 10) throw new ApiError('EMAIL_RATE_LIMIT', 'Email invitation limit reached. Try again later.', { status: 429 });
      const created = access.create(context, roomId, { request_id: randomUUID(), kind: 'human', label: input.label });
      const room = rooms.get(context, roomId);
      const link = `${origin.origin}/#invite=${encodeURIComponent(created.token)}`;
      const message = { to: input.email, subject: 'Invitation to Agent Chat Room',
        text: `${person.name} invited you to the room "${room.name}".\n\nJoin: ${link}\n\nThis single-use link expires at ${created.invitation.expires_at}. Access can be revoked by the host. If you were not expecting this invitation, ignore this email.` };
      const id = randomUUID();
      db.prepare('INSERT INTO invitation_emails VALUES (?,?,?,?,?,?,?)')
        .run(id, created.invitation.id, person.id, roomId, JSON.stringify(message), 'pending', now());
      journal.record(key, { id });
      return db.prepare('SELECT * FROM invitation_emails WHERE id=?').get(id);
    });
    if (flights.has(row.id)) return flights.get(row.id);
    if (row.status !== 'pending') return Promise.resolve(result(row));
    const invite = db.prepare('SELECT revoked_at,expires_at FROM invitations WHERE id=?').get(row.invitation_id);
    if (invite.revoked_at || invite.expires_at <= now()) {
      db.prepare("UPDATE invitation_emails SET status='failed' WHERE id=?").run(row.id);
      return Promise.resolve(result({ ...row, status: 'failed' }));
    }
    const claimed = db.prepare("UPDATE invitation_emails SET status='sending' WHERE id=? AND status='pending'").run(row.id);
    if (!claimed.changes) return Promise.resolve(result(db.prepare('SELECT * FROM invitation_emails WHERE id=?').get(row.id)));
    const flight = Promise.resolve().then(async () => {
      let status = 'unknown';
      try {
        const response = await sender.send(JSON.parse(row.message_json), `room-invite/${row.id}`);
        if (['accepted', 'failed'].includes(response?.status)) status = response.status;
      } catch { /* Outcome uncertain. Do not automatically resend. */ }
      db.prepare('UPDATE invitation_emails SET status=? WHERE id=?').run(status, row.id);
      return result({ ...row, status });
    }).finally(() => flights.delete(row.id));
    flights.set(row.id, flight);
    return flight;
  }
  async function close() { await Promise.allSettled([...flights.values()]); }
  return { send, close };
}
