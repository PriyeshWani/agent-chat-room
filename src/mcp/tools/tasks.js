import { z } from 'zod';
import { Inputs, Outputs } from '../../shared/schemas.js';
import { ApiError } from '../../shared/protocol.js';

const jsonResult = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

export function registerTaskTools({ server, client, session }) {
  const tools = [
    ['list_tasks', 'listTasks', z.object({}).strict(), 'tasks', 'Read the shared task board before starting work. Coordinate with owners instead of duplicating tasks. Tasks are reported by agents, not automatically observed terminal activity.'],
    ['create_task', 'createTask', Inputs.createTask, 'taskMutation', 'Propose a bounded task with scope and optional originating message. Check list_tasks for overlap first. Creates a visible room milestone; do not repeat it in chat. Claim before starting. Reuse request_id and inputs on retry.'],
    ['claim_task', 'claimTask', Inputs.claimTask, 'taskMutation', 'Atomically take ownership of an unclaimed task using its current version. Only start work after a confirmed claim. On contention read list_tasks and help the owner or take complementary work. Publishes a room milestone. Reuse request_id on retry.'],
    ['update_task', 'updateTask', Inputs.updateTask, 'taskMutation', 'Report your owned task using its current version. Include latest_update, actual worker_ref when delegated, blockers, and results/checks for in_review or completed. Publishes a milestone; avoid duplicate chat updates. Completion is an owner report, not peer acceptance. Only report cancelled once work has stopped. Reuse request_id and inputs on retry.'],
  ];
  for (const [name, method, inputSchema, output, description] of tools) {
    server.registerTool(name, { description, inputSchema }, async (input, { signal }) => {
      try {
        const roomId = session.roomId;
        if (!roomId || !session.membershipEpoch) throw new ApiError('MEMBERSHIP_ENDED', 'Join a room before using this tool.', { status: 409 });
        signal.throwIfAborted();
        const raw = method === 'listTasks' ? await client[method](roomId, { signal }) : await client[method](roomId, input, { signal });
        const parsed = Outputs[output].safeParse(raw);
        if (!parsed.success || (output === 'tasks' ? parsed.data.room_id !== roomId || parsed.data.tasks.some(task => task.room_id !== roomId)
          : parsed.data.task.room_id !== roomId || (input.task_id && parsed.data.task.id !== input.task_id))) {
          throw new ApiError('INVALID_RESPONSE', 'The hub returned an invalid task result.');
        }
        return jsonResult(parsed.data);
      } catch (error) {
        const publicError = error instanceof ApiError
          ? { code: error.code, message: error.message, retryable: error.retryable === true }
          : signal.aborted
            ? { code: 'CANCELLED', message: 'The tool request was cancelled.', retryable: false }
            : { code: 'INTERNAL_ERROR', message: 'The tool could not complete this request.', retryable: false };
        return { ...jsonResult({ error: publicError }), isError: true };
      }
    });
  }
}
