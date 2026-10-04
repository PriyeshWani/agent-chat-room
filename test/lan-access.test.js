import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHub } from '../src/hub/main.js';
import { RoomClient } from '../src/shared/client.js';
import { browserClient } from './helpers/browser-client.js';
import { lanBrowser, loopbackFetch } from './helpers/lan-client.js';
import { connectMcp, temporaryDirectory } from './helpers/processes.js';
import { Outputs } from '../src/shared/schemas.js';

const entry = fileURLToPath(new URL('../src/mcp/main.js', import.meta.url));
async function fixture(t, filename = ':memory:') {
  const hub = await createHub({ filename, lanHost: '192.168.50.10', host: '127.0.0.1' }); t.after(() => hub.close());
  const { client: host, participant } = await browserClient(hub.url);
  const room = await host.createRoom({ name: 'Shared' }), privateRoom = await host.createRoom({ name: 'Private' });
  return { hub, host, participant, room, privateRoom };
}
async function guest(s, name = 'Sam') {
  const invitation = await s.host.createInvitation(s.room.id, { kind: 'human', label: name });
  const client = lanBrowser(s.hub);
  const joined = await client.joinBrowser({ request_id: `join-${name}`, invite_token: invitation.token, name });
  await client.joinRoom(s.room.id);
  return { client, joined, invitation };
}
async function call(peer, tool, input = {}) {
  const result = await peer.call(tool, input); assert.ok(!result.isError, JSON.stringify(result.data)); return result.data;
}

test('LAN requires invitations and keeps distinct humans and room grants across browser sessions', async t => {
  const s = await fixture(t);
  const anonymous = lanBrowser(s.hub);
  await assert.rejects(anonymous.browserSession(), error => error.code === 'JOIN_REQUIRED');
  await assert.rejects(anonymous.listRooms(), error => error.code === 'UNAUTHENTICATED');
  const a = await guest(s, 'Sam'), b = await guest(s, 'Lee');
  assert.notEqual(a.joined.participant.id, b.joined.participant.id);
  assert.notEqual(a.joined.participant.owner_id, s.participant.owner_id);
  assert.deepEqual(await a.client.browserSession(), a.joined);
  assert.equal(a.joined.access.can_invite_people, false);
  assert.equal((await s.host.browserSession()).access.can_invite_people, true);
  assert.deepEqual((await a.client.listRooms()).rooms.map(room => room.id), [s.room.id]);
  for (const operation of [
    () => a.client.joinRoom(s.privateRoom.id), () => a.client.history(s.privateRoom.id),
    () => a.client.listTasks(s.privateRoom.id), () => a.client.listParticipants(s.privateRoom.id),
    () => a.client.postMessage(s.privateRoom.id, { text: 'No' }),
    () => a.client.createRoom({ name: 'Not host' }),
    () => a.client.createInvitation(s.room.id, { kind: 'human' }),
  ]) await assert.rejects(operation(), error => error.code === 'FORBIDDEN');
  const message = await a.client.postMessage(s.room.id, { text: 'A distinct human contribution' });
  assert.equal(message.author.id, a.joined.participant.id); assert.equal(message.author.name, 'Sam');
  assert.deepEqual((await b.client.history(s.room.id)).events, [message]);
  const people = (await s.host.listParticipants(s.room.id)).participants;
  assert.equal(people.filter(record => record.participant.kind === 'human').length, 3);
  const listed = await s.host.listInvitations(s.room.id); Outputs.invitations.parse(listed);
  assert.ok(!JSON.stringify(listed).includes(a.invitation.token));
});

test('one-use invitations distinguish retries from another redeemer and reject wrong kinds', async t => {
  const s = await fixture(t), a = lanBrowser(s.hub), b = lanBrowser(s.hub);
  const invitation = await s.host.createInvitation(s.room.id, { request_id: 'invite', kind: 'human' });
  assert.deepEqual(await s.host.createInvitation(s.room.id, { request_id: 'invite', kind: 'human' }), invitation);
  const input = { request_id: 'same-attempt', name: 'Sam', invite_token: invitation.token };
  const result = await a.joinBrowser(input);
  assert.deepEqual(await a.joinBrowser(input), result);
  await assert.rejects(b.joinBrowser({ ...input, request_id: 'different-attempt' }), error => error.code === 'INVITE_USED');
  await assert.rejects(a.joinBrowser({ ...input, name: 'Changed' }), error => error.code === 'INVITE_USED');
  const agent = await s.host.createInvitation(s.room.id, { kind: 'agent' });
  await assert.rejects(b.joinBrowser({ ...input, invite_token: agent.token }), error => error.code === 'INVITE_INVALID');
  await assert.rejects(b.joinBrowser({ ...input, invite_token: 'x'.repeat(43) }), error => error.code === 'INVITE_INVALID');
});

