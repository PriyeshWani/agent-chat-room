#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { buildLaunchConfig } from '../src/runtime/launch-config.js';
import { createInterface } from 'node:readline/promises';

const help = `Usage: node scripts/chat.js --room ROOM [options]
  --workspace PATH     Working directory (default: current directory)
  --name NAME          Participant name (default: Agent)
  --hub URL            Hub URL (default: http://127.0.0.1:8787)
  --invite             Prompt for an agent invitation code (LAN sessions)
  --context TEXT       Initial descriptive context
  --session-file PATH  Explicit adapter session file
  --resume             Resume the selected session file
  --command PATH       Client executable (default: codex)
                       Use declawd to show its startup diagnostics
  --help               Show this help
`;

try {
  const argv = process.argv.slice(2);
  const input = { workspace: process.cwd(), name: 'Agent', hubUrl: 'http://127.0.0.1:8787' };
  const names = { '--workspace': 'workspace', '--room': 'roomId', '--name': 'name', '--hub': 'hubUrl', '--context': 'context', '--session-file': 'sessionFile', '--command': 'command' };
  const seen = new Set();
  let showHelp = false;
  let promptInvite = false;
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (seen.has(option)) throw new Error('Duplicate option.');
    seen.add(option);
    if (option === '--help') { showHelp = true; continue; }
    if (option === '--resume') { input.resume = true; continue; }
    if (option === '--invite') { promptInvite = true; continue; }
    if (!Object.hasOwn(names, option) || index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error('Invalid option.');
    input[names[option]] = argv[++index];
  }
  if (showHelp) process.stdout.write(help);
  else {
    const config = buildLaunchConfig(input);
    let inviteToken = process.env.ROOM_INVITE_TOKEN;
    if (promptInvite) {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const closed = new Promise((_, reject) => prompt.once('close', () => reject(new Error('No invitation supplied.'))));
        inviteToken = (await Promise.race([prompt.question('Paste agent invitation code: '), closed])).trim();
      }
      finally { prompt.close(); }
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(inviteToken)) throw new Error('Invalid agent invitation.');
    }
    process.stdout.write(`Starting room agent ${JSON.stringify(input.name)} in room ${JSON.stringify(input.roomId)} at ${input.hubUrl}.\n`);
    process.stdout.write('The room adapter provides join_room, post_message, and receive_events.\n');
    const child = spawn(config.command, config.args, { cwd: config.cwd, stdio: 'inherit', shell: false,
      env: { ...process.env, ...(inviteToken ? { ROOM_INVITE_TOKEN: inviteToken } : {}) } });
    const forward = signal => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
    const onInt = () => forward('SIGINT');
    const onTerm = () => forward('SIGTERM');
    const cleanup = () => { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); };
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    child.once('error', () => {
      cleanup();
      process.stderr.write('Could not launch the configured client executable.\n');
      process.exitCode = 1;
    });
    child.once('exit', (code, signal) => {
      cleanup();
      if (signal) process.kill(process.pid, signal);
      else {
        if (code) process.stderr.write(`Chat client exited with code ${code}. Check the client output above for its startup or session error.\n`);
        process.exitCode = code ?? 1;
      }
    });
  }
} catch {
  process.stderr.write('Invalid chat launch options. Run with --help for usage.\n');
  process.exitCode = 1;
}
