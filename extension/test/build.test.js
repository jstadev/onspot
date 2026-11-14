import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const sizes = [16, 32, 48, 128];
const files = ["manifest.json", "content.js", "background.js", ...sizes.map((size) => `icons/icon-${size}.png`)];
const json = (file, dir = root) => JSON.parse(readFileSync(join(dir, file), "utf8"));
const BUDGET = 88 * 1024;
// The build variables of this shell must not reach a test build.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ONSPOT_")));
const chromeId = (key) => [...createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16)]
  .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");

// A copy of the build script next to links to the real inputs: it builds into its own dist.
// `t` is a test, or `{ after }` for a folder that lives as long as this file.
function fixture(t, { copy = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "onspot-build-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(join(root, "build.mjs"), join(dir, "build.mjs"));
  for (const name of ["node_modules", "src", "manifest", "icons", "package.json"]) {
    if (copy.includes(name)) cpSync(join(root, name), join(dir, name), { recursive: true });
    else symlinkSync(join(root, name), join(dir, name));
  }
  const run = (env = {}, options = {}) => spawnSync(process.execPath, [join(dir, "build.mjs")], { encoding: "utf8", timeout: 60000, env: { ...cleanEnv, ...env }, ...options });
  return { dir, run };
}

// The real dist holds the build of the operator, and the server serves it as downloads. A test
// run must never write there: every build of this file goes to a temp folder.
// `ctimeMs` changes with every write and no call can set it.
function realDist() {
  try {
    return readdirSync(join(root, "dist"), { recursive: true }).sort().map((file) => {
      const { size, ctimeMs } = statSync(join(root, "dist", file));
      return `${file} ${size} ${ctimeMs}`;
    });
  } catch {
    return null; // No build yet.
  }
}
const distAtStart = realDist();

// The default build that the tests below read. Its folder lives until the file ends.
const built = fixture({ after });
before(() => {
  const result = built.run();
  assert.equal(result.status, 0, result.stderr);
  console.log(result.stdout.trim());
});

for (const browser of ["chrome", "firefox"]) {
  test(`${browser} build has the contract manifest, bounded bundles, and exact ZIP contents`, () => {
    const manifest = json(`dist/${browser}/manifest.json`, built.dir);
    assert.equal(manifest.name, "OnSpot");
    assert.equal(manifest.version, json("package.json").version);
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions, ["storage"]);
    assert.deepEqual(manifest.host_permissions, ["https://ai.koglabs.com/*"]);
    assert.deepEqual(manifest.content_scripts, [{
      matches: ["https://koglabs.com/*", "https://*.koglabs.com/*"],
      js: ["content.js"], run_at: "document_idle", all_frames: false,
    }]);
    assert.equal(manifest.commands["toggle-pins"].suggested_key.default, "Alt+Shift+P");
    assert.equal(manifest.action.default_title, "OnSpot");
    assert.equal(manifest.action.default_popup, undefined);
    const icons = Object.fromEntries(sizes.map((size) => [size, `icons/icon-${size}.png`]));
    assert.deepEqual(manifest.icons, icons);
    assert.deepEqual(manifest.action.default_icon, icons);
    // Least privilege: nothing but these keys, so a new permission or page cannot slip in.
    assert.deepEqual(Object.keys(manifest).sort(), ["action", "background", "commands", "content_scripts", "description", "host_permissions", "icons",
      "manifest_version", "name", "permissions", "version", ...(browser === "chrome" ? ["key", "minimum_chrome_version"] : ["browser_specific_settings"])].sort());
    if (browser === "chrome") {
      assert.deepEqual(manifest.background, { service_worker: "background.js" });
      assert.equal(manifest.minimum_chrome_version, "120");
      assert.equal(manifest.key, readFileSync(join(root, "manifest/chrome-key.txt"), "utf8").trim());
      assert.equal(chromeId(manifest.key), "djdijfjclpkhleoeaedeglfbbbmhmbff");
      assert.equal(manifest.browser_specific_settings, undefined);
    } else {
      assert.deepEqual(manifest.background, { scripts: ["background.js"] });
      assert.deepEqual(manifest.browser_specific_settings, {
        gecko: { id: "pins@koglabs.com", strict_min_version: "140.0", data_collection_permissions: { required: ["websiteContent"] } },
      });
      assert.equal(manifest.key, undefined);
    }
    const dir = join(built.dir, "dist", browser);
    const bytes = statSync(join(dir, "content.js")).size;
    assert.ok(bytes > 0 && bytes <= BUDGET);
    assert.ok(statSync(join(dir, "background.js")).size > 0);
    const zip = join(built.dir, "dist", `onspot-${browser}.zip`);
    assert.deepEqual(execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).trim().split("\n"), files);
    execFileSync("unzip", ["-tqq", zip]);
    for (const file of files) assert.deepEqual(execFileSync("unzip", ["-p", zip, file]), readFileSync(join(dir, file)));
  });
}