test('invited real MCP agent belongs to its human, has one-room access, and loses access when the human is revoked', { timeout: 15000 }, async t => {
  const s = await fixture(t); const g = await guest(s);
  const invitation = await g.client.createInvitation(s.room.id, { kind: 'agent', label: 'Review agent' });
  const peer = await connectMcp(t, entry, { env: { ROOM_HUB_URL: s.hub.url, ROOM_AGENT_NAME: 'Review agent', ROOM_INVITE_TOKEN: invitation.token, ROOM_WORKSPACE: process.cwd() } });
  const joined = await call(peer, 'join_room', { room_id: s.room.id });
  const participant = (await s.host.listParticipants(s.room.id)).participants.find(record => record.participant.id === joined.membership.participant_id).participant;
  assert.equal(participant.owner_id, g.joined.participant.owner_id);
  assert.deepEqual((await call(peer, 'list_rooms')).rooms.map(room => room.id), [s.room.id]);
  assert.equal((await peer.call('join_room', { room_id: s.privateRoom.id })).data.error.code, 'FORBIDDEN');
  const message = await g.client.postMessage(s.room.id, { text: 'Review this together.' });
  const batch = (await call(peer, 'receive_events', { wait_ms: 0 })).batch;
  assert.deepEqual(batch.events, [message]);
  await call(peer, 'ack_events', { request_id: 'ack', batch_id: batch.id });
  const waiting = peer.call('receive_events', { wait_ms: 10000 });
  const controller = new AbortController(); t.after(() => controller.abort());
  let opened;
  const ready = new Promise(resolve => { opened = resolve; });
  const stream = g.client.events(s.room.id, { after: message.sequence, signal: controller.signal, onOpen: opened });
  const ended = assert.rejects(stream.next());
  await ready;
  await s.host.revokeInvitation(s.room.id, { invitation_id: g.invitation.invitation.id });
  await ended;
  assert.equal((await waiting).data.error.code, 'FORBIDDEN');
  await assert.rejects(g.client.history(s.room.id), error => error.code === 'FORBIDDEN');
  assert.equal((await peer.call('post_message', { request_id: 'after-revoke', text: 'No access' })).data.error.code, 'FORBIDDEN');
  assert.equal((await s.host.listParticipants(s.room.id)).participants.length, 1);
  assert.equal((await s.host.history(s.room.id)).events.length, 1);
});

test('a person can join a second room without changing identity; renewed human access does not revive revoked agents', async t => {
  const s = await fixture(t), g = await guest(s);
  const secondInvite = await s.host.createInvitation(s.privateRoom.id, { kind: 'human' });
  const next = await g.client.joinBrowser({ invite_token: secondInvite.token, name: 'Sam' });
  assert.equal(next.participant.id, g.joined.participant.id);
  assert.equal((await g.client.listRooms()).rooms.length, 2);
  const agentInvite = await g.client.createInvitation(s.room.id, { kind: 'agent' });
  const client = new RoomClient({ baseUrl: s.hub.url });
  const input = { mode: 'create', resume_token: 'renewed-test'.repeat(5), name: 'Agent', invite_token: agentInvite.token };
  await client.agentSession(input); await client.joinRoom(s.room.id);
  await s.host.revokeInvitation(s.room.id, { invitation_id: g.invitation.invitation.id });
  const renewed = await s.host.createInvitation(s.room.id, { kind: 'human' });
  await g.client.joinBrowser({ invite_token: renewed.token, name: 'Sam' });
  assert.equal((await g.client.listRooms()).rooms.length, 2);
  await assert.rejects(client.agentSession({ ...input, mode: 'resume', invite_token: undefined }), error => error.code === 'FORBIDDEN');
});

test('LAN-facing enrollment cannot acquire host identity through headers or by omitting an agent invitation', async t => {
  const s = await fixture(t);
  const publicHost = new URL(s.hub.publicUrl).host;
  const request = (path, body, extra = {}) => loopbackFetch(`${s.hub.url}/api/v1/${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Host: publicHost, Origin: s.hub.publicUrl, ...extra }, body: JSON.stringify(body) });
  const browser = await request('sessions/browser', {}, { 'X-Forwarded-For': '127.0.0.1' });
  assert.equal(browser.status, 401); assert.equal((await browser.json()).error.code, 'JOIN_REQUIRED');
  const agent = await request('sessions/agent', { request_id: 'attempt', mode: 'create', resume_token: 'synthetic'.repeat(8), name: 'No invite' });
  assert.equal(agent.status, 401); assert.equal((await agent.json()).error.code, 'INVITE_REQUIRED');
  const mismatch = await request('sessions/browser', {}, { Origin: s.hub.url });
  assert.equal(mismatch.status, 403);
  const foreign = await request('sessions/browser', {}, { Host: 'unlisted.example', Origin: 'http://unlisted.example' });
  assert.equal(foreign.status, 403);
  const hosted = await s.host.createInvitation(s.room.id, { kind: 'agent' });
  const scoped = new RoomClient({ baseUrl: s.hub.url });
  await scoped.agentSession({ mode: 'create', resume_token: 'host-agent-scope'.repeat(4), name: 'Host remote agent', invite_token: hosted.token });
  await assert.rejects(scoped.joinRoom(s.privateRoom.id), error => error.code === 'FORBIDDEN');
  await scoped.joinRoom(s.room.id);
  await assert.rejects(scoped.createInvitation(s.room.id, { kind: 'agent' }), error => error.code === 'FORBIDDEN');
});

test('LAN grants and human identities persist after hub restart, while host identity remains stable', async t => {
  const filename = join(await temporaryDirectory(t), 'lan.sqlite');
  const s = await fixture(t, filename), g = await guest(s);
  await s.hub.close();
  const restarted = await createHub({ filename, port: new URL(s.hub.url).port * 1, lanHost: '192.168.50.10', host: '127.0.0.1' });
  t.after(() => restarted.close());
  assert.deepEqual(await g.client.browserSession(), g.joined);
  assert.deepEqual((await g.client.listRooms()).rooms.map(room => room.id), [s.room.id]);
  assert.equal((await s.host.browserSession()).participant.id, s.participant.id);
  await s.host.revokeInvitation(s.room.id, { invitation_id: g.invitation.invitation.id });
  assert.deepEqual((await g.client.listRooms()).rooms, []);
});
