import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';
import { createHub } from '../src/hub/main.js';
import { createEmailSender } from '../src/hub/invitation-email.js';
import { RoomClient } from '../src/shared/client.js';
import { browserClient } from './helpers/browser-client.js';
import { lanBrowser } from './helpers/lan-client.js';
import { temporaryDirectory } from './helpers/processes.js';
import { openDatabase } from '../src/hub/db.js';
import { mountChatroom } from '../public/chatroom/app.js';

async function fixture(t, emailSender = null, filename = ':memory:') {
  const hub = await createHub({ filename, externalUrl: 'https://fixture.trycloudflare.com', emailSender });
  t.after(() => hub.close());
  const { client: host } = await browserClient(hub.url);
  const room = await host.createRoom({ name: 'Team' });
  await host.joinRoom(room.id);
  const invite = await host.createInvitation(room.id, { kind: 'human' });
  const member = lanBrowser(hub);
  const identity = await member.joinBrowser({ name: 'Member', invite_token: invite.token });
  await member.joinRoom(room.id);
  return { hub, host, room, member, identity, invite };
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise(setImmediate);
  assert.ok(predicate(), 'UI did not settle');
}
const html = readFileSync(new URL('../public/chatroom/index.html', import.meta.url), 'utf8');

test('members invite people with attribution; revocation cancels unused invites but preserves joined teammates and their agents', async t => {
  const s = await fixture(t);
  assert.equal(s.identity.access.can_invite_people, true);
  const joinedInvite = await s.member.createInvitation(s.room.id, { kind: 'human', label: 'Child' });
  assert.equal(joinedInvite.invitation.inviter.name, 'Member');
  const child = lanBrowser(s.hub);
  await child.joinBrowser({ name: 'Child', invite_token: joinedInvite.token }); await child.joinRoom(s.room.id);
  const unused = await s.member.createInvitation(s.room.id, { kind: 'human' });
  const ownAgentInvite = await s.member.createInvitation(s.room.id, { kind: 'agent' });
  const childAgentInvite = await child.createInvitation(s.room.id, { kind: 'agent' });
  const ownAgent = new RoomClient({ baseUrl: s.hub.url });
  await ownAgent.agentSession({ mode: 'create', name: 'Member agent', resume_token: 'member'.repeat(10), invite_token: ownAgentInvite.token });
  await ownAgent.joinRoom(s.room.id);
  const childAgent = new RoomClient({ baseUrl: s.hub.url });
  await childAgent.agentSession({ mode: 'create', name: 'Child agent', resume_token: 'child'.repeat(10), invite_token: childAgentInvite.token });
  await childAgent.joinRoom(s.room.id);
  const privateRoom = await s.host.createRoom({ name: 'Private' });
  await assert.rejects(s.member.createInvitation(privateRoom.id, { kind: 'human' }), e => e.code === 'FORBIDDEN');
  await s.host.revokeInvitation(s.room.id, { invitation_id: s.invite.invitation.id });
  await assert.rejects(s.member.history(s.room.id), e => e.code === 'FORBIDDEN');
  await assert.rejects(ownAgent.history(s.room.id), e => e.code === 'FORBIDDEN');
  await assert.rejects(lanBrowser(s.hub).joinBrowser({ name: 'Late', invite_token: unused.token }), e => e.code === 'INVITE_INVALID');
  await child.history(s.room.id); await childAgent.history(s.room.id);
  assert.equal((await s.host.listInvitations(s.room.id)).invitations.find(i => i.id === joinedInvite.invitation.id).inviter.name, 'Member');
  await s.host.revokeInvitation(s.room.id, { invitation_id: joinedInvite.invitation.id });
  await assert.rejects(child.history(s.room.id), e => e.code === 'FORBIDDEN');
  await assert.rejects(childAgent.history(s.room.id), e => e.code === 'FORBIDDEN');
});

