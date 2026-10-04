// Pre-mention MCP adapters validate payloads with a strict schema. Project only
// their JSON responses; stored events, mutation results and batches stay intact.
export function legacyMessageResult(schema, data) {
  const event = value => value.payload.mentions === undefined ? value
    : { ...value, payload: { text: value.payload.text, reply_to: value.payload.reply_to } };
  const history = value => ({ ...value, events: value.events.map(event) });
  if (schema === 'postMessage') return event(data);
  if (schema === 'history') return history(data);
  if (schema === 'joinRoom') return { ...data, history: history(data.history) };
  if (schema === 'receive' && data.kind === 'batch') return { ...data, batch: { ...data.batch, events: data.batch.events.map(event) } };
  return data;
}
