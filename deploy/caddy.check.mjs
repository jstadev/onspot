// Checks deploy/onspot.caddy against the contract (docs/protocol.md, "Caddy") with a real Caddy.
// It starts a fake SSO and a fake Pins server on loopback, runs `caddy run` with the snippet on a
// free port and sends the requests below. It never touches the live proxy or the live server.
// Usage: node deploy/caddy.check.mjs [snippet file]   (needs the `caddy` binary on PATH)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const snippetFile = process.argv[2] || fileURLToPath(new URL("onspot.caddy", import.meta.url));
const CHROME = "chrome-extension://djdijfjclpkhleoeaedeglfbbbmhmbff";
const FIREFOX = "moz-extension://0a1b2c3d-0a1b-0a1b-0a1b-0a1b2c3d4e5f";
const HUB = "https://ai.koglabs.com";

const listen = (handler) => new Promise((resolve) => {
  const server = createServer(handler).listen(0, "127.0.0.1", () => resolve(server));
});
const freePort = async () => {
  const server = await listen(() => {});
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
};

// The fake SSO: the cookie "sso=ok" is an admin, "sso=nouser" is a 200 without a user header.
const sso = await listen((req, res) => {
  const cookie = req.headers.cookie ?? "";
  const admin = req.url === "/api/sso/verify?require=admin" && /\bsso=(ok|nouser)\b/.test(cookie);
  res.writeHead(admin ? 200 : 401, { "Content-Type": "application/json", ...(cookie.includes("sso=ok") ? { "X-SSO-User": "tester" } : {}) });
  res.end(admin ? "{}" : '{"error":"sign in"}');
});
// The fake Pins server: it records what reaches it.
const seen = [];
const pins = await listen((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; }).on("end", () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
});
const ssoAt = `127.0.0.1:${sso.address().port}`, pinsAt = `127.0.0.1:${pins.address().port}`;

const port = await freePort();
const dir = mkdtempSync(join(tmpdir(), "onspot-caddy-"));
const snippet = readFileSync(snippetFile, "utf8").replaceAll("127.0.0.1:3000", ssoAt).replaceAll("127.0.0.1:4750", pinsAt);
writeFileSync(join(dir, "Caddyfile"), `{\n\tadmin off\n\tauto_https off\n}\nhttp://127.0.0.1:${port} {\n${snippet}\n\thandle {\n\t\trespond "outside" 200\n\t}\n}\n`);
const caddy = spawn("caddy", ["run", "--config", join(dir, "Caddyfile"), "--adapter", "caddyfile"], { stdio: ["ignore", "ignore", "pipe"] });
let caddyLog = "";
caddy.stderr.on("data", (chunk) => { caddyLog += chunk; });
const stop = () => { caddy.kill("SIGTERM"); sso.close(); pins.close(); rmSync(dir, { recursive: true, force: true }); };
caddy.once("error", (error) => { console.error(`caddy did not start: ${error.message}`); stop(); process.exit(1); });

const base = `http://127.0.0.1:${port}`;
// node:http, not fetch: fetch sets its own Sec-Fetch-Mode and Origin rules.
const send = (path, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
  seen.length = 0;
  const req = request(base + path, { method, headers }, (res) => {
    res.resume().on("end", () => resolve({ status: res.statusCode, headers: res.headers, upstream: seen[0] ?? null }));
  });
  req.on("error", reject).end(body);
});
for (let tries = 0; ; tries++) {
  try { await send("/"); break; }
  catch {
    if (tries > 100 || caddy.exitCode !== null) { console.error(`caddy is not ready:\n${caddyLog.slice(-800)}`); stop(); process.exit(1); }
    await new Promise((done) => setTimeout(done, 50));
  }
}

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
};
const admin = { Cookie: "sso=ok" };
const json = { "Content-Type": "application/json" };

