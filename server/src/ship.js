// `pins ship`: commit, gate, push, merge, release to staging, check and close one pin in one blocking call.
// Every step is safe to run again. The gate and the release run in one lane per project (a lock file).
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ID_RE } from "./id.js";

const BRANCH_RE = /^[\w./-]{1,100}$/;
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const DOMAIN_RE = /^[a-z0-9.-]{1,253}$/i;
const SHA_RE = /^[0-9a-f]{40}$/;
// Matched on each part of the path, and on the whole path. Any case: a checkout can be on a file system that ignores case.
const PART_REFUSED = [/^\.git$/i, /^\.env/i, /\.key$/i, /\.pem$/i, /secret/i];
const TREE_REFUSED = [/^\.github\/workflows(\/|$)/i, /^infra(\/|$)/i];
const CRED = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1" };
const POLL_MS = 2000;
const STALE_MS = 30 * 60 * 1000;
// A guard file, and a lock file that names no process, are left behind when they are older than this.
const ORPHAN_MS = 60 * 1000;
// A release tries this long to get into the guard.
const RELEASE_WAIT_MS = 5000;
const RELEASE_MS = 480000;
const NO_MANIFEST = "this project has no staging manifest: ship by hand";

class Busy extends Error {
  message = "the lane is busy";
}

function failure(reason, output = "") {
  return Object.assign(new Error(reason), { output });
}

function need(result, label) {
  if (result.code !== 0) throw failure(`${label} exited ${result.code}`, `${result.stdout}\n${result.stderr}`);
  return result;
}

const redact = (text) => text.replace(/(:\/\/[^/\s:@]+:)[^@\s]+@/g, "$1***@").replace(/\b(gh[pousr]_|github_pat_)\w+/g, "$1***");
const firstLine = (text) => String(text).trim().split("\n", 1)[0];
const is = (re, value) => typeof value === "string" && re.test(value);

const MAX_OUTPUT = 16 * 1024 * 1024;
const running = new Set();
const killGroup = (child) => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };

