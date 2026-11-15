// Pins, replies, steps and image metadata in SQLite (node:sqlite, no native modules); shots and images in files. Validates
// every write and emits a "change" event after it. The HTTP API, SSE and MCP all go through this module.
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ID } from "./id.js";
import { IMAGE_ID_RE, SHOT_KINDS, SHOT_MAX, SHOT_TYPES, shotType } from "./shots.js";

export class ValidationError extends Error {
  status = 400;
}
export class ForbiddenError extends Error {
  status = 403;
}
export class ConflictError extends Error {
  status = 409;
}

export const STATUSES = ["queued", "working", "waiting", "done", "dismissed"];
const OPEN = ["queued", "working", "waiting"];
const TRANSITIONS = {
  start: { from: ["queued"], to: "working" },
  resolve: { from: ["queued", "working", "waiting"], to: "done" },
  dismiss: { from: ["queued", "working", "waiting"], to: "dismissed" },
  ask: { from: ["queued", "working"], to: "waiting" },
  reopen: { from: ["working", "waiting", "done", "dismissed"], to: "queued" },
  accept: { from: ["done"], to: "done" },
  revert: { from: ["done", "dismissed"], to: "queued" },
};
// Only he can accept a result or go back to an earlier version.
const USER_ONLY = { accept: "accept a pin", revert: "go back to an earlier version" };
// A version is one live fix commit; a git sha of 7 to 40 hex characters. The list keeps the newest.
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;
const VERSIONS_MAX = 30;
// The reply that a resolve writes: "Done: <summary> (<commit>)". The first open of a v3.5 file reads the versions from it.
const DONE_REPLY_RE = /^Done: ([\s\S]*) \(([0-9a-f]{7,40})\)$/i;
export const BATCH_MAX = 30;
const KEY_RE = /^[A-Za-z0-9_-]{8,80}$/;
const ATTR_KEYS = ["id", "class", "role", "aria-label", "href", "src", "alt", "name", "type", "placeholder", "data-testid", "data-slot", "data-component", "title"];
const INTENTS = ["text", "style", "layout", "behaviour", "remove", "task"];
const SCOPES = ["element", "similar", "page", "site"];
const STEP_MAX = 40;
// A shot file, or the temp file of an upload that did not finish.
const SHOT_FILE_RE = new RegExp(`^(${ID})-(?:${SHOT_KINDS.join("|")})(?:\\.tmp)?$`);
// An image file, or its temp file. Images per pin input or reply, per pin, and unlinked on the server.
const IMAGE_FILE_RE = /^([A-Za-z0-9_-]{22})(?:\.tmp)?$/;
const IMAGES_PER_INPUT = 6;
const IMAGES_PER_PIN = 12;
const IMAGES_WAITING = 200;
// Columns that newer versions added; an older file gets them on open.
const ADDED_COLUMNS = [["run", "TEXT"], ["batch", "INTEGER"], ["model", "TEXT"], ["attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["intent", "TEXT"], ["scope", "TEXT"], ["presets", "TEXT"], ["shot_before", "TEXT"], ["shot_after", "TEXT"],
  ["accepted_at", "TEXT"], ["reopens", "INTEGER"], ["versions", "TEXT"], ["revert", "TEXT"], ["reverted_at", "TEXT"]];
const BULK_DEFAULT = { on: false, delegate: false, agents: 3 };
const isFlag = (v) => typeof v === "boolean";
const BULK_CHECKS = { on: isFlag, delegate: isFlag, agents: (v) => Number.isInteger(v) && v >= 1 && v <= 8 };
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const PINS_SCHEMA = `
CREATE TABLE IF NOT EXISTS pins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','working','waiting','done','dismissed')),
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT,
  note TEXT NOT NULL,
  quote TEXT,
  targets TEXT NOT NULL,
  viewport TEXT,
  author TEXT,
  agent TEXT,
  summary TEXT,
  commit_ref TEXT,
  run TEXT,
  batch INTEGER,
  model TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  intent TEXT,
  scope TEXT,
  presets TEXT,
  shot_before TEXT,
  shot_after TEXT,
  accepted_at TEXT,
  reopens INTEGER,
  versions TEXT,
  revert TEXT,
  reverted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  closed_at TEXT
);
`;
const SCHEMA = `
CREATE INDEX IF NOT EXISTS pins_status ON pins(status, id);
CREATE INDEX IF NOT EXISTS pins_host_status ON pins(host, status, id);
CREATE INDEX IF NOT EXISTS pins_batch ON pins(batch);
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  author TEXT,
  client_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pin_id INTEGER NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('user','agent')),
  author TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS replies_pin ON replies(pin_id, id);
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pin_id INTEGER NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
  author TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS steps_pin ON steps(pin_id, id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  pin_id INTEGER REFERENCES pins(id) ON DELETE CASCADE,
  reply_id INTEGER,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  author TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS images_pin ON images(pin_id, created_at);
`;

// `l` is the latest step of the pin; the steps table holds only the current run.
const SELECT_PIN = `SELECT p.*, (SELECT COUNT(*) FROM replies r WHERE r.pin_id = p.id) AS reply_count,
  (SELECT COUNT(*) FROM steps s WHERE s.pin_id = p.id) AS step_count, l.body AS step_body, l.created_at AS step_at
  FROM pins p LEFT JOIN steps l ON l.id = (SELECT MAX(s.id) FROM steps s WHERE s.pin_id = p.id)`;

function migrate(db) {
  // Disable cascades before the transaction so replacing pins cannot delete replies.
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(PINS_SCHEMA);
      const existing = new Set(db.prepare("PRAGMA table_info(pins)").all().map(({ name }) => name));
      const backfill = !existing.has("versions");
      for (const [name, type] of ADDED_COLUMNS) {
        if (!existing.has(name)) db.exec(`ALTER TABLE pins ADD COLUMN ${name} ${type};`);
      }
      const { sql } = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'pins'").get();
      if (!/CHECK\s*\(\s*status\s+IN\s*\([^)]*'waiting'/i.test(sql)) {
        const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'pins'").get();
        const columns = db.prepare("PRAGMA table_info(pins)").all().map(({ name }) => `"${name.replaceAll('"', '""')}"`).join(", ");
        db.exec(PINS_SCHEMA.replace("IF NOT EXISTS pins", "pins_new"));
        db.exec(`INSERT INTO pins_new (${columns}) SELECT ${columns} FROM pins;
          DROP TABLE pins;
          ALTER TABLE pins_new RENAME TO pins;`);
        if (sequence) {
          db.exec("DELETE FROM sqlite_sequence WHERE name = 'pins';");
          db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('pins', ?)").run(sequence.seq);
        }
      }
      db.exec(SCHEMA);
      if (backfill) backfillVersions(db);
      if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("database has invalid foreign keys");
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

// Before v3.5 a pin kept only its latest commit. Its own "Done: <summary> (<commit>)" replies hold every fix, oldest first.
function backfillVersions(db) {
  const found = new Map();
  for (const { pin_id: id, body, created_at: at } of db.prepare("SELECT pin_id, body, created_at FROM replies WHERE body LIKE 'Done: %' ORDER BY id").all()) {
    const match = DONE_REPLY_RE.exec(body);
    if (!match) continue;
    const list = found.get(id) ?? [];
    if (!list.some((v) => v.commit === match[2])) list.push({ commit: match[2], summary: clip(match[1].trim(), 300), at });
    found.set(id, list);
  }
  const write = db.prepare("UPDATE pins SET versions = ? WHERE id = ?");
  for (const [id, list] of found) write.run(JSON.stringify(list.slice(-VERSIONS_MAX)), id);
}

/** "open" (default), "all", or a comma list of statuses. */
export function parseStatuses(value) {
  const s = String(value ?? "open").trim().toLowerCase() || "open";
  if (s === "open") return OPEN;
  if (s === "all") return STATUSES;
  const list = [...new Set(s.split(",").map((x) => x.trim()).filter(Boolean))];
  const bad = list.find((x) => !STATUSES.includes(x));
  if (bad || !list.length) throw new ValidationError(`unknown status "${bad ?? s}"`);
  return list;
}

// Captured page data is clipped; text the user or an agent wrote is rejected when too long.
// No clipped value ends with half a character (the first unit of a surrogate pair). The cut here can leave one,
// and a value can arrive with one: the extension cuts label and text itself.
function clip(v, max) {
  if (typeof v !== "string") return undefined;
  const cut = v.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

// The reply that a resolve or a dismiss writes. The summary may use all 4000 characters: its text is cut, the commit stays.
function closing(verb, text, ref) {
  const tail = ref ? ` (${ref})` : "";
  return `${verb}: ${clip(text, 4000 - verb.length - 2 - tail.length)}${tail}`;
}

function required(v, max, name) {
  if (typeof v !== "string" || !v.trim()) throw new ValidationError(`${name} is required`);
  const s = v.trim();
  if (s.length > max) throw new ValidationError(`${name} is longer than ${max} characters`);
  return s;
}

function optional(v, max, name) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new ValidationError(`${name} must be text`);
  if (!v.trim()) throw new ValidationError(`${name} must not be blank`);
  return required(v, max, name);
}

// JSON carries numbers like 1e999 (Infinity) and 1e300. Only a safe integer is a coordinate.
function int(v) {
  const n = Math.round(v);
  return typeof v === "number" && Number.isSafeInteger(n) ? n : undefined;
}

function choice(v, names, name) {
  if (v === undefined || v === null) return null;
  if (!names.includes(v)) throw new ValidationError(`${name} must be one of ${names.join(", ")}`);
  return v;
}

// His own instructions: like the note, they are rejected when too long, never clipped.
function cleanPresets(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 6) throw new ValidationError("presets must hold 0 to 6 presets");
  return v.map((p) => {
    if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some((k) => k !== "label" && k !== "text")) {
      throw new ValidationError("each preset must hold only a label and a text");
    }
    return { label: required(p.label, 40, "preset label"), text: required(p.text, 500, "preset text") };
  });
}

function cleanTarget(t) {
  if (!t || typeof t !== "object" || Array.isArray(t)) throw new ValidationError("each target must be an object");
  const out = {
    selector: required(t.selector, 500, "target selector"),
    label: required(clip(t.label, 160), 160, "target label"),
  };
  if (typeof t.tag === "string") out.tag = clip(t.tag.toLowerCase(), 40);
  if (typeof t.text === "string") out.text = clip(t.text, 300);
  if (t.attrs && typeof t.attrs === "object") {
    const attrs = {};
    for (const k of ATTR_KEYS) if (typeof t.attrs[k] === "string") attrs[k] = clip(t.attrs[k], 200);
    if (Object.keys(attrs).length) out.attrs = attrs;
  }
  if (t.rect && typeof t.rect === "object") {
    const r = { x: int(t.rect.x), y: int(t.rect.y), w: int(t.rect.w), h: int(t.rect.h) };
    if (Object.values(r).every((n) => n !== undefined)) out.rect = r;
  }
  if (t.styles && typeof t.styles === "object") {
    const styles = {};
    for (const [k, v] of Object.entries(t.styles).slice(0, 12)) {
      // "constructor" fits the pattern of a CSS property name; no name of Object.prototype is a style.
      if (/^[a-z-]{1,40}$/.test(k) && !(k in Object.prototype) && typeof v === "string") styles[k] = clip(v, 120);
    }
    if (Object.keys(styles).length) out.styles = styles;
  }
  if (Array.isArray(t.ancestors)) {
    const a = t.ancestors.filter((x) => typeof x === "string").slice(0, 6).map((x) => clip(x, 80));
    if (a.length) out.ancestors = a;
  }
  return out;
}

function cleanViewport(v) {
  if (!v || typeof v !== "object") return null;
  const dpr = typeof v.dpr === "number" ? int(v.dpr * 100) : undefined;
  const out = { w: int(v.w), h: int(v.h), dpr: dpr === undefined ? undefined : dpr / 100, scrollX: int(v.scrollX), scrollY: int(v.scrollY) };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : null;
}

function toPin(row, images = []) {
  return {
    id: row.id,
    status: row.status,
    url: row.url,
    host: row.host,
    path: row.path,
    title: row.title,
    note: row.note,
    quote: row.quote,
    targets: JSON.parse(row.targets),
    viewport: row.viewport ? JSON.parse(row.viewport) : null,
    author: row.author,
    agent: row.agent,
    summary: row.summary,
    commit: row.commit_ref,
    run: row.run,
    batch: row.batch ?? null,
    model: row.model ?? null,
    attempts: Number(row.attempts ?? 0),
    intent: row.intent ?? null,
    scope: row.scope ?? null,
    presets: row.presets ? JSON.parse(row.presets) : [],
    progress: row.step_count ? { text: row.step_body, at: row.step_at, count: Number(row.step_count) } : null,
    shots: { before: row.shot_before ?? null, after: row.shot_after ?? null },
    acceptedAt: row.accepted_at ?? null,
    reopens: row.reopens === null || row.reopens === undefined ? null : Number(row.reopens),
    versions: row.versions ? JSON.parse(row.versions) : [],
    revert: row.revert ? JSON.parse(row.revert) : null,
    revertedAt: row.reverted_at ?? null,
    images,
    replyCount: Number(row.reply_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    closedAt: row.closed_at,
  };
}

const toReply = (row) => ({ id: row.id, pinId: row.pin_id, kind: row.kind, author: row.author, body: row.body, createdAt: row.created_at });
const toImage = (row) => ({ id: row.id, type: row.type, size: row.size, replyId: row.reply_id ?? null, author: row.author, createdAt: row.created_at });
const toStep = (row) => ({ id: row.id, pinId: row.pin_id, author: row.author, body: row.body, createdAt: row.created_at });

// Shots are files `<pin id>-<kind>` in shotsDir, images files `<image id>` in imagesDir (default: "shots" and
// "images" next to the database file).
export function openStore({ file, rootDomain = "koglabs.com", shotsDir = file && file !== ":memory:" ? join(dirname(file), "shots") : null,
  imagesDir = file && file !== ":memory:" ? join(dirname(file), "images") : null } = {}) {
  if (!file) throw new Error("openStore needs a file (or ':memory:')");
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  try { migrate(db); }
  catch (error) { db.close(); throw error; }

  const events = new EventEmitter();
  events.setMaxListeners(0);
  const now = () => new Date().toISOString();
  const root = rootDomain.toLowerCase();

  const q = {
    get: db.prepare(`${SELECT_PIN} WHERE p.id = ?`),
    insert: db.prepare(`INSERT INTO pins (status, url, host, path, title, note, quote, targets, viewport, author, batch, intent, scope, presets, reopens, created_at, updated_at)
      VALUES ('queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`),
    batchInsert: db.prepare(`INSERT INTO batches (host, author, client_key, created_at) VALUES (?, ?, ?, ?)`),
    batchByKey: db.prepare(`SELECT * FROM batches WHERE client_key = ?`),
    batchPins: db.prepare(`${SELECT_PIN} WHERE p.batch = ? ORDER BY p.id`),
    start: db.prepare(`UPDATE pins SET status = 'working', agent = ?, summary = NULL, commit_ref = NULL, run = ?, model = ?, attempts = attempts + 1, shot_before = NULL, shot_after = NULL, started_at = ?, closed_at = NULL, updated_at = ? WHERE id = ?`),
    note: db.prepare(`UPDATE pins SET note = ?, updated_at = ? WHERE id = ?`),
    status: db.prepare(`UPDATE pins SET status = ?, agent = ?, summary = ?, commit_ref = ?, run = ?, started_at = ?, closed_at = ?, updated_at = ? WHERE id = ?`),
    requeue: db.prepare(`UPDATE pins SET status = 'queued', agent = NULL, summary = NULL, commit_ref = NULL, run = NULL, started_at = NULL, closed_at = NULL, accepted_at = NULL, reverted_at = NULL, reopens = reopens + ?, updated_at = ? WHERE id = ?`),
    resolve: db.prepare(`UPDATE pins SET status = 'done', agent = ?, summary = ?, commit_ref = ?, versions = ?, revert = NULL, reverted_at = ?, closed_at = ?, updated_at = ? WHERE id = ?`),
    revert: db.prepare(`UPDATE pins SET status = 'queued', agent = NULL, summary = NULL, commit_ref = NULL, run = NULL, started_at = NULL, closed_at = NULL, accepted_at = NULL, reverted_at = NULL, revert = ?, reopens = reopens + 1, updated_at = ? WHERE id = ?`),
    dropRevert: db.prepare(`UPDATE pins SET revert = NULL WHERE id = ?`),
    accept: db.prepare(`UPDATE pins SET accepted_at = ?, updated_at = ? WHERE id = ?`),
    touch: db.prepare(`UPDATE pins SET updated_at = ? WHERE id = ?`),
    del: db.prepare(`DELETE FROM pins WHERE id = ?`),
    reply: db.prepare(`INSERT INTO replies (pin_id, kind, author, body, created_at) VALUES (?, ?, ?, ?, ?)`),
    replyGet: db.prepare(`SELECT * FROM replies WHERE id = ?`),
    replies: db.prepare(`SELECT * FROM replies WHERE pin_id = ? ORDER BY id`),
    step: db.prepare(`INSERT INTO steps (pin_id, author, body, created_at) VALUES (?, ?, ?, ?)`),
    stepGet: db.prepare(`SELECT * FROM steps WHERE id = ?`),
    steps: db.prepare(`SELECT * FROM steps WHERE pin_id = ? ORDER BY id`),
    stepsDel: db.prepare(`DELETE FROM steps WHERE pin_id = ?`),
    shot: Object.fromEntries(SHOT_KINDS.map((kind) => [kind, db.prepare(`UPDATE pins SET shot_${kind} = ?, updated_at = ? WHERE id = ?`)])),
    shotsOld: db.prepare(`UPDATE pins SET shot_before = NULL, shot_after = NULL WHERE closed_at < ? AND (shot_before IS NOT NULL OR shot_after IS NOT NULL)`),
    closedAt: db.prepare(`SELECT closed_at FROM pins WHERE id = ?`),
    stats: db.prepare(`SELECT host, status, COUNT(*) AS n FROM pins GROUP BY host, status ORDER BY host`),
    setting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
    imagesOf: db.prepare(`SELECT * FROM images WHERE pin_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid`),
    imageGet: db.prepare(`SELECT id FROM images WHERE id = ?`),
    imageInsert: db.prepare(`INSERT INTO images (id, type, size, author, created_at) VALUES (?, ?, ?, ?, ?)`),
    imageLink: db.prepare(`UPDATE images SET pin_id = ?, reply_id = ? WHERE id = ? AND pin_id IS NULL`),
    imagesWaiting: db.prepare(`SELECT COUNT(*) AS n FROM images WHERE pin_id IS NULL`),
    imageCount: db.prepare(`SELECT COUNT(*) AS n FROM images WHERE pin_id = ?`),
    imageIds: db.prepare(`SELECT id FROM images WHERE pin_id = ?`),
    imagesOld: db.prepare(`DELETE FROM images WHERE (pin_id IS NULL AND created_at < ?) OR pin_id IN (SELECT id FROM pins WHERE closed_at < ?)`),
    imageIdsAll: db.prepare(`SELECT id FROM images`),
    setSetting: db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  };

  function parseUrl(raw) {
    let u;
    try {
      u = new URL(String(raw ?? ""));
    } catch {
      throw new ValidationError("url is not a valid URL");
    }
    if (u.protocol !== "https:") throw new ValidationError("url must use https");
    const hostname = u.hostname.toLowerCase();
    if (hostname !== root && !hostname.endsWith(`.${root}`)) throw new ValidationError(`url host must be ${root} or a subdomain`);
    u.hash = "";
    u.username = "";
    u.password = "";
    if (u.href.length > 2048) throw new ValidationError("url is longer than 2048 characters");
    return { url: u.href, host: u.host.toLowerCase(), path: u.pathname || "/" };
  }

  // Pin rows to pin JSON, with the images of all of them read in one query.
  const toPins = (rows) => {
    const images = new Map(rows.map((row) => [row.id, []]));
    if (rows.length) for (const row of q.imagesOf.all(JSON.stringify(rows.map((r) => r.id)))) images.get(row.pin_id).push(toImage(row));
    return rows.map((row) => toPin(row, images.get(row.id)));
  };
  const getPin = (id) => {
    const row = q.get.get(id);
    return row ? toPins([row])[0] : null;
  };
  const emit = (e) => events.emit("change", e);
  // Called after the commit, so it must not throw: the change event still has to go out. A file that stays is
  // hidden (its column is NULL); the next upload replaces it, and the prune removes the files of a deleted pin.
  const removeShots = (id) => {
    if (!shotsDir) return;
    for (const kind of SHOT_KINDS) {
      try { rmSync(join(shotsDir, `${id}-${kind}`), { force: true }); } catch { /* It stays hidden. */ }
    }
  };
  // Like removeShots: called after the commit, so it never throws. A file that stays goes at the next prune.
  const removeImages = (ids) => {
    for (const id of ids) {
      try { rmSync(join(imagesDir, id), { force: true }); } catch { /* The prune removes it. */ }
    }
  };
  // 0 to 6 image ids, each once. Checked before anything is written.
  function cleanImages(v) {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > IMAGES_PER_INPUT || v.some((id) => typeof id !== "string" || !IMAGE_ID_RE.test(id)) || new Set(v).size !== v.length) {
      throw new ValidationError(`images must hold 0 to ${IMAGES_PER_INPUT} different image ids`);
    }
    return v;
  }
  // Inside the transaction of the pin or the reply insert: only an unlinked image can be linked.
  function linkImages(ids, pinId, replyId) {
    for (const id of ids) {
      if (!q.imageLink.run(pinId, replyId, id).changes) throw new ValidationError(`image ${id.slice(0, 6)} is gone; remove it and try again`);
    }
  }
  // One write: BEGIN IMMEDIATE, fn, COMMIT; ROLLBACK when fn throws.
  function inTransaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const getSettings = () => {
    const autofix = q.setting.get("autofix");
    const bulk = q.setting.get("bulk");
    return { autofix: autofix ? JSON.parse(autofix.value) : true, bulk: { ...BULK_DEFAULT, ...(bulk && JSON.parse(bulk.value)) } };
  };

  function insertReply(pinId, kind, author, body) {
    if (kind !== "user" && kind !== "agent") throw new ValidationError('reply kind must be "user" or "agent"');
    const { lastInsertRowid } = q.reply.run(pinId, kind, optional(author, 60, "author"), required(body, 4000, "reply"), now());
    return toReply(q.replyGet.get(lastInsertRowid));
  }

  // Validate one new pin completely before anything is written.
  function preparePin({ url, title, note, quote, targets, viewport, intent, scope, presets, images } = {}) {
    const where = parseUrl(url);
    const text = required(note, 4000, "note");
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 10) throw new ValidationError("targets must hold 1 to 10 elements");
    return {
      ...where, note: text, targets: JSON.stringify(targets.map(cleanTarget)), viewport: JSON.stringify(cleanViewport(viewport)),
      title: clip(typeof title === "string" ? title.trim() : undefined, 300) ?? null,
      quote: clip(typeof quote === "string" ? quote.trim() : undefined, 2000) || null,
      intent: choice(intent, INTENTS, "intent"), scope: choice(scope, SCOPES, "scope"), presets: JSON.stringify(cleanPresets(presets)),
      images: cleanImages(images),
    };
  }
  const insertPin = (p, author, batch, t) => {
    const id = Number(q.insert.run(p.url, p.host, p.path, p.title, p.note, p.quote, p.targets, p.viewport, author, batch, p.intent, p.scope, p.presets, t, t).lastInsertRowid);
    linkImages(p.images, id, null);
    return id;
  };

  return {
    createPin({ author, ...input } = {}) {
      const prepared = preparePin(input);
      const who = optional(author, 60, "author");
      const pin = getPin(inTransaction(() => insertPin(prepared, who, null, now())));
      emit({ type: "pin", action: "created", pin });
      return pin;
    },

    /**
     * Submit-all: 1 to BATCH_MAX pins on one host, written in one transaction. A repeated `key`
     * returns the batch it already created (a lost response must not double the pins).
     */
    createBatch({ pins: items, key, author } = {}) {
      if (!Array.isArray(items) || items.length < 1 || items.length > BATCH_MAX) throw new ValidationError(`pins must hold 1 to ${BATCH_MAX} pins`);
      if (key !== undefined && key !== null && (typeof key !== "string" || !KEY_RE.test(key))) throw new ValidationError("key must be 8 to 80 letters, digits, _ or -");
      const who = optional(author, 60, "author");
      const toBatch = (row, pins, created) => ({ batch: { id: row.id, host: row.host, author: row.author, createdAt: row.created_at, count: pins.length }, pins, created });
      if (key) {
        const row = q.batchByKey.get(key);
        if (row) return toBatch(row, toPins(q.batchPins.all(row.id)), false);
      }
      const prepared = items.map((item, index) => {
        try { return preparePin(item); }
        catch (error) { if (error instanceof ValidationError) error.message = `pin ${index + 1}: ${error.message}`; throw error; }
      });
      const host = prepared[0].host;
      if (prepared.some((p) => p.host !== host)) throw new ValidationError("all pins in a batch must be on one host");
      const t = now();
      const batchId = inTransaction(() => {
        const id = Number(q.batchInsert.run(host, who, key || null, t).lastInsertRowid);
        for (const p of prepared) insertPin(p, who, id, t);
        return id;
      });
      const pins = toPins(q.batchPins.all(batchId));
      for (const pin of pins) emit({ type: "pin", action: "created", pin });
      return toBatch({ id: batchId, host, author: who, created_at: t }, pins, true);
    },

    getPin,

    listPins({ statuses = OPEN, host, path, q: text, limit = 200, before, batch, selector } = {}) {
      const where = [];
      const args = [];
      // All five statuses need no filter: the list then reads the newest rows and stops at the limit.
      if (!STATUSES.every((status) => statuses.includes(status))) where.push(`p.status IN (${statuses.map(() => "?").join(",")})`), args.push(...statuses);
      if (host) where.push("p.host = ?"), args.push(String(host).toLowerCase());
      if (path) where.push("p.path = ?"), args.push(String(path));
      if (before) where.push("p.id < ?"), args.push(Number(before));
      if (batch) where.push("p.batch = ?"), args.push(Number(batch));
      if (selector) where.push("json_extract(p.targets, '$[0].selector') = ?"), args.push(String(selector));
      if (text) {
        const like = `%${String(text).slice(0, 200).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        where.push(`(p.note LIKE ? ESCAPE '\\' OR p.targets LIKE ? ESCAPE '\\' OR p.url LIKE ? ESCAPE '\\')`);
        args.push(like, like, like);
      }
      const n = Math.min(Math.max(Number(limit) || 200, 1), 500);
      // The inner query picks the ids; only those rows get the reply and step subqueries of SELECT_PIN.
      // In one flat query SQLite runs the subqueries for every matching row before it sorts and cuts.
      const ids = `SELECT p.id FROM pins p${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY p.id DESC LIMIT ${n}`;
      return toPins(db.prepare(`${SELECT_PIN} WHERE p.id IN (${ids}) ORDER BY p.id DESC`).all(...args));
    },

    updateNote(id, note) {
      const before = getPin(id);
      if (!before) return null;
      if (before.status !== "queued") throw new ConflictError(`pin #${id} is ${before.status}; only a queued note can change`);
      q.note.run(required(note, 4000, "note"), now(), id);
      const pin = getPin(id);
      emit({ type: "pin", action: "updated", pin });
      return pin;
    },

    transition(id, action, { agent, summary, commit, reason, question, run, model, kind = "agent", author } = {}) {
      const rule = TRANSITIONS[action];
      if (!rule) throw new ValidationError(`unknown action "${action}"`);
      if (USER_ONLY[action] && kind !== "user") throw new ForbiddenError(`only a user can ${USER_ONLY[action]}`);
      let reply = null;
      db.exec("BEGIN IMMEDIATE");
      try {
        const pin = getPin(id);
        if (!pin) { db.exec("COMMIT"); return null; }
        if (!rule.from.includes(pin.status)) throw new ConflictError(`pin #${id} is ${pin.status}`);
        const t = now();
        const who = optional(agent, 60, "agent") ?? pin.agent;
        if (action === "start") {
          q.stepsDel.run(id);
          q.start.run(who, optional(run, 200, "run"), optional(model, 40, "model"), t, t, id);
        } else if (action === "resolve") {
          const text = required(summary, 4000, "summary");
          const ref = optional(commit, 200, "commit");
          // A revert run takes its commits out of the live versions; its own commit is no new version.
          let versions = pin.versions;
          if (pin.revert) versions = versions.filter((v) => !pin.revert.commits.includes(v.commit));
          else if (ref && COMMIT_RE.test(ref) && !versions.some((v) => v.commit === ref)) {
            versions = [...versions, { commit: ref, summary: clip(text, 300), at: t }].slice(-VERSIONS_MAX);
          }
          q.resolve.run(who, text, ref, JSON.stringify(versions), pin.revert ? t : null, t, t, id);
          reply = insertReply(id, kind, author ?? who, closing(pin.revert ? "Reverted" : "Done", text, ref));
        } else if (action === "dismiss") {
          const why = optional(reason, 4000, "reason");
          q.status.run("dismissed", pin.agent, why, null, pin.run, pin.startedAt, t, t, id);
          q.dropRevert.run(id);
          if (why) reply = insertReply(id, kind, author ?? who, closing("Dismissed", why));
        } else if (action === "ask") {
          const text = required(question, 4000, "question");
          q.status.run("waiting", pin.agent, pin.summary, pin.commit, pin.run, pin.startedAt, pin.closedAt, t, id);
          reply = insertReply(id, kind, author ?? who, text);
        } else if (action === "accept") {
          // A second accept changes nothing and sends no event.
          if (pin.acceptedAt) { db.exec("COMMIT"); return pin; }
          q.accept.run(t, t, id);
        } else if (action === "revert") {
          // commit is the first fix to undo; every later fix goes too, so the page is the version before it.
          const ref = required(commit, 200, "commit");
          const index = pin.versions.findIndex((v) => v.commit === ref);
          if (index < 0) throw new ConflictError(pin.versions.length ? `pin #${id} has no live fix ${ref}` : `pin #${id} has no version to go back to`);
          const undo = pin.versions.slice(index).reverse().map((v) => v.commit);
          q.revert.run(JSON.stringify({ commits: undo, at: t, attempts: pin.attempts }), t, id);
          const short = (sha) => sha.slice(0, 7);
          const target = index ? `fix ${index} (${short(pin.versions[index - 1].commit)})` : "the version before this pin";
          reply = insertReply(id, "user", author, `Go back to ${target}: undo ${undo.map(short).join(", ")}.`);
        } else {
          q.requeue.run(kind === "user" ? 1 : 0, t, id);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      const next = getPin(id);
      if (action === "start") removeShots(next.id);
      emit({ type: "pin", action: "updated", pin: next });
      if (reply) emit({ type: "reply", pin: next, reply });
      return next;
    },

    deletePin(id) {
      const pin = getPin(id);
      if (!pin) return false;
      const images = q.imageIds.all(id).map((row) => row.id);
      q.del.run(id);
      removeShots(pin.id);
      removeImages(images);
      emit({ type: "pin", action: "deleted", pin });
      return true;
    },

    // A user reply on a waiting pin requeues it. With reopen: true it also sends a done or
    // dismissed pin back to the queue ("Not right").
    addReply(id, { kind, author, body, reopen = false, images } = {}) {
      const ids = cleanImages(images);
      let reply;
      let reopened;
      db.exec("BEGIN IMMEDIATE");
      try {
        const pin = getPin(id);
        if (!pin) { db.exec("COMMIT"); return null; }
        reply = insertReply(id, kind, author, body);
        if (ids.length && q.imageCount.get(id).n + ids.length > IMAGES_PER_PIN) throw new ConflictError(`a pin holds at most ${IMAGES_PER_PIN} images`);
        linkImages(ids, id, reply.id);
        reopened = kind === "user" && (pin.status === "waiting" || (reopen === true && ["done", "dismissed"].includes(pin.status)));
        if (reopened) q.requeue.run(1, reply.createdAt, id);
        else q.touch.run(reply.createdAt, id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const pin = getPin(id);
      if (reopened) emit({ type: "pin", action: "updated", pin });
      emit({ type: "reply", pin, reply });
      return reply;
    },

    listReplies: (id) => q.replies.all(id).map(toReply),

    // One progress line of the current run. Only a working pin takes steps.
    addStep(id, { author, body } = {}) {
      const before = getPin(id);
      if (!before) return null;
      if (before.status !== "working") throw new ConflictError(`pin #${id} is ${before.status}`);
      if ((before.progress?.count ?? 0) >= STEP_MAX) throw new ConflictError(`pin #${id} has ${STEP_MAX} steps, the limit of a run`);
      const t = now();
      const { lastInsertRowid } = q.step.run(id, optional(author, 60, "author"), required(body, 200, "step"), t);
      q.touch.run(t, id);
      const pin = getPin(id);
      emit({ type: "pin", action: "updated", pin });
      return { step: toStep(q.stepGet.get(lastInsertRowid)), pin };
    },

    listSteps: (id) => q.steps.all(id).map(toStep),

    // The file is complete before it gets its name, so a reader never sees half an image.
    setShot(id, kind, { type, bytes } = {}) {
      if (!SHOT_KINDS.includes(kind)) throw new ValidationError('shot kind must be "before" or "after"');
      if (!SHOT_TYPES.includes(type)) throw new ValidationError(`shot type must be ${SHOT_TYPES.join(", ")}`);
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > SHOT_MAX) throw new ValidationError("shot must hold 1 byte to 2 MiB");
      if (shotType(bytes) !== type) throw new ValidationError(`shot is not ${type}`);
      const before = getPin(id);
      if (!before) return null;
      if (!shotsDir) throw new Error("openStore needs a shotsDir to keep shots");
      mkdirSync(shotsDir, { recursive: true, mode: 0o700 });
      const path = join(shotsDir, `${before.id}-${kind}`);
      writeFileSync(`${path}.tmp`, bytes, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      const t = now();
      q.shot[kind].run(t, t, id);
      const pin = getPin(id);
      emit({ type: "pin", action: "updated", pin });
      return pin;
    },

    getShot(id, kind) {
      const pin = SHOT_KINDS.includes(kind) ? getPin(id) : null;
      if (!pin?.shots[kind]) return null;
      let bytes;
      try { bytes = readFileSync(join(shotsDir, `${pin.id}-${kind}`)); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
      const type = shotType(bytes);
      return type ? { type, bytes } : null;
    },

    // Removes the shot files of deleted pins and of pins closed more than olderThanDays ago.
    pruneShots({ olderThanDays = 30 } = {}) {
      if (!shotsDir || !existsSync(shotsDir)) return 0;
      const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
      q.shotsOld.run(cutoff);
      let removed = 0;
      for (const name of readdirSync(shotsDir)) {
        const match = SHOT_FILE_RE.exec(name);
        if (!match) continue;
        const row = q.closedAt.get(Number(match[1]));
        if (row && !(row.closed_at && row.closed_at < cutoff)) continue;
        rmSync(join(shotsDir, name), { force: true });
        removed++;
      }
      return removed;
    },

    // An image he attached, waiting for "Submit all" or the reply that links it. Written like a shot.
    addImage({ type, bytes, author } = {}) {
      if (!SHOT_TYPES.includes(type)) throw new ValidationError(`image type must be ${SHOT_TYPES.join(", ")}`);
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > SHOT_MAX) throw new ValidationError("image must hold 1 byte to 2 MiB");
      if (shotType(bytes) !== type) throw new ValidationError(`image is not ${type}`);
      const who = optional(author, 60, "author");
      if (!imagesDir) throw new Error("openStore needs an imagesDir to keep images");
      if (q.imagesWaiting.get().n >= IMAGES_WAITING) throw new ConflictError("too many images wait for a pin");
      const id = randomBytes(16).toString("base64url");
      mkdirSync(imagesDir, { recursive: true, mode: 0o700 });
      const path = join(imagesDir, id);
      writeFileSync(`${path}.tmp`, bytes, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      const t = now();
      try { q.imageInsert.run(id, type, bytes.length, who, t); }
      catch (error) { removeImages([id]); throw error; }
      return { id, type, size: bytes.length, replyId: null, author: who, createdAt: t };
    },

    getImage(id) {
      if (typeof id !== "string" || !IMAGE_ID_RE.test(id) || !imagesDir || !q.imageGet.get(id)) return null;
      let bytes;
      try { bytes = readFileSync(join(imagesDir, id)); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
      const type = shotType(bytes);
      return type ? { type, bytes } : null;
    },

    // Removes the images of pins closed more than olderThanDays ago and unlinked images older than that, then
    // every file without a row (deleted pins, unfinished uploads). Runs with pruneShots.
    pruneImages({ olderThanDays = 30 } = {}) {
      if (!imagesDir) return 0;
      const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
      q.imagesOld.run(cutoff, cutoff);
      if (!existsSync(imagesDir)) return 0;
      const known = new Set(q.imageIdsAll.all().map((row) => row.id));
      let removed = 0;
      for (const name of readdirSync(imagesDir)) {
        const match = IMAGE_FILE_RE.exec(name);
        if (!match || (known.has(match[1]) && name === match[1])) continue;
        rmSync(join(imagesDir, name), { force: true });
        removed++;
      }
      return removed;
    },

    getSettings,

    // Merges the given keys only. Everything is checked before anything is written.
    setSettings(patch) {
      if (!isObject(patch) || !Object.keys(patch).length || Object.keys(patch).some((k) => k !== "autofix" && k !== "bulk")) {
        throw new ValidationError("settings must hold autofix and/or bulk");
      }
      const { autofix, bulk } = patch;
      if (Object.hasOwn(patch, "autofix") && typeof autofix !== "boolean") throw new ValidationError("autofix must be true or false");
      if (Object.hasOwn(patch, "bulk")) {
        if (!isObject(bulk) || !Object.keys(bulk).length) throw new ValidationError("bulk must hold on, delegate and/or agents");
        for (const [key, value] of Object.entries(bulk)) {
          if (!Object.hasOwn(BULK_CHECKS, key)) throw new ValidationError(`unknown bulk setting "${key}"`);
          if (!BULK_CHECKS[key](value)) throw new ValidationError(`bulk.${key} must be ${key === "agents" ? "an integer from 1 to 8" : "true or false"}`);
        }
      }
      const before = getSettings();
      const next = { autofix: Object.hasOwn(patch, "autofix") ? autofix : before.autofix, bulk: { ...before.bulk, ...bulk } };
      // A patch that changes nothing writes nothing and sends no event.
      if (JSON.stringify(next) === JSON.stringify(before)) return before;
      if (Object.hasOwn(patch, "autofix")) q.setSetting.run("autofix", JSON.stringify(autofix));
      if (Object.hasOwn(patch, "bulk")) q.setSetting.run("bulk", JSON.stringify(next.bulk));
      emit({ type: "settings", settings: next });
      return next;
    },

    stats() {
      const total = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      const hosts = new Map();
      for (const { host, status, n } of q.stats.all()) {
        total[status] += Number(n);
        if (!hosts.has(host)) hosts.set(host, { host, ...Object.fromEntries(STATUSES.map((s) => [s, 0])) });
        hosts.get(host)[status] = Number(n);
      }
      return { total, hosts: [...hosts.values()] };
    },

    nextCreated({ host, timeoutMs = 120000, signal } = {}) {
      return new Promise((resolve) => {
        const done = (pin) => {
          clearTimeout(timer);
          events.off("change", onChange);
          signal?.removeEventListener("abort", onAbort);
          resolve(pin);
        };
        const onChange = (e) => {
          if (e.type === "pin" && e.action === "created" && (!host || e.pin.host === String(host).toLowerCase())) done(e.pin);
        };
        const onAbort = () => done(null);
        const timer = setTimeout(() => done(null), timeoutMs);
        events.on("change", onChange);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) done(null);
      });
    },

    on: (name, fn) => events.on(name, fn),
    off: (name, fn) => events.off(name, fn),
    close: () => db.close(),
  };
}
