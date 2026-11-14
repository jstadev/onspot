import { DatabaseSync } from "node:sqlite";

// The original store schema, kept verbatim so migration tests cannot use the new CHECK.
export const OLD_SCHEMA = `
CREATE TABLE IF NOT EXISTS pins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','working','done','dismissed')),
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS pins_status ON pins(status, id);
CREATE INDEX IF NOT EXISTS pins_host_status ON pins(host, status, id);
CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pin_id INTEGER NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('user','agent')),
  author TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS replies_pin ON replies(pin_id, id);
`;

export function createOldDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(OLD_SCHEMA);
  const time = "2026-10-17T14:00:00.000Z";
  const insert = db.prepare(`INSERT INTO pins
    (id, status, url, host, path, title, note, quote, targets, viewport, author, agent, summary, commit_ref, created_at, updated_at, started_at, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const reply = db.prepare("INSERT INTO replies (id, pin_id, kind, author, body, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const [index, status] of ["queued", "working", "done", "dismissed"].entries()) {
    const id = 12 + index;
    insert.run(id, status, "https://crete.koglabs.com/pricing?x=1", "crete.koglabs.com", "/pricing", "Pricing",
      `Καλώς 👋 ${status} \"quotes\" \\ back`, "ξανά", JSON.stringify([{ selector: "h1", label: "h1" }]),
      JSON.stringify({ w: 1200, h: 900, dpr: 2 }), "sam", index ? "codex" : null,
      index > 1 ? "Old result" : null, status === "done" ? "abc123" : null, time, time, index ? time : null, index > 1 ? time : null);
    reply.run(21 + index, id, index % 2 ? "agent" : "user", index % 2 ? "codex" : "sam", `Old reply ${id} ξανά`, time);
  }
  // Deleted high IDs must stay reserved after migration, including the reply sequence.
  db.exec(`INSERT INTO pins (id, url, host, path, note, targets, created_at, updated_at)
    SELECT 80, url, host, path, note, targets, created_at, updated_at FROM pins WHERE id = 12;
    INSERT INTO replies (id, pin_id, kind, body, created_at) VALUES (90, 80, 'user', 'Deleted', '${time}');
    DELETE FROM pins WHERE id = 80;`);
  return db;
}

// The v2 schema (contract v2, before intent, scope, presets, steps and shots), kept verbatim.
export const V2_SCHEMA = `
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  closed_at TEXT
);
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
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// A v2 file with one pin per status, a batch, replies and a setting.
export function createV2Database(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(V2_SCHEMA);
  const time = "2026-11-01T09:00:00.000Z";
  db.prepare("INSERT INTO batches (id, host, author, client_key, created_at) VALUES (4, 'crete.koglabs.com', 'sam', 'v2-batch-key', ?)").run(time);
  db.exec("INSERT INTO settings (key, value) VALUES ('autofix', 'false');");
  const insert = db.prepare(`INSERT INTO pins
    (id, status, url, host, path, title, note, quote, targets, viewport, author, agent, summary, commit_ref, run, batch, model, attempts, created_at, updated_at, started_at, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const reply = db.prepare("INSERT INTO replies (id, pin_id, kind, author, body, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const [index, status] of ["queued", "working", "waiting", "done", "dismissed"].entries()) {
    const id = 30 + index;
    insert.run(id, status, "https://crete.koglabs.com/pricing?x=1", "crete.koglabs.com", "/pricing", "Pricing",
      `Καλώς 👋 ${status}`, null, JSON.stringify([{ selector: `#v2-${index}`, label: "h1", attrs: { class: "t" } }]),
      JSON.stringify({ w: 1200, h: 900, dpr: 2 }), "sam", index ? "claude" : null,
      index > 2 ? "Old result" : null, status === "done" ? "abc123" : null, index ? `triad:${id}` : null, index % 2 ? 4 : null,
      index ? "opus" : null, index, time, time, index ? time : null, index > 2 ? time : null);
    reply.run(50 + index, id, index % 2 ? "agent" : "user", index % 2 ? "claude" : "sam", `Old reply ${id} ξανά`, time);
  }
  return db;
}