test("the default build holds the default addresses and no build placeholder", () => {
  for (const browser of ["chrome", "firefox"]) {
    const background = readFileSync(join(built.dir, "dist", browser, "background.js"), "utf8");
    const content = readFileSync(join(built.dir, "dist", browser, "content.js"), "utf8");
    for (const text of ['"https://ai.koglabs.com"', "/pins`", '"koglabs.com"']) assert.ok(background.includes(text), `${browser} background.js: ${text}`);
    for (const text of ['"https://ai.koglabs.com"', "/triad?tab=pins`", "/login`", "/agents?tab=today&run=`", `"${json("package.json").version}"`]) {
      assert.ok(content.includes(text), `${browser} content.js: ${text}`);
    }
    for (const bundle of [background, content]) assert.equal(/__ONSPOT_/.test(bundle), false);
  }
});

test("generated icons have transparent, antialiased edges, blue pins, and white dots", () => {
  for (const size of sizes) {
    const png = readFileSync(join(root, "icons", `icon-${size}.png`));
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    assert.equal(png[24], 8);
    assert.equal(png[25], 6);
    const data = [];
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset);
      if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") data.push(png.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    const rows = inflateSync(Buffer.concat(data));
    const stride = 1 + size * 4;
    assert.equal(rows.length, stride * size);
    let blue = false, white = false, antialiased = false;
    for (let y = 0; y < size; y++) {
      assert.equal(rows[y * stride], 0);
      for (let x = 0; x < size; x++) {
        const offset = y * stride + 1 + 4 * x;
        const [r, g, b, alpha] = rows.subarray(offset, offset + 4);
        if (alpha === 255 && r === 59 && g === 130 && b === 246) blue = true;
        if (alpha === 255 && r === 255 && g === 255 && b === 255) white = true;
        if (alpha > 0 && alpha < 255) antialiased = true;
      }
    }
    assert.equal(rows[4], 0); // The top-left pixel remains transparent.
    assert.ok(blue && white && antialiased, `icon-${size}.png`);
  }
});

test("ZIP builds are reproducible: a second build, another umask, other file dates and empty variables give the same bytes", (t) => {
  const archives = ["chrome", "firefox"].map((browser) => `dist/onspot-${browser}.zip`);
  const first = archives.map((archive) => readFileSync(join(built.dir, archive)));
  assert.equal(built.run().status, 0);
  archives.forEach((archive, index) => assert.deepEqual(readFileSync(join(built.dir, archive)), first[index], `second build: ${archive}`));
  // The same inputs in another folder, as copies with new dates, built with a strict umask.
  const { dir } = fixture(t, { copy: ["src", "manifest", "icons", "package.json"] });
  const empty = Object.fromEntries(["API", "ROOT_DOMAIN", "QUEUE_URL", "LOGIN_URL", "RUN_URL", "CHROME_KEY", "GECKO_ID"].map((name) => [`ONSPOT_${name}`, ""]));
  const result = spawnSync("sh", ["-c", 'umask 077 && exec "$0" "$1"', process.execPath, join(dir, "build.mjs")], { encoding: "utf8", timeout: 60000, env: { ...cleanEnv, ...empty } });
  assert.equal(result.status, 0, result.stderr);
  archives.forEach((archive, index) => assert.deepEqual(readFileSync(join(dir, archive)), first[index], `umask 077: ${archive}`));
});

