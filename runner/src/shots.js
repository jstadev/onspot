// The "before" shot of a started pin (docs/protocol.md, Auto-fix runner, item 13). The harness
// takes it, so the session spends no call on it.
import { execFile } from "node:child_process";
import { homedir } from "node:os";

const AT_ONCE = 2;
// A simple pin is live about 70 s after its start. A shot that starts later than this after the
// delegation could show the page after the change, and the element check would then compare the
// change with itself.
const MAX_WAIT = 60_000;

/** `pins snap <id> before` in its own transient unit, so the browser stays outside the runner's
 *  memory limit and sandbox. Returns [file, args] for execFile: an argument array, no shell. */
export function shotCommand(id, { port, pinsCli, node = process.execPath, env = process.env }) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid pin id");
  return ["/usr/bin/systemd-run", [
    "--quiet", "--wait", "--collect", "--slice=onspot.slice", "--property=MemoryMax=1G", "--property=RuntimeMaxSec=75",
    "--setenv=PINS_AGENT=claude", `--setenv=PINS_PORT=${port}`, `--setenv=HOME=${homedir()}`,
    `--setenv=PATH=${env.PINS_SHOT_PATH || "/opt/studio/bin:/usr/local/bin:/usr/bin:/bin"}`,
    ...(env.PINS_FACTS_DIR ? [`--setenv=PINS_FACTS_DIR=${env.PINS_FACTS_DIR}`] : []),
    node, pinsCli, "snap", String(id), "before",
  ]];
}

/** Runs the command. The unit stops itself after 75 s; the wait ends after 90 s at the latest. */
export const systemShot = (options) => (id) => new Promise((resolve, reject) => {
  const [file, args] = shotCommand(id, options);
  execFile(file, args, { timeout: 90_000 }, (error) => (error ? reject(error) : resolve()));
});

/** A queue of pins that wait for their shot: at most 2 run at a time, outside the decision queue.
 *  add(id, since): since is the time when the session of the pin started (default: now). A shot
 *  that cannot start within 60 s of it is skipped. A failed or skipped shot changes nothing else.
 *  stop() does not wait for running shots. */
export function createShots({ shoot, clock, log }) {
  const waiting = [];
  let running = 0, stopped = false;
  function pump() {
    while (!stopped && running < AT_ONCE && waiting.length) {
      const { id, since } = waiting.shift();
      if (clock.now() - since > MAX_WAIT) { log(`before shot skipped pin=${id}`); continue; }
      running++;
      Promise.resolve(id).then(shoot)
        .catch(() => log(`before shot failed pin=${id}`))
        .finally(() => { running--; pump(); })
        // A log that throws must not become an unhandled rejection.
        .catch(() => {});
    }
  }
  return {
    add(id, since = clock.now()) { waiting.push({ id, since }); pump(); },
    stop() { stopped = true; waiting.length = 0; },
    get size() { return waiting.length; },
  };
}
