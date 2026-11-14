import { readFile } from "node:fs/promises";
import { EFFORTS, MODELS } from "./model.js";

const ALLOWED = new Set(Object.values(MODELS));
const ACCOUNTS = ["claude", "claude-2"];

export function createTriad({
  fetch = globalThis.fetch,
  url = process.env.TRIAD_URL || "http://127.0.0.1:7788",
  tokenFile = process.env.TRIAD_TOKEN_FILE || "/srv/hub/triad/data/token",
  readToken = () => readFile(tokenFile, "utf8"),
  // The Claude account that runs every session: "claude" is main, "claude-2" is the second.
  account = process.env.PINS_CLAUDE_ACCOUNT ?? "claude",
} = {}) {
  if (!ACCOUNTS.includes(account)) throw new Error("PINS_CLAUDE_ACCOUNT must be claude or claude-2");
  const base = new URL(url);
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.username || base.password) {
    throw new Error("TRIAD_URL must be a loopback HTTP URL");
  }
  let token;
  async function request(path, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (token === undefined) token = String(await readToken()).trim();
      if (!token) throw new Error("Triad token is empty");
      const response = await fetch(`${base.href.replace(/\/$/, "")}${path}`, {
        method: body ? "POST" : "GET", redirect: "error",
        headers: { "x-triad-key": token, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      if ((response.status === 401 || response.status === 403) && attempt === 0) {
        await response.body?.cancel();
        token = undefined;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error(`Triad HTTP ${response.status}`), { status: response.status });
      }
      return response.json();
    }
  }
  return {
    // The bulk prompt names it in the lane command (docs/protocol.md, Bulk mode, item 5).
    account,
    async delegate({ cwd, label, prompt, model = MODELS.opus, effort = "high", profile }) {
      // Only the models of model.js, at a known effort, whatever a caller passes.
      if (!ALLOWED.has(model) || !EFFORTS.includes(effort)) throw new Error("Unsupported fix model");
      // "pin" asks Triad for the lean start (runner/src/profile.js). No profile is the full start.
      if (profile != null && profile !== "pin") throw new Error("Unsupported profile");
      const result = await request("/delegate", {
        agent: account, model, effort, cwd, label,
        reason: "OnSpot auto-fix", prompt, ...(profile ? { profile } : {}),
      });
      if (result.ok === false || !/^[1-9][0-9]*$/.test(String(result.id))) throw new Error("Triad returned no task id");
      return String(result.id);
    },
    async task(id) {
      if (!/^[1-9][0-9]*$/.test(String(id))) throw new Error("Invalid Triad task id");
      const result = await request(`/api/task/${id}`);
      if (typeof result.status !== "string" || !result.status) throw new Error("Triad returned no task status");
      // At a plan limit Triad ends the task and continues the same session in a new task on the
      // other Claude account. Task ids only grow, so a lower id is never a continuation.
      const next = String(result.continuedAs ?? "");
      return {
        status: result.status, exitCode: result.exitCode ?? null,
        lastLine: String(result.lastLine ?? result.result ?? "").trim().split(/\r?\n/).at(-1) || "",
        continuedAs: /^[1-9][0-9]*$/.test(next) && Number(next) > Number(id) ? next : null,
      };
    },
  };
}
