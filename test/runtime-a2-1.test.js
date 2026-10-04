import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildLaunchConfig } from '../src/runtime/launch-config.js';
import { buildParticipationInstructions } from '../src/runtime/participation.js';
import { temporaryDirectory } from './helpers/processes.js';

const script = new URL('../scripts/chat.js', import.meta.url).pathname;
async function run(t, args, { cwd, env = {}, stdin } = {}) {
  const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...process.env, ...env }, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (stdin !== undefined) child.stdin.end(stdin);
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const [code, signal] = await once(child, 'exit');
  return { code, signal, stdout, stderr };
}
async function fakeClient(t, body, name = 'fake-client') {
  const directory = await temporaryDirectory(t);
  const file = join(directory, name);
  await writeFile(file, `#!${process.execPath}\n${body}\n`);
  await chmod(file, 0o700);
  return file;
}

test('configuration uses the original probe single-table launch format with literal TOML values', async t => {
  const directory = await temporaryDirectory(t);
  const workspace = join(directory, 'workspace "quoted" `ticks` $(literal)');
  await mkdir(workspace);
  const input = {
    workspace, roomId: 'room "quoted"\nnext', name: 'Agent "quoted"\n`literal` $(literal)',
    context: 'line1\nline2\\path\t"quoted" `literal` $(literal)', hubUrl: 'http://127.0.0.1:8787/',
    sessionFile: join(directory, 'session "name".json'), resume: true,
  };
  const config = buildLaunchConfig(input);
  assert.equal(config.command, 'codex');
  assert.equal(config.cwd, workspace);
  assert.equal(config.args.length, 3);
  assert.equal(config.args[0], '-c');
  const quote = JSON.stringify;
  assert.equal(config.args[1], 'mcp_servers.agent_chat_room={ command = ' + quote(process.execPath)
    + ', args = [' + quote(new URL('../src/mcp/main.js', import.meta.url).pathname) + ']'
    + ', env = { ROOM_HUB_URL = "http://127.0.0.1:8787", ROOM_AGENT_NAME = ' + quote(input.name)
    + ', ROOM_WORKSPACE = ' + quote(workspace) + ', ROOM_CONTEXT = ' + quote(input.context)
    + ', ROOM_SESSION_FILE = ' + quote(input.sessionFile) + ', ROOM_RESUME = "1" }'
    + ', env_vars = ["ROOM_INVITE_TOKEN"], startup_timeout_sec = 30, tool_timeout_sec = 30, required = true }');
  assert.equal(config.args.at(-1), buildParticipationInstructions({ roomId: input.roomId, name: input.name, workspace }));
  const injected = buildLaunchConfig({ ...input, command: './relative-client' }, { nodePath: './node', adapterPath: './adapter.mjs' });
  assert.equal(injected.command, resolve('relative-client'));
  assert.ok(injected.args[1].includes('command = ' + quote(resolve('node'))));
  assert.ok(injected.args[1].includes('args = [' + quote(resolve('adapter.mjs')) + ']'));
});

test('builder rejects malformed inputs and unsupported URLs before spawning', async t => {
  const workspace = await temporaryDirectory(t);
  const valid = { workspace, roomId: 'room', name: 'Agent', hubUrl: 'http://127.0.0.1:8787' };
  for (const patch of [
    { roomId: '' }, { name: ' ' }, { workspace: join(workspace, 'missing') }, { context: 1 },
    { context: '\ud800' }, { name: 'a\0b' }, { command: '' }, { resume: true }, { resume: '1' },
    { sessionFile: '' }, { unknown: 'option' },
  ]) assert.throws(() => buildLaunchConfig({ ...valid, ...patch }));
  const file = join(workspace, 'file'); await writeFile(file, '');
  assert.throws(() => buildLaunchConfig({ ...valid, workspace: file }));
  for (const hubUrl of ['https://127.0.0.1', 'http://localhost:8787', 'http://[::1]:8787', 'http://example.com', 'http://user:secret@127.0.0.1', 'http://127.0.0.1/path', 'http://127.0.0.1/?x=1', 'http://127.0.0.1/#fragment']) {
    assert.throws(() => buildLaunchConfig({ ...valid, hubUrl }));
  }
  assert.throws(() => buildLaunchConfig(valid, { unknown: true }));
});

test('normal launch keeps participation rules off argv and stays within project argument budgets', () => {
  const config = buildLaunchConfig({
    workspace: process.cwd(), roomId: '1ad7fdb3-c123-4211-87cc-5b0338020932',
    name: 'Agent1', hubUrl: 'http://127.0.0.1:60413',
  }, { nodePath: '/usr/local/bin/node', adapterPath: '/project/src/mcp/main.js' });
  const prompt = config.args.at(-1);
  // Project regression budgets for ordinary inputs, not Declawd's unknown limit.
  assert.ok(Buffer.byteLength(prompt) < 1024, 'keep the CLI bootstrap under 1 KiB');
  assert.ok(config.args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg) + 1, 0) < 2048,
    'keep normal launch arguments under 2 KiB, including separators');
  assert.match(prompt, /agent_chat_room MCP tools and its server instructions/);
  assert.match(prompt, /join_room with room_id=roomId/);
  assert.match(prompt, /receive_events, including after timeouts/);
  assert.match(prompt, /ack_events each batch/);
  assert.match(prompt, /retries and stopping/);
  assert.match(prompt, /terminal rules and user authorization/);
});

