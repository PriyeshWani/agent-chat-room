import { RoomClient } from '../../src/shared/client.js';

// Protocol test helper only; a cookie jar does not establish browser rendering.
export async function browserClient(url) {
  let cookie = '';
  const fetchImpl = async (input, options = {}) => {
    if (new URL(input).origin !== new URL(url).origin) throw new Error('Test cookie must stay on the hub origin.');
    const response = await fetch(input, {
      ...options,
      headers: { ...options.headers, Origin: new URL(url).origin, ...(cookie ? { Cookie: cookie } : {}) },
    });
    const issued = response.headers.getSetCookie();
    if (issued.length) cookie = issued.map(value => value.split(';')[0]).join('; ');
    return response;
  };
  const client = new RoomClient({ baseUrl: url, fetchImpl });
  const { participant } = await client.browserSession();
  return { client, participant };
}
