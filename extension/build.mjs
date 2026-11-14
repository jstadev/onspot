// Builds dist/chrome, dist/firefox and the two ZIPs. Optional build variables for another
// deployment (all ONSPOT_*; an empty value counts as not set):
//   ONSPOT_API          where the Pins server is reached, default https://ai.koglabs.com/pins
//   ONSPOT_ROOT_DOMAIN  pins live on this domain and its subdomains, default koglabs.com
//   ONSPOT_QUEUE_URL    the queue page, default <API origin>/triad?tab=pins
//   ONSPOT_LOGIN_URL    the login page, default <API origin>/login
//   ONSPOT_RUN_URL      the live view of a run, plus its id, default <API origin>/agents?tab=today&run=
//   ONSPOT_CHROME_KEY   the public key that fixes the Chrome extension id, default manifest/chrome-key.txt
//   ONSPOT_GECKO_ID     the Firefox add-on id, default from manifest/firefox.json
import { build } from "esbuild";
import { access, chmod, copyFile, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createHash, createPublicKey } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL(".", import.meta.url));
const dist = join(root, "dist");
const budgetKB = 88; // 0.4.0 (shortcuts) does not fit the old 72 KB
const budget = budgetKB * 1024;
const icons = [16, 32, 48, 128].map((size) => `icons/icon-${size}.png`);
const files = ["manifest.json", "content.js", "background.js", ...icons];
const entries = { content: "src/content/index.js", background: "src/background.js" };
const protocol = "src/shared/protocol.js";
const manifestParts = ["manifest/base.json", "manifest/chrome.json", "manifest/firefox.json", "manifest/chrome-key.txt"];

async function readText(path) {
  try {
    return (await readFile(join(root, path), "utf8")).trim();
  } catch {
    throw new Error(`Missing ${path}.`);
  }
}

