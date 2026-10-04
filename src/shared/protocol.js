export const VERSION = '1';
export const API_PATH = '/api/v1';
export const LIMITS = Object.freeze({ message: 4000, batch: 100, history: 100, waitMs: 20000, bodyBytes: 32768 });

export class ApiError extends Error {
  constructor(code, message, { status = 400, retryable = false, details } = {}) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, { code, status, retryable, details });
  }
}

export function requestId() {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  // getRandomValues also works on HTTP LAN pages, where randomUUID is absent.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

// Portable minimum event validation; full schemas are enforced by the hub.
export function isRoomEvent(event) {
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
  return event !== null && typeof event === 'object'
    && id(event.id) && id(event.room_id) && event.kind === 'message'
    && Number.isSafeInteger(event.sequence) && event.sequence > 0
    && event.author && id(event.author.id) && typeof event.author.name === 'string'
    && event.author.name.length > 0 && event.author.name.length <= 80
    && ['human', 'agent'].includes(event.author.kind)
    && event.payload && typeof event.payload.text === 'string'
    && event.payload.text.length > 0 && event.payload.text.length <= LIMITS.message
    && (event.payload.reply_to === null || id(event.payload.reply_to))
    && (event.payload.mentions === undefined || (Array.isArray(event.payload.mentions) && event.payload.mentions.length <= 20
      && event.payload.mentions.every(person => person && id(person.id) && typeof person.name === 'string'
        && person.name.length > 0 && person.name.length <= 80 && ['human', 'agent'].includes(person.kind))
      && new Set(event.payload.mentions.map(person => person.id)).size === event.payload.mentions.length))
    && typeof event.created_at === 'string' && Number.isFinite(Date.parse(event.created_at));
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function success(data) { return { version: VERSION, data }; }
export function failure(error) {
  return { version: VERSION, error: {
    code: error.code ?? 'INTERNAL_ERROR',
    message: error.code ? error.message : 'The hub could not complete this request.',
    retryable: error.retryable === true,
    ...(error.details === undefined ? {} : { details: error.details }),
  } };
}
