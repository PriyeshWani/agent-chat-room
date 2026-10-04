import { RoomClient } from '../../src/shared/client.js';
import http from 'node:http';
import { Readable } from 'node:stream';

export function loopbackFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: options.method, headers: options.headers, signal: options.signal }, response => {
      const headers = new Headers();
      for (let index = 0; index < response.rawHeaders.length; index += 2) headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
      resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers }));
    });
    request.on('error', reject); request.end(options.body);
  });
}

// Real HTTP over a test-owned loopback listener. Host/Origin model the advertised
// LAN endpoint; these tests do not contact another machine or network interface.
export function lanBrowser(hub) {
  let cookie = '';
  const client = new RoomClient({ baseUrl: hub.publicUrl, fetchImpl: async (input, options = {}) => {
    const url = new URL(input);
    if (url.origin !== hub.publicUrl) throw new Error('Fixture URL must match the LAN origin.');
    const response = await loopbackFetch(`${hub.url}${url.pathname}${url.search}`, { ...options,
      headers: { ...options.headers, Host: url.host, Origin: url.origin, ...(cookie ? { Cookie: cookie } : {}) },
    });
    const issued = response.headers.getSetCookie();
    if (issued.length) cookie = issued.map(value => value.split(';')[0]).join('; ');
    return response;
  } });
  return client;
}
