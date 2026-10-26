#!/usr/bin/env node
import { resolve } from 'node:path';
import { createHub } from '../src/hub/main.js';
import { createEmailSender } from '../src/hub/invitation-email.js';

try {
  const configuredPort = process.env.ROOM_HUB_PORT ?? '8787';
  if (!/^(0|[1-9]\d*)$/.test(configuredPort) || Number(configuredPort) > 65535) {
    throw new Error('Invalid ROOM_HUB_PORT.');
  }
  const filename = resolve(process.env.ROOM_HUB_DATA ?? '.agent-chat-room/hub.sqlite');
  const lanHost = process.env.ROOM_HUB_LAN_HOST ?? null;
  const externalUrl = process.env.ROOM_HUB_PUBLIC_URL ?? null;
  const hub = await createHub({ filename, port: Number(configuredPort), lanHost, externalUrl, emailSender: createEmailSender() });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await hub.close(); }
    catch { process.stderr.write('Room hub shutdown failed.\n'); process.exitCode = 1; }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stdout.write(`ROOM_HUB_READY ${hub.url}\n`);
  if (lanHost) process.stdout.write(`ROOM_HUB_LAN ${hub.publicUrl}\n`);
  if (externalUrl) process.stdout.write(`ROOM_HUB_PUBLIC ${hub.publicUrl}\n`);
} catch {
  process.stderr.write('Room hub failed to start. Check its port and data path.\n');
  process.exitCode = 1;
}
