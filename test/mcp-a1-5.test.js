import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareAdapterConfig } from '../src/mcp/main.js';
import { createHub } from '../src/hub/main.js';
import { temporaryDirectory, connectMcp } from './helpers/processes.js';
import { browserClient } from './helpers/browser-client.js';

const entry = fileURLToPath(new URL('../src/mcp/main.js', import.meta.url));
async function setup(t) {
  const directory = await temporaryDirectory(t);
  const hub = await createHub({ filename: join(directory, 'hub.sqlite') });
  t.after(() => hub.close());
  const human = await browserClient(hub.url);
  const room = await human.client.createRoom({ name: 'Adapter test' });
  const env = (name, resume = false) => ({ ROOM_HUB_URL: hub.url, ROOM_AGENT_NAME: name,
    ROOM_AGENT_RUNTIME: 'Codex', ROOM_WORKSPACE: directory, ROOM_CONTEXT: '',
    ROOM_SESSION_FILE: join(directory, `${name}.json`), ROOM_RESUME: resume ? '1' : '0' });
  return { directory, hub, human, room, env };
}
async function call(adapter, name, args = {}) {
  const result = await adapter.call(name, args);
  assert.ok(!result.isError, JSON.stringify(result.data));
  return result.data;
}

test('two actual SDK adapters exchange batches and replies; closing one preserves hub and peer', { timeout: 15000 }, async t => {
  const s = await setup(t);
  const a = await connectMcp(t, entry, { env: s.env('Alice') });
  const b = await connectMcp(t, entry, { env: s.env('Bob') });
  assert.deepEqual((await a.client.listTools()).tools.map(tool => tool.name).sort(),
    ['ack_events', 'claim_task', 'create_task', 'join_room', 'leave_room', 'list_participants', 'list_rooms', 'list_tasks', 'post_message', 'read_history', 'receive_events', 'update_task']);
  const aj = await call(a, 'join_room', { room_id: s.room.id });
  const bj = await call(b, 'join_room', { room_id: s.room.id });
  assert.notEqual(aj.membership.participant_id, bj.membership.participant_id);
  const message = await call(a, 'post_message', { request_id: 'first', text: 'Hello Bob' });
  const received = await call(b, 'receive_events', { wait_ms: 0 });
  assert.deepEqual(received.batch.events, [message]);
  await call(b, 'ack_events', { request_id: 'ack', batch_id: received.batch.id });
  const reply = await call(b, 'post_message', { request_id: 'reply', text: 'Hello Alice', reply_to: message.id });
  assert.equal(reply.author.id, bj.membership.participant_id);
  assert.deepEqual((await call(a, 'receive_events', { wait_ms: 0 })).batch.events, [reply]);
  await a.client.close();
  assert.equal((await s.human.client.health()).status, 'ok');
  assert.equal((await call(b, 'read_history')).events.length, 2);
  const participants = await s.human.client.listParticipants(s.room.id);
  assert.ok(participants.participants.some(item => item.participant.id === aj.membership.participant_id));
  assert.equal(a.stderr(), ''); assert.equal(b.stderr(), '');
});

test('exclusive private session files resume durable identity, epoch and pending delivery', { timeout: 15000 }, async t => {
  const s = await setup(t);
  const env = s.env('Resume');
  const a = await connectMcp(t, entry, { env });
  const joined = await call(a, 'join_room', { room_id: s.room.id });
  const file = await readFile(env.ROOM_SESSION_FILE, 'utf8');
  const saved = JSON.parse(file);
  assert.deepEqual(Object.keys(saved).sort(), ['hubUrl', 'profile', 'resumeToken', 'version']);
  assert.equal((await stat(env.ROOM_SESSION_FILE)).mode & 0o777, 0o600);
  assert.ok(saved.resumeToken.length >= 32);
  assert.equal(saved.token, undefined);
  await assert.rejects(prepareAdapterConfig(env), error => error.code === 'EEXIST');
  assert.equal(await readFile(env.ROOM_SESSION_FILE, 'utf8'), file);
  const posted = await s.human.client.postMessage(s.room.id, { text: 'Keep pending' });
  const pending = await call(a, 'receive_events', { wait_ms: 0 });
  assert.deepEqual(pending.batch.events, [posted]);
  await a.client.close();
  const resumed = await connectMcp(t, entry, { env: { ...env, ROOM_RESUME: '1' } });
  const rejoined = await call(resumed, 'join_room', { room_id: s.room.id });
  assert.equal(rejoined.membership.participant_id, joined.membership.participant_id);
  assert.equal(rejoined.membership.epoch, joined.membership.epoch);
  assert.deepEqual(await call(resumed, 'receive_events', { wait_ms: 0 }), pending);
  assert.equal(await readFile(env.ROOM_SESSION_FILE, 'utf8'), file);
  assert.ok(!JSON.stringify(rejoined).includes(saved.resumeToken));
});

test('configuration validates local URL, profile and explicit resume before enrollment', async t => {
  const directory = await temporaryDirectory(t);
  const base = { ROOM_WORKSPACE: directory, ROOM_HUB_URL: 'http://127.0.0.1:8787' };
  for (const extra of [
    { ROOM_HUB_URL: 'https://127.0.0.1:8787' }, { ROOM_HUB_URL: 'http://example.invalid' },
    { ROOM_HUB_URL: 'http://user:secret@127.0.0.1:8787' }, { ROOM_HUB_URL: 'http://127.0.0.1:8787/path' },
    { ROOM_HUB_URL: 'http://127.0.0.1:8787/?x=1' }, { ROOM_HUB_URL: 'http://127.0.0.1:8787/#fragment' },
    { ROOM_RESUME: '1' }, { ROOM_RESUME: 'yes' }, { ROOM_AGENT_NAME: '' }, { ROOM_WORKSPACE: '' },
    { ROOM_SESSION_FILE: '' }, { ROOM_WORKSPACE: join(directory, 'missing') },
  ]) await assert.rejects(prepareAdapterConfig({ ...base, ...extra }));
  const sessionPath = join(directory, 'malformed.json');
  await writeFile(sessionPath, JSON.stringify({ version: 1, resumeToken: 'short', profile: {} }));
  await assert.rejects(prepareAdapterConfig({ ...base, ROOM_RESUME: '1', ROOM_SESSION_FILE: sessionPath }));
  const first = await prepareAdapterConfig(base), second = await prepareAdapterConfig(base);
  assert.notEqual(first.resumeToken, second.resumeToken);
  assert.equal(first.profile.runtime, 'Codex');
});

