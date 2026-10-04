import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function temporaryDirectory(t) {
  const path = await mkdtemp(join(tmpdir(), 'agent-room-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

export async function startNode(t, file, { args = [], env = {}, ready = /ROOM_HUB_READY (http:\/\/127\.0\.0\.1:\d+)/ } = {}) {
  const child = spawn(process.execPath, [file, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  const exited = once(child, 'exit').catch(() => {});
  t.after(async () => {
    const wait = async ms => {
      let timer;
      try { return await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
      finally { clearTimeout(timer); }
    };
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (!await wait(2000)) {
      child.kill('SIGKILL');
      if (!await wait(1000)) throw new Error('Test-owned child did not terminate.');
    }
  });
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Process did not become ready: ${output}`)), 5000);
    const finish = fn => value => { clearTimeout(timeout); child.off('error', onError); child.off('exit', onExit); fn(value); };
    const onError = error => finish(reject)(error);
    const onExit = () => finish(reject)(new Error(`Process exited before ready: ${output}`));
    const onData = data => { output += data; const match = output.match(ready); if (match) finish(resolve)(match[1]); };
    child.on('error', onError); child.on('exit', onExit); child.stdout.on('data', onData); child.stderr.on('data', onData);
  });
  return { child, url, output: () => output, exited };
}

export async function connectMcp(t, file, { env = {}, args = [] } = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [file, ...args], env: { ...process.env, ...env }, stderr: 'pipe' });
  const client = new Client({ name: 'room-sdk-test', version: '1.0.0' });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => client.close());
  await client.connect(transport);
  return { client, stderr: () => stderr, async call(name, args = {}, options) {
    const response = await client.callTool({ name, arguments: args }, undefined, options);
    const data = JSON.parse(response.content[0].text);
    return { ...response, data };
  } };
}
