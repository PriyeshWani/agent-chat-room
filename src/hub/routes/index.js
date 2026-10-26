import { createSessionRoutes } from './session.js';
import { createRoomRoutes } from './rooms.js';
import { createMessageRoutes } from './messages.js';
import { createDeliveryRoutes } from './delivery.js';
import { createPresenceRoutes } from './presence.js';
import { createStreamRoutes } from './stream.js';
import { createTaskRoutes } from './tasks.js';
import { createInvitationRoutes } from './invitations.js';

export function createRoutes({ sessions, rooms, events, tasks, access, invitationEmail, deliveryService, presence, browserStream, changes }) {
  return [
    createSessionRoutes({ sessions }),
    createRoomRoutes({ sessions, rooms, events, onChange: roomId => changes.emit('room', roomId) }),
    createMessageRoutes({ sessions, events }),
    createTaskRoutes({ sessions, tasks }),
    createInvitationRoutes({ sessions, rooms, access, invitationEmail }),
    createDeliveryRoutes({ sessions, deliveryService }),
    createPresenceRoutes({ sessions, presence }),
    createStreamRoutes({ sessions, browserStream, events }),
  ];
}