test('CLI fake child receives literal argv and workspace cwd, and child exit codes propagate', { timeout: 10000 }, async t => {
  const workspace = await temporaryDirectory(t);
  const fake = await fakeClient(t, `process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})); process.exitCode=Number(process.env.FAKE_EXIT ?? 0);`);
  const name = 'Agent "name"\n`literal` $(literal)';
  const context = 'context\n"quotes" `literal` $(literal)';
  const result = await run(t, ['--workspace', workspace, '--room', 'room', '--name', name, '--context', context, '--command', fake], { env: { FAKE_EXIT: '7' } });
  assert.equal(result.code, 7);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /Chat client exited with code 7/);
  assert.match(result.stdout, /Starting room agent/);
  assert.match(result.stdout, /join_room, post_message, and receive_events/);
  const recorded = JSON.parse(result.stdout.split('\n').at(-1));
  const expected = buildLaunchConfig({ workspace, roomId: 'room', name, context, hubUrl: 'http://127.0.0.1:8787', command: fake });
  assert.deepEqual(recorded, { args: expected.args, cwd: await realpath(workspace) });
  const defaults = await run(t, ['--room', 'room', '--command', fake], { cwd: workspace });
  assert.equal(JSON.parse(defaults.stdout.split('\n').at(-1)).cwd, await realpath(workspace));
  assert.equal(defaults.stderr, '');
  assert.ok(!defaults.stdout.includes('ROOM_RESUME'));
  assert.ok(!defaults.stdout.includes('ROOM_SESSION_FILE'));
});

test('explicit Declawd launch selects Codex, retains startup output and forwards the same room config', { timeout: 10000 }, async t => {
  const workspace = await temporaryDirectory(t);
  const fake = await fakeClient(t, `process.stderr.write('Visible startup diagnostic\\n'); process.stdout.write(JSON.stringify(process.argv.slice(2)));`, 'declawd');
  const result = await run(t, ['--room', 'room', '--workspace', workspace, '--command', fake]);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /Visible startup diagnostic/);
  const args = JSON.parse(result.stdout.split('\n').at(-1));
  const normal = buildLaunchConfig({ workspace, roomId: 'room', name: 'Agent', hubUrl: 'http://127.0.0.1:8787' });
  assert.deepEqual(args, ['--codex', ...normal.args]);
  const onPath = buildLaunchConfig({ workspace, roomId: 'room', name: 'Agent', hubUrl: 'http://127.0.0.1:8787', command: 'declawd' });
  assert.equal(onPath.command, 'declawd');
  assert.deepEqual(onPath.args, args);
});

test('LAN invitation reaches the fake child by environment, without entering argv, prompt, or output', { timeout: 10000 }, async t => {
  const token = 'synthetic-invitation-code-'.repeat(3);
  const fake = await fakeClient(t, `const token=process.env.ROOM_INVITE_TOKEN; process.stdout.write(JSON.stringify({received:token===process.env.EXPECT_TOKEN,exposed:JSON.stringify(process.argv).includes(token)}));`);
  const result = await run(t, ['--room', 'room', '--hub', 'http://192.168.1.20:60413', '--invite', '--command', fake], { env: { EXPECT_TOKEN: token }, stdin: token + '\n' });
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  assert.ok(result.stdout.includes('"received":true,"exposed":false'));
  assert.ok(!result.stdout.includes(token));
  const eof = await run(t, ['--room', 'room', '--invite', '--command', fake], { stdin: '' });
  assert.equal(eof.code, 1); assert.ok(!eof.stdout.includes('"received"'));
});

test('help and invalid arguments never launch the fake client; launch failures are concise', { timeout: 10000 }, async t => {
  const fake = await fakeClient(t, `process.stdout.write('FAKE_STARTED');`);
  const help = await run(t, ['--help', '--command', fake]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:/);
  assert.ok(!help.stdout.includes('FAKE_STARTED'));
  for (const args of [[], ['--room'], ['--room', 'room', '--room', 'again'], ['--room', 'room', '--resume'], ['--room', 'room', '--unknown'], ['--room', 'room', '--', 'extra']]) {
    const result = await run(t, [...args, '--command', fake]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Invalid chat launch options/);
  }
  const failure = await run(t, ['--room', 'room', '--command', '/nonexistent-chat-test-executable']);
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /Could not launch/);
});

test('launcher forwards termination and propagates a child termination signal', { timeout: 10000 }, async t => {
  const fake = await fakeClient(t, `process.stdout.write('READY\\n'); setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, [script, '--room', 'room', '--command', fake], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const exited = once(child, 'exit');
  await new Promise((resolveReady, reject) => {
    child.once('error', reject);
    child.stdout.on('data', data => { if (String(data).includes('READY')) resolveReady(); });
  });
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, 'SIGTERM');
});