test("build variables move every address, the key and the add-on id; nothing of the default deployment stays", (t) => {
  const { dir, run } = fixture(t);
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const result = run({
    ONSPOT_API: "https://hub.example.org:8443/feedback/pins",
    ONSPOT_ROOT_DOMAIN: "example.org",
    ONSPOT_QUEUE_URL: "https://hub.example.org/queue?view=pins",
    ONSPOT_LOGIN_URL: "https://sso.example.org/login",
    ONSPOT_RUN_URL: "https://hub.example.org/runs/",
    ONSPOT_CHROME_KEY: key,
    ONSPOT_GECKO_ID: "{2f1e8a5c-0000-4000-8000-00000000abcd}",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`API https://hub\\.example\\.org:8443/feedback/pins; root domain example\\.org; Chrome id ${chromeId(key)}; Firefox id \\{2f1e8a5c`));
  for (const browser of ["chrome", "firefox"]) {
    const manifest = json(`dist/${browser}/manifest.json`, dir);
    assert.deepEqual(manifest.host_permissions, ["https://hub.example.org/*"], "a match pattern takes no port");
    assert.deepEqual(manifest.content_scripts[0].matches, ["https://example.org/*", "https://*.example.org/*"]);
    if (browser === "chrome") assert.equal(manifest.key, key);
    else assert.equal(manifest.browser_specific_settings.gecko.id, "{2f1e8a5c-0000-4000-8000-00000000abcd}");
    const background = readFileSync(join(dir, "dist", browser, "background.js"), "utf8");
    const content = readFileSync(join(dir, "dist", browser, "content.js"), "utf8");
    for (const text of ['"https://hub.example.org:8443/feedback/pins"', '"example.org"']) assert.ok(background.includes(text), `${browser} background.js: ${text}`);
    for (const text of ['"https://hub.example.org/queue?view=pins"', '"https://sso.example.org/login"', '"https://hub.example.org/runs/"']) assert.ok(content.includes(text), `${browser} content.js: ${text}`);
    assert.equal(/koglabs\.com/i.test(background), false, `${browser} background.js still names koglabs.com`);
    assert.equal(/ai\.koglabs\.com/i.test(content), false, `${browser} content.js still names ai.koglabs.com`);
    assert.equal(/koglabs/i.test(JSON.stringify({ ...manifest, description: "" })), false, `${browser} manifest still names koglabs`);
  }
  // Only the API set: the queue, login and run pages follow its origin.
  assert.equal(run({ ONSPOT_API: "https://pins.example.net" }).status, 0);
  const content = readFileSync(join(dir, "dist/chrome/content.js"), "utf8");
  assert.ok(content.includes('"https://pins.example.net"') && !/ai\.koglabs\.com/.test(content));
  assert.deepEqual(json("dist/firefox/manifest.json", dir).host_permissions, ["https://pins.example.net/*"]);
  assert.deepEqual(json("dist/firefox/manifest.json", dir).content_scripts[0].matches, ["https://koglabs.com/*", "https://*.koglabs.com/*"]);
});

test("a bad build variable stops the build with its name, the rule and the value; dist stays as it was", async (t) => {
  const { dir, run } = fixture(t);
  assert.equal(run().status, 0);
  const zip = readFileSync(join(dir, "dist/onspot-chrome.zip"));
  const bad = {
    ONSPOT_API: ["http://ai.koglabs.com/pins", "https://ai.koglabs.com/pins/", "https://ai.koglabs.com/pins?x=1", "https://ai.koglabs.com/pins#x", "https://user:pw@ai.koglabs.com/pins",
      "https://AI.koglabs.com/pins", "ai.koglabs.com/pins", "//ai.koglabs.com/pins", "https://", " https://ai.koglabs.com/pins", "javascript:alert(1)", "https://ai.koglabs.com/a/../pins",
      // The URL parser takes these host names; a manifest permission must not.
      "https://*.example.org/pins", "https://*/pins", 'https://a.example"/pins', "https://a`${x}`.example/pins", "https://a_b.example.org/pins", "https://localhost/pins", "https://10.0.0.1/pins", "https://[::1]/pins",
      "https://example.org./pins"],
    ONSPOT_ROOT_DOMAIN: ["https://koglabs.com", "koglabs.com/", "*.koglabs.com", ".koglabs.com", "koglabs.com.", "KogLabs.com", "localhost", "com", "10.0.0.1", "kog labs.com", "koglabs.com:443", "-a.com", "a..com"],
    ONSPOT_QUEUE_URL: ["https://ai.koglabs.com/triad", "http://ai.koglabs.com/triad?tab=pins", "https://ai.koglabs.com/triad?tab=pins#x", "/triad?tab=pins"],
    ONSPOT_LOGIN_URL: ["https://ai.koglabs.com/login?next=", "http://ai.koglabs.com/login", "https://ai.koglabs.com", "login"],
    ONSPOT_RUN_URL: ["http://ai.koglabs.com/agents?run=", "agents?run=", "https://ai.koglabs.com/agents?run=#x", "https://ai.koglabs.com/a b"],
    ONSPOT_CHROME_KEY: ["not base64!", "AAAA", Buffer.from("not a key, but long enough to look like one").toString("base64"), ` ${readFileSync(join(root, "manifest/chrome-key.txt"), "utf8").trim()}`],
    ONSPOT_GECKO_ID: ["pins", "pins@", "pins @koglabs.com", "{not-a-uuid}", `${"a".repeat(80)}@x`, "<pins@koglabs.com>"],
  };
  // A refused build writes nothing, so these runs can share the folder and run side by side.
  const refused = (name, value) => new Promise((resolve) => {
    execFile(process.execPath, [join(dir, "build.mjs")], { env: { ...cleanEnv, [name]: value }, timeout: 60000 }, (error, stdout, stderr) => {
      assert.equal(error?.code, 1, `${name}=${value}`);
      assert.ok(stderr.startsWith(`Build failed: ${name} must be `), `${name}=${value}: ${stderr}`);
      assert.ok(stderr.includes(`It is ${JSON.stringify(value)}.`), stderr);
      assert.equal(stdout, "");
      resolve();
    });
  });
  await Promise.all(Object.entries(bad).flatMap(([name, values]) => values.map((value) => refused(name, value))));
  assert.deepEqual(readFileSync(join(dir, "dist/onspot-chrome.zip")), zip);
});

