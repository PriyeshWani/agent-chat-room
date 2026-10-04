import { randomBytes } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Inputs } from '../shared/schemas.js';
import { parseHubUrl } from '../shared/hub-url.js';
import { startupStep } from './startup-errors.js';

const Profile = Inputs.agentSession.pick({ name: true, runtime: true, workspace: true, context: true });
const SessionFile = z.object({ version: z.literal(1), resumeToken: z.string().min(32).max(256), profile: Profile, hubUrl: z.string().optional() }).strict();

export async function prepareAdapterConfig(env = process.env) {
  const rawUrl = env.ROOM_HUB_URL ?? 'http://127.0.0.1:8787';
  const hub = await startupStep('HUB_URL', () => parseHubUrl(rawUrl));
  const inviteToken = env.ROOM_INVITE_TOKEN?.trim();
  await startupStep('INVITATION', () => {
    if (inviteToken !== undefined && !Inputs.agentSession.shape.invite_token.safeParse(inviteToken).success) throw new Error('Invalid agent invitation.');
  });
  const resume = env.ROOM_RESUME === '1';
  const sessionPath = env.ROOM_SESSION_FILE;
  await startupStep('SESSION_SETTINGS', () => {
    if (env.ROOM_RESUME !== undefined && !['0', '1'].includes(env.ROOM_RESUME)) throw new Error('Invalid ROOM_RESUME.');
    if (sessionPath !== undefined && (!sessionPath.trim() || sessionPath.includes('\0'))) throw new Error('Invalid ROOM_SESSION_FILE.');
    if (resume && !sessionPath) throw new Error('Explicit resume requires ROOM_SESSION_FILE.');
  });
  // Claude supplies its project root to stdio servers. A user-scoped MCP
  // registration can therefore follow each session without pinning a repo.
  const selectedWorkspace = env.ROOM_WORKSPACE ?? env.CLAUDE_PROJECT_DIR;
  let profile, resumeToken;
  if (resume) {
    const saved = await startupStep('SESSION_READ', async () => {
      const file = await open(resolve(sessionPath), 'r');
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 32768) throw new Error('Invalid adapter session file.');
        return SessionFile.parse(JSON.parse(await file.readFile('utf8')));
      } finally { await file.close(); }
    });
    if ((saved.hubUrl && saved.hubUrl !== hub.origin) || (!saved.hubUrl && hub.hostname !== '127.0.0.1')) {
      throw Object.assign(new Error('Hub URL differs from the saved session, or the legacy session has no LAN binding.'), { code: 'HUB_MISMATCH' });
    }
    profile = saved.profile; resumeToken = saved.resumeToken;
  } else {
    const workspace = selectedWorkspace ?? process.cwd();
    await startupStep('WORKSPACE', () => {
      if (!workspace.trim() || workspace.includes('\0')) throw new Error('Invalid ROOM_WORKSPACE.');
    });
    profile = await startupStep('PROFILE', () => Profile.parse({ name: env.ROOM_AGENT_NAME ?? 'Agent', runtime: env.ROOM_AGENT_RUNTIME ?? 'Codex',
      workspace: { path: resolve(workspace) }, context: env.ROOM_CONTEXT ?? '' }));
    resumeToken = randomBytes(32).toString('base64url');
  }
  await startupStep('WORKSPACE', async () => {
    if (!profile.workspace || !(await stat(profile.workspace.path)).isDirectory()) throw new Error('Workspace must be a directory.');
  });
  // Resume retains the saved descriptive profile. The selected or client-
  // supplied workspace must match, so another project's identity is not reused.
  if (resume && selectedWorkspace !== undefined) {
    const selected = selectedWorkspace;
    await startupStep('WORKSPACE', async () => {
      if (!selected.trim() || selected.includes('\0')) throw new Error('Invalid ROOM_WORKSPACE.');
      if (await realpath(resolve(selected)) !== await realpath(profile.workspace.path)) {
        throw Object.assign(new Error('Selected workspace differs from the saved session workspace.'), { code: 'WORKSPACE_MISMATCH' });
      }
    });
  }
  if (sessionPath && !resume) {
    await startupStep('SESSION_WRITE', async () => {
      const file = await open(resolve(sessionPath), 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ version: 1, resumeToken, profile, hubUrl: hub.origin }) + '\n'); }
      finally { await file.close(); }
    });
  }
  return { baseUrl: hub.origin, profile, resumeToken, mode: resume ? 'resume' : 'create', ...(inviteToken ? { inviteToken } : {}) };
}
