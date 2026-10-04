import { readFile } from 'node:fs/promises';
import { ApiError } from '../shared/protocol.js';

const assets = new Map([
  ['/', ['../../public/chatroom/index.html', 'text/html']],
  ['/index.html', ['../../public/chatroom/index.html', 'text/html']],
  ['/style.css', ['../../public/chatroom/style.css', 'text/css']],
  ...['theme', 'rooms', 'drafts', 'conversation', 'composer', 'mentions', 'event-feed', 'participants', 'tasks', 'access', 'app'].map(name =>
    [`/${name}.js`, [`../../public/chatroom/${name}.js`, 'text/javascript']]),
  ...['client', 'protocol'].map(name => [`/shared/${name}.js`, [`../shared/${name}.js`, 'text/javascript']]),
  ['/ids.js', ['../shared/protocol.js', 'text/javascript']],
]);

export function createStaticAssets() {
  return async ({ request, response, path, method }) => {
    if (!['GET', 'HEAD'].includes(method)) return undefined;
    // Match the original pathname too: URL normalization must not turn an
    // unlisted traversal-like request into an allowed asset.
    if (request.url.split('?')[0] !== path) return undefined;
    const asset = assets.get(path);
    if (!asset) return undefined;
    let content;
    try { content = await readFile(new URL(asset[0], import.meta.url)); }
    catch (error) {
      if (error.code === 'ENOENT') throw new ApiError('NOT_FOUND', 'The requested asset is unavailable.', { status: 404 });
      throw error;
    }
    response.writeHead(200, {
      'Content-Type': `${asset[1]}; charset=utf-8`, 'Content-Length': content.length,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache',
    });
    response.end(method === 'HEAD' ? undefined : content);
    return { handled: true };
  };
}
