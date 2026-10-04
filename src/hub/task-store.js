import { randomUUID } from 'node:crypto';
import { Inputs } from '../shared/schemas.js';
import { ApiError } from '../shared/protocol.js';
import { createMutationStore } from './mutation-store.js';

const labels = { proposed: 'Proposed', in_progress: 'In progress', blocked: 'Blocked', in_review: 'Ready for review', completed: 'Completed', cancelled: 'Cancelled' };
const transitions = {
  in_progress: ['in_progress', 'blocked', 'in_review', 'completed', 'cancelled'],
  blocked: ['blocked', 'in_progress', 'cancelled'],
  in_review: ['in_review', 'in_progress', 'blocked', 'completed', 'cancelled'],
  completed: [], cancelled: [],
};
function fail(code, message, status = 409) { throw new ApiError(code, message, { status }); }

export function createTaskStore(database, { identity, rooms, events, onChange = () => {} }) {
  const { db, transaction } = database;
  const journal = createMutationStore(database);
  function person(id) {
    if (!id) return null;
    const row = db.prepare('SELECT id,name,kind,workspace_json FROM participants WHERE id=?').get(id);
    return { id: row.id, name: row.name, kind: row.kind, workspace: JSON.parse(row.workspace_json ?? 'null') };
  }
  function task(row) {
    const { owner_id, created_by, ...fields } = row;
    return { ...fields, owner: person(owner_id), created_by: person(created_by) };
  }
  function get(roomId, id) {
    const row = db.prepare('SELECT * FROM tasks WHERE room_id=? AND id=?').get(roomId, id);
    if (!row) fail('TASK_NOT_FOUND', 'This task does not exist in the active room.', 404);
    return row;
  }
  function list(context, roomId) {
    return transaction(() => {
      rooms.requireMembership(context, roomId);
      return { room_id: roomId, tasks: db.prepare(`SELECT * FROM tasks WHERE room_id=?
        ORDER BY CASE WHEN status IN ('completed','cancelled') THEN 1 ELSE 0 END, updated_at DESC, id`).all(roomId).map(task) };
    });
  }
  function mutate(operation, context, roomId, raw) {
    const parsed = Inputs[operation].safeParse(raw);
    if (!parsed.success) fail('VALIDATION_ERROR', 'Invalid task input.', 400);
    const { request_id, ...input } = parsed.data;
    let changed = false;
    const result = transaction(() => {
      rooms.requireMembership(context, roomId);
      const actor = identity.assertCurrent(context);
      const key = { participantId: actor.id, requestId: request_id, operation, roomId, payload: input };
      const previous = journal.lookup(key);
      if (previous.found) return previous.result;
      const now = new Date().toISOString();
      let row;
      if (operation === 'createTask') {
        if (input.source_message_id && !db.prepare('SELECT id FROM events WHERE room_id=? AND id=?').get(roomId, input.source_message_id)) {
          fail('VALIDATION_ERROR', 'The source message must belong to this room.', 400);
        }
        const id = randomUUID();
        db.prepare(`INSERT INTO tasks (id,room_id,title,scope,status,created_by,owner_id,source_message_id,
          worker_ref,latest_update,result,version,created_at,updated_at) VALUES (?,?,?,?, 'proposed',?,NULL,?,NULL,'','',1,?,?)`)
          .run(id, roomId, input.title, input.scope, actor.id, input.source_message_id, now, now);
        row = get(roomId, id);
      } else {
        row = get(roomId, input.task_id);
        if (operation === 'claimTask' && (row.owner_id || row.status !== 'proposed')) {
          fail('TASK_CLAIMED', 'This task is already owned. Read list_tasks and coordinate with its owner.');
        }
        if (operation === 'updateTask' && row.owner_id !== actor.id) {
          fail('TASK_NOT_OWNER', 'Only the task owner can report its work. Discuss changes with the owner.', 403);
        }
        if (row.version !== input.expected_version) fail('TASK_CONFLICT', 'The task has changed. Read list_tasks before updating it.');
        if (!Number.isSafeInteger(row.version + 1)) fail('TASK_CONFLICT', 'Task revision is exhausted.');
        if (operation === 'claimTask') {
          db.prepare("UPDATE tasks SET owner_id=?,status='in_progress',latest_update=?,version=version+1,updated_at=? WHERE id=?")
            .run(actor.id, 'Claimed; preparing to start.', now, row.id);
        } else {
          if (!transitions[row.status]?.includes(input.status)) fail('TASK_TRANSITION', 'This status change is not allowed. Completed and cancelled tasks are final.');
          const result = input.result ?? row.result;
          if (['in_review', 'completed'].includes(input.status) && !result.trim()) {
            fail('VALIDATION_ERROR', 'Include results and checks before reporting review readiness or completion.', 400);
          }
          db.prepare('UPDATE tasks SET status=?,latest_update=?,worker_ref=?,result=?,version=version+1,updated_at=? WHERE id=?')
            .run(input.status, input.latest_update, input.worker_ref === undefined ? row.worker_ref : input.worker_ref, result, now, row.id);
        }
        row = get(roomId, row.id);
      }
      const current = task(row);
      // Ordinary room messages keep existing clients compatible and give every
      // peer durable, acknowledged task milestones without a second event feed.
      const text = `Task ${labels[row.status].toLowerCase()}: ${row.title}\n${row.owner_id ? `Owner: ${actor.name}. ` : ''}Task ID: ${row.id}\n${operation === 'createTask' ? row.scope : row.latest_update}${row.result ? `\nResult: ${row.result}` : ''}`;
      const event = events.post(context, roomId, { request_id: randomUUID(), text, reply_to: row.source_message_id }, { notify: false });
      const outcome = { task: current, event };
      journal.record(key, outcome);
      changed = true;
      return outcome;
    });
    // Notify only after both the task and its milestone have committed.
    if (changed) { try { Promise.resolve(onChange(roomId)).catch(() => {}); } catch { /* Durable log remains authoritative. */ } }
    return result;
  }
  return { list, create: (context, roomId, input) => mutate('createTask', context, roomId, input),
    claim: (context, roomId, input) => mutate('claimTask', context, roomId, input),
    update: (context, roomId, input) => mutate('updateTask', context, roomId, input) };
}
