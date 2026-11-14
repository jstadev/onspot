// The runner's settings, from the environment (docs/protocol.md, Auto-fix runner, items 2, 4, 5 and
// 12 to 14). A bad value throws at start: a limit or a switch that is misread is worse than a stop.
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function readConfig(env = process.env) {
  const integer = (name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < min || value > max || env[name] === "") throw new Error(`Invalid ${name}`);
    return value;
  };
  // A switch is "0" or "1". Any other value throws, so "true" or "off" never passes for a setting.
  const flag = (name, fallback) => {
    if (![undefined, "0", "1"].includes(env[name])) throw new Error(`Invalid ${name}`);
    return env[name] === undefined ? fallback : env[name] === "1";
  };
  const folder = (name, fallback) => {
    const value = env[name] ?? fallback;
    if (!isAbsolute(value)) throw new Error(`Invalid ${name}`);
    return value;
  };
  // Hosts whose pins another agent handles (for example Drop store previews, edited by the Drop
  // worker as store content). Each entry is a host suffix that starts with a dot.
  const skipHosts = (env.PINS_RUNNER_SKIP_HOSTS ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (skipHosts.some((suffix) => !/^\.[a-z0-9.-]+$/.test(suffix))) throw new Error("Invalid PINS_RUNNER_SKIP_HOSTS");
  return {
    port: integer("PINS_PORT", 4750, 1, 65535), disabled: flag("PINS_RUNNER_DISABLED", false),
    // 0 = no limit (the default since 2026-11-10: a queued pin starts at once, however many run).
    maxRuns: integer("MAX_RUNS", 0), maxRunsPerProject: integer("MAX_RUNS_PER_PROJECT", 0),
    maxRunsPerDay: integer("MAX_RUNS_PER_DAY", 0), skipHosts,
    // The fast path (docs/memory-layer.md). Each part is on unless its switch is "0".
    brief: flag("PINS_RUNNER_BRIEF", true), shots: flag("PINS_RUNNER_SHOTS", true), lean: flag("PINS_RUNNER_LEAN", true),
    // Where a session starts when no project matches the host.
    cwd: folder("PINS_RUNNER_CWD", homedir()),
    // One folder per project, each with project.json, MEMORY.md and state.md (runner/src/projects.js).
    projectsDir: folder("PINS_PROJECTS_DIR", join(homedir(), ".claude", "memory-store", "projects")),
  };
}
