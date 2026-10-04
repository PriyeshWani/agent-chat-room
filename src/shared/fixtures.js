// Explicit synthetic records for contract tests; never loaded by the live hub.
export const createdAt = '2026-09-27T12:00:00.000Z';
export const human = { id: 'human-local', owner_id: 'owner-local', kind: 'human', name: 'You', runtime: null, workspace: null, context: '', created_at: createdAt };
export const agent = { id: 'agent-api', owner_id: 'owner-local', kind: 'agent', name: 'API agent', runtime: 'Codex', workspace: { path: '/sample/api' }, context: 'Sample API context', created_at: createdAt };
export const peer = { ...agent, id: 'agent-review', name: 'Review agent', workspace: { path: '/sample/review' } };
export const room = { id: 'room-design', name: 'cache-design', goal: 'Compare cache strategies', created_at: createdAt };
export const otherRoom = { ...room, id: 'room-general', name: 'general', goal: '' };
export const event = { id: 'event-1', room_id: room.id, sequence: 1, kind: 'message', author: { id: human.id, name: human.name, kind: human.kind }, payload: { text: 'Could these requests race?', reply_to: null }, created_at: createdAt };
export const membership = { room_id: room.id, participant_id: agent.id, epoch: 'membership-1', active: true, joined_sequence: 1, acknowledged_sequence: 1, paused: false };
export const beforeBatchMembership = { ...membership, joined_sequence: 0, acknowledged_sequence: 0 };
export const history = { room, events: [event], head_sequence: 1, next_before: null };
export const batch = { id: 'batch-1', room_id: room.id, membership_epoch: membership.epoch, events: [event], scanned_through: 1 };
export const status = { participant: agent, connection: 'connected', delivery: 'idle', pending_count: 0, activity: null, last_seen_at: createdAt };
export const token = 'fixture-only-token-never-a-live-credential';
