import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inputs, Participant } from '../shared/schemas.js';
import { ApiError, canonical } from '../shared/protocol.js';

const hash = token => createHash('sha256').update(token).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
function fail(code, message, status = 409) { throw new ApiError(code, message, { status }); }

export function createIdentityStore(database, { bootId, now = () => new Date().toISOString(), id = randomUUID }) {
  if (typeof bootId !== 'string' || !bootId.trim()) throw new TypeError('A nonempty bootId is required.');
  const { db, transaction } = database;
  const hasSettings = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE name='hub_settings'").get());
  function getParticipant(participantId) {
    const row = db.prepare('SELECT * FROM participants WHERE id=?').get(participantId);
    if (!row) return null;
    const { workspace_json, ...publicFields } = row;
    return Participant.parse({ ...publicFields, workspace: workspace_json === null ? null : JSON.parse(workspace_json) });
  }
  function localOwner() {
    const saved = hasSettings && db.prepare("SELECT value FROM hub_settings WHERE key='local_owner'").get();
    if (saved) return saved.value;
    let owner = db.prepare('SELECT id FROM owners ORDER BY created_at, id LIMIT 1').get();
    if (!owner) {
      owner = { id: id() };
      db.prepare('INSERT INTO owners VALUES (?, ?, ?)').run(owner.id, 'Local owner', now());
    }
    if (hasSettings) db.prepare("INSERT OR IGNORE INTO hub_settings VALUES ('local_owner', ?)").run(owner.id);
    return owner.id;
  }
  function browserSession(ownerId, name = 'You') {
    return transaction(() => {
      ownerId ??= localOwner();
      const previous = db.prepare(`SELECT s.token_value, s.participant_id FROM browser_sessions s
        JOIN participants p ON p.id=s.participant_id WHERE p.owner_id=? AND p.kind='human' ORDER BY p.created_at,p.id LIMIT 1`).get(ownerId);
      if (previous) return { participant: getParticipant(previous.participant_id), token: previous.token_value };
      let participant = db.prepare("SELECT id FROM participants WHERE owner_id=? AND kind='human' ORDER BY created_at,id LIMIT 1").get(ownerId);
      if (!participant) {
        participant = { id: id() };
        db.prepare('INSERT INTO participants VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(participant.id, ownerId, 'human', name, null, null, '', now());
      }
      const token = secret();
      db.prepare('INSERT INTO browser_sessions VALUES (?, ?, ?)').run(hash(token), token, participant.id);
      return { participant: getParticipant(participant.id), token };
    });
  }
  function guestBrowserSession(name) {
    return transaction(() => {
      localOwner(); // Establish the host identity before adding other owners.
      const ownerId = id();
      db.prepare('INSERT INTO owners VALUES (?, ?, ?)').run(ownerId, name, now());
      return browserSession(ownerId, name);
    });
  }
  function assertCurrent(context) {
    const cached = context?.participant;
    if (!cached?.id) fail('UNAUTHENTICATED', 'Authentication is required.', 401);
    const participant = getParticipant(cached.id);
    if (!participant || cached.owner_id !== participant.owner_id || cached.kind !== participant.kind || context.kind !== participant.kind) {
      fail('UNAUTHENTICATED', 'Identity is no longer valid.', 401);
    }
    if (participant.kind === 'human') {
      if (context.connection_id !== null || context.generation !== 0) fail('UNAUTHENTICATED', 'Identity is no longer valid.', 401);
      return participant;
    }
    const binding = db.prepare('SELECT generation FROM agent_bindings WHERE participant_id=?').get(participant.id);
    const connection = typeof context.connection_id === 'string'
      ? db.prepare('SELECT * FROM connections WHERE id=? AND participant_id=?').get(context.connection_id, participant.id) : null;
    if (!binding || !connection || connection.generation !== context.generation) fail('UNAUTHENTICATED', 'Connection is not valid.', 401);
    if (binding.generation !== connection.generation) fail('SESSION_REPLACED', 'This connection was replaced.');
    if (connection.boot_id !== bootId || connection.closed_at !== null) fail('SESSION_EXPIRED', 'This connection has expired.', 401);
    return participant;
  }
  function agentContext(participant, connection) {
    return { participant, connection_id: connection.id, generation: connection.generation, kind: 'agent' };
  }
  function authenticate({ bearer, cookie } = {}) {
    return transaction(() => {
      let context;
      if (bearer !== undefined) {
        const connection = typeof bearer === 'string' && db.prepare('SELECT * FROM connections WHERE token_hash=?').get(hash(bearer));
        if (!connection) fail('UNAUTHENTICATED', 'Credential is not valid.', 401);
        context = agentContext(getParticipant(connection.participant_id), connection);
      } else {
        const session = typeof cookie === 'string' && db.prepare('SELECT participant_id FROM browser_sessions WHERE token_hash=?').get(hash(cookie));
        if (!session) fail('UNAUTHENTICATED', 'Credential is not valid.', 401);
        context = { participant: getParticipant(session.participant_id), connection_id: null, generation: 0, kind: 'human' };
      }
      context.participant = assertCurrent(context);
      return context;
    });
  }
  function agentSession(raw, { ownerId } = {}) {
    const parsed = Inputs.agentSession.safeParse(raw);
    if (!parsed.success) fail('VALIDATION_ERROR', 'Invalid agent session input.', 400);
    const { request_id, resume_token, invite_token: ignoredInvite, ...input } = parsed.data;
    const resumeHash = hash(resume_token);
    const payload = canonical(input);
    return transaction(() => {
      const previous = db.prepare('SELECT payload_json,result_json FROM session_requests WHERE resume_hash=? AND request_id=?').get(resumeHash, request_id);
      if (previous) {
        if (previous.payload_json !== payload) fail('IDEMPOTENCY_CONFLICT', 'Request ID already has different input.');
        const result = JSON.parse(previous.result_json);
        assertCurrent(agentContext(result.participant, result.connection));
        return result;
      }
      const binding = db.prepare('SELECT participant_id,generation FROM agent_bindings WHERE resume_hash=?').get(resumeHash);
      if (input.mode === 'create' && binding) fail('SESSION_EXISTS', 'This agent session already exists.');
      if (input.mode === 'resume' && !binding) fail('UNAUTHENTICATED', 'Agent session is not registered.', 401);
      const participantId = binding?.participant_id ?? id();
      const generation = (binding?.generation ?? 0) + 1;
      if (!Number.isSafeInteger(generation)) fail('SESSION_EXPIRED', 'Session generation is exhausted.', 401);
      const workspace = input.workspace === null ? null : canonical(input.workspace);
      if (binding) {
        db.prepare('UPDATE participants SET name=?,runtime=?,workspace_json=?,context=? WHERE id=?')
          .run(input.name, input.runtime, workspace, input.context, participantId);
        db.prepare('UPDATE agent_bindings SET generation=? WHERE participant_id=?').run(generation, participantId);
      } else {
        db.prepare('INSERT INTO participants VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(participantId, ownerId ?? localOwner(), 'agent', input.name, input.runtime, workspace, input.context, now());
        db.prepare('INSERT INTO agent_bindings VALUES (?, ?, ?)').run(participantId, resumeHash, generation);
      }
      const token = secret();
      const connection = { id: id(), generation };
      db.prepare('INSERT INTO connections VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(connection.id, participantId, generation, hash(token), bootId, now(), null);
      const result = { participant: getParticipant(participantId), connection, token };
      db.prepare('INSERT INTO session_requests VALUES (?, ?, ?, ?)').run(resumeHash, request_id, payload, canonical(result));
      return result;
    });
  }
  function disconnect(context) {
    return transaction(() => {
      const participant = assertCurrent(context);
      if (participant.kind === 'agent') db.prepare('UPDATE connections SET closed_at=? WHERE id=?').run(now(), context.connection_id);
      return { ok: true };
    });
  }
  return { browserSession, guestBrowserSession, localOwner, agentSession, authenticate, assertCurrent, disconnect, getParticipant };
}
