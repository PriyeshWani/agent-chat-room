// Plain HTTP is limited to local/private addresses. Remote hubs require HTTPS.
export function privateIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function parseHubUrl(value) {
  const url = new URL(value);
  const local = url.hostname === '127.0.0.1' || privateIpv4(url.hostname);
  const remote = url.protocol === 'https:' && url.hostname.includes('.') && !local
    && !/^\d+(?:\.\d+){3}$/.test(url.hostname);
  if (!(url.protocol === 'http:' && local) && !remote
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('Hub URL must be a local/private HTTP root URL or a remote HTTPS root URL.');
  }
  return url;
}

export function parsePublicUrl(value) {
  const url = parseHubUrl(value);
  if (url.protocol !== 'https:') throw new TypeError('Public hub URL must use HTTPS.');
  return url;
}
