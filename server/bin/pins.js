#!/usr/bin/env node
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearFacts, judge, loadFacts, saveFacts } from "../src/facts.js";
import { formatDetail, formatLine, formatList } from "../src/format.js";
import { ID_RE } from "../src/id.js";
import { ship } from "../src/ship.js";
import { SHOT_KINDS, SHOT_MAX, shotType } from "../src/shots.js";
import { snapPin } from "../src/snap.js";

const usage = `Usage:
  pins list [--host H] [--status S] [--path P] [--limit N] [--json]
  pins show <id> [--json]
  pins start <id>
  pins done <id> --summary "..." [--commit SHA]
  pins dismiss <id> --reason "..."
  pins ask <id> "question"
  pins reopen <id>
  pins reply <id> "text"
  pins wait [--host H] [--timeout 120]
  pins progress <id> "text"
  pins shot <id> before|after <file>
  pins snap <id> before|after [--url U] [--selector S] [--pad 40]
  pins check <id> --url U [--selector S] [--pad 40]
  pins ship <id> --dir <worktree> --summary "..." [--message "..."] <path> [<path> ...]
  pins --help`;

class UsageError extends Error {}
const commands = {
  list: { count: 0, flags: ["host", "status", "path", "limit", "json"] },
  show: { count: 1, flags: ["json"] },
  start: { count: 1, flags: [] },
  done: { count: 1, flags: ["summary", "commit"], required: ["summary"] },
  dismiss: { count: 1, flags: ["reason"], required: ["reason"] },
  ask: { count: 2, flags: [] },
  reopen: { count: 1, flags: [] },
  reply: { count: 2, flags: [] },
  wait: { count: 0, flags: ["host", "timeout"] },
  progress: { count: 2, flags: [] },
  shot: { count: 3, flags: [] },
  snap: { count: 2, flags: ["url", "selector", "pad"] },
  check: { count: 1, flags: ["url", "selector", "pad"], required: ["url"] },
  // The pin id, then 1 to 50 changed files.
  ship: { range: [2, 51], flags: ["dir", "summary", "message"], required: ["dir", "summary"] },
};
const TEXT_MAX = { reply: 4000, ask: 4000, progress: 200 };

function parse(argv) {
  const [command, ...args] = argv;
  if (!Object.hasOwn(commands, command)) throw new UsageError("unknown or missing command");
  const spec = commands[command];
  const options = {};
  const positional = [];
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!literal && arg === "--") { literal = true; continue; }
    // Only "--name" is an option. A text may start with one dash ("- tests pass", "-webkit-...").
    if (!literal && arg.startsWith("--")) {
      const key = arg.slice(2);
      if (!spec.flags.includes(key) || Object.hasOwn(options, key)) throw new UsageError(`unknown or repeated option ${arg}`);
      if (key === "json") options.json = true;
      else {
        const value = args[++i];
        // A value may start with "--" (a CSS variable in a summary). The name of an option here means that the value is missing.
        const missing = value === undefined || !value.trim() || value === "--" || (value.startsWith("--") && spec.flags.includes(value.slice(2)));
        if (missing) throw new UsageError(`${arg} needs a value`);
        options[key] = value;
      }
    } else positional.push(arg);
  }
  const [least, most] = spec.range ?? [spec.count, spec.count];
  if (positional.length < least || positional.length > most) throw new UsageError(`wrong number of arguments for ${command}`);
  if (least && !ID_RE.test(positional[0])) throw new UsageError("id must be a positive integer of at most 12 digits");
  for (const key of spec.required ?? []) {
    if (!Object.hasOwn(options, key)) throw new UsageError(`--${key} is required`);
  }
  for (const key of ["summary", "reason", "commit", "message"]) {
    if (options[key]?.trim().length > (key === "commit" ? 200 : 4000)) throw new UsageError(`--${key} is too long`);
  }
  const max = TEXT_MAX[command];
  if (max && (!positional[1].trim() || positional[1].trim().length > max)) throw new UsageError(`${command} text must have 1 to ${max} characters`);
  if (["shot", "snap"].includes(command) && !SHOT_KINDS.includes(positional[1])) throw new UsageError("the shot kind must be before or after");
  if (options.url !== undefined && !/^https?:$/.test(URL.parse(options.url)?.protocol ?? "")) throw new UsageError("--url must be an http or https URL");
  if (options.selector?.length > 500) throw new UsageError("--selector is too long");
  if (options.dir !== undefined && !options.dir.startsWith("/")) throw new UsageError("--dir must be an absolute path");
  if (options.pad !== undefined && (!/^[0-9]{1,3}$/.test(options.pad) || Number(options.pad) > 400)) throw new UsageError("--pad must be an integer from 0 to 400");
  if (options.limit !== undefined && (!/^[1-9][0-9]*$/.test(options.limit) || Number(options.limit) > 500)) throw new UsageError("--limit must be an integer from 1 to 500");
  if (options.timeout !== undefined && (!Number.isFinite(Number(options.timeout)) || Number(options.timeout) < 0 || Number(options.timeout) * 1000 > 2147483647)) {
    throw new UsageError("--timeout must be a nonnegative number of seconds within the timer range");
  }
  return { command, options, positional };
}

