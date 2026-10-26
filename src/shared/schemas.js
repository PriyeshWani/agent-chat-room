import { z } from 'zod';
import { LIMITS, VERSION } from './protocol.js';

export const Id = z.string().min(1).max(128);
export const Sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const Timestamp = z.string().datetime();
export const Workspace = z.object({ path: z.string().min(1).max(4096), branch: z.string().max(256).optional() }).strict();
export const Participant = z.object({
  id: Id, owner_id: Id, kind: z.enum(['human', 'agent']), name: z.string().min(1).max(80),
  runtime: z.string().max(80).nullable(), workspace: Workspace.nullable(),
  context: z.string().max(2000), created_at: Timestamp,
}).strict();
export const Room = z.object({ id: Id, name: z.string().min(1).max(80), goal: z.string().max(500), created_at: Timestamp }).strict();
export const Membership = z.object({
  room_id: Id, participant_id: Id, epoch: Id, active: z.boolean(),
  joined_sequence: Sequence, acknowledged_sequence: Sequence, paused: z.boolean(),
}).strict();
export const Mention = Participant.pick({ id: true, name: true, kind: true });
export const RoomEvent = z.object({
  id: Id, room_id: Id, sequence: Sequence.min(1), kind: z.literal('message'),
  author: Participant.pick({ id: true, name: true, kind: true }),
  payload: z.object({ text: z.string().min(1).max(LIMITS.message), reply_to: Id.nullable(), mentions: z.array(Mention).max(20).optional() }).strict(),
  created_at: Timestamp,
}).strict();
function checkEvents(events, roomId, head, ctx) {
  let previous = 0;
  const ids = new Set();
  for (const event of events) {
    if (event.room_id !== roomId || event.sequence > head || event.sequence <= previous || ids.has(event.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Events must be unique, ordered, in this room, and within the scanned head.' });
    }
    previous = event.sequence; ids.add(event.id);
  }
}
export const History = z.object({ room: Room, events: z.array(RoomEvent).max(LIMITS.history), head_sequence: Sequence, next_before: Sequence.nullable() }).strict()
  .superRefine((value, ctx) => checkEvents(value.events, value.room.id, value.head_sequence, ctx));
export const JoinResult = z.object({ room: Room, membership: Membership, history: History }).strict().superRefine((value, ctx) => {
  if (value.room.id !== value.membership.room_id || value.room.id !== value.history.room.id
    || value.membership.joined_sequence > value.membership.acknowledged_sequence
    || value.membership.acknowledged_sequence > value.history.head_sequence) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Join membership/history must belong to the room and agree on progress.' });
  }
});
export const Batch = z.object({
  id: Id, room_id: Id, membership_epoch: Id, events: z.array(RoomEvent).max(LIMITS.batch), scanned_through: Sequence,
}).strict().superRefine((value, ctx) => checkEvents(value.events, value.room_id, value.scanned_through, ctx));
export const ReceiveResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('timeout'), room_id: Id, acknowledged_through: Sequence }).strict(),
  z.object({ kind: z.literal('batch'), batch: Batch }).strict(),
]);
export const AckResult = z.object({ room_id: Id, batch_id: Id, acknowledged_through: Sequence }).strict();
export const ParticipantStatus = z.object({
  participant: Participant, connection: z.enum(['connected', 'disconnected']),
  delivery: z.enum(['receiving', 'idle', 'paused']), pending_count: Sequence,
  activity: z.object({ text: z.string().max(500), reported_at: Timestamp }).nullable(), last_seen_at: Timestamp.nullable(),
}).strict();
export const Connection = z.object({ id: Id, generation: Sequence }).strict();
export const TaskStatus = z.enum(['proposed', 'in_progress', 'blocked', 'in_review', 'completed', 'cancelled']);
const TaskPerson = Participant.pick({ id: true, name: true, kind: true, workspace: true });
export const Task = z.object({
  id: Id, room_id: Id, title: z.string().min(1).max(200), scope: z.string().max(2000),
  status: TaskStatus, created_by: TaskPerson, owner: TaskPerson.nullable(),
  source_message_id: Id.nullable(), worker_ref: z.string().max(256).nullable(),
  latest_update: z.string().max(1000), result: z.string().max(2000), version: Sequence.min(1),
  created_at: Timestamp, updated_at: Timestamp,
}).strict();