async function readJSON(path) {
  const text = await readText(path);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`);
  }
}

function httpsURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash ? url : null;
  } catch {
    return null;
  }
}

function publicKey(value) {
  try {
    const der = Buffer.from(value, "base64");
    createPublicKey({ key: der, format: "der", type: "spki" });
    return der.toString("base64") === value;
  } catch {
    return false;
  }
}

// A plain host name: lower case, at least one dot, no port. Both names go into match patterns of
// the manifest, where "*" and other signs that the URL parser takes would widen the permission.
const hostName = (value) => /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(value);

// Each build variable: what a good value is (for the error message) and its check.
const VARIABLES = {
  ONSPOT_API: ["an https URL with a plain host name, without a query and without a slash at the end, like https://ai.koglabs.com/pins",
    (value) => { const url = httpsURL(value); return Boolean(url) && hostName(url.hostname) && url.origin + url.pathname.replace(/\/$/, "") === value; }],
  ONSPOT_ROOT_DOMAIN: ["a host name in lower case with at least one dot, like koglabs.com", hostName],
  ONSPOT_QUEUE_URL: ["an https URL with a query, like https://ai.koglabs.com/triad?tab=pins (the extension adds &host=<host>)",
    (value) => { const url = httpsURL(value); return url?.href === value && url.search !== ""; }],
  ONSPOT_LOGIN_URL: ["an https URL without a query, like https://ai.koglabs.com/login (the extension adds ?next=<page>)",
    (value) => { const url = httpsURL(value); return url?.href === value && url.search === ""; }],
  ONSPOT_RUN_URL: ["an https URL, like https://ai.koglabs.com/agents?tab=today&run= (the extension adds the run id)",
    (value) => httpsURL(value)?.href === value],
  ONSPOT_CHROME_KEY: ["a public key (DER, SubjectPublicKeyInfo) in base64 on one line", publicKey],
  ONSPOT_GECKO_ID: ["a Firefox add-on id, like pins@koglabs.com or a {UUID}, at most 80 characters",
    (value) => value.length <= 80 && /^(\{[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\}|[\w.-]*@[\w.-]+)$/i.test(value)],
};

// Stops the build when a value breaks the rule of its variable. `source` names where the value is from.
function check(name, value, source = name) {
  const [rule, valid] = VARIABLES[name];
  if (typeof value !== "string" || !valid(value)) throw new Error(`${source} must be ${rule}. It is ${JSON.stringify(value)}.`);
  return value;
}

// Chrome makes the extension id from the key: the first 16 bytes of its SHA-256, as the letters a to p.
const chromeId = (key) => [...createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16)]
  .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");

async function main() {
  for (const path of [...Object.values(entries), protocol, ...manifestParts, "package.json", ...icons]) {
    try { await access(join(root, path)); } catch { throw new Error(`Missing ${path}.`); }
  }
  const pkg = await readJSON("package.json");
  const base = await readJSON("manifest/base.json");
  const overlays = { chrome: await readJSON("manifest/chrome.json"), firefox: await readJSON("manifest/firefox.json") };
  const gecko = overlays.firefox.browser_specific_settings?.gecko;
  if (!base.content_scripts?.[0]) throw new Error("manifest/base.json needs content_scripts with one entry.");
  if (!gecko?.strict_min_version) throw new Error("manifest/firefox.json needs browser_specific_settings.gecko with id and strict_min_version.");
  if (!overlays.chrome.minimum_chrome_version) throw new Error("manifest/chrome.json needs minimum_chrome_version.");

  // A variable that is not set stays `undefined` in the bundles: the default in the shared
  // constants applies. An empty value counts as not set.
  const env = {};
  for (const name of Object.keys(VARIABLES)) if (process.env[name]) env[name] = check(name, process.env[name]);
  const shared = await import(pathToFileURL(join(root, protocol)).href);
  const api = new URL(env.ONSPOT_API ?? shared.API);
  const rootDomain = env.ONSPOT_ROOT_DOMAIN ?? shared.ROOT_DOMAIN;
  const chromeKey = env.ONSPOT_CHROME_KEY ?? check("ONSPOT_CHROME_KEY", await readText("manifest/chrome-key.txt"), "manifest/chrome-key.txt");
  gecko.id = env.ONSPOT_GECKO_ID ?? check("ONSPOT_GECKO_ID", gecko.id, "The gecko id in manifest/firefox.json");
  const literal = (value) => value === undefined ? "undefined" : JSON.stringify(value);
  const define = {
    __ONSPOT_VERSION__: literal(pkg.version),
    __ONSPOT_ROOT_DOMAIN__: literal(env.ONSPOT_ROOT_DOMAIN),
    __ONSPOT_API_ORIGIN__: literal(env.ONSPOT_API && api.origin),
    __ONSPOT_API__: literal(env.ONSPOT_API),
    __ONSPOT_QUEUE_URL__: literal(env.ONSPOT_QUEUE_URL),
    __ONSPOT_LOGIN_URL__: literal(env.ONSPOT_LOGIN_URL),
    __ONSPOT_RUN_URL__: literal(env.ONSPOT_RUN_URL),
  };
  // A match pattern takes no port: the permission names the host of the API only.
  base.host_permissions = [`https://${api.hostname}/*`];
  base.content_scripts[0].matches = [`https://${rootDomain}/*`, `https://*.${rootDomain}/*`];
  // The oldest browser that each manifest allows is also the syntax target of its bundle.
  const targets = { chrome: `chrome${overlays.chrome.minimum_chrome_version}`, firefox: `firefox${Number.parseInt(gecko.strict_min_version, 10)}` };

  // Build both browsers before the first write, so a failure leaves the old dist whole.
  const builds = [];
  for (const browser of ["chrome", "firefox"]) {
    const outdir = join(dist, browser);
    const manifest = { ...base, ...overlays[browser], version: pkg.version, ...(browser === "chrome" ? { key: chromeKey } : {}) };
    const result = await build({
      absWorkingDir: root,
      entryPoints: entries,
      outdir,
      bundle: true,
      format: "iife",
      minify: true,
      legalComments: "none",
      target: targets[browser],
      write: false,
      logLevel: "silent",
      define,
    });
    const content = result.outputFiles.find((file) => file.path === join(outdir, "content.js"));
    if (content.contents.byteLength > budget) {
      throw new Error(`${browser} content.js is ${content.contents.byteLength} bytes; the limit is ${budgetKB} KB (${budget} bytes).`);
    }
    builds.push({ browser, outdir, manifest, result, contentBytes: content.contents.byteLength });
  }

  for (const { browser, outdir, manifest, result, contentBytes } of builds) {
    await rm(outdir, { recursive: true, force: true });
    await mkdir(join(outdir, "icons"), { recursive: true });
    for (const file of result.outputFiles) await writeFile(file.path, file.contents);
    await writeFile(join(outdir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    for (const icon of icons) await copyFile(join(root, icon), join(outdir, icon));
    // Fixed file order, timestamps and modes keep repeated archives byte-identical, with any umask.
    for (const file of files) {
      await chmod(join(outdir, file), 0o644);
      await utimes(join(outdir, file), 946684800, 946684800);
    }
    const zip = join(dist, `onspot-${browser}.zip`);
    await rm(zip, { force: true });
    try {
      // A clean environment: zip reads more options from ZIPOPT.
      execFileSync("zip", ["-X", "-q", zip, ...files], { cwd: outdir, env: { PATH: process.env.PATH, TZ: "UTC" } });
    } catch (error) {
      throw new Error(`Cannot create ${browser} ZIP. Install the zip CLI and retry. ${error.message}`);
    }
    const backgroundBytes = (await stat(join(outdir, "background.js"))).size;
    console.log(`${browser}: content.js ${contentBytes} bytes; background.js ${backgroundBytes} bytes; ZIP ${(await stat(zip)).size} bytes`);
  }
  console.log(`API ${api.href}; root domain ${rootDomain}; Chrome id ${chromeId(chromeKey)}; Firefox id ${gecko.id}`);
}

main().catch((error) => {
  console.error(`Build failed: ${error.message}`);
  process.exitCode = 1;
});
