const PREFIX = 'agent-chat-room-draft:';
const empty = () => ({ text: '', replyTo: null });
const validMention = person => person && typeof person.id === 'string' && person.id.length > 0 && person.id.length <= 128
  && typeof person.name === 'string' && person.name.length > 0 && person.name.length <= 80 && ['human', 'agent'].includes(person.kind);
const withMentions = mentions => mentions?.length ? { mentions: mentions.map(({ id, name, kind }) => ({ id, name, kind })) } : {};

export function createDraftStore({ storage } = {}) {
  const drafts = new Map();
  if (storage === undefined) {
    try { storage = globalThis.localStorage; } catch { /* Memory remains available. */ }
  }
  const key = roomId => `${PREFIX}${encodeURIComponent(roomId)}`;
  function get(roomId) {
    if (!drafts.has(roomId)) {
      let draft = empty();
      try {
        const saved = JSON.parse(storage?.getItem(key(roomId)) ?? 'null');
        if (saved && typeof saved.text === 'string' && (saved.replyTo === null || typeof saved.replyTo === 'string')) {
          draft = { text: saved.text, replyTo: saved.replyTo,
            ...withMentions(Array.isArray(saved.mentions) && saved.mentions.every(validMention) ? saved.mentions : []) };
        }
      } catch { /* Ignore malformed or unavailable persistence. */ }
      drafts.set(roomId, draft);
    }
    const draft = drafts.get(roomId);
    return { ...draft, ...withMentions(draft.mentions) };
  }
  function set(roomId, { text, replyTo, mentions = [] }) {
    if (typeof text !== 'string' || (replyTo !== null && typeof replyTo !== 'string')) {
      throw new TypeError('A draft needs text and a reply event ID or null.');
    }
    if (!Array.isArray(mentions) || !mentions.every(validMention)) throw new TypeError('Invalid draft mentions.');
    const draft = { text, replyTo, ...withMentions(mentions) };
    drafts.set(roomId, draft);
    try { storage?.setItem(key(roomId), JSON.stringify(draft)); } catch { /* Keep memory copy. */ }
  }
  function clear(roomId) {
    // Keep a tombstone so a failed removal cannot resurrect this page's old draft.
    drafts.set(roomId, empty());
    try { storage?.removeItem(key(roomId)); } catch { /* Keep memory cleared. */ }
  }
  return { get, set, clear };
}