test('email is disabled without configuration and creates no invitation; malformed and unauthorized requests never send', async t => {
  const s = await fixture(t);
  const before = (await s.host.listInvitations(s.room.id)).invitations.length;
  await assert.rejects(s.member.emailInvitation(s.room.id, { email: 'test@example.com' }), e => e.code === 'EMAIL_NOT_CONFIGURED');
  assert.equal((await s.host.listInvitations(s.room.id)).invitations.length, before);
  assert.equal((await s.member.browserSession()).access.email_enabled, false);
  let sends = 0;
  const enabled = await fixture(t, { send: async () => { sends++; return { status: 'accepted' }; } });
  await assert.rejects(enabled.member.emailInvitation(enabled.room.id, { email: 'a@example.com\r\nBcc:other@example.com' }), e => e.code === 'VALIDATION_ERROR');
  const privateRoom = await enabled.host.createRoom({ name: 'Private' });
  await assert.rejects(enabled.member.emailInvitation(privateRoom.id, { email: 'a@example.com' }), e => e.code === 'FORBIDDEN');
  await assert.rejects(lanBrowser(enabled.hub).emailInvitation(enabled.room.id, { email: 'a@example.com' }), e => e.code === 'UNAUTHENTICATED');
  const code = await enabled.member.createInvitation(enabled.room.id, { kind: 'agent' });
  const agent = new RoomClient({ baseUrl: enabled.hub.url });
  await agent.agentSession({ mode: 'create', name: 'Agent', resume_token: 'secret'.repeat(10), invite_token: code.token });
  await agent.joinRoom(enabled.room.id);
  await assert.rejects(agent.emailInvitation(enabled.room.id, { email: 'a@example.com' }), e => e.code === 'FORBIDDEN');
  assert.equal(sends, 0);
});

test('concurrent and repeated email requests create one invitation and one provider submission; recipient can redeem it', async t => {
  let release, calls = [];
  const sender = { send: async (message, key) => { calls.push({ message, key }); await new Promise(resolve => { release = resolve; }); return { status: 'accepted' }; } };
  const s = await fixture(t, sender);
  const before = (await s.host.listInvitations(s.room.id)).invitations.length;
  const input = { request_id: 'same-email', email: 'recipient@example.com', label: 'Recipient' };
  const a = s.member.emailInvitation(s.room.id, input);
  await until(() => Boolean(release));
  const b = s.member.emailInvitation(s.room.id, input);
  release();
  const [first, second] = await Promise.all([a,b]);
  assert.deepEqual(first, second); assert.equal(first.status, 'accepted');
  assert.deepEqual(await s.member.emailInvitation(s.room.id, input), first);
  assert.equal(calls.length, 1);
  assert.equal((await s.host.listInvitations(s.room.id)).invitations.length, before + 1);
  const link = calls[0].message.text.match(/Join: (\S+)/)[1];
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get('invite');
  assert.ok(token); assert.equal(new URL(link).origin, s.hub.publicUrl);
  assert.ok(!JSON.stringify(first).includes(token)); assert.ok(!JSON.stringify(first).includes(input.email));
  const recipient = lanBrowser(s.hub);
  await recipient.joinBrowser({ name: 'Recipient', invite_token: token }); await recipient.joinRoom(s.room.id);
  await assert.rejects(s.member.emailInvitation(s.room.id, { ...input, email: 'other@example.com' }), e => e.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal((await s.host.history(s.room.id)).events.length, 0);
});

test('uncertain submission is durable and never resent after reconnect/restart; owner quota bounds sends', async t => {
  let count = 0;
  const sender = { send: async () => { count++; throw new Error('private provider error'); } };
  const filename = join(await temporaryDirectory(t), 'email.sqlite');
  const s = await fixture(t, sender, filename);
  const input = { request_id: 'uncertain', email: 'recipient@example.com' };
  const first = await s.member.emailInvitation(s.room.id, input);
  assert.equal(first.status, 'unknown'); assert.equal(count, 1);
  await s.hub.close();
  // Simulate a process exiting between provider submission and recording its result.
  const db = await openDatabase({ filename });
  db.db.prepare("UPDATE invitation_emails SET status='sending'").run(); db.close();
  const restarted = await createHub({ filename, port: Number(new URL(s.hub.url).port), externalUrl: s.hub.publicUrl, emailSender: sender });
  t.after(() => restarted.close());
  assert.deepEqual(await s.member.emailInvitation(s.room.id, input), first); assert.equal(count, 1);
  for (let n = 0; n < 9; n++) await s.member.emailInvitation(s.room.id, { email: `recipient${n}@example.com` });
  await assert.rejects(s.member.emailInvitation(s.room.id, { email: 'over@example.com' }), e => e.code === 'EMAIL_RATE_LIMIT');
  assert.equal(count, 10);
});

test('Resend adapter is opt-in, pins endpoint, uses provider idempotency, and distinguishes rejection from uncertainty', async () => {
  assert.equal(createEmailSender({ env: {} }), null);
  assert.throws(() => createEmailSender({ env: { ROOM_EMAIL_ENABLED: '1' } }));
  const requests = []; let status = 200;
  const sender = createEmailSender({ env: { ROOM_EMAIL_ENABLED: '1', ROOM_EMAIL_API_KEY: 'synthetic', ROOM_EMAIL_FROM: 'room@example.com' },
    fetchImpl: async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify({ id: 'provider-id' }), { status }); } });
  const message = { to: 'person@example.com', subject: 'Invitation', text: 'Join link' };
  assert.deepEqual(await sender.send(message, 'unique-id'), { status: 'accepted' });
  assert.equal(requests[0].url, 'https://api.resend.com/emails');
  assert.equal(requests[0].options.headers['Idempotency-Key'], 'unique-id');
  assert.equal(requests[0].options.redirect, 'error');
  status = 400; assert.equal((await sender.send(message, 'other')).status, 'failed');
  status = 503; assert.equal((await sender.send(message, 'next')).status, 'unknown');
});