try {
  let r = await send("/pins");
  check("/pins redirects to /pins/", r.status === 308 && r.headers.location === "/pins/", `${r.status} ${r.headers.location}`);

  r = await send("/other");
  check("a path outside /pins is not handled here", r.status === 200 && !r.upstream);

  r = await send("/pins/api/health");
  check("signed out, API call: 401 and nothing reaches the server", r.status === 401 && !r.upstream, String(r.status));

  r = await send("/pins/?host=a.koglabs.com", { headers: { "Sec-Fetch-Mode": "navigate" } });
  check("signed out, page load: 302 to the hub login and back", r.status === 302 && r.headers.location === `${HUB}/login?next=${HUB}/pins/?host=a.koglabs.com` && !r.upstream, `${r.status} ${r.headers.location}`);

  r = await send("/pins/api/pins?status=all", { headers: admin });
  const up = r.upstream;
  check("signed in GET reaches the server without /pins", r.status === 200 && up?.url === "/api/pins?status=all", `${r.status} ${up?.url}`);
  check("the server gets Host of loopback, the SSO user and X-Forwarded-For", up?.headers.host === pinsAt && up.headers["x-sso-user"] === "tester" && up.headers["x-forwarded-for"] !== undefined, JSON.stringify(up?.headers));
  check("response headers: nosniff, noindex, no Server", r.headers["x-content-type-options"] === "nosniff" && /noindex/.test(r.headers["x-robots-tag"] ?? "") && r.headers.server === undefined);

  r = await send("/pins/api/pins", { headers: { ...admin, "X-Pins-Agent": "claude", "X-SSO-User": "evil" } });
  check("a browser cannot act as an agent or name itself", r.upstream && r.upstream.headers["x-pins-agent"] === undefined && r.upstream.headers["x-sso-user"] === "tester", JSON.stringify(r.upstream?.headers));

  r = await send("/pins/api/pins", { headers: { Cookie: "sso=nouser", "X-SSO-User": "evil" } });
  check("a client X-SSO-User never reaches the server, also when the SSO names no user", r.upstream?.headers["x-sso-user"] === undefined, `x-sso-user=${r.upstream?.headers["x-sso-user"]}`);

  for (const origin of ["https://evil.example", "https://ai.koglabs.com.evil.example", "https://x.koglabs.com", "http://ai.koglabs.com", "null",
    "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "moz-extension://not-a-uuid", `${CHROME}x`]) {
    r = await send("/pins/api/pins", { headers: { ...admin, Origin: origin } });
    const w = await send("/pins/api/pins", { method: "POST", headers: { ...admin, ...json, Origin: origin }, body: "{}" });
    check(`foreign Origin ${origin}: 403 for GET and POST`, r.status === 403 && !r.upstream && w.status === 403 && !w.upstream, `${r.status} ${w.status}`);
  }

  for (const origin of [HUB, CHROME, FIREFOX]) {
    r = await send("/pins/api/pins", { method: "POST", headers: { ...admin, ...json, Origin: origin }, body: '{"note":"x"}' });
    check(`allowed Origin ${origin.split("//")[0]}: the write reaches the server without Origin`, r.status === 200 && r.upstream?.method === "POST" && r.upstream.body === '{"note":"x"}' && r.upstream.headers.origin === undefined, `${r.status} origin=${r.upstream?.headers.origin}`);
  }

  for (const method of ["POST", "PATCH", "DELETE", "PUT"]) {
    r = await send("/pins/api/pins/1", { method, headers: { ...admin, ...json }, body: method === "DELETE" ? undefined : "{}" });
    check(`${method} without an Origin: 403`, r.status === 403 && !r.upstream, String(r.status));
  }

  r = await send("/pins/api/pins", { method: "POST", headers: { ...json, Origin: CHROME }, body: "{}" });
  check("allowed Origin, signed out: 401 and nothing reaches the server", r.status === 401 && !r.upstream, String(r.status));

  for (const path of ["/pins/mcp", "/pins/mcp/", "/pins/mcp/x", "/pins/MCP", "/pins/%6dcp", "/pins//mcp", "/pins/./mcp", "/pins/api/../mcp"]) {
    r = await send(path, { method: "POST", headers: { ...admin, ...json, Origin: HUB }, body: "{}" });
    const reached = r.upstream && /^\/+mcp(\/|$)/i.test(r.upstream.url);
    check(`MCP is never served: POST ${path}`, !reached && (r.status === 404 || r.upstream), `${r.status} upstream=${r.upstream?.url}`);
  }
} finally {
  stop();
}
console.log(failed ? `FAIL: ${failed} checks failed` : "PASS: the snippet meets the contract");
process.exitCode = failed ? 1 : 0;
