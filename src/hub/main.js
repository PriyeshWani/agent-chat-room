import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { openDatabase } from './db.js';
import { createIdentityStore } from './identity-store.js';
import { createAccessStore } from './access-store.js';
import { createRoomStore } from './room-store.js';
import { createEventStore } from './event-store.js';
import { createTaskStore } from './task-store.js';
import { createDeliveryStore } from './delivery-store.js';
import { createDeliveryService } from './delivery-service.js';
import { createPresenceService } from './presence-service.js';
import { createBrowserStream } from './browser-stream.js';
import { createLocalSession } from './local-session.js';
import { createHttpServer } from './http-server.js';
import { createStaticAssets } from './static-assets.js';
import { createRoutes } from './routes/index.js';
import { createInvitationEmail } from './invitation-email.js';

export async function createHub({ filename, port = 0, lanHost = null, externalUrl = null, emailSender = null, host = lanHost ? '0.0.0.0' : '127.0.0.1', bootId = randomUUID() }) {
  const changes = new EventEmitter();
  // Each active room wait/stream owns listeners and removes them on completion.
  changes.setMaxListeners(0);
  let database, deliveryService, presence, browserStream, http, closing, invitationEmail;
  function close() {
    if (!closing) closing = (async () => {
      const httpClosed = http?.close();
      try {
        deliveryService?.close();
        browserStream?.close();
        presence?.close();
        await httpClosed;
        await invitationEmail?.close();
      } finally {
        database?.close();
        changes.removeAllListeners();
      }
    })();
    return closing;
  }
  try {
    database = await openDatabase({ filename });
    const identity = createIdentityStore(database, { bootId });
    const access = lanHost || externalUrl ? createAccessStore(database, { identity, onChange: roomId => changes.emit('room', roomId) }) : null;
    const rooms = createRoomStore(database, { identity, access });
    const events = createEventStore(database, { identity, rooms, onChange: roomId => changes.emit('room', roomId) });
    const tasks = createTaskStore(database, { identity, rooms, events, onChange: roomId => changes.emit('room', roomId) });
    const delivery = createDeliveryStore(database, { identity, rooms, events });
    deliveryService = createDeliveryService({ delivery, rooms, identity, changes });
    presence = createPresenceService({ identity, rooms, events, deliveryService });
    browserStream = createBrowserStream({ events, rooms, identity, changes });
    invitationEmail = access ? createInvitationEmail({ database, access, rooms, publicUrl: () => http.publicUrl, sender: emailSender }) : null;
    const sessions = createLocalSession({ identity, presence, changes, access, publicUrl: () => http.publicUrl,
      emailEnabled: Boolean(emailSender && externalUrl) });
    const handlers = createRoutes({ sessions, rooms, events, tasks, access, invitationEmail, deliveryService, presence, browserStream, changes });
    http = await createHttpServer({ port, host, lanHost, externalUrl, handlers, assets: createStaticAssets() });
    return { url: http.url, publicUrl: http.publicUrl, close };
  } catch (error) {
    await close();
    throw error;
  }
}
