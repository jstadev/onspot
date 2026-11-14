// The process of the auto-fix runner: it reads the environment and joins the parts.
// An error at start (a bad setting) ends the process with its message; systemd shows it.
import { fileURLToPath } from "node:url";
import { createRunner } from "./runner.js";
import { readConfig } from "./config.js";
import { createTriad } from "./triad.js";
import { resolveProject } from "./projects.js";
import { buildPrompt } from "./prompt.js";
import { buildBrief } from "./brief.js";
import { openBudget } from "./budget.js";
import { systemShot } from "./shots.js";

const config = readConfig();
const pinsCli = fileURLToPath(new URL("../../server/bin/pins.js", import.meta.url));

const runner = createRunner({
  fetch: globalThis.fetch,
  clock: { now: Date.now, setTimeout, clearTimeout },
  triad: createTriad(),
  resolveProject: (host, path) => resolveProject(host, path, { root: config.projectsDir }),
  buildPrompt,
  brief: (input) => buildBrief(input, { log: console.log }),
  shoot: systemShot({ port: config.port, pinsCli }),
  config: { ...config, budget: openBudget(process.env.PINS_RUNNER_BUDGET_FILE || "/var/lib/onspot-runner/budget.json") },
});

// stop() waits for the step that runs, so a delegation that Triad took still gets its claim.
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await runner.stop();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
await runner.start();