test('user-scoped adapters report each Claude project instead of the adapter checkout', { timeout: 15000 }, async t => {
  const s = await setup(t);
  const projects = [join(s.directory, 'api-project'), join(s.directory, 'ui-project')];
  const ids = [];
  for (const project of projects) {
    await mkdir(project);
    const adapter = await connectMcp(t, entry, { env: {
      ROOM_HUB_URL: s.hub.url, ROOM_AGENT_NAME: 'Claude agent', ROOM_AGENT_RUNTIME: 'Claude Code',
      ROOM_WORKSPACE: undefined, ROOM_SESSION_FILE: undefined, ROOM_RESUME: undefined, ROOM_INVITE_TOKEN: undefined,
      CLAUDE_PROJECT_DIR: project,
    } });
    const joined = await call(adapter, 'join_room', { room_id: s.room.id });
    ids.push(joined.membership.participant_id);
  }
  assert.notEqual(ids[0], ids[1]);
  const { participants } = await s.human.client.listParticipants(s.room.id);
  for (const [index, id] of ids.entries()) {
    const participant = participants.find(item => item.participant.id === id).participant;
    assert.equal(participant.workspace.path, projects[index]);
    assert.equal(participant.runtime, 'Claude Code');
  }
});

test('workspace selection honors an explicit override and rejects an invalid Claude project', async t => {
  const directory = await temporaryDirectory(t);
  const explicit = await prepareAdapterConfig({ ROOM_WORKSPACE: directory, CLAUDE_PROJECT_DIR: join(directory, 'missing') });
  assert.equal(explicit.profile.workspace.path, directory);
  for (const project of ['', join(directory, 'missing')]) {
    await assert.rejects(prepareAdapterConfig({ CLAUDE_PROJECT_DIR: project }));
  }
  const fallback = await prepareAdapterConfig({});
  assert.equal(fallback.profile.workspace.path, process.cwd());
});

test('resume rejects a different workspace without rewriting the session and accepts equivalent paths', async t => {
  const directory = await temporaryDirectory(t);
  const original = join(directory, 'original'), different = join(directory, 'different'), alias = join(directory, 'alias');
  await mkdir(original); await mkdir(different); await symlink(original, alias, 'dir');
  const env = { ROOM_WORKSPACE: original, ROOM_SESSION_FILE: join(directory, 'session.json'), ROOM_AGENT_NAME: 'Saved name' };
  const saved = await prepareAdapterConfig(env);
  const contents = await readFile(env.ROOM_SESSION_FILE, 'utf8');
  await assert.rejects(prepareAdapterConfig({ ...env, ROOM_RESUME: '1', ROOM_WORKSPACE: different }), /differs from the saved session workspace/);
  assert.equal(await readFile(env.ROOM_SESSION_FILE, 'utf8'), contents);
  for (const workspace of [alias, join(original, '..', 'original')]) {
    const resumed = await prepareAdapterConfig({ ...env, ROOM_RESUME: '1', ROOM_WORKSPACE: workspace, ROOM_AGENT_NAME: 'Ignored override' });
    assert.deepEqual(resumed.profile, saved.profile);
    assert.equal(resumed.resumeToken, saved.resumeToken);
  }
  const claudeEnv = { ROOM_SESSION_FILE: env.ROOM_SESSION_FILE, ROOM_RESUME: '1' };
  await assert.rejects(prepareAdapterConfig({ ...claudeEnv, CLAUDE_PROJECT_DIR: different }), error => error.code === 'WORKSPACE_MISMATCH');
  const claudeResumed = await prepareAdapterConfig({ ...claudeEnv, CLAUDE_PROJECT_DIR: alias });
  assert.deepEqual(claudeResumed.profile, saved.profile);
  assert.equal(claudeResumed.resumeToken, saved.resumeToken);
  assert.equal(await readFile(env.ROOM_SESSION_FILE, 'utf8'), contents);
});

for (const shutdown of ['eof', 'signal']) {
  test(`adapter ${shutdown} shutdown exits cleanly with protocol-only stdout`, { timeout: 10000 }, async t => {
    const s = await setup(t);
    const child = spawn(process.execPath, [entry], { env: { ...process.env, ...s.env(shutdown) }, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const finished = await Promise.race([exited.then(() => true), delay(1000).then(() => false)]);
      if (!finished) { child.kill('SIGKILL'); await exited; }
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'shutdown-test', version: '1' },
    } }) + '\n');
    for (let i = 0; i < 200 && !stdout.includes('serverInfo'); i++) await delay(5);
    assert.ok(stdout.includes('serverInfo'));
    if (shutdown === 'eof') child.stdin.end(); else child.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.equal(code, 0); assert.equal(signal, null); assert.equal(stderr, '');
    for (const line of stdout.trim().split('\n')) assert.equal(JSON.parse(line).jsonrpc, '2.0');
    assert.equal((await s.human.client.health()).status, 'ok');
  });
}
