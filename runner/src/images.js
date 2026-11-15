// The images of a pin, saved before the session starts (docs/protocol.md, Auto-fix runner, item 17).
// The session opens each file with the Read tool. A failed image never stops the run.
import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createPins } from "./pins.js";

export const IMAGE_MS = 5_000;
export const IMAGE_MAX = 2 * 1024 * 1024;
const IMAGE_COUNT = 12;
const KEEP_MS = 30 * 86400000;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** The image type that the first bytes name, or null. Same rules as a shot. */
export function imageType(bytes) {
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * Saves the images of one pin (at most 12) into dir as `<pinId>-<n>.<ext>`. Returns one entry per
 * image, a path or null, in order. The downloads share one 5 s limit. A failure logs
 * `image skipped pin=<id> n=<n>` and never throws. A caller that starts every pin of a run before
 * it waits keeps the whole run inside that same window.
 */
export async function savePinImages({ pin, fetch, clock, port, dir, log = () => {} } = {}) {
  const list = imageList(pin);
  if (!list.length) return [];
  const paths = new Array(list.length).fill(null);
  const logged = new Set();
  const skip = (n) => {
    if (logged.has(n)) return;
    logged.add(n);
    try { log(`image skipped pin=${pin.id} n=${n}`); } catch { /* a log must not stop the run */ }
  };
  if (!Number.isSafeInteger(pin.id) || pin.id < 1 || typeof dir !== "string" || !isAbsolute(dir)) {
    list.forEach((_, index) => skip(index + 1));
    return paths;
  }
  const controller = new AbortController();
  const timer = clock.setTimeout(() => controller.abort(), IMAGE_MS);
  const stopped = new Promise((resolve) => {
    if (controller.signal.aborted) resolve();
    else controller.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  const pins = createPins({ fetch, clock, port });
  const tasks = list.map((image, index) => loadOne({ image, index, pin, dir, pins, controller, paths, skip }));
  const done = Promise.all(tasks);
  try {
    await Promise.race([done, stopped]);
    if (controller.signal.aborted) {
      for (let index = 0; index < list.length; index++) if (paths[index] === null) skip(index + 1);
    }
    await done;
    return paths;
  } catch {
    list.forEach((_, index) => { if (paths[index] === null) skip(index + 1); });
    return paths;
  } finally {
    clock.clearTimeout(timer);
  }
}

function imageList(pin) {
  if (!pin || pin.revert || !Array.isArray(pin.images)) return [];
  return pin.images.slice(0, IMAGE_COUNT);
}

async function loadOne({ image, index, pin, dir, pins, controller, paths, skip }) {
  const n = index + 1;
  try {
    if (controller.signal.aborted) throw new Error("aborted");
    if (typeof image?.id !== "string" || !ID_RE.test(image.id)) throw new Error("id");
    const bytes = await pins.bytes(`/api/images/${image.id}`, { signal: controller.signal, maxBytes: IMAGE_MAX });
    if (controller.signal.aborted) throw new Error("aborted");
    const type = imageType(bytes);
    const ext = EXT[type];
    if (!ext) throw new Error("type");
    paths[index] = writePrivate(dir, `${pin.id}-${n}.${ext}`, bytes);
  } catch {
    paths[index] = null;
    skip(n);
  }
}

// mode 0600 in a 0700 folder. A temp file plus rename, so a reader never sees a partial image.
function writePrivate(dir, name, bytes) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, name);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, bytes, { mode: 0o600, flush: true });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* already gone */ }
    throw error;
  }
  prune(dir);
  return file;
}

// Removes files in the folder whose last write is more than 30 days ago. A directory stays.
// A link is removed as a link. It never throws: a cleanup must not fail the save that started it.
function prune(dir) {
  const cutoff = Date.now() - KEEP_MS;
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const file = join(dir, name);
    try {
      const stat = lstatSync(file);
      if (stat.isDirectory() || stat.mtimeMs >= cutoff) continue;
      rmSync(file, { force: true });
    } catch { /* another save removed it, or it is not ours to remove */ }
  }
}