const mutation = { request_id: Id };
const InviteToken = z.string().min(32).max(256);
export const Invitation = z.object({ id: Id, room_id: Id, kind: z.enum(['human', 'agent']),
  label: z.string().max(80), expires_at: Timestamp, revoked_at: Timestamp.nullable(), used: z.boolean(),
  inviter: Participant.pick({ id: true, name: true, kind: true }).optional(),
}).strict();
export const Inputs = {
  browserSession: z.object({}).strict(),
  joinBrowser: z.object({ ...mutation, invite_token: InviteToken, name: z.string().trim().min(1).max(80) }).strict(),
  createInvitation: z.object({ ...mutation, kind: z.enum(['human', 'agent']), label: z.string().trim().max(80).default(''),
    expires_in_minutes: z.number().int().min(1).max(1440).default(60),
  }).strict(),
  revokeInvitation: z.object({ ...mutation, invitation_id: Id }).strict(),
  emailInvitation: z.object({ ...mutation, email: z.string().trim().email().max(254),
    label: z.string().trim().max(80).default('') }).strict(),
  agentSession: z.object({
    ...mutation, mode: z.enum(['create', 'resume']), resume_token: z.string().min(32).max(256),
    name: z.string().trim().min(1).max(80), runtime: z.string().max(80).default('unknown'),
    workspace: Workspace.nullable().default(null), context: z.string().max(2000).default(''),
    invite_token: InviteToken.optional(),
  }).strict(),
  createRoom: z.object({ ...mutation, name: z.string().trim().min(1).max(80), goal: z.string().max(500).default('') }).strict(),
  joinRoom: z.object({ ...mutation }).strict(),
  leaveRoom: z.object({ ...mutation, membership_epoch: Id }).strict(),
  updateRoomGoal: z.object({ ...mutation, goal: z.string().trim().max(500) }).strict(),
  postMessage: z.object({ ...mutation, text: z.string().trim().min(1).max(LIMITS.message), reply_to: Id.nullable().default(null),
    mention_ids: z.array(Id).max(20).refine(ids => new Set(ids).size === ids.length, 'Mention IDs must be unique.').optional(),
  }).strict(),
  receive: z.object({ wait_ms: z.number().int().min(0).max(LIMITS.waitMs).default(LIMITS.waitMs), limit: z.number().int().min(1).max(LIMITS.batch).default(50) }).strict(),
  ack: z.object({ ...mutation, batch_id: Id, membership_epoch: Id }).strict(),
  heartbeat: z.object({ activity: z.string().max(500).optional() }).strict(),
  createTask: z.object({ ...mutation, title: z.string().trim().min(1).max(200),
    scope: z.string().trim().min(1).max(2000), source_message_id: Id.nullable().default(null),
  }).strict(),
  claimTask: z.object({ ...mutation, task_id: Id, expected_version: Sequence.min(1) }).strict(),
  updateTask: z.object({ ...mutation, task_id: Id, expected_version: Sequence.min(1),
    status: TaskStatus.exclude(['proposed']), latest_update: z.string().trim().min(1).max(1000),
    worker_ref: z.string().trim().min(1).max(256).nullable().optional(),
    result: z.string().trim().max(2000).optional(),
  }).strict(),
};

export const Outputs = {
  health: z.object({ status: z.literal('ok'), version: z.literal(VERSION) }).strict(),
  browserSession: z.object({ participant: Participant, access: z.object({
    mode: z.literal('lan'), public_url: z.string().url(), can_create_rooms: z.boolean(), can_invite_people: z.boolean(),
    email_enabled: z.boolean().optional(),
  }).strict().optional() }).strict(),
  createInvitation: z.object({ invitation: Invitation, token: InviteToken }).strict(),
  invitations: z.object({ invitations: z.array(Invitation) }).strict(),
  revokeInvitation: z.object({ invitation_id: Id, revoked: z.literal(true) }).strict(),
  emailInvitation: z.object({ invitation_id: Id, status: z.enum(['accepted', 'failed', 'unknown']),
    expires_at: Timestamp }).strict(),
  agentSession: z.object({ participant: Participant, connection: Connection, token: z.string().min(32) }).strict(),
  rooms: z.object({ rooms: z.array(Room) }).strict(),
  createRoom: Room,
  joinRoom: JoinResult,
  leaveRoom: z.object({ room_id: Id, left: z.literal(true) }).strict(),
  updateRoomGoal: z.object({ room: Room, event: RoomEvent.nullable() }).strict().superRefine((value, ctx) => {
    if (value.event && value.event.room_id !== value.room.id) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Goal announcement must belong to the room.' });
  }),
  history: History,
  postMessage: RoomEvent,
  receive: ReceiveResult,
  ack: AckResult,
  participants: z.object({ participants: z.array(ParticipantStatus) }).strict(),
  heartbeat: z.object({ ok: z.literal(true) }).strict(),
  tasks: z.object({ room_id: Id, tasks: z.array(Task) }).strict(),
  taskMutation: z.object({ task: Task, event: RoomEvent }).strict().superRefine((value, ctx) => {
    if (value.task.room_id !== value.event.room_id) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Task and milestone must belong to the same room.' });
  }),
};

export function parseInput(name, value) { return Inputs[name].parse(value); }
