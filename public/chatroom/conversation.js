import { mentionRanges } from './mentions.js';

const copyEvent = event => ({ ...event, author: { ...event.author }, payload: { ...event.payload,
  ...(event.payload.mentions ? { mentions: event.payload.mentions.map(person => ({ ...person })) } : {}) } });

// Stable across history pagination, room changes and refreshes. Names remain
// visible so attribution never depends on color alone.
export function participantAppearance(participant) {
  let hash = 0;
  for (const char of participant.id) hash = (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0;
  const words = participant.name.trim().split(/\s+/u);
  const initials = words.length > 1
    ? Array.from(words[0])[0] + Array.from(words.at(-1))[0]
    : Array.from(words[0]).slice(0, 2).join('');
  return { hue: hash % 360, initials: initials.toLocaleUpperCase() || '?' };
}

export function createConversationView({ element, onReply = () => {} }) {
  const document = element.ownerDocument;
  let events = new Map();
  let pending = [];
  let destroyed = false;
  let viewer = null;
  const nodes = new Map();
  const originalAnchor = element.style.overflowAnchor;
  element.style.overflowAnchor = 'none';
  const getEvents = () => [...events.values()].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)).map(copyEvent);
  function textNode(tag, text, className) {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function eventNode(event) {
    const parent = events.get(event.payload.reply_to);
    const own = event.author.id === viewer?.id;
    const fingerprint = JSON.stringify([event, parent?.author.name, parent?.payload.text, own, viewer?.id]);
    const cached = nodes.get(event.id);
    if (cached?.fingerprint === fingerprint) return cached.node;
    const article = document.createElement('article');
    article.dataset.eventId = event.id;
    article.id = `message-${encodeURIComponent(event.id)}`;
    article.tabIndex = -1;
    const bubble = messageLayout(article, event.author, own);
    if (event.payload.mentions?.some(person => person.id === viewer?.id)) article.classList.add('message--mentioned');
    const byline = document.createElement('header');
    byline.className = 'message-byline';
    byline.append(textNode('strong', event.author.name), textNode('span', event.author.kind === 'human' ? 'Human' : 'Agent', 'message-role'));
    const date = new Date(event.created_at);
    const validDate = Number.isFinite(date.getTime());
    const time = textNode('time', validDate ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : event.created_at);
    time.dateTime = event.created_at;
    time.title = validDate ? date.toLocaleString() : event.created_at;
    byline.append(time);
    bubble.append(byline);
    appendAddresses(bubble, event.payload.mentions ?? []);
    if (event.payload.reply_to) {
      const reference = parent
        ? textNode('a', `In reply to ${parent.author.name}`)
        : textNode('p', `In reply to message ${event.payload.reply_to}`);
      reference.className = 'message-reference';
      if (parent) {
        reference.href = `#message-${encodeURIComponent(parent.id)}`;
        const preview = Array.from(parent.payload.text.replace(/\s+/gu, ' '));
        reference.append(textNode('span', preview.slice(0, 100).join('') + (preview.length > 100 ? '…' : ''), 'message-reply-preview'));
      }
      bubble.append(reference);
    }
    bubble.append(messageText(event.payload.text, event.payload.mentions ?? []));
    const reply = textNode('button', 'Reply');
    reply.type = 'button';
    reply.dataset.replyId = event.id;
    reply.setAttribute('aria-label', `Reply to ${event.author.name}`);
    reply.className = 'message-reply';
    bubble.append(reply);
    nodes.set(event.id, { fingerprint, node: article });
    return article;
  }
  function appendAddresses(bubble, mentions) {
    if (!mentions.length) return;
    const row = textNode('div', 'To ', 'message-addresses');
    for (const person of mentions) {
      const chip = textNode('span', `@${person.name}`, 'mention-chip');
      chip.dataset.mentionedId = person.id;
      chip.title = `${person.kind === 'human' ? 'Human' : 'Agent'} · ${person.id}`;
      if (person.id === viewer?.id) { chip.classList.add('mention-chip--you'); chip.setAttribute('aria-label', `@${person.name}, mentioned you`); }
      row.append(chip);
    }
    bubble.append(row);
  }
  function messageText(text, mentions) {
    const paragraph = textNode('p', '', 'message-text');
    let offset = 0;
    for (const range of mentionRanges(text, mentions)) {
      paragraph.append(document.createTextNode(text.slice(offset, range.start)));
      paragraph.append(textNode('mark', text.slice(range.start, range.end), 'mention-text'));
      offset = range.end;
    }
    paragraph.append(document.createTextNode(text.slice(offset)));
    return paragraph;
  }
  function messageLayout(article, author, own) {
    const appearance = participantAppearance(author);
    article.className = `message message--${author.kind}${own ? ' message--own' : ''}`;
    article.dataset.authorId = author.id;
    article.style.setProperty('--author-hue', String(appearance.hue));
    const avatar = textNode('span', appearance.initials, 'participant-avatar');
    avatar.setAttribute('aria-hidden', 'true');
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    article.append(avatar, bubble);
    return bubble;
  }
  function pendingNode(item) {
    const article = document.createElement('article');
    article.dataset.requestId = item.requestId;
    const bubble = messageLayout(article, viewer ?? { id: 'local-pending', name: 'You', kind: 'human' }, true);
    bubble.append(textNode('strong', item.status === 'sending' ? 'Sending · unconfirmed' : 'Send failed · unconfirmed', 'message-send-status'));
    if (item.replyTo) bubble.append(textNode('p', `In reply to message ${item.replyTo}`, 'message-reference'));
    appendAddresses(bubble, item.mentions ?? []);
    bubble.append(messageText(item.text, item.mentions ?? []));
    if (item.status === 'failed') {
      if (item.error) bubble.append(textNode('p', item.error.message ?? String(item.error)));
      if (typeof item.retry === 'function') {
        const retry = textNode('button', 'Retry sending');
        retry.type = 'button'; retry.dataset.retryId = item.requestId;
        bubble.append(retry);
      }
    }
    return article;
  }
  function render() {
    const previousTop = element.scrollTop;
    const atBottom = element.scrollHeight - element.clientHeight - previousTop <= 48;
    const top = element.getBoundingClientRect().top;
    const anchor = [...element.children].find(node => node.dataset.eventId && node.getBoundingClientRect().bottom > top);
    const anchorId = anchor?.dataset.eventId;
    const anchorTop = anchor?.getBoundingClientRect().top;
    const focused = document.activeElement;
    const focusedReply = element.contains(focused) ? focused.dataset?.replyId : null;
    const focusedRetry = element.contains(focused) ? focused.dataset?.retryId : null;
    element.replaceChildren(...getEvents().map(eventNode), ...pending.map(pendingNode));
    for (const id of nodes.keys()) if (!events.has(id)) nodes.delete(id);
    if (atBottom) element.scrollTop = element.scrollHeight;
    else {
      const nextAnchor = anchorId ? nodes.get(anchorId)?.node : null;
      element.scrollTop = nextAnchor ? previousTop + nextAnchor.getBoundingClientRect().top - anchorTop : previousTop;
    }
    if (focusedReply || focusedRetry) {
      [...element.querySelectorAll('button')].find(button => focusedReply
        ? button.dataset.replyId === focusedReply : button.dataset.retryId === focusedRetry)?.focus({ preventScroll: true });
    }
  }
  function setEvents(items) {
    if (destroyed) return;
    events = new Map();
    for (const event of items) if (!events.has(event.id)) events.set(event.id, copyEvent(event));
    render();
  }
  function addEvents(items) {
    if (destroyed) return;
    for (const event of items) if (!events.has(event.id)) events.set(event.id, copyEvent(event));
    render();
  }
  function setPending(items) {
    if (destroyed) return;
    pending = items.map(item => ({ ...item, ...(item.mentions ? { mentions: item.mentions.map(person => ({ ...person })) } : {}) }));
    render();
  }
  function setViewer(participant) {
    if (destroyed) return;
    viewer = participant ? { ...participant } : null;
    render();
  }
  function clicked(event) {
    const button = event.target.closest('button');
    if (!button || !element.contains(button)) return;
    const roomEvent = events.get(button.dataset.replyId);
    if (roomEvent) onReply(copyEvent(roomEvent));
    else pending.find(item => item.requestId === button.dataset.retryId)?.retry?.();
  }
  function clear() {
    if (destroyed) return;
    events.clear(); pending = []; nodes.clear(); element.replaceChildren(); element.scrollTop = 0;
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    element.removeEventListener('click', clicked);
    element.style.overflowAnchor = originalAnchor;
    nodes.clear(); pending = []; events.clear();
  }
  element.addEventListener('click', clicked);
  return { setEvents, addEvents, setPending, setViewer, getEvents, clear, destroy };
}
