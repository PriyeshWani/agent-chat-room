import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerRoomTools } from './tools/rooms.js';
import { participationGuidance } from '../runtime/participation.js';

export function createMcpServer({ client, connect, toolGroups = [registerRoomTools] }) {
  const server = new McpServer({ name: 'agent-chat-room', version: '0.1.0' }, { instructions: participationGuidance });
  const session = { roomId: null, membershipEpoch: null, participant: null };
  for (const register of toolGroups) register({ server, client, session, connect });
  return server;
}
