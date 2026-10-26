import { ApiError } from '../shared/protocol.js';

function credentials(request) {
  const invalid = () => { throw new ApiError('UNAUTHENTICATED', 'Provide one valid session credential.', { status: 401 }); };
  for (const name of ['authorization', 'cookie']) {
    let count = 0;
    for (let i = 0; i < (request.rawHeaders?.length ?? 0); i += 2) {
      if (request.rawHeaders[i].toLowerCase() === name) count++;
    }
    if (count > 1) invalid();
  }
  const authorization = request.headers.authorization;
  let bearer, cookie;
  if (authorization !== undefined) {
    if (typeof authorization !== 'string') invalid();
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization);
    if (!match) invalid();
    bearer = match[1];
  }
  const cookies = request.headers.cookie;
  if (cookies !== undefined) {
    if (typeof cookies !== 'string') invalid();
    for (const part of cookies.split(';')) {
      const match = /^([^=\s;]+)=([^;]*)$/.exec(part.trim());
      if (!match) invalid();
      if (match[1] === 'acr_session') {
        if (cookie !== undefined || !/^[A-Za-z0-9_-]+$/.test(match[2])) invalid();
        cookie = match[2];
      }
    }
  }
  if (bearer !== undefined && cookie !== undefined) invalid();
  return { ...(bearer === undefined ? {} : { bearer }), ...(cookie === undefined ? {} : { cookie }) };
}

export function createLocalSession({ identity, presence, changes, access, publicUrl, emailEnabled = false }) {
  const trustedLocal = request => ['127.0.0.1', '::ffff:127.0.0.1'].includes(request?.socket?.remoteAddress)
    && /^127\.0\.0\.1(?::\d+)?$/.test(request.headers.host);
  function browserResult(result) {
    if (!access) return result;
    return { ...result, access: { mode: 'lan', public_url: publicUrl(),
      can_create_rooms: access.isHost(result.participant), can_invite_people: result.participant.kind === 'human',
      email_enabled: emailEnabled } };
  }
  return {
    authenticate(request) {
      const context = identity.authenticate(credentials(request));
      presence?.touch(context);
      return context;
    },
    browserSession(request) {
      let result;
      if (access) {
        const supplied = credentials(request);
        if (supplied.cookie) {
          try {
            const context = identity.authenticate(supplied);
            result = identity.browserSession(context.participant.owner_id, context.participant.name);
          } catch (error) {
            // A restarted/replaced hub can leave the host browser with a stale
            // cookie. Only the direct local endpoint may bootstrap a new host.
            if (error.code !== 'UNAUTHENTICATED' || !trustedLocal(request)) throw error;
            result = identity.browserSession();
          }
        } else if (!supplied.bearer && trustedLocal(request)) result = identity.browserSession();
        else throw new ApiError('JOIN_REQUIRED', 'Use a room invitation to join this hub.', { status: 401 });
      } else result = identity.browserSession();
      presence?.touch(identity.authenticate({ cookie: result.token }));
      return browserResult(result);
    },
    joinBrowser(input, request) {
      if (!access) throw new ApiError('NOT_FOUND', 'LAN invitations are not enabled.', { status: 404 });
      const supplied = credentials(request);
      if (supplied.bearer) throw new ApiError('FORBIDDEN', 'Use a browser session to join as a person.', { status: 403 });
      let existing = null;
      if (supplied.cookie) {
        try { existing = identity.authenticate(supplied).participant; }
        catch (error) { if (error.code !== 'UNAUTHENTICATED') throw error; }
      }
      const result = access.joinBrowser(input, existing);
      presence?.touch(identity.authenticate({ cookie: result.token }));
      return browserResult(result);
    },
    agentSession(input, request) {
      const result = access ? access.agentSession(input, trustedLocal(request)) : identity.agentSession(input);
      changes?.emit('identity', result.participant.id);
      presence?.touch(identity.authenticate({ bearer: result.token }));
      return result;
    },
    heartbeat(context, input) {
      identity.assertCurrent(context);
      presence?.touch(context, input);
      return { ok: true };
    },
    disconnect(context) {
      const result = identity.disconnect(context);
      changes?.emit('identity', context.participant.id);
      presence?.disconnect(context);
      return result;
    },
  };
}
