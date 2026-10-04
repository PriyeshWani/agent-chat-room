import { createMentionPicker } from './mentions.js';
import { requestId } from './ids.js';

export function createComposer({ client, form, input, sendButton, drafts, onPosted = () => {}, onPending = () => {}, onError = () => {} }) {
  const document = form.ownerDocument;
  const pending = new Map();
  const revisions = new Map();
  const replyEvents = new Map();
  const errors = new Map();
  // local-v1's shared protocol LIMITS.message. Composition imports the client;
  // this DOM component enforces the same wire limit without importing transport.
  const originalMaxLength = input.getAttribute('maxlength');
  input.maxLength = 4000;
  input.setAttribute('maxlength', '4000');
  let room = null;
  let replyTo = null;
  let destroyed = false;
  let composing = false;
  const preview = document.createElement('div');
  const previewText = document.createElement('span');
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.textContent = 'Cancel reply';
  preview.append(previewText, document.createTextNode(' '), cancel);
  preview.hidden = true; form.prepend(preview);
  const errorText = document.createElement('p');
  errorText.setAttribute('role', 'alert'); errorText.hidden = true;
  form.append(errorText);
  const hint = document.getElementById('composer-status');
  const mentionPicker = createMentionPicker({ client, input, form });

  function getPending() {
    return [...pending.values()].map(item => ({
      requestId: item.requestId, roomId: item.roomId, text: item.text, replyTo: item.replyTo,
      ...(item.mentions.length ? { mentions: item.mentions.map(person => ({ ...person })) } : {}),
      status: item.status, error: item.error, retry: () => retry(item.requestId),
    }));
  }
  function updateControls() {
    input.disabled = !room;
    const unresolved = room && [...pending.values()].some(item => item.roomId === room.id);
    const tooManyMentions = mentionPicker.getMentions().length > 20;
    sendButton.disabled = !room || !input.value.trim() || unresolved || tooManyMentions;
    errorText.textContent = room ? (errors.get(room.id)?.message ?? '') : '';
    errorText.hidden = !errorText.textContent;
    preview.hidden = !replyTo;
    if (replyTo) {
      const event = replyEvents.get(replyTo);
      previewText.textContent = event ? `Replying to ${event.author.name}: ${event.payload.text}` : `Replying to message ${replyTo}`;
    } else previewText.textContent = '';
    if (hint) hint.textContent = !room ? 'Select a connected room to send a message.' : unresolved
      ? 'Resolve the unconfirmed message before sending another in this room.'
      : tooManyMentions ? 'Mention up to 20 participants per message.' : '@ to mention · Enter to send · Shift+Enter for a new line';
  }
  function emitPending() {
    if (destroyed) return;
    updateControls(); onPending(getPending());
  }
  function saveDraft() {
    if (!room) return;
    const previous = drafts.get(room.id);
    const mentions = mentionPicker.getMentions();
    if (previous.text !== input.value || previous.replyTo !== replyTo || JSON.stringify(previous.mentions ?? []) !== JSON.stringify(mentions)) {
      drafts.set(room.id, { text: input.value, replyTo, mentions });
      revisions.set(room.id, (revisions.get(room.id) ?? 0) + 1);
    }
  }
  function setRoom(nextRoom) {
    if (destroyed) return;
    saveDraft();
    room = nextRoom ? { ...nextRoom } : null;
    const draft = room ? drafts.get(room.id) : { text: '', replyTo: null };
    input.value = draft.text; replyTo = draft.replyTo;
    mentionPicker.setRoom(room, draft.mentions ?? []);
    composing = false;
    updateControls();
  }
  function setReply(event) {
    if (destroyed || !room || (event && event.room_id !== room.id)) return;
    if (event) replyEvents.set(event.id, { ...event, author: { ...event.author }, payload: { ...event.payload } });
    replyTo = event?.id ?? null;
    saveDraft(); updateControls(); input.focus();
  }
  function cancelReply() { setReply(null); }
  function changed() { mentionPicker.changed(); saveDraft(); updateControls(); }
  async function transmit(item) {
    if (destroyed) return null;
    item.status = 'sending'; item.error = null;
    errors.delete(item.roomId);
    item.controller = new AbortController();
    emitPending();
    if (destroyed) return null;
    let event;
    try {
      event = await client.postMessage(item.roomId, {
        request_id: item.requestId, text: item.text, reply_to: item.replyTo,
        ...(item.mentions.length ? { mention_ids: item.mentions.map(person => person.id) } : {}),
      }, { signal: item.controller.signal });
    } catch (error) {
      if (destroyed) return null;
      errors.set(item.roomId, error);
      const definitive = error.status >= 400 && error.status < 500
        && !['INVALID_RESPONSE', 'VERSION_MISMATCH'].includes(error.code);
      if (definitive) pending.delete(item.requestId);
      else { item.status = 'failed'; item.error = error; }
      emitPending();
      if (!destroyed) onError(error);
      return null;
    }
    if (destroyed) return null;
    // Capture even programmatic edits made without an input event before deciding
    // whether the submitted draft is still the one the user has in progress.
    if (room?.id === item.roomId) saveDraft();
    const draft = drafts.get(item.roomId);
    if ((revisions.get(item.roomId) ?? 0) === item.revision
      && draft.text === item.originalText && draft.replyTo === item.replyTo) {
      drafts.clear(item.roomId);
      if (room?.id === item.roomId) { input.value = ''; replyTo = null; mentionPicker.changed(); }
    }
    pending.delete(item.requestId);
    emitPending();
    if (!destroyed) onPosted(event);
    return event;
  }
  function submit(event) {
    event.preventDefault();
    if (destroyed || composing || !room || !input.value.trim() || mentionPicker.getMentions().length > 20
      || [...pending.values()].some(item => item.roomId === room.id)) return;
    saveDraft();
    const item = {
      requestId: requestId(), roomId: room.id,
      text: input.value.trim(), originalText: input.value, replyTo,
      mentions: mentionPicker.getMentions(),
      revision: revisions.get(room.id) ?? 0, status: 'sending', error: null, controller: null,
    };
    pending.set(item.requestId, item);
    mentionPicker.close();
    void transmit(item);
  }
  async function retry(requestId) {
    if (destroyed) return null;
    const item = pending.get(requestId);
    if (!item || item.status !== 'failed'
      || [...pending.values()].some(other => other.roomId === item.roomId && other.status === 'sending')) return null;
    return transmit(item);
  }
  function keydown(event) {
    if (!composing && mentionPicker.keydown(event)) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) submit(event);
  }
  function compositionStart() { composing = true; }
  function compositionEnd() { composing = false; }
  function destroy() {
    if (destroyed) return;
    saveDraft(); destroyed = true;
    mentionPicker.destroy();
    for (const item of pending.values()) item.controller?.abort();
    form.removeEventListener('submit', submit);
    input.removeEventListener('input', changed);
    input.removeEventListener('keydown', keydown);
    input.removeEventListener('compositionstart', compositionStart);
    input.removeEventListener('compositionend', compositionEnd);
    cancel.removeEventListener('click', cancelReply);
    preview.remove(); errorText.remove();
    if (originalMaxLength === null) input.removeAttribute('maxlength');
    else input.setAttribute('maxlength', originalMaxLength);
    input.disabled = true; sendButton.disabled = true;
  }
  form.addEventListener('submit', submit);
  input.addEventListener('input', changed);
  input.addEventListener('keydown', keydown);
  input.addEventListener('compositionstart', compositionStart);
  input.addEventListener('compositionend', compositionEnd);
  cancel.addEventListener('click', cancelReply);
  updateControls();
  return { setRoom, setReply, retry, getPending, destroy };
}
