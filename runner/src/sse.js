// One pin event is a few KiB. A line that never ends is a broken stream: stop, so the caller connects again.
const MAX_LINE = 1024 * 1024;

// Decode complete SSE records only. Chunks may split UTF-8, lines, or CRLF pairs.
export async function readEvents(body, onEvent, signal) {
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const decoder = new TextDecoder();
  let buffer = "", event = "message", data = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (!line) {
          if (data.length) {
            let parsed;
            try { parsed = JSON.parse(data.join("\n")); } catch { /* Next poll repairs malformed events. */ }
            if (parsed) onEvent(event, parsed);
          }
          event = "message";
          data = [];
        } else if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (buffer.length > MAX_LINE) throw new Error("SSE line too long");
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
