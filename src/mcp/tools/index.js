import { registerRoomTools } from './rooms.js';
import { registerDeliveryTools } from './delivery.js';
import { registerMessageTools } from './messages.js';
import { registerTaskTools } from './tasks.js';

export const toolGroups = [registerRoomTools, registerDeliveryTools, registerMessageTools, registerTaskTools];
