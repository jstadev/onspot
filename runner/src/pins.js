// The runner's client of the Pins server (docs/protocol.md, HTTP): loopback only, as the agent
// "claude", and every request ends after 10 s.
export const API_MS = 10_000;
// The write limit refills in 60 s, so no true Retry-After is longer.
const RETRY_AFTER_MAX = 60;

export function createPins({ fetch, clock, port }) {
  const base = `http://127.0.0.1:${port}`;

  /** GET, or POST when there is a body. Returns the JSON answer. A status that is not 2xx throws
   *  an error with .status and .retryAfter (the Retry-After header in ms, at most 60 s, else 0);
   *  no answer in time throws one without. */
  async function call(path, body) {
    const controller = new AbortController();
    const timeout = clock.setTimeout(() => controller.abort(), API_MS);
    try {
      const response = await fetch(`${base}${path}`, {
        method: body ? "POST" : "GET", redirect: "error", signal: controller.signal,
        ...(body ? { headers: { "Content-Type": "application/json", "X-Pins-Agent": "claude" }, body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const seconds = Number(response.headers.get("retry-after"));
        throw Object.assign(new Error(`Pins HTTP ${response.status}`), { status: response.status,
          retryAfter: seconds > 0 ? Math.min(seconds, RETRY_AFTER_MAX) * 1000 : 0 });
      }
      return await response.json();
    } finally { clock.clearTimeout(timeout); }
  }

  /** GET the raw body, at most maxBytes, then stops reading. A status that is not 2xx throws.
   *  The caller's signal aborts the read; the request also ends after API_MS. */
  async function bytes(path, { signal, maxBytes = 2 * 1024 * 1024 } = {}) {
    const controller = new AbortController();
    const timeout = clock.setTimeout(() => controller.abort(), API_MS);
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(`${base}${path}`, { method: "GET", redirect: "error", signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error(`Pins HTTP ${response.status}`), { status: response.status });
      }
      return await readMax(response, maxBytes);
    } finally {
      clock.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Reads the pins of a status page by page (500, newest first) and hands each page over, so one
   *  page is in memory at a time. */
  async function pages(status, onPage) {
    let before;
    for (;;) {
      const result = await call(`/api/pins?status=${status}&limit=500${before ? `&before=${before}` : ""}`);
      if (!Array.isArray(result.pins)) throw new Error("Invalid pins list");
      await onPage(result.pins);
      if (result.pins.length < 500) return;
      const next = Math.min(...result.pins.map((pin) => pin.id));
      if (!Number.isSafeInteger(next) || next < 1 || (before && next >= before)) throw new Error("Invalid pins cursor");
      before = next;
    }
  }

  return { base, call, pages, bytes };
}

// Keeps the first max bytes and cancels the rest, so a long body cannot grow past the limit.
async function readMax(response, max) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const take = Math.min(value.byteLength, max - total);
      chunks.push(Buffer.from(value.subarray(0, take)));
      total += take;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return total ? Buffer.concat(chunks, total) : Buffer.alloc(0);
}