const port = process.env.PINS_PORT || "4750";
const base = `http://127.0.0.1:${port}/api`;
const headers = { "X-Pins-Agent": process.env.PINS_AGENT || "agent" };

async function send(path, init = {}) {
  const response = await fetch(base + path, { ...init, headers: { ...headers, ...init.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `pins server returned HTTP ${response.status}`);
  return data;
}
const request = (path, body) => send(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// The type comes from the first bytes, never from the file name.
function upload(id, kind, bytes) {
  const type = shotType(bytes);
  if (!type) throw new Error("the image is not a PNG, JPEG or WebP file");
  if (bytes.length > SHOT_MAX) throw new Error("the image is larger than 2 MiB");
  return send(`/pins/${id}/shots/${kind}`, { method: "PUT", headers: { "Content-Type": type }, body: bytes });
}

// `pins check` writes its image to a private file in the temp dir. An old file goes first, so no symlink is followed.
function saveImage(id, bytes) {
  const name = (ext) => join(tmpdir(), `pins-check-${id}.${ext}`);
  for (const ext of ["png", "jpg"]) rmSync(name(ext), { force: true });
  const file = name(shotType(bytes) === "image/jpeg" ? "jpg" : "png");
  writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  return file;
}

// A done pin whose before and after facts show no change gets a warning. It never blocks the command.
function warnIfUnchanged(id, pin) {
  const [before, after] = ["before", "after"].map((kind) => loadFacts(id, kind));
  const result = before && after && judge(pin.intent, before, after);
  if (result?.ok === false) console.error(`warning: ${result.text}`);
}

async function waitForPin(options) {
  const controller = new AbortController();
  let timedOut = false;
  let reader;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Number(options.timeout ?? 120) * 1000);
  try {
    const query = new URLSearchParams();
    if (options.host) query.set("host", options.host);
    const response = await fetch(`${base}/events?${query}`, { headers, signal: controller.signal });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || `pins server returned HTTP ${response.status}`);
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let event = "";
    let data = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("pins event stream closed");
      buffer += decoder.decode(chunk.value, { stream: true });
      while (true) {
        const end = buffer.search(/[\r\n]/);
        if (end < 0 || (buffer[end] === "\r" && end === buffer.length - 1)) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + (buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1));
        if (!line) {
          if (event === "pin" && data.length) {
            const value = JSON.parse(data.join("\n"));
            if (value?.action === "created" && value.pin) return value.pin;
          }
          event = "";
          data = [];
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const key = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (key === "event") event = value;
          if (key === "data") data.push(value);
        }
      }
    }
  } catch (error) {
    if (timedOut) return null;
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === "--help") { console.log(usage); return; }
  const { command, options, positional } = parse(argv);
  if (!/^[0-9]{1,5}$/.test(port) || Number(port) > 65535) throw new Error("PINS_PORT must be a port number");
  const [id, body, file] = positional;
  let data;
  if (command === "wait") {
    const pin = await waitForPin(options);
    console.log(pin ? formatDetail(pin) : "no new pins");
    return;
  }
  if (command === "progress") {
    const { pin } = await request(`/pins/${id}/progress`, { text: body });
    console.log(`#${id} step ${pin.progress.count}`);
    return;
  }
  if (command === "shot") {
    // A device or a pipe has no size: reading it would never end.
    const info = statSync(file);
    if (!info.isFile()) throw new Error(`${file} is not a regular file`);
    if (info.size > SHOT_MAX) throw new Error("the image is larger than 2 MiB");
    await upload(id, body, readFileSync(file));
    console.log(`#${id} ${body}: image saved`);
    return;
  }
  if (command === "ship") {
    // The "after" shot of the live page, its facts and the verdict, as `pins snap <id> after` gives them.
    const snapAfter = async (pin) => {
      const shot = await snapPin(pin, {});
      await upload(id, "after", shot.bytes);
      saveFacts(id, "after", shot.facts);
      const verdict = judge(pin.intent, loadFacts(id, "before"), shot.facts);
      return { ok: verdict.ok, text: `#${id} after: ${shot.text} · ${verdict.text}` };
    };
    process.exitCode = await ship(
      { id, dir: options.dir, summary: options.summary, message: options.message, paths: positional.slice(1) },
      { api: { get: (path) => request(path), post: (path, payload) => request(path, payload) }, snapAfter, out: console.log },
    );
    return;
  }
  if (command === "snap" || command === "check") {
    const pin = (await request(`/pins/${id}`)).pin;
    const shot = await snapPin(pin, options);
    const kind = command === "snap" ? body : "check";
    let image = "";
    if (command === "snap") await upload(id, kind, shot.bytes);
    else image = ` · image ${saveImage(id, shot.bytes)}`;
    saveFacts(id, kind, shot.facts);
    if (kind === "before") clearFacts(id, ["after", "check"]);
    console.log(`#${id} ${kind}: ${shot.text}${image}`);
    if (kind !== "before") console.log(`#${id} ${judge(pin.intent, loadFacts(id, "before"), shot.facts).text}`);
    return;
  }
  if (command === "list") {
    const query = new URLSearchParams();
    for (const key of ["host", "status", "path", "limit"]) {
      if (options[key] !== undefined) query.set(key, options[key]);
    }
    data = await request(`/pins?${query}`);
  } else if (command === "show") data = await request(`/pins/${id}`);
  else if (command === "reply") data = await request(`/pins/${id}/replies`, { body });
  else {
    const payload = command === "done" ? { summary: options.summary, ...(options.commit === undefined ? {} : { commit: options.commit }) }
      : command === "dismiss" ? { reason: options.reason } : command === "ask" ? { question: body } : {};
    data = await request(`/pins/${id}/${command === "done" ? "resolve" : command}`, payload);
  }
  if (options.json) console.log(JSON.stringify(data));
  else if (command === "list") console.log(formatList(data.pins));
  else if (command === "show") console.log(formatDetail(data.pin, data.replies, data.steps));
  else if (command === "reply") console.log(`reply added to #${id}`);
  else console.log(formatLine(data.pin));
  if (command === "done") warnIfUnchanged(id, data.pin);
}

try {
  await main();
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n${usage}`);
    process.exitCode = 2;
  } else {
    const refused = error.code === "ECONNREFUSED" || error.cause?.code === "ECONNREFUSED"
      || error.cause?.errors?.some((item) => item.code === "ECONNREFUSED");
    console.error(refused ? `pins server is not running on 127.0.0.1:${port}` : error.message);
    process.exitCode = 1;
  }
}