/** Runs a program without a shell. A non-zero exit, a timeout or a spawn error resolves with a code. */
export function run(file, args, { cwd, env, timeoutMs } = {}) {
  return new Promise((done) => {
    // spawn, not execFile: execFile drops `detached`. Its own process group lets a timeout stop the children of a test command.
    const child = spawn(file, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const output = { stdout: "", stderr: "" };
    let size = 0;
    let note = "";
    const stop = (why) => { note = why; killGroup(child); };
    for (const name of ["stdout", "stderr"]) {
      child[name].setEncoding("utf8").on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_OUTPUT) stop("the output is larger than 16 MiB");
        else output[name] += chunk;
      });
    }
    const timer = timeoutMs ? setTimeout(() => stop(`timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs) : null;
    running.add(child);
    let settled = false;
    const finish = (code, why = note) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(child);
      done({ code: why && code === 0 ? 1 : code, stdout: output.stdout, stderr: why ? `${output.stderr}\n${why}` : output.stderr });
    };
    child.once("error", (error) => finish(1, error.message));
    child.once("close", (code) => finish(code ?? 1));
  });
}

// The reason when the input is not safe to ship, else null.
function badInput({ id, dir, summary, message, paths }) {
  if (!is(ID_RE, id)) return "the pin id must be a positive integer of at most 12 digits";
  if (typeof summary !== "string" || !summary.trim() || summary.length > 4000) return "the summary must have 1 to 4000 characters";
  if (message !== undefined && (typeof message !== "string" || !firstLine(message) || message.length > 4000)) return "the message must have 1 to 4000 characters and a first line";
  if (typeof dir !== "string" || !isAbsolute(dir)) return "the folder must be an absolute path";
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 50) return "give 1 to 50 paths";
  for (const path of paths) {
    if (typeof path !== "string" || !path || path.length > 500 || isAbsolute(path)) return `${path} is not a relative path`;
  }
  return null;
}

// The path relative to root, or a reason why it is refused.
function checkPath(root, path) {
  const full = resolve(root, path);
  if (!full.startsWith(root + sep)) return { reason: `${path} is outside the folder` };
  const rel = relative(root, full).split(sep).join("/");
  if (rel.split("/").some((part) => PART_REFUSED.some((re) => re.test(part))) || TREE_REFUSED.some((re) => re.test(rel))) {
    return { reason: `${path} is a refused path (secrets, .git, .github/workflows or infra): commit it by hand` };
  }
  // A folder would stage every file inside it, also the refused ones.
  if (lstatSync(full, { throwIfNoEntry: false })?.isDirectory()) return { reason: `${path} is a folder: list its files` };
  // root is a real path, so the folder of the file is real too unless a link is on the way. A missing folder holds a deleted file.
  let parent;
  try { parent = realpathSync(dirname(full)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (parent !== undefined && parent !== dirname(full)) return { reason: `${path} goes through a link: give the real path` };
  return { rel };
}

function readManifest(text) {
  let m;
  try { m = JSON.parse(text); } catch { return null; }
  const domains = m?.channels?.staging?.domains;
  const command = (value) => typeof value === "string" && value.trim() !== "";
  const ok = is(KEY_RE, m?.key) && is(REPO_RE, m.repo) && (command(m.release?.build) || command(m.release?.test))
    && Array.isArray(domains) && domains.length > 0 && domains.every((d) => is(DOMAIN_RE, d));
  return ok ? m : null;
}

const gone = (pid) => {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
};
// A sleep that does not return to the event loop: the release runs in a signal handler.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// What a lock file says, or null when the file is gone. It is stale when its process is gone or the file is older
// than 30 minutes. A lock with no pid (its maker died between create and write) can never show a dead process,
// so it is stale after ORPHAN_MS.
function holder(file) {
  let text, age;
  try {
    text = readFileSync(file, "utf8");
    age = Date.now() - statSync(file).mtimeMs;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let data = {};
  try { data = JSON.parse(text) ?? {}; } catch {}
  const { pid, pin } = data;
  const named = Number.isInteger(pid) && pid > 0;
  return { text, pin: Number.isInteger(pin) ? pin : "?", stale: (named && gone(pid)) || age > (named ? STALE_MS : ORPHAN_MS) };
}

/**
 * Runs work as the only process inside the guard of a lock, so a look at the lock and its removal are one step
 * for every process. False when another process is inside.
 * Each process makes a guard file with its pid in the name, then looks for the files of others. Two that come
 * together both see each other and both step back. Only its own process removes a guard file. The exception is
 * a file that was left behind (its process is gone, or the file is older than a minute): any process removes it,
 * by a name that no live process uses.
 */
function guarded(file, work) {
  const dir = dirname(file);
  const prefix = `${basename(file)}.takeover.`;
  const mine = `${prefix}${process.pid}`;
  writeFileSync(join(dir, mine), String(process.pid), { mode: 0o600 });
  try {
    let alone = true;
    for (const name of readdirSync(dir)) {
      if (name === mine || !name.startsWith(prefix)) continue;
      const other = join(dir, name);
      const pid = Number(name.slice(prefix.length));
      const made = statSync(other, { throwIfNoEntry: false })?.mtimeMs;
      // Gone by now: its process left the guard. Its name is never removed here: the process can come back with it.
      if (made === undefined) continue;
      if ((Number.isInteger(pid) && pid > 0 && gone(pid)) || Date.now() - made > ORPHAN_MS) rmSync(other, { force: true });
      else alone = false;
    }
    if (alone) work();
    return alone;
  } finally {
    rmSync(join(dir, mine), { force: true });
  }
}

// Removes the lock while it still holds this caller's text. Without the guard, a waiter can take an old lock over
// between the look and the remove, and the remove then hits the lock of the next holder. A guard is held for
// microseconds, so a busy one is tried again. If it stays busy, the lock stays: it is stale when this process ends.
function release(file, body) {
  const until = Date.now() + RELEASE_WAIT_MS;
  try {
    while (!guarded(file, () => { if (holder(file)?.text === body) rmSync(file, { force: true }); })) {
      if (Date.now() >= until) return;
      pause(1);
    }
  } catch (error) {
    // No lock folder, no lock.
    if (error.code !== "ENOENT") throw error;
  }
}

/**
 * Takes the lock file of a lane and resolves with the function that releases it. The file is created with wx,
 * so one process holds a lane. body is the JSON text { pid, pin, at }. A lock whose process is gone, or that is
 * older than 30 minutes (one minute when it names no process), is taken over.
 * Rejects when the lane stays busy for waitMs. onWait gets the pin of the holder one time.
 */
export async function takeLane(file, body, { waitMs, sleep, onWait = () => {} }) {
  let waited = 0;
  let told = false;
  while (true) {
    try {
      writeFileSync(file, body, { flag: "wx", mode: 0o600 });
      return () => release(file, body);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const held = holder(file);
    if (!held) continue;
    // The second look is inside the guard: by then the lock can be the fresh one of another waiter.
    if (held.stale && guarded(file, () => { if (holder(file)?.stale) rmSync(file, { force: true }); })) continue;
    if (waited >= waitMs) throw new Busy();
    if (!held.stale && !told) {
      onWait(held.pin);
      told = true;
    }
    await sleep(POLL_MS);
    waited += POLL_MS;
  }
}

/**
 * @param {{ id: string, dir: string, summary: string, message?: string, paths: string[] }} input
 * @param {{ api: { get(path), post(path, body) }, snapAfter: (pin) => Promise<{ ok: boolean|null, text: string }>,
 *           out: (line: string) => void, exec?, lockDir?, waitMs?, gateMs?, sleep? }} deps
 * @returns {Promise<number>} 0 shipped and closed; 1 a step failed; 3 a lane is busy, run again; 4 live, but the element check failed
 */
export async function ship(input, deps) {
  const { api, snapAfter, out } = deps;
  const exec = deps.exec ?? run;
  const lockDir = deps.lockDir ?? (process.env.PINS_LOCK_DIR || "/run/lock/onspot");
  const waitMs = deps.waitMs ?? 240000;
  const gateMs = deps.gateMs ?? 480000;
  const sleep = deps.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const id = String(input?.id ?? "");
  let step = "validate";
  let root, branch;

  const git = async (args, { repo = root, check = true } = {}) => {
    const result = await exec("git", ["-C", repo, ...args], { cwd: "/tmp", env: GIT_ENV, timeoutMs: 120000 });
    return check ? need(result, `git ${args.find((a) => /^[a-z][a-z-]*$/.test(a))}`) : result;
  };
  const gh = async (args) => need(await exec("gh", args, { cwd: "/tmp", timeoutMs: 120000 }), `gh ${args[0]} ${args[1]}`);
  const head = async () => (await git(["rev-parse", "HEAD"])).stdout.trim();
  const progress = async (text) => {
    out(text);
    try { await api.post(`/pins/${id}/progress`, { text: text.slice(0, 120) }); } catch {}
  };

  // One lane per project: the lock is released in finally and on SIGINT or SIGTERM.
  async function inLane(name, lane, work) {
    const body = JSON.stringify({ pid: process.pid, pin: Number(id), at: new Date().toISOString() });
    const drop = await takeLane(join(lockDir, `${name}.lock`), body, {
      waitMs, sleep, onWait: (pin) => out(`Waiting for the ${lane} lane (pin #${pin} holds it)`),
    });
    const onSignal = (signal) => {
      drop();
      for (const child of running) killGroup(child);
      process.kill(process.pid, signal);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      return await work();
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      drop();
    }
  }

  async function mergeCommit(number, repo) {
    const view = JSON.parse((await gh(["pr", "view", String(number), "-R", repo, "--json", "state,mergeCommit"])).stdout);
    if (view.state !== "MERGED" || !is(SHA_RE, view.mergeCommit?.oid)) throw failure(`PR #${number} is ${view.state}, not merged`);
    return view.mergeCommit.oid;
  }

  try {
    // 1. Validate. No git write happens before the pin check.
    const bad = badInput({ ...input, id });
    if (bad) throw failure(bad);
    const { dir, summary, paths } = input;
    const message = input.message ?? `Pin #${id}: ${firstLine(summary).slice(0, 72)}`;
    try { root = realpathSync(dir); } catch { throw failure(`${dir} does not exist`); }
    const checked = paths.map((path) => checkPath(root, path));
    const refused = checked.find((c) => c.reason);
    if (refused) throw failure(refused.reason);
    const files = [...new Set(checked.map((c) => c.rel))];
    if ((await git(["rev-parse", "--show-toplevel"])).stdout.trim() !== root) throw failure(`${dir} is not the top folder of a git checkout`);
    branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    if (["main", "master", "HEAD"].includes(branch) || !BRANCH_RE.test(branch)) throw failure(`ship needs a pin branch, not ${branch}`);
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    out(`Branch ${branch}, paths: ${files.length}`);

    // 2. Pin.
    step = "pin";
    const { pin } = await api.get(`/pins/${id}`);
    if (pin?.status !== "working") throw failure(`pin #${id} is ${pin?.status ?? "missing"}`);
    out(`Pin #${id} is working`);

    // 3. Manifest, from main, not from the working files.
    step = "manifest";
    const shown = await git(["show", "origin/main:deploy/project.json"], { check: false });
    const manifest = shown.code === 0 ? readManifest(shown.stdout) : null;
    if (!manifest) throw failure(NO_MANIFEST);
    const { key, repo } = manifest;
    const node = manifest.runtime?.node;
    if (node != null && (typeof node !== "string" || !isAbsolute(node) || node.includes(":"))) throw failure("runtime.node must be an absolute folder");
    const domain = manifest.channels.staging.domains[0];
    out(`Project ${key} (${repo}), staging ${domain}`);

    // 4. Commit only the listed paths; other staged or changed files stop the ship.
    step = "commit";
    await git(["add", "--", ...files]);
    const staged = (await git(["diff", "--cached", "--quiet", "--", ...files], { check: false })).code === 1;
    if (staged) await git(["commit", "-q", "-m", message, "--", ...files]);
    else if ((await git(["rev-list", "--count", "origin/main..HEAD"])).stdout.trim() === "0") throw failure("nothing to ship");
    const left = (await git(["status", "--porcelain", "--untracked-files=no"])).stdout.trimEnd();
    if (left) throw failure("changed but not in the commit: add them to the command or restore them", left);
    let commit = await head();
    out(staged ? `Commit ${commit.slice(0, 7)}` : `No new changes, HEAD ${commit.slice(0, 7)}`);

    // 5. Resume: a merged PR that holds this HEAD goes straight to the release.
    step = "resume";
    const [pr] = JSON.parse((await gh(["pr", "list", "-R", repo, "--head", branch, "--state", "all", "--json", "number,state,headRefOid", "--limit", "1"])).stdout);
    let merged = null;
    if (pr?.state === "MERGED" && pr.headRefOid === commit) {
      merged = await mergeCommit(pr.number, repo);
      out(`PR #${pr.number} is merged already (${merged.slice(0, 7)}): go to the release`);
    } else out(pr?.state === "OPEN" ? `PR #${pr.number} is open` : "No open PR yet");

    if (!merged) {
      // 6. Base.
      step = "base";
      await git([...CRED, "fetch", "-q", "origin", "main"]);
      const based = (await git(["merge-base", "--is-ancestor", "origin/main", "HEAD"], { check: false })).code === 0;
      if (!based) {
        const rebase = await git(["rebase", "-q", "origin/main"], { check: false });
        if (rebase.code !== 0) {
          await git(["rebase", "--abort"], { check: false });
          throw failure("main changed the same lines", `${rebase.stdout}\n${rebase.stderr}`);
        }
        commit = await head();
      }
      out(based ? "Base is origin/main" : `Rebased on origin/main: ${commit.slice(0, 7)}`);

      // 7. Gate, in the test lane. A marker skips a commit that passed before.
      step = "gate";
      const marker = join(lockDir, `passed-${key}-${id}`);
      let passedBefore = false;
      try { passedBefore = readFileSync(marker, "utf8").trim() === commit; } catch {}
      if (passedBefore) await progress(`Gate passes (${commit.slice(0, 7)} passed before)`);
      else {
        const env = { PATH: [node, "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":"), HOME: process.env.HOME ?? "/root", CI: "1", LANG: "C.UTF-8" };
        const seconds = await inLane(`gate-${key}`, "test", async () => {
          const started = Date.now();
          for (const name of ["build", "test"]) {
            const script = manifest.release[name];
            if (typeof script === "string" && script.trim()) need(await exec("bash", ["-c", script], { cwd: root, env, timeoutMs: gateMs }), `release.${name}`);
          }
          writeFileSync(marker, `${commit}\n`, { mode: 0o600 });
          return Math.round((Date.now() - started) / 1000);
        });
        await progress(`Gate passes (${seconds} s)`);
      }

      // 8. Push and merge. --force only for this pin's own branch, checked in step 1.
      step = "merge";
      await git([...CRED, "push", "-q", "--force", "origin", `HEAD:refs/heads/${branch}`]);
      let number = pr?.state === "OPEN" ? pr.number : null;
      if (!number) {
        const created = await gh(["pr", "create", "-R", repo, "--head", branch, "--base", "main", `--title=${firstLine(message)}`, `--body=OnSpot pin #${id}.\n\n${summary}`]);
        number = Number(/\/pull\/(\d+)\s*$/.exec(created.stdout)?.[1]);
        if (!number) throw failure("gh pr create printed no PR link", created.stdout);
      }
      await gh(["pr", "merge", String(number), "-R", repo, "--squash", "--delete-branch"]);
      merged = await mergeCommit(number, repo);
      await progress(`Merged ${merged.slice(0, 7)}`);
    }

    // 9. Release to staging, in the release lane. The channel is a constant: never prod.
    step = "release";
    const version = await inLane(`release-${key}`, "release", async () => {
      const result = need(await exec("proj", ["release", key, "staging"], { cwd: "/tmp", timeoutMs: RELEASE_MS }), "proj release");
      const last = result.stdout.trim().split("\n").pop() ?? "";
      return /: staging runs (\S+) \(/.exec(last)?.[1];
    });
    await progress(version ? `Live on staging ${version}` : "Live on staging");

    // 10. Check the pinned element on the live page.
    step = "check";
    let shot;
    try { shot = await snapAfter(pin); } catch (error) { shot = { ok: null, text: `after shot failed: ${error.message}` }; }
    if (shot?.text) out(String(shot.text));
    if (shot?.ok === false) {
      out(`The pinned element did not change as the pin asks. Look at the live page. Then fix the change and run ship again, or close with: pins done ${id} --summary "..." --commit ${merged}`);
      return 4;
    }

    // 11. Close.
    step = "close";
    await api.post(`/pins/${id}/resolve`, { summary, commit: merged });
    out(`#${id} done · ${merged.slice(0, 7)} · https://${domain}`);

    // 12. Clean up, best effort: it never fails the ship.
    try {
      rmSync(join(lockDir, `passed-${key}-${id}`), { force: true });
      const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
      const main = dirname(common);
      for (const args of [["worktree", "remove", root], ["branch", "-D", branch]]) {
        const result = await git(args, { repo: main, check: false });
        if (result.code !== 0) {
          out(`Note: git ${args[0]} ${args[1]} failed: ${redact(firstLine(result.stderr || result.stdout))}`);
          break;
        }
      }
    } catch (error) {
      out(`Note: clean up failed: ${redact(firstLine(error.message))}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof Busy) {
      out("The lane is busy. Run the same command again.");
      return 3;
    }
    out(`ship stopped at ${step}: ${redact(String(error.message))}`);
    const lines = redact(String(error.output ?? "")).replace(/^\s*\n/, "").trimEnd();
    if (lines) for (const line of lines.split("\n").slice(-30)) out(line);
    out("Fix it and run the same command again.");
    return 1;
  }
}
