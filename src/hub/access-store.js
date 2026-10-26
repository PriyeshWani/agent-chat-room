import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inputs } from '../shared/schemas.js';
import { ApiError, canonical } from '../shared/protocol.js';
import { createMutationStore } from './mutation-store.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const denied = () => { throw new ApiError('FORBIDDEN', 'Room access is not permitted.', { status: 403 }); };
const invalidInvite = () => { throw new ApiError('INVITE_INVALID', 'This invitation is invalid, expired, or revoked.', { status: 403 }); };
const publicInvite = row => ({ id: row.id, room_id: row.room_id, kind: row.kind, label: row.label,
  expires_at: row.expires_at, revoked_at: row.revoked_at, used: row.used_key !== null });

export function createAccessStore(database, { identity, now = () => new Date().toISOString(), onChange = () => {} }) {
  const { db, transaction } = database;
  const journal = createMutationStore(database);
  const localOwner = identity.localOwner();
  function describe(row) {
    const { id, name, kind } = identity.getParticipant(row.created_by);
    return { ...publicInvite(row), inviter: { id, name, kind } };
  }
  const scope = participant => db.prepare('SELECT * FROM agent_scopes WHERE participant_id=?').get(participant.id);
  const isHost = participant => participant.owner_id === localOwner && !scope(participant);
  function ownerAllowed(ownerId, roomId) {
    return ownerId === localOwner || Boolean(db.prepare(`SELECT 1 FROM room_access a JOIN invitations i ON i.id=a.invitation_id
      WHERE a.owner_id=? AND a.room_id=? AND i.revoked_at IS NULL`).get(ownerId, roomId));
  }
  function canAccess(participant, roomId) {
    const restriction = scope(participant);
    if (restriction) {
      if (restriction.room_id !== roomId || db.prepare('SELECT revoked_at FROM invitations WHERE id=?').get(restriction.invitation_id)?.revoked_at) return false;
    } else if (participant.kind === 'agent' && participant.owner_id !== localOwner) return false;
    return ownerAllowed(participant.owner_id, roomId);
  }
  function authorize(participant, roomId) { if (roomId && !canAccess(participant, roomId)) denied(); }
  function human(context, roomId) {
    const participant = identity.assertCurrent(context);
    if (participant.kind !== 'human') denied();
    authorize(participant, roomId);
    return participant;
  }
  function create(context, roomId, raw) {
    const input = Inputs.createInvitation.parse(raw);
    return transaction(() => {
      const participant = human(context, roomId);
      const key = { participantId: participant.id, requestId: input.request_id, operation: 'createInvitation', roomId, payload: input };
      const previous = journal.lookup(key); if (previous.found) return previous.result;
      const token = randomBytes(32).toString('base64url'), id = randomUUID();
      const expires = new Date(Date.parse(now()) + input.expires_in_minutes * 60000).toISOString();
      db.prepare(`INSERT INTO invitations(id,token_hash,room_id,owner_id,created_by,kind,label,expires_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id, hash(token), roomId, participant.owner_id, participant.id, input.kind, input.label, expires, now());
      const result = { invitation: describe(db.prepare('SELECT * FROM invitations WHERE id=?').get(id)), token };
      journal.record(key, result); return result;
    });
  }
  function list(context, roomId) {
    return transaction(() => {
      const participant = human(context, roomId);
      return { invitations: db.prepare('SELECT * FROM invitations WHERE room_id=? ORDER BY created_at DESC,id').all(roomId)
        .filter(invite => isHost(participant) || invite.owner_id === participant.owner_id).map(describe) };
    });
  }
  function revoke(context, roomId, raw) {
    const input = Inputs.revokeInvitation.parse(raw);
    const result = transaction(() => {
      const participant = human(context, roomId);
      const key = { participantId: participant.id, requestId: input.request_id, operation: 'revokeInvitation', roomId, payload: input };
      const previous = journal.lookup(key); if (previous.found) return previous.result;
      const invite = db.prepare('SELECT * FROM invitations WHERE id=? AND room_id=?').get(input.invitation_id, roomId);
      if (!invite || !(isHost(participant) || invite.owner_id === participant.owner_id)) denied();
      db.prepare('UPDATE invitations SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(now(), invite.id);
      if (invite.kind === 'human') db.prepare(`UPDATE invitations SET revoked_at=COALESCE(revoked_at,?)
        WHERE (kind='agent' OR used_key IS NULL) AND room_id=? AND owner_id IN (SELECT owner_id FROM room_access WHERE invitation_id=?)`)
        .run(now(), roomId, invite.id);
      const output = { invitation_id: invite.id, revoked: true }; journal.record(key, output); return output;
    });
    // Room waiters/streams recheck authorization on this post-commit hint.
    try { onChange(roomId); } catch { /* Access checks remain authoritative. */ }
    return result;
  }
  function invitation(token, kind) {
    const row = db.prepare('SELECT * FROM invitations WHERE token_hash=? AND kind=?').get(hash(token), kind);
    if (!row || row.revoked_at || (!row.used_key && row.expires_at <= now()) || !ownerAllowed(row.owner_id, row.room_id)) invalidInvite();
    return row;
  }
  function joinBrowser(raw, existing = null) {
    const input = Inputs.joinBrowser.parse(raw);
    return transaction(() => {
      const invite = invitation(input.invite_token, 'human');
      const payload = canonical({ name: input.name });
      if (invite.used_key) {
        if (invite.used_key !== input.request_id || invite.used_payload !== payload) throw new ApiError('INVITE_USED', 'This invitation was already used. Ask the host for another.', { status: 409 });
        const result = JSON.parse(invite.result_json);
        if (existing && existing.owner_id !== result.participant.owner_id) denied();
        return result;
      }
      const result = existing ? identity.browserSession(existing.owner_id, existing.name) : identity.guestBrowserSession(input.name);
      db.prepare(`INSERT INTO room_access VALUES (?,?,?) ON CONFLICT(owner_id,room_id)
        DO UPDATE SET invitation_id=excluded.invitation_id`).run(result.participant.owner_id, invite.room_id, invite.id);
      db.prepare('UPDATE invitations SET used_key=?,used_payload=?,result_json=? WHERE id=?')
        .run(input.request_id, payload, JSON.stringify(result), invite.id);
      return result;
    });
  }
  function agentSession(raw, trustedLocal) {
    const input = Inputs.agentSession.parse(raw);
    return transaction(() => {
      let invite;
      if (input.mode === 'create') {
        if (input.invite_token) {
          invite = invitation(input.invite_token, 'agent');
          if (invite.used_key && invite.used_key !== hash(input.resume_token)) throw new ApiError('INVITE_USED', 'This agent invitation was already used.', { status: 409 });
        } else if (!trustedLocal) throw new ApiError('INVITE_REQUIRED', 'An agent invitation is required for a new LAN session.', { status: 401 });
      }
      const result = identity.agentSession(input, { ownerId: invite?.owner_id });
      if (invite) {
        const previousScope = scope(result.participant);
        if (result.participant.owner_id !== invite.owner_id || (previousScope && previousScope.invitation_id !== invite.id)) denied();
        db.prepare('INSERT OR IGNORE INTO agent_scopes VALUES (?,?,?)').run(result.participant.id, invite.room_id, invite.id);
        db.prepare('UPDATE invitations SET used_key=? WHERE id=?').run(hash(input.resume_token), invite.id);
      }
      const restriction = scope(result.participant);
      if (restriction && !canAccess(result.participant, restriction.room_id)) denied();
      return result;
    });
  }
  return { isHost, canAccess, authorize, requireHuman: human, create, list, revoke, joinBrowser, agentSession };
}
