import { requestId } from './ids.js';

export function createAccessPanel({ document, client, onJoined }) {
  const $ = id => document.getElementById(id);
  let access = null, room = null, destroyed = false, generation = 0, controller = null, listController = null, currentInviteId = null;
  let joinAttempt = null, joinController = null;
  let emailAttempt = null, emailController = null;
  const attempts = new Map(), revocations = new Map();
  const window = document.defaultView;
  // Invitations stay in the fragment until this page reads them, never in a
  // request URL, chat message, or persistent browser storage.
  const fragment = new URLSearchParams(window?.location?.hash?.slice(1) ?? '');
  const token = fragment.get('invite');
  let pendingInvitation = Boolean(token);
  if (token) {
    $('join-code').value = token;
    window.history?.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }
  function showJoin(name) {
    if (!destroyed) {
      if (name && !$('join-name').value) $('join-name').value = name;
      $('join-name').readOnly = Boolean(name);
      $('join-panel').hidden = false; $('join-name').focus();
    }
  }
  async function join(event) {
    event.preventDefault();
    if (joinController || destroyed) return;
    const input = { name: $('join-name').value.trim(), invite_token: $('join-code').value.trim() };
    if (!joinAttempt || joinAttempt.name !== input.name || joinAttempt.invite_token !== input.invite_token) {
      joinAttempt = { ...input, request_id: requestId() };
    }
    joinController = new AbortController(); $('join-submit').disabled = true; $('join-status').textContent = 'Joining…';
    try {
      await client.joinBrowser(joinAttempt, { signal: joinController.signal });
      if (destroyed) return;
      joinAttempt = null; pendingInvitation = false; $('join-code').value = ''; $('join-status').textContent = ''; $('join-panel').hidden = true;
      await onJoined();
    } catch (error) { if (!destroyed) $('join-status').textContent = error.message; }
    finally { joinController = null; if (!destroyed) $('join-submit').disabled = false; }
  }
  function renderResult(kind, result) {
    currentInviteId = result.invitation.id;
    $('invite-result').hidden = false;
    $('invite-output-label').textContent = kind === 'human' ? 'Share this single-use invitation link' : 'Agent invitation code';
    $('invite-output').value = kind === 'human' ? `${access.public_url}/#invite=${encodeURIComponent(result.token)}` : result.token;
    $('invite-expiry').textContent = `Redeem by ${new Date(result.invitation.expires_at).toLocaleString()}. Access continues until revoked.`;
    $('invite-launch').hidden = kind !== 'agent';
    if (kind === 'agent') {
      const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
      $('invite-launch').textContent = `npm run chat -- --room ${quote(room.id)} --hub ${quote(access.public_url)} --name "Agent name" --workspace /path/to/repo --invite`;
    } else $('invite-launch').textContent = '';
  }
  async function refresh() {
    if (destroyed || !room || !access) return;
    listController?.abort(); listController = new AbortController();
    const operation = generation, id = room.id, request = listController;
    try {
      const result = await client.listInvitations(id, { signal: request.signal });
      if (destroyed || operation !== generation || request !== listController) return;
      $('invitations-list').replaceChildren(...result.invitations.map(invite => {
        const item = document.createElement('li');
        const description = document.createElement('span');
        const status = invite.revoked_at ? 'Revoked' : invite.used ? 'Joined' : Date.parse(invite.expires_at) <= Date.now() ? 'Expired' : 'Not used';
        description.textContent = `${invite.label || (invite.kind === 'human' ? 'Person' : 'My agent')} · ${status}${invite.inviter ? ` · Invited by ${invite.inviter.name}` : ''}`;
        item.append(description);
        if (!invite.revoked_at) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = invite.used ? 'Revoke access' : 'Revoke invitation';
          button.addEventListener('click', () => { void revoke(invite.id, button, id, operation); }); item.append(button);
        }
        return item;
      }));
    } catch (error) { if (!destroyed && operation === generation && !request.signal.aborted) $('invite-status').textContent = error.message; }
  }
  async function revoke(id, button, roomId, operation) {
    if (destroyed || generation !== operation) return;
    const input = revocations.get(id) ?? { request_id: requestId(), invitation_id: id }; revocations.set(id, input);
    button.disabled = true;
    try {
      await client.revokeInvitation(roomId, input);
      if (!destroyed && generation === operation) {
        if (currentInviteId === id) { $('invite-result').hidden = true; $('invite-output').value = ''; }
        $('invite-status').textContent = 'Access revoked.'; await refresh();
      }
    } catch (error) { if (!destroyed && generation === operation) { button.disabled = false; $('invite-status').textContent = error.message; } }
  }
  async function create(kind) {
    if (destroyed || !room || !access || controller) return;
    const operation = generation, id = room.id, key = `${id}:${kind}`;
    const label = $('invite-label').value.trim();
    let attempt = attempts.get(key);
    if (!attempt || attempt.result || attempt.input.label !== label) {
      attempt = { input: { kind, label, request_id: requestId() }, result: null }; attempts.set(key, attempt);
    }
    const request = new AbortController(); controller = request;
    $('invite-human').disabled = $('invite-agent').disabled = true; $('invite-status').textContent = 'Creating invitation…';
    try {
      attempt.result = await client.createInvitation(id, attempt.input, { signal: request.signal });
      if (destroyed || operation !== generation) return;
      renderResult(kind, attempt.result); $('invite-status').textContent = ''; await refresh();
    } catch (error) { if (!destroyed && operation === generation) $('invite-status').textContent = `${error.message} Try again to retry this invitation.`; }
    finally {
      if (controller === request) controller = null;
      if (!destroyed && operation === generation) $('invite-human').disabled = $('invite-agent').disabled = false;
    }
  }
  function select(selected) {
    ++generation; controller?.abort(); controller = null; listController?.abort();
    emailController?.abort(); emailController = null; emailAttempt = null;
    $('invite-email').value = '';
    $('invite-email').disabled = !access?.email_enabled;
    $('invite-email-send').disabled = !selected || !access?.email_enabled;
    $('invite-email-status').textContent = access?.email_enabled ? 'Send a single-use invitation to this room.' : 'Email sending is not configured. Share an invitation link instead.';
    room = selected; $('share-room').hidden = !room || !access;
    currentInviteId = null;
    $('invite-result').hidden = true; $('invite-output').value = ''; $('invite-launch').textContent = '';
    $('invite-label').value = ''; $('invite-status').textContent = ''; $('invitations-list').replaceChildren();
    $('invite-human').disabled = $('invite-agent').disabled = !room;
    if (room && access) void refresh();
  }
  function setAccess(value) {
    access = value ?? null;
    $('invite-human').hidden = !access?.can_invite_people;
    $('share-room').hidden = !room || !access;
    if (access) $('join-panel').hidden = true;
  }
  const inviteHuman = () => { void create('human'); }, inviteAgent = () => { void create('agent'); };
  async function sendEmail(event) {
    event.preventDefault();
    if (destroyed || !room || !access?.email_enabled || emailController) return;
    const operation = generation, id = room.id;
    const email = $('invite-email').value.trim(), label = $('invite-label').value.trim();
    if (!emailAttempt || emailAttempt.email !== email || emailAttempt.label !== label) {
      emailAttempt = { email, label, request_id: requestId() };
    }
    const request = new AbortController(); emailController = request;
    $('invite-email-send').disabled = true; $('invite-email-status').textContent = 'Sending invitation…';
    try {
      const result = await client.emailInvitation(id, emailAttempt, { signal: request.signal });
      if (destroyed || operation !== generation) return;
      const messages = {
        accepted: 'Invitation accepted by the email provider. Inbox delivery is not confirmed.',
        failed: 'The email provider rejected this invitation. Share a new invitation link instead.',
        unknown: 'Email submission is unconfirmed. This request will not be resent automatically. Check with the recipient before creating another.',
      };
      $('invite-email-status').textContent = messages[result.status];
      await refresh();
    } catch (error) {
      if (!destroyed && operation === generation) $('invite-email-status').textContent = `${error.message} Retry uses the same invitation request.`;
    } finally {
      if (emailController === request) emailController = null;
      if (!destroyed && operation === generation) $('invite-email-send').disabled = false;
    }
  }
  const refreshClicked = () => { void refresh(); };
  $('join-form').addEventListener('submit', join);
  $('invite-email-form').addEventListener('submit', sendEmail);
  $('invite-human').addEventListener('click', inviteHuman); $('invite-agent').addEventListener('click', inviteAgent);
  $('invitations-refresh').addEventListener('click', refreshClicked);
  function destroy() {
    destroyed = true; ++generation; controller?.abort(); listController?.abort(); joinController?.abort(); emailController?.abort();
    attempts.clear(); joinAttempt = null; $('invite-output').value = ''; $('join-code').value = '';
    $('join-form').removeEventListener('submit', join); $('invite-human').removeEventListener('click', inviteHuman);
    $('invite-email-form').removeEventListener('submit', sendEmail);
    $('invite-agent').removeEventListener('click', inviteAgent); $('invitations-refresh').removeEventListener('click', refreshClicked);
  }
  return { select, setAccess, showJoin, refresh, destroy, hasInvitation: () => pendingInvitation };
}
