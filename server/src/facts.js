// What `pins snap` measured on the pinned element, kept per pin so that a later call can compare. Zero dependencies.
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ID, ID_RE } from "./id.js";

const KINDS = ["before", "after", "check"];
const FILE_RE = new RegExp(`^${ID}-(?:${KINDS.join("|")})\\.json$`);
const KEEP_DAYS = 30;
const STYLE_KEYS = ["color", "background", "font", "margin", "padding", "display", "gap", "radius", "opacity", "border"];
const LAYOUT_STYLES = ["display", "margin", "padding", "gap"];
const factsDir = () => process.env.PINS_FACTS_DIR || "/var/lib/onspot-runner/facts";

// The values come from the web page: keep only the known keys, as short strings and integers.
const clip = (value, max) => String(value ?? "").slice(0, max);
export function cleanFacts(facts) {
  const url = clip(facts?.url, 2048);
  const at = clip(facts?.at, 40);
  if (facts?.found !== true) return { found: false, url, at };
  const rect = Object.fromEntries(["x", "y", "w", "h"].map((key) => [key, Math.round(Number(facts.rect?.[key])) || 0]));
  const styles = Object.fromEntries(STYLE_KEYS.map((key) => [key, clip(facts.styles?.[key], 200)]));
  return { found: true, text: clip(facts.text, 300), rect, styles, url, at };
}

function factsFile(id, kind, dir) {
  if (!ID_RE.test(String(id))) throw new TypeError("id must be a positive integer of at most 12 digits");
  if (!KINDS.includes(kind)) throw new TypeError(`kind must be one of ${KINDS.join(", ")}`);
  return join(dir, `${id}-${kind}.json`);
}

/**
 * Writes the facts of one pin and kind (mode 0600 in a 0700 dir), then removes the facts files that are older
 * than 30 days, so the dir holds one month of snaps at most. Returns false when the write fails.
 */
export function saveFacts(id, kind, facts, dir = factsDir()) {
  const file = factsFile(id, kind, dir);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(cleanFacts(facts)), { mode: 0o600 });
  } catch {
    return false;
  }
  pruneFacts(dir);
  return true;
}

/**
 * Removes the facts files whose last write is more than maxAgeDays ago; returns how many. Other files stay.
 * It never throws: a cleanup must not fail the snap that started it.
 */
export function pruneFacts(dir = factsDir(), maxAgeDays = KEEP_DAYS) {
  const cutoff = Date.now() - maxAgeDays * 86400000;
  let removed = 0;
  let names = [];
  try { names = readdirSync(dir); } catch { /* No dir, nothing to remove. */ }
  for (const name of names) {
    if (!FILE_RE.test(name)) continue;
    const file = join(dir, name);
    try {
      // lstat: a link is judged and removed as a link.
      if (lstatSync(file).mtimeMs >= cutoff) continue;
      rmSync(file, { force: true });
      removed++;
    } catch { /* Another snap removed it, or it is not ours to remove. */ }
  }
  return removed;
}

/** The saved facts, or null when the file is missing or bad. */
export function loadFacts(id, kind, dir = factsDir()) {
  const file = factsFile(id, kind, dir);
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return data && typeof data === "object" ? cleanFacts(data) : null;
  } catch {
    return null;
  }
}

/** Removes facts of an earlier run (a new "before" shot starts a new run). Never throws on I/O errors. */
export function clearFacts(id, kinds, dir = factsDir()) {
  for (const kind of kinds) {
    const file = factsFile(id, kind, dir);
    try { rmSync(file, { force: true }); } catch { /* The next save replaces it. */ }
  }
}

const differs = (a, b) => Math.abs(a - b) >= 1;

// What changed on the element: kinds, and the names of the style properties. Never a page value.
function changes(before, after) {
  if (!after.found) return { kinds: ["gone"], props: [] };
  const props = STYLE_KEYS.filter((key) => before.styles[key] !== after.styles[key]);
  const kinds = [
    before.text !== after.text && "text",
    props.length && "style",
    (differs(before.rect.w, after.rect.w) || differs(before.rect.h, after.rect.h)) && "size",
    (differs(before.rect.x, after.rect.x) || differs(before.rect.y, after.rect.y)) && "position",
  ].filter(Boolean);
  return { kinds, props };
}

// The change that each intent asks for, and the line for "it did not happen".
const WANTED = {
  text: { kinds: ["text"], none: "the text did not change" },
  style: { kinds: ["style", "size"], none: "the look did not change" },
  layout: { kinds: ["size", "position"], none: "position and size did not change" },
};

/**
 * Did the pinned element change the way the pin asks? A pure function.
 * Returns { ok: true | false | null, text }; null means that the facts cannot say.
 */
export function judge(intent, before, after) {
  if (!before?.found) return { ok: null, text: "check: no before facts (a signed-out visitor did not see the element)" };
  if (!after) return { ok: null, text: "check: no after facts" };
  const { kinds, props } = changes(before, after);
  const gone = kinds.includes("gone");
  if (intent === "remove") return gone ? { ok: true, text: "check: the element is gone" } : { ok: false, text: "check: the element is still on the page" };
  const wanted = WANTED[intent];
  if (!wanted && gone) return { ok: true, text: "check: the element is gone" };
  // Content above the element can move it. Without an intent, a move alone says nothing about the element.
  if (!wanted && kinds.length === 1 && kinds[0] === "position") return { ok: null, text: "check: only the position moved" };
  const done = wanted
    ? wanted.kinds.some((kind) => kinds.includes(kind)) || (intent === "layout" && props.some((key) => LAYOUT_STYLES.includes(key)))
    : kinds.length > 0;
  if (!done) return { ok: false, text: `check: ${gone ? "the element is gone" : wanted?.none ?? "nothing changed on the pinned element"}` };
  return { ok: true, text: `check: changed ${kinds.join(", ")}${props.length ? ` (${props.slice(0, 3).join(", ")})` : ""}` };
}
