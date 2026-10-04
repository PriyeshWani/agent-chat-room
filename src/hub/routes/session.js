import { Inputs } from '../../shared/schemas.js';

export function createSessionRoutes({ sessions }) {
  return ({ request, response, path, method, body, secure }) => {
    if (method !== 'POST') return undefined;
    if (path === '/api/v1/sessions/browser') {
      Inputs.browserSession.parse(body);
      const { token, ...data } = sessions.browserSession(request);
      response.setHeader('Set-Cookie', `acr_session=${token}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`);
      return { schema: 'browserSession', data };
    }
    if (path === '/api/v1/sessions/join') {
      const { token, ...data } = sessions.joinBrowser(Inputs.joinBrowser.parse(body), request);
      response.setHeader('Set-Cookie', `acr_session=${token}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`);
      return { schema: 'browserSession', data };
    }
    if (path === '/api/v1/sessions/agent') {
      return { schema: 'agentSession', data: sessions.agentSession(Inputs.agentSession.parse(body), request) };
    }
    if (path === '/api/v1/sessions/heartbeat') {
      const input = Inputs.heartbeat.parse(body);
      return { schema: 'heartbeat', data: sessions.heartbeat(sessions.authenticate(request), input) };
    }
    if (path === '/api/v1/sessions/disconnect') {
      Inputs.browserSession.parse(body);
      return { schema: 'heartbeat', data: sessions.disconnect(sessions.authenticate(request)) };
    }
    return undefined;
  };
}
