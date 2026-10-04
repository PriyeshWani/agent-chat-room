import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { checkMcp } from '../src/mcp/diagnostic.js';
import { createFixtureServer } from './helpers/fixture-server.js';
import { temporaryDirectory } from './helpers/processes.js';

const exec = promisify(execFile);

test('startup diagnostic discovers the real adapter from another workspace without enrollment', { timeout: 10000 }, async t => {
  const cwd = await temporaryDirectory(t);
  const fixture = await createFixtureServer(); t.after(() => fixture.close());
  const session = join(cwd, 'session.json');
  const result = await checkMcp({ cwd, env: { ...process.env,
    ROOM_HUB_URL: fixture.url, ROOM_SESSION_FILE: session,
    ROOM_AGENT_NAME: 'Claude agent', ROOM_AGENT_RUNTIME: 'Claude Code',
  } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.tools.length, 12);
  assert.ok(result.tools.includes('join_room'));
  assert.equal(result.stderr, '');
  assert.deepEqual(result.exit, { code: 0, signal: null });
  assert.equal(fixture.calls.length, 0);
  await assert.rejects(stat(session), { code: 'ENOENT' });
});

test('checker works without installed dependencies and shows the adapter import error', { timeout: 10000 }, async t => {
  const cwd = await temporaryDirectory(t);
  const scripts = join(cwd, 'scripts'), mcp = join(cwd, 'src/mcp');
  await mkdir(scripts); await mkdir(mcp, { recursive: true });
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  await copyFile(new URL('../scripts/check-mcp.js', import.meta.url), join(scripts, 'check-mcp.js'));
  await copyFile(new URL('../src/mcp/diagnostic.js', import.meta.url), join(mcp, 'diagnostic.js'));
  await writeFile(join(mcp, 'main.js'), "import 'agent-chat-room-missing-test-dependency';\n");
  await assert.rejects(exec(process.execPath, [join(scripts, 'check-mcp.js')], { cwd }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /FAIL \[initialize\]/);
    assert.match(error.stdout, /Adapter exit: code=1/);
    assert.match(error.stdout, /ERR_MODULE_NOT_FOUND/);
    assert.match(error.stdout, /agent-chat-room-missing-test-dependency/);
    return true;
  });
});

test('silent early adapter exit retains the exit status', async t => {
  const entry = join(await temporaryDirectory(t), 'exit.cjs');
  await writeFile(entry, 'process.exitCode = 2;');
  const result = await checkMcp({ entry });
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'initialize');
  assert.equal(result.stderr, '');
  assert.deepEqual(result.exit, { code: 2, signal: null });
});

test('a stalled adapter times out and its child is stopped', { timeout: 5000 }, async t => {
  const entry = join(await temporaryDirectory(t), 'hang.cjs');
  await writeFile(entry, 'process.stdin.resume(); setInterval(() => {}, 1000);');
  const result = await checkMcp({ entry, timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.match(result.message, /Timed out.*initialize/);
  assert.equal(result.exit.signal, 'SIGTERM');
});

test('non-protocol stdout reports a handshake error and closes the adapter', { timeout: 5000 }, async t => {
  const entry = join(await temporaryDirectory(t), 'noise.cjs');
  await writeFile(entry, "console.log('debug output'); process.stdin.resume();");
  const result = await checkMcp({ entry });
  assert.equal(result.ok, false);
  assert.match(result.message, /non-JSON output/);
  assert.ok(result.exit);
});
