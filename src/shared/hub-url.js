// LAN hosting is explicit and limited to literal private IPv4 addresses.
// No DNS lookup, forwarding, or changes to the terminal's network policy.
export function privateIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function parseHubUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !(url.hostname === '127.0.0.1' || privateIpv4(url.hostname))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('Hub URL must be an HTTP root URL using 127.0.0.1 or a private LAN IPv4 address.');
  }
  return url;
}
