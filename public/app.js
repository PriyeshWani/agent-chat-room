const status = document.querySelector('#status');
const list = document.querySelector('#messages');
const form = document.querySelector('#composer');
const input = document.querySelector('#message');
const error = document.querySelector('#error');
let rendered = '';

function item(label, text, detail) {
  const element = document.createElement('li');
  const heading = document.createElement('strong');
  heading.textContent = label;
  const content = document.createElement('p');
  content.textContent = text;
  const footer = document.createElement('small');
  footer.textContent = detail;
  element.append(heading, content, footer);
  return element;
}

async function refresh() {
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const state = await response.json();
    status.textContent = state.client
      ? `MCP client: ${state.client.name} · ${state.waiting ? 'Waiting for your message' : 'Connected; no receive call is waiting'}`
      : 'No MCP client connected. Launch with npm run codex for an agent reply.';
    const next = JSON.stringify([state.messages, state.replies]);
    if (next === rendered) return;
    rendered = next;
    list.replaceChildren();
    for (const message of state.messages) {
      const reply = state.replies.find((entry) => entry.in_reply_to === message.id);
      list.append(item('You', message.text, `#${message.id} · ${reply ? 'Replied' : message.delivered_at ? 'Returned through MCP' : 'Queued'}`));
      if (reply) list.append(item('Agent', reply.text, `Reply to #${message.id}`));
    }
    for (const reply of state.replies.filter((entry) => entry.in_reply_to === null)) {
      list.append(item('Agent', reply.text, 'Agent message'));
    }
  } catch {
    status.textContent = 'Bridge disconnected. Check the terminal running the probe.';
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch('/api/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: input.value }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    input.value = '';
    await refresh();
  } catch (failure) {
    error.textContent = failure.message || 'Could not send the message.';
  } finally {
    button.disabled = false;
    input.focus();
  }
});

async function poll() {
  await refresh();
  setTimeout(poll, 500);
}
poll();
