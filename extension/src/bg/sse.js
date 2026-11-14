// One event of the API is far below this limit (a pin is at most about 150 KB of JSON). A
// stream that goes over it is broken; the caller drops it and connects again.
export const EVENT_MAX = 1024 * 1024;

// Input is decoded text. Keep CRLF state across chunks, including an empty chunk.
export function createSSEParser() {
  let line = "";
  let held = 0; // characters in the data lines of the event that is not complete yet
  let skipLF = false;
  let first = true;
  let data = [];
  let event = "";
  let id = "";
  let retry;

  function readLine(events) {
    if (line === "") {
      if (data.length) {
        events.push({ event: event || "message", data: data.join("\n"), id,
          ...(retry === undefined ? {} : { retry }) });
      }
      data = [];
      held = 0;
      event = "";
      return;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      data.push(value);
      held += value.length;
    }
    else if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0")) id = value;
    else if (field === "retry" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) {
      retry = Number(value);
    }
  }

  return {
    feed(chunk) {
      if (typeof chunk !== "string") throw new TypeError("SSE input must be text");
      const events = [];
      for (const char of chunk) {
        if (first) {
          first = false;
          if (char === "\uFEFF") continue;
        }
        if (skipLF) {
          skipLF = false;
          if (char === "\n") continue;
        }
        if (char === "\r" || char === "\n") {
          readLine(events);
          line = "";
          skipLF = char === "\r";
        } else {
          line += char;
          if (line.length + held > EVENT_MAX) throw new RangeError("SSE event is too large");
        }
      }
      return events;
    },
    get retry() { return retry; },
  };
}
