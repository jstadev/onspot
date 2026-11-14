import { ConflictError, ValidationError, parseStatuses } from "./store.js";
import { formatDetail, formatLine, formatList } from "./format.js";

const versions = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
const id = { type: "integer", minimum: 1, maximum: 999999999999 };
const agent = { type: "string", minLength: 1, maxLength: 60 };
const host = { type: "string", minLength: 1 };
const message = { type: "string", minLength: 1, maxLength: 4000 };
const tool = (name, description, properties, required = []) => ({
  name, description, inputSchema: { type: "object", properties, required, additionalProperties: false },
});
const tools = [
  tool("pins_list", "List open feedback before choosing a pin to fix. Filter by host, path or status.", {
    host, status: { type: "string", default: "open", description: "open (queued, working, waiting), all, or comma-separated statuses" },
    path: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
  }),
  tool("pins_get", "Read a pin's targets, replies and steps before making a change.", { id }, ["id"]),
  tool("pins_start", "Claim a queued pin before starting its fix. Set agent to your name (claude, codex or grok).", { id, agent }, ["id"]),
  tool("pins_resolve", "Resolve a pin after fixing and deploying it. Include the summary, the commit and your agent name.", {
    id, summary: message, commit: { type: "string", maxLength: 200 }, agent,
  }, ["id", "summary"]),
  tool("pins_dismiss", "Dismiss an open pin when no change is needed. Explain the reason.", { id, reason: message, agent }, ["id", "reason"]),
  tool("pins_ask", "Ask a question and wait for the user's reply before continuing.", { id, question: message, agent }, ["id", "question"]),
  tool("pins_reopen", "Return a working, waiting or closed pin to the queue.", { id }, ["id"]),
  tool("pins_reply", "Add progress to a pin's thread without changing its status.", { id, body: message, agent }, ["id", "body"]),
  tool("pins_progress", "Post one short progress step while you work on a pin (at most 40 per run). The user sees it live.", {
    id, text: { type: "string", minLength: 1, maxLength: 200 }, agent,
  }, ["id", "text"]),
  tool("pins_wait", "Wait for the next new pin when the queue is empty. Optionally filter by host.", {
    host, timeoutSec: { type: "number", minimum: 0, maximum: 600, default: 120 },
  }),
];
const byName = new Map(tools.map((item) => [item.name, item]));
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const result = (text, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });
const missing = (id) => result(`pin #${id} not found`, true);
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

// Validate the small schema vocabulary above without a dependency or type coercion.
function checkInput(input, schema) {
  if (!object(input)) return "arguments must be an object";
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(schema.properties, key)) return `unknown argument "${key}"`;
  }
  for (const key of schema.required) {
    if (!Object.hasOwn(input, key)) return `${key} is required`;
  }
  for (const [key, value] of Object.entries(input)) {
    const rule = schema.properties[key];
    if (rule.type === "string") {
      if (typeof value !== "string") return `${key} must be text`;
      if (rule.minLength && value.trim().length < rule.minLength) return `${key} is required`;
      if (rule.maxLength && value.length > rule.maxLength) return `${key} is longer than ${rule.maxLength} characters`;
    } else {
      if (typeof value !== "number" || !Number.isFinite(value) || (rule.type === "integer" && !Number.isSafeInteger(value))) {
        return `${key} must be ${rule.type === "integer" ? "an integer" : "a number"}`;
      }
      if (value < rule.minimum || value > rule.maximum) return `${key} must be between ${rule.minimum} and ${rule.maximum}`;
    }
  }
  return null;
}