test("build fails clearly for a missing input, a broken manifest part and an oversized content bundle; dist stays as it was", (t) => {
  const empty = mkdtempSync(join(tmpdir(), "onspot-build-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  copyFileSync(join(root, "build.mjs"), join(empty, "build.mjs"));
  symlinkSync(join(root, "node_modules"), join(empty, "node_modules"), "dir");
  let result = spawnSync(process.execPath, [join(empty, "build.mjs")], { encoding: "utf8", timeout: 60000, env: cleanEnv });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "Build failed: Missing src/content/index.js.\n");

  const { dir, run } = fixture(t, { copy: ["src", "manifest"] });
  assert.equal(run().status, 0);
  const zips = () => ["chrome", "firefox"].map((browser) => readFileSync(join(dir, `dist/onspot-${browser}.zip`)));
  const good = zips();
  const original = (file) => readFileSync(join(root, file), "utf8");
  const fails = (expected) => {
    result = run();
    assert.equal(result.status, 1, expected);
    assert.equal(result.stderr, `Build failed: ${expected}\n`);
    assert.deepEqual(zips(), good, `dist changed after: ${expected}`);
  };
  for (const part of ["manifest/base.json", "manifest/chrome.json", "manifest/firefox.json", "manifest/chrome-key.txt", "src/shared/protocol.js", "src/background.js"]) {
    rmSync(join(dir, part));
    fails(`Missing ${part}.`);
    writeFileSync(join(dir, part), original(part));
  }
  writeFileSync(join(dir, "manifest/firefox.json"), "{ not JSON");
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Build failed: manifest\/firefox\.json is not valid JSON: /);
  writeFileSync(join(dir, "manifest/firefox.json"), JSON.stringify({ background: { scripts: ["background.js"] } }));
  fails("manifest/firefox.json needs browser_specific_settings.gecko with id and strict_min_version.");
  writeFileSync(join(dir, "manifest/firefox.json"), original("manifest/firefox.json").replace("pins@koglabs.com", "no at sign"));
  fails('The gecko id in manifest/firefox.json must be a Firefox add-on id, like pins@koglabs.com or a {UUID}, at most 80 characters. It is "no at sign".');
  writeFileSync(join(dir, "manifest/firefox.json"), original("manifest/firefox.json"));
  writeFileSync(join(dir, "manifest/chrome.json"), JSON.stringify({ background: { service_worker: "background.js" } }));
  fails("manifest/chrome.json needs minimum_chrome_version.");
  writeFileSync(join(dir, "manifest/chrome.json"), original("manifest/chrome.json"));
  writeFileSync(join(dir, "manifest/base.json"), JSON.stringify({ ...json("manifest/base.json"), content_scripts: [] }));
  fails("manifest/base.json needs content_scripts with one entry.");
  writeFileSync(join(dir, "manifest/base.json"), original("manifest/base.json"));
  writeFileSync(join(dir, "manifest/chrome-key.txt"), "AAAA\n");
  fails('manifest/chrome-key.txt must be a public key (DER, SubjectPublicKeyInfo) in base64 on one line. It is "AAAA".');
  writeFileSync(join(dir, "manifest/chrome-key.txt"), original("manifest/chrome-key.txt"));

  writeFileSync(join(dir, "src/content/index.js"), `globalThis.large = ${JSON.stringify("x".repeat(BUDGET + 1))};`);
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Build failed: chrome content\.js is \d+ bytes; the limit is 88 KB \(90112 bytes\)\.\n$/);
  assert.deepEqual(zips(), good);
  writeFileSync(join(dir, "src/content/index.js"), `globalThis.large = ${JSON.stringify("x".repeat(BUDGET - 200))};`);
  assert.equal(run().status, 0, "a bundle just under the limit builds");
});

test("the test run leaves the real dist as the last build made it", () => {
  assert.deepEqual(realDist(), distAtStart);
});