test('email UI is disabled when unconfigured, preserves request identity on retry, and fences late room responses', async t => {
  const disabled = await fixture(t);
  let doc = parseHTML(html);
  let app = await mountChatroom({ document: doc.document, client: disabled.host }); t.after(() => app.destroy());
  assert.equal(doc.document.getElementById('invite-email-send').disabled, true);
  assert.match(doc.document.getElementById('invite-email-status').textContent, /not configured/);
  const calls = [];
  const s = await fixture(t, { send: async () => ({ status: 'accepted' }) });
  const client = Object.create(s.member); let lose = true;
  client.emailInvitation = async (id, input, options) => {
    calls.push(input);
    const result = await s.member.emailInvitation(id, input, options);
    if (lose) { lose = false; throw new Error('Lost response'); }
    return result;
  };
  const enabledDoc = parseHTML(html);
  const enabled = await mountChatroom({ document: enabledDoc.document, client }); t.after(() => enabled.destroy());
  const $ = id => enabledDoc.document.getElementById(id);
  assert.equal($('invite-human').hidden, false); assert.equal($('invite-email-send').disabled, false);
  $('invite-email').value = 'person@example.com';
  const submit = () => $('invite-email-form').dispatchEvent(new enabledDoc.window.Event('submit', { cancelable: true }));
  submit(); await until(() => $('invite-email-status').textContent.includes('Lost response'));
  submit(); await until(() => $('invite-email-status').textContent.includes('accepted by'));
  await until(() => !$('invite-email-send').disabled);
  assert.equal(calls[0].request_id, calls[1].request_id);
  let release;
  client.emailInvitation = async () => { await new Promise(resolve => { release = resolve; }); return { status: 'accepted' }; };
  $('invite-email').value = 'another@example.com'; submit(); await until(() => Boolean(release));
  const other = await s.host.createRoom({ name: 'Another' });
  const invite = await s.host.createInvitation(other.id, { kind: 'human' });
  await s.member.joinBrowser({ name: 'Member', invite_token: invite.token });
  await enabled.rooms.refresh(); await enabled.rooms.select(other.id); release(); await new Promise(setImmediate);
  assert.equal($('invite-email').value, ''); assert.ok(!$('invite-email-status').textContent.includes('accepted by'));
});