export function createMcpHandler({ store, version }) {
  async function callTool(name, input, signal) {
    const invalid = checkInput(input, byName.get(name).inputSchema);
    if (invalid) return result(invalid, true);
    const actor = input.agent?.trim() ?? "agent";
    try {
      if (name === "pins_list") {
        return result(formatList(store.listPins({ statuses: parseStatuses(input.status), host: input.host, path: input.path, limit: input.limit ?? 30 })));
      }
      if (name === "pins_wait") {
        const pin = await store.nextCreated({ host: input.host, timeoutMs: (input.timeoutSec ?? 120) * 1000, signal });
        return result(pin ? formatDetail(pin, store.listReplies(pin.id)) : "no new pins");
      }
      if (name === "pins_get") {
        const pin = store.getPin(input.id);
        return pin ? result(formatDetail(pin, store.listReplies(pin.id), store.listSteps(pin.id))) : missing(input.id);
      }
      if (name === "pins_reply") {
        const reply = store.addReply(input.id, { kind: "agent", author: actor, body: input.body });
        return reply ? result(`reply added to #${input.id}`) : missing(input.id);
      }
      if (name === "pins_progress") {
        const added = store.addStep(input.id, { author: actor, body: input.text });
        return added ? result(`#${input.id} step ${added.pin.progress.count}`) : missing(input.id);
      }
      const pin = store.transition(input.id, name.slice(5), { ...input, agent: actor, kind: "agent", author: actor });
      return pin ? result(formatLine(pin)) : missing(input.id);
    } catch (error) {
      if (error instanceof ValidationError || error instanceof ConflictError) return result(error.message, true);
      throw error;
    }
  }

  async function dispatch(request, signal) {
    if (!object(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string"
      || (Object.hasOwn(request, "id") && request.id !== null && typeof request.id !== "string"
        && !(typeof request.id === "number" && Number.isFinite(request.id)))) {
      return rpcError(null, -32600, "Invalid Request");
    }
    const notification = !Object.hasOwn(request, "id");
    const fail = (code, message) => notification ? null : rpcError(request.id, code, message);
    const params = request.params === undefined ? {} : request.params;
    if (!object(params)) return fail(-32602, "params must be an object");
    let value;
    try {
      switch (request.method) {
        case "initialize":
          if ((params.protocolVersion !== undefined && typeof params.protocolVersion !== "string")
            || (params.capabilities !== undefined && !object(params.capabilities))
            || (params.clientInfo !== undefined && !object(params.clientInfo))) return fail(-32602, "invalid initialize params");
          value = {
            protocolVersion: versions.has(params.protocolVersion) ? params.protocolVersion : "2025-06-18",
            capabilities: { tools: {} }, serverInfo: { name: "pins", version },
            instructions: "List pins, start one, fix it, deploy the fix, then resolve it with a summary and commit.",
          };
          break;
        case "notifications/initialized":
        case "ping":
          value = {};
          break;
        case "tools/list":
          value = { tools };
          break;
        case "tools/call":
          if (typeof params.name !== "string") return fail(-32602, "tool name is required");
          if (!byName.has(params.name)) return fail(-32602, `unknown tool "${params.name}"`);
          value = await callTool(params.name, params.arguments === undefined ? {} : params.arguments, signal);
          break;
        default:
          return fail(-32601, "Method not found");
      }
    } catch {
      return fail(-32603, "Internal error");
    }
    return notification ? null : { jsonrpc: "2.0", id: request.id, result: value };
  }

  return async (req, res, body) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    // IncomingMessage also emits close after a complete body, before the response.
    const requestClosed = () => { if (req.aborted || !req.complete || req.socket?.destroyed) abort(); };
    req.once("close", requestClosed);
    res.once("close", abort);
    if (req.aborted || res.destroyed) abort();
    try {
      const answer = Array.isArray(body) && body.length
        ? (await Promise.all(body.map((item) => dispatch(item, controller.signal)))).filter((item) => item !== null)
        : await dispatch(body, controller.signal);
      if (res.destroyed) return;
      if (answer === null || (Array.isArray(answer) && !answer.length)) {
        res.writeHead(202);
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        res.end(JSON.stringify(answer));
      }
    } finally {
      req.off("close", requestClosed);
      res.off("close", abort);
    }
  };
}
