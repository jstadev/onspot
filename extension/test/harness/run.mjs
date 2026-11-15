import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { build } from '../../node_modules/esbuild/lib/main.js';

// Switches for a short run (the default is the whole run in both browsers):
//   HARNESS_BROWSER=chromium|firefox   one browser
//   HARNESS_ONLY=audit                 only the audit probes
//   HARNESS_PROBE=<words>              only the audit probes whose name holds these words
//   HARNESS_ENTRY=<path to index.js>   another content entry, to see a probe fail on older code
// PLAYWRIGHT_CORE: the entry file of playwright-core, as for `pins snap`.
const { chromium, firefox } = await import(pathToFileURL(process.env.PLAYWRIGHT_CORE || '/srv/design-kit/node_modules/playwright-core/index.mjs').href);
const here = dirname(fileURLToPath(import.meta.url));
const extension = resolve(here, '../..');
const temporary = await mkdtemp(resolve(tmpdir(), 'onspot-bundle-'));
const screenshots = '/tmp/onspot-harness';
await mkdir(screenshots, { recursive: true });
const { version } = JSON.parse(await readFile(resolve(extension, 'package.json'), 'utf8'));
const result = await build({ entryPoints: [process.env.HARNESS_ENTRY || resolve(extension, 'src/content/index.js')], bundle: true, minify: true, format: 'iife', write: false, define: { __ONSPOT_VERSION__: JSON.stringify(version) } });
const bundle = result.outputFiles[0].contents;
const budget = 88 * 1024;
assert.ok(bundle.byteLength <= budget, `Bundle is ${bundle.byteLength} bytes, above 88 KB`);
await writeFile(resolve(temporary, 'content.js'), bundle);
// Two real PNG files (40 x 30, one colour each) stand in for the before and after shots.
function png([r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(40, 0); header.writeUInt32BE(30, 4); header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(120, Buffer.from([r, g, b]))]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array(30).fill(row)))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
await build({ entryPoints: [resolve(here, 'fake-ext.js')], bundle: true, format: 'iife', outfile: resolve(temporary, 'fake-ext.js'),
  define: { __ONSPOT_VERSION__: JSON.stringify(version), __SHOTS__: JSON.stringify({ before: png([220, 38, 38]), after: png([22, 163, 74]) }) } });
const [fixtureJS, fixtureCSS, fakeJS] = await Promise.all([
  readFile(resolve(here, 'fixture.js')), readFile(resolve(here, 'fixture.css')), readFile(resolve(temporary, 'fake-ext.js')),
]);
const basicCSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'";
const nonceCSP = basicCSP.replace("script-src 'self'", "script-src 'nonce-onspot-fixture-2026' 'strict-dynamic'");
const noImageCSP = basicCSP.replace("img-src 'self' data:", "img-src 'none'");
const policy = path => path === '/nonce' ? nonceCSP : path === '/shots' ? noImageCSP : basicCSP;
function html(path) {
  const nonce = path === '/nonce' ? ' nonce="onspot-fixture-2026"' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fieldwork | OnSpot fixture</title><link rel="stylesheet" href="/fixture.css"></head><body>
  <header><strong>Fieldwork</strong><button id="route" type="button">Next route</button></header>
  <main><div class="eyebrow">Your next afternoon</div><h1 id="target" class="hero-title">Make room for something good.</h1>
  <p class="intro" id="quote-target">A quieter place to collect ideas, shape the details, and decide what comes next.</p>
  <div class="details"><section class="panel" id="card-target"><h2 data-testid="secondary">Small details. Better days.</h2><p id="second-target">Keep the useful pieces close. Give everything else some room.</p><button id="action-target" type="button">Explore the collection</button></section>
  <section class="panel" id="other-card"><h2>Built for the way you work</h2><p>A single place for the notes that deserve another look.</p><div id="nested-parent"><span id="nested-child">A detail inside a container</span></div></section></div>
  <div class="motion" id="animation"></div>
  ${path === '/complex' ? '<div id="shadow-host"></div><div class="scrollbox" id="scrollbox"><div class="scroll-content"><div id="scroll-target">A target inside a scroll container</div></div></div>' : ''}
  <div class="spacer"></div><h2 id="bottom-target">The next chapter</h2><input id="page-input" aria-label="A field of the page"></main>
  <script src="/fake-ext.js"${nonce}></script><script src="/fixture.js"${nonce}></script><script src="/content.js"${nonce}></script></body></html>`;
}
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://fixture').pathname;
  const assets = { '/fixture.js': [fixtureJS, 'text/javascript'], '/fixture.css': [fixtureCSS, 'text/css'], '/fake-ext.js': [fakeJS, 'text/javascript'], '/content.js': [bundle, 'text/javascript'] };
  if (path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  const [body, type] = assets[path] || [html(path), 'text/html'];
  response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Content-Security-Policy': policy(path), 'Cache-Control': 'no-store' });
  response.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const localOrigin = `http://127.0.0.1:${server.address().port}`;
const origin = 'https://fixture.koglabs.com';
const ui = selector => `on-spot ${selector}`;
const defaultKeys = [['mode', 'Mod+KeyM'], ['eye', 'Mod+KeyK'], ['menu', 'Alt+Shift+KeyM'], ['log', 'Alt+Shift+KeyL'], ['settings', 'Alt+Shift+KeyS'], ['freeze', 'Alt+Shift+KeyF'], ['queue', 'Alt+Shift+KeyQ']].map(([action, combo]) => ({ action, combo }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const summaries = [];
const failures = [];

async function waitFor(page, predicate, arg, timeout = 6000) {
  await page.waitForFunction(predicate, arg, { timeout });
}
async function visible(page, selector) { await page.locator(ui(selector)).waitFor({ state: 'visible' }); }
async function gone(page, selector) { await page.locator(ui(selector)).waitFor({ state: 'hidden' }); }
async function toggle(page) { await page.evaluate(() => __fake.toggle()); }
async function openMenu(page) {
  if (await page.locator(ui('.menu-button')).getAttribute('aria-expanded') !== 'true') await page.locator(ui('.menu-button')).click();
  await visible(page, '.menu');
}
const inside = (box, width, height) => box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height;
const pressedIn = (page, selector) => page.evaluate(sel => [...document.querySelector('on-spot').shadowRoot.querySelectorAll(`:is(${sel}) button`)].filter(node => node.getAttribute('aria-pressed') === 'true').map(node => node.textContent), selector);
const labelsIn = (page, selector) => page.evaluate(sel => [...document.querySelector('on-spot').shadowRoot.querySelectorAll(`:is(${sel}) button`)].map(node => node.textContent), selector);
async function point(page, selector) {
  const rect = await page.locator(selector).boundingBox();
  assert.ok(rect, `Missing element ${selector}`);
  return { x: rect.x + Math.min(rect.width / 2, 80), y: rect.y + Math.min(rect.height / 2, 20) };
}
async function pick(page, selector, modifier) {
  const p = await point(page, selector);
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.click(p.x, p.y);
  if (modifier) await page.keyboard.up(modifier);
}
async function note(page, text, key = 'Enter') {
  await visible(page, '.popup');
  const input = page.locator(ui('textarea[name="pin-note"]'));
  await input.fill(text); await input.press(key);
  await gone(page, '.popup');
}
async function marker(page, id, status = 'queued') {
  await visible(page, `.marker[data-pin="${id}"][data-status="${status}"]`);
}
async function drafts(page) {
  return page.evaluate(() => [...document.querySelector('on-spot').shadowRoot.querySelectorAll('.marker[data-status="draft"]')].map(node => node.textContent));
}
async function trayText(page) { return page.locator(ui('.tray-text')).textContent(); }
async function waitTray(page, text) {
  await waitFor(page, value => document.querySelector('on-spot').shadowRoot.querySelector('.tray-text')?.textContent === value, text);
}
const shadowText = (page, selector) => page.locator(ui(selector)).first().textContent();
const posts = page => page.evaluate(() => __fake.calls.filter(call => call.method === 'POST' && call.path === '/api/batches'));
async function screenshot(page, browser, state) {
  await page.screenshot({ path: `${screenshots}/${browser}-${state}.png` });
}
async function freshPage(context, path) {
  const page = await context.newPage();
  const issues = { console: [], errors: [] };
  // Firefox itself asks for /favicon.ico; a page with img-src 'none' blocks that. It is not our request.
  page.on('console', message => { if (/content security policy|refused to.*(?:script|style)|violat.*(?:directive|policy)|\bCSP\b/i.test(message.text()) && !/FaviconLoader/.test(message.text())) issues.console.push(message.text()); });
  page.on('pageerror', error => issues.errors.push(error.message));
  await page.goto(`${origin}${path}`);
  await visible(page, '.capsule');
  await waitFor(page, () => __fake.calls.some(call => call.method === 'GET'));
  await delay(100);
  return { page, issues };
}
// Same-origin HTTPS fixture URLs exercise the real URL validation, while all fixture bytes come
// from the loopback HTTP server. The queue shortcut opens the hub: the harness answers that
// itself. No request leaves this machine.
async function serve(context) {
  await context.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    const response = await fetch(`${localOrigin}${url.pathname}${url.search}`);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  await context.route('https://ai.koglabs.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Queue stand-in</title>' }));
}
async function clean(page, issues) {
  assert.deepEqual(await page.evaluate(() => __metrics.csp), [], 'CSP violation events');
  assert.deepEqual(issues.console, [], 'CSP console errors');
  assert.deepEqual(issues.errors, [], 'Page errors');
  const badUI = await page.locator('on-spot').evaluate(host => {
    const root = host.shadowRoot;
    return {
      styles: root.querySelectorAll('style').length,
      missingTitles: [...root.querySelectorAll('button, a')].filter(button => !button.title).length,
      inlineEvents: [...root.querySelectorAll('*')].flatMap(node => [...node.attributes].filter(attr => /^on/i.test(attr.name)).map(attr => attr.name)),
    };
  });
  assert.deepEqual(badUI, { styles: 0, missingTitles: 0, inlineEvents: [] });
}

// Audit probes (2026-11). Each one is a bug that the audit found, on a page of its own, so one
// failure does not hide the next. They need only clicks and keys that also exist in older code.
async function auditProbes(context, name, pass) {
  const draftsKey = 'kog-pins:drafts:fixture.koglabs.com', seenKey = 'kog-pins:seen:fixture.koglabs.com';
  const target = { selector: '#target', label: 'h1 "Make room"', rect: { x: 100, y: 100, w: 500, h: 50 } };
  const wait = (page, predicate, arg) => waitFor(page, predicate, arg, 2500);
  const seen = (page, selector, state = 'visible') => page.locator(ui(selector)).waitFor({ state, timeout: 2500 });
  const active = page => page.evaluate(() => { const node = document.querySelector('on-spot').shadowRoot.activeElement; return node ? node.className || node.title : ''; });
  const draft = async page => {
    await page.locator(ui('.pin-button')).click(); await pick(page, '#target');
    await seen(page, '.popup'); await page.locator(ui('textarea[name="pin-note"]')).fill('My own pin.');
    await page.locator(ui('textarea[name="pin-note"]')).press('Enter'); await seen(page, '.popup', 'hidden');
    await page.keyboard.press('Escape'); await seen(page, '.overlay', 'hidden');
  };
  async function probe(title, run) {
    if (process.env.HARNESS_PROBE && !title.includes(process.env.HARNESS_PROBE)) return;
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`${origin}/probe`); await visible(page, '.capsule');
      await page.evaluate(() => { __fake.reset(); localStorage.removeItem('onspot-harness-storage'); });
      await page.reload(); await visible(page, '.capsule');
      await waitFor(page, () => __fake.calls.some(call => call.method === 'GET'));
      await run(page);
      assert.deepEqual(errors, [], 'page errors');
      pass(`audit: ${title}`);
    } catch (error) {
      failures.push(`${name}: audit: ${title}: ${String(error.message).split('\n')[0]}`);
      process.stdout.write(`  FAIL audit: ${title}\n       ${String(error.stack).split('\n').filter(line => !line.includes('node_modules')).slice(0, 6).join('\n       ')}\n`);
      if (errors.length) process.stdout.write(`       page errors: ${errors.join(' | ')}\n`);
    } finally {
      await page.evaluate(() => localStorage.clear()).catch(() => {}); // the next probe starts with no stored data
      await page.close();
    }
  }

  await probe('a click, a pick or a key that a page script makes does nothing', async page => {
    const started = await page.evaluate(() => {
      const root = document.querySelector('on-spot').shadowRoot, button = root.querySelector('.pin-button');
      button.click();
      if (root.querySelector('.overlay').hidden) button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
      if (root.querySelector('.overlay').hidden) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', key: 'm', ctrlKey: true, bubbles: true, cancelable: true }));
      return !root.querySelector('.overlay').hidden;
    });
    const made = { mode: started };
    if (started) { await page.keyboard.press('Escape'); await seen(page, '.overlay', 'hidden'); }
    await draft(page);
    await page.locator(ui('.pin-button')).click(); await seen(page, '.overlay');
    await page.evaluate(() => {
      const root = document.querySelector('on-spot').shadowRoot, box = document.querySelector('#second-target').getBoundingClientRect();
      const at = { clientX: box.x + 5, clientY: box.y + 5, button: 0, bubbles: true, composed: true, cancelable: true };
      try { root.querySelector('.overlay').dispatchEvent(new PointerEvent('pointerdown', at)); } catch { /* older code throws on the made pointer id */ }
      root.querySelector('.overlay').dispatchEvent(new PointerEvent('pointerup', at));
    });
    await delay(150);
    made.note = await page.locator(ui('.popup')).count() > 0;
    if (made.note) { await page.keyboard.press('Escape'); await seen(page, '.popup', 'hidden'); }
    await page.evaluate(() => {
      const root = document.querySelector('on-spot').shadowRoot;
      root.querySelector('.tray .primary').click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
      root.querySelector('.tray .primary').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true, composed: true, cancelable: true }));
    });
    await delay(200);
    made.sent = (await posts(page)).length > 0;
    assert.deepEqual(made, { mode: false, note: false, sent: false }, `a page script started pin mode, opened the note or sent the pins: ${JSON.stringify(made)}`);
    await page.locator(ui('.tray .primary')).click(); await seen(page, '.marker[data-pin="1"]');
  });

  await probe('a deep link opens only a pin of this site', async page => {
    await page.evaluate(() => {
      __fake.seed({ url: 'https://other.koglabs.com/', note: 'A note of another site.', targets: [{ selector: '#target', label: 'h1', rect: { x: 1, y: 1, w: 1, h: 1 } }] });
      location.hash = '#kog-pin=1';
    });
    await seen(page, '.thread'); await wait(page, () => __fake.calls.some(call => call.path === '/api/pins/1'));
    await delay(200);
    assert.equal(await page.evaluate(() => document.querySelector('on-spot').shadowRoot.textContent.includes('A note of another site.')), false, 'the card shows a pin of another site');
    assert.equal(await shadowText(page, '#onspot-card-error'), 'This pin is not on this site.');
    assert.equal(await shadowText(page, '.thread .status'), 'Not loaded');
  });

  await probe('a pin that another tab adds during a send is kept', async page => {
    await draft(page);
    await page.evaluate(() => { __fake.delay = 500; });
    await page.locator(ui('.tray .primary')).click(); await delay(120);
    await page.evaluate(key => {
      const mine = __fake.storage()[key];
      const extra = { ...mine.items[0], id: 'other-tab-1', body: { ...mine.items[0].body, note: 'Added in another tab.' } };
      __fake.delay = 30;
      return chrome.storage.local.set({ [key]: { tab: 'other', items: [...mine.items, extra], submit: mine.submit } });
    }, draftsKey);
    await seen(page, '.marker[data-pin="1"]');
    await wait(page, () => document.querySelector('on-spot').shadowRoot.querySelector('.tray-text')?.textContent === '1 pin ready');
    assert.deepEqual(await page.evaluate(key => __fake.storage()[key].items.map(item => item.body.note), draftsKey), ['Added in another tab.']);
    assert.equal(await page.evaluate(() => __fake.db.pins.length), 1, 'the sent pin is not sent twice');
  });

  await probe('a page that comes back from the page cache reads the stored data again', async page => {
    await page.evaluate(([key, item]) => {
      __fake.setStorage({ [key]: { tab: 'other', items: [{ id: 'd-other', createdAt: new Date().toISOString(), body: { url: `${location.origin}/probe`, note: 'Pinned on another page.', targets: [item] } }], submit: null }, 'kog-pins:hidden:fixture.koglabs.com': true });
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    }, [draftsKey, target]);
    await delay(400);
    const back = await page.evaluate(() => { const root = document.querySelector('on-spot').shadowRoot; return { unsent: root.querySelector('.badge').hidden ? 0 : Number(root.querySelector('.badge').textContent), eye: root.querySelector('.capsule button:nth-of-type(2)').getAttribute('aria-pressed') }; });
    assert.deepEqual(back, { unsent: 1, eye: 'true' }, `the page shows the old data: ${JSON.stringify(back)}`);
  });

  await probe('a batch answer without the pins still counts as sent', async page => {
    await draft(page);
    await page.evaluate(() => __fake.answerNext('POST', '/api/batches', { batch: { id: 1 } }, 201));
    await page.locator(ui('.tray .primary')).click();
    await wait(page, () => __fake.db.pins.length === 1); await delay(500);
    const after = await page.evaluate(() => { const root = document.querySelector('on-spot').shadowRoot; return { marker: root.querySelectorAll('.marker[data-pin="1"]').length, toast: root.querySelector('.toast .toast-title')?.textContent ?? null, said: root.querySelector('.sr-only').textContent, unsent: root.querySelector('.tray').hidden ? 0 : root.querySelector('.tray-text').textContent }; });
    assert.deepEqual(after, { marker: 1, toast: '1 pin sent', said: '1 pin sent. Fixing starts now.', unsent: 0 }, JSON.stringify(after));
  });

  await probe('a resync during a fetch fetches once more', async page => {
    await page.evaluate(item => { __fake.seed({ url: `${location.origin}/probe`, note: 'Watch me.', targets: [item] }); __fake.push({ t: 'resync' }); }, target);
    await seen(page, '.marker[data-pin="1"][data-status="queued"]');
    await page.evaluate(() => { __fake.answerFirst = true; __fake.delay = 400; __fake.push({ t: 'resync' }); });
    await delay(120);
    // The stream was down: the change has no event. The stream comes back and says resync.
    await page.evaluate(() => { __fake.db.pins[0].status = 'working'; __fake.delay = 30; __fake.push({ t: 'resync' }); });
    await seen(page, '.marker[data-pin="1"][data-status="working"]');
  });

  await probe('a toast goes when its pin is deleted or moved on without an event', async page => {
    await page.evaluate(item => { for (const note of ['One.', 'Two.']) __fake.seed({ url: `${location.origin}/probe`, note, targets: [item] }); __fake.push({ t: 'resync' }); }, target);
    await seen(page, '.marker[data-pin="2"]');
    await page.evaluate(() => { __fake.update(1, { status: 'working', startedAt: new Date().toISOString() }); __fake.update(2, { status: 'done', summary: 'Done.', closedAt: new Date().toISOString() }); });
    await seen(page, '.toast[data-kind="working"]'); await seen(page, '.toast[data-kind="done"]');
    await page.evaluate(() => __fake.update(2, {}, 'deleted'));
    await delay(200);
    const stale = { deleted: await page.locator(ui('.toast[data-kind="done"]')).count() };
    await page.evaluate(() => { Object.assign(__fake.db.pins[0], { status: 'done', summary: 'Done too.', closedAt: new Date().toISOString() }); __fake.push({ t: 'resync' }); });
    await seen(page, '.marker[data-pin="1"][data-status="done"]'); await delay(100);
    stale.moved = await page.locator(ui('.toast[data-kind="working"]')).count();
    assert.deepEqual(stale, { deleted: 0, moved: 0 }, `toasts that stay: ${JSON.stringify(stale)}`);
  });

  await probe('a pin that was seen, then opened again, shows its next result', async page => {
    await page.evaluate(item => { __fake.seed({ url: `${location.origin}/probe`, note: 'Twice.', targets: [item] }); __fake.push({ t: 'resync' }); }, target);
    await seen(page, '.marker[data-pin="1"]');
    await page.evaluate(() => __fake.update(1, { status: 'done', summary: 'First try.', closedAt: new Date().toISOString() }));
    await page.locator(ui('.marker[data-pin="1"][data-status="done"]')).click(); await seen(page, '.thread');
    await wait(page, () => document.querySelector('on-spot').shadowRoot.querySelector('.thread .status')?.textContent === 'Done');
    await page.keyboard.press('Escape'); await seen(page, '.marker[data-pin="1"]', 'hidden');
    await page.evaluate(() => __fake.update(1, { status: 'queued', summary: null, closedAt: null }));
    await seen(page, '.marker[data-pin="1"][data-status="queued"]');
    await page.evaluate(() => __fake.update(1, { status: 'done', summary: 'Second try.', closedAt: new Date().toISOString() }));
    await seen(page, '.marker[data-pin="1"][data-status="done"]');
    assert.deepEqual(await page.evaluate(key => __fake.storage()[key], seenKey), []);
  });

  await probe('the seen list keeps only pin ids', async page => {
    await page.evaluate(item => { __fake.seed({ url: `${location.origin}/probe`, note: 'See me.', targets: [item] }); __fake.push({ t: 'resync' }); }, target);
    await seen(page, '.marker[data-pin="1"]');
    await page.evaluate(key => chrome.storage.local.set({ [key]: ['x', 1.5, null, 7] }), seenKey); // as another tab
    await page.evaluate(() => __fake.update(1, { status: 'done', summary: 'Done.', closedAt: new Date().toISOString() }));
    await page.locator(ui('.marker[data-pin="1"][data-status="done"]')).click(); await seen(page, '.thread');
    await wait(page, () => document.querySelector('on-spot').shadowRoot.querySelector('.thread .status')?.textContent === 'Done');
    await page.keyboard.press('Escape'); await seen(page, '.marker[data-pin="1"]', 'hidden'); await delay(100);
    assert.deepEqual(await page.evaluate(key => __fake.storage()[key], seenKey), [7, 1]);
  });

  await probe('bad stored pins are dropped and do not break the page', async page => {
    await page.evaluate(([key, item]) => {
      const body = { url: `${location.origin}/probe`, note: 'A good one.', targets: [item] };
      __fake.setStorage({ [key]: { items: [{ id: 'bad-target', body: { ...body, targets: [null] } }, { id: 'bad-label', body: { ...body, targets: [{ selector: '#target' }] } },
        { id: 'bad-url', body: { ...body, url: 'javascript://fixture.koglabs.com/%0aalert(1)' } }, { id: 'good', body }] }, 'kog-pins:seen:fixture.koglabs.com': ['x', 1.5, null, 7] });
      __fake.seed({ url: `${location.origin}/probe`, note: 'A server pin.', targets: [item] });
    }, [draftsKey, target]);
    await page.reload(); await visible(page, '.capsule');
    await seen(page, '.marker[data-pin="1"]');
    await wait(page, () => document.querySelector('on-spot').shadowRoot.querySelector('.tray-text')?.textContent === '1 pin ready');
    await page.evaluate(() => __fake.update(1, { status: 'done', summary: 'Done.', closedAt: new Date().toISOString() }));
    await page.locator(ui('.marker[data-pin="1"][data-status="done"]')).click(); await seen(page, '.thread');
    await wait(page, () => document.querySelector('on-spot').shadowRoot.querySelector('.thread .status')?.textContent === 'Done');
    await page.keyboard.press('Escape');
    await wait(page, key => JSON.stringify(__fake.storage()[key]) === '[7,1]', seenKey);
  });

  await probe('the focus comes back when the Log, Settings, the menu or the discard question close', async page => {
    await openMenu(page); await page.locator(ui('.log-button')).click(); await seen(page, '.log');
    const focus = {};
    await page.keyboard.press('Escape'); await seen(page, '.log', 'hidden');
    focus.afterLog = await active(page);
    await page.locator(ui('.menu button[title^="Open Settings"]')).click(); await seen(page, '.sheet');
    await page.mouse.click(640, 20); await seen(page, '.menu', 'hidden');
    // A click on the text of the sheet, then Esc: the sheet closes. With the menu closed the focus goes to the Menu button.
    await page.locator(ui('.sheet .panel-title')).click(); await page.keyboard.press('Escape'); await delay(150);
    focus.sheetClosed = await page.locator(ui('.sheet')).count() === 0;
    focus.afterSettings = await active(page);
    if (!focus.sheetClosed) { await page.locator(ui('.sheet button[title="Close Settings"]')).click(); await seen(page, '.sheet', 'hidden'); }
    await draft(page);
    await page.locator(ui('button[title="Discard all unsent pins"]')).click(); await page.keyboard.press('Escape');
    focus.afterEsc = await page.evaluate(() => document.querySelector('on-spot').shadowRoot.activeElement?.title ?? '');
    await page.locator(ui('button[title="Discard all unsent pins"]')).click(); await page.locator(ui('button[title="Confirm: discard all unsent pins"]')).click();
    focus.afterDiscard = await active(page);
    assert.deepEqual(focus, { afterLog: 'log-button', sheetClosed: true, afterSettings: 'icon menu-button', afterEsc: 'Discard all unsent pins', afterDiscard: 'icon pin-button' }, JSON.stringify(focus));
  });

  await probe('at 320 px with reduced motion every surface fits the screen', async page => {
    const W = 320, H = 568;
    await page.setViewportSize({ width: W, height: H });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const shot = state => page.screenshot({ path: `${screenshots}/${name}-320-${state}.png` });
    // Every visible box of ours inside the screen, and no control cut off inside its surface.
    const check = async (surface, state) => {
      await seen(page, surface);
      const bad = await page.evaluate(([sel, w, h]) => {
        const root = document.querySelector('on-spot').shadowRoot, out = [];
        const box = root.querySelector(sel).getBoundingClientRect();
        if (box.left < 0 || box.top < 0 || box.right > w || box.bottom > h) out.push(`${sel} ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`);
        for (const node of root.querySelector(sel).querySelectorAll('button, a, input, select, textarea')) {
          if (node.closest('[hidden]')) continue;
          const b = node.getBoundingClientRect();
          if (b.width < 24 || b.left < box.left - 1 || b.right > box.right + 1) out.push(`${node.title || node.name} ${Math.round(b.left)}..${Math.round(b.right)} w${Math.round(b.width)}`);
        }
        if (document.documentElement.scrollWidth > w) out.push(`page scrolls sideways: ${document.documentElement.scrollWidth}`);
        return out;
      }, [surface, W, H]);
      await shot(state);
      assert.deepEqual(bad, [], `${state}: ${bad.join('; ')}`);
    };
    await page.evaluate(item => {
      __fake.setStorage({ 'kog-pins:prefs': { v: 1, presets: [{ id: 'a', label: '5 agents', text: 'Start a thread and delegate 5 agents.' }, { id: 'b', label: 'Staging first, then ask me', text: 'Deploy to staging and stop.' }] } });
      for (const note of ['The first pin of this page has a long note that wraps.', 'Second.', 'Third.']) __fake.seed({ url: `${location.origin}/probe`, note, targets: [item] });
    }, target);
    await page.reload(); await visible(page, '.capsule'); await seen(page, '.marker[data-pin="3"]');
    await check('.capsule', 'capsule');
    await page.evaluate(() => { __fake.serverExtension = '9.0.0'; __fake.settings({ on: true, delegate: true, agents: 3 }); __fake.state('login'); });
    await openMenu(page); await seen(page, '.login'); await seen(page, '.update');
    await check('.menu', 'menu');
    const menuBox = await page.locator(ui('.menu')).boundingBox(), capsuleBox = await page.locator(ui('.capsule')).boundingBox();
    assert.ok(menuBox.x + menuBox.width <= capsuleBox.x || menuBox.y + menuBox.height <= capsuleBox.y, 'the menu does not cover the capsule');
    assert.equal(await page.locator(ui('.menu')).evaluate(node => getComputedStyle(node).transitionDuration), '0s', 'no slide with reduced motion');
    await page.evaluate(() => __fake.state('live'));
    await page.locator(ui('.menu button[title^="Open Settings"]')).click();
    await check('.sheet', 'settings');
    if (await page.locator(ui('button[title="Add a shortcut"]')).count()) {
      await page.locator(ui('button[title="Add a shortcut"]')).click();
      await check('.sheet', 'settings-shortcut-form');
      const sheet = await page.locator(ui('.sheet')).boundingBox(), twoLines = await page.locator(ui('.menu')).boundingBox();
      assert.ok(twoLines.height > 60 && sheet.y + sheet.height <= twoLines.y, `Settings sits above the menu, also when the menu takes two lines (${JSON.stringify([sheet, twoLines])})`);
      assert.deepEqual(await page.evaluate(() => [...document.querySelector('on-spot').shadowRoot.querySelectorAll('.key-row .row-label span')].filter(node => node.scrollWidth > node.clientWidth).map(node => node.textContent)), [], 'no shortcut name is cut');
      await page.keyboard.press('Escape');
    }
    await page.keyboard.press('Escape'); await seen(page, '.sheet', 'hidden');
    await page.locator(ui('.log-button')).click(); await check('.log', 'log');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await seen(page, '.menu', 'hidden');
    await page.evaluate(() => {
      __fake.update(1, { status: 'working', agent: 'claude', model: 'opus 5.5 high', attempts: 1, run: 'triad:9', startedAt: new Date().toISOString() });
      __fake.step(1, 'Found the code in app/page.tsx'); __fake.update(2, { status: 'done', summary: 'The second pin is done and its summary is long enough to wrap.', commit: 'a1b2c3d', closedAt: new Date().toISOString() });
      __fake.update(3, { status: 'waiting' }); __fake.reply(3, 'Should the gap be 8px or 16px?');
    });
    await seen(page, '.toast[data-kind="waiting"]');
    await check('.toasts', 'toasts');
    await page.locator(ui('.marker[data-pin="1"]')).click(); await check('.thread', 'card');
    await page.keyboard.press('Escape'); await seen(page, '.thread', 'hidden');
    for (const node of await page.locator(ui('.toast button[title="Close this message"]')).all()) await node.click();
    await page.locator(ui('.pin-button')).click(); await seen(page, '.overlay');
    await check('.tray', 'tray-hint');
    await page.locator('#second-target').scrollIntoViewIfNeeded();
    await pick(page, '#second-target'); await check('.popup', 'popup');
    await page.locator(ui('textarea[name="pin-note"]')).fill('A narrow pin.'); await page.locator(ui('textarea[name="pin-note"]')).press('Enter');
    await page.locator('#target').scrollIntoViewIfNeeded();
    await pick(page, '#target', 'Shift'); await check('.selection-bar', 'selection');
    await page.keyboard.press('Escape'); await seen(page, '.overlay', 'hidden');
    await seen(page, '.bulk-chip');
    await check('.tray', 'tray');
    const tray = await page.evaluate(() => { const root = document.querySelector('on-spot').shadowRoot; return { text: root.querySelector('.tray-text').getBoundingClientRect().width, full: root.querySelector('.tray-text').scrollWidth }; });
    assert.ok(tray.text >= tray.full, `the tray text shows whole (${tray.text} of ${tray.full} px)`);
    const trayBox = await page.locator(ui('.tray')).boundingBox();
    assert.ok(trayBox.y + trayBox.height <= capsuleBox.y, 'the tray sits above the capsule');
    await page.locator(ui('button[title="Discard all unsent pins"]')).click();
    await check('.tray', 'tray-discard');
  });

  await probe('a form with a field named "id" keeps its own id in labels and selectors', async page => {
    await page.evaluate(() => {
      const form = document.createElement('form');
      form.id = 'signup';
      form.append(Object.assign(document.createElement('input'), { name: 'id', value: '7', type: 'hidden' }), Object.assign(document.createElement('button'), { type: 'button', textContent: 'Join the list' }));
      document.querySelector('main').prepend(form);
    });
    await page.locator(ui('.pin-button')).click(); await pick(page, '#signup button');
    await seen(page, '.popup'); await page.locator(ui('textarea[name="pin-note"]')).fill('Make this button bigger.');
    await page.locator(ui('textarea[name="pin-note"]')).press('Control+Enter'); await seen(page, '.marker[data-pin="1"]');
    const sent = await page.evaluate(() => __fake.db.pins[0].targets[0]);
    assert.equal(sent.ancestors[0], 'form#signup');
    assert.equal(sent.selector, '#signup > button:nth-of-type(1)');
    assert.equal(await page.evaluate(sel => document.querySelector(sel)?.textContent, sent.selector), 'Join the list');
  });

  await probe('a screen reader gets the visible words: Log rows, text buttons and the connection', async page => {
    await page.evaluate(item => { __fake.seed({ url: `${location.origin}/probe`, note: 'Read me.', targets: [item] }); __fake.push({ t: 'resync' }); }, target);
    await seen(page, '.marker[data-pin="1"]');
    await page.evaluate(() => __fake.update(1, { status: 'done', summary: 'Done.', closedAt: new Date().toISOString() }));
    await seen(page, '.toast[data-kind="done"]');
    await openMenu(page); await page.locator(ui('.log-button')).click(); await seen(page, '.log .log-row');
    const names = await page.evaluate(() => {
      const root = document.querySelector('on-spot').shadowRoot;
      const menu = root.querySelector('.menu-button');
      return { row: root.querySelector('.log-row').getAttribute('aria-label'), rowTitle: root.querySelector('.log-row').title,
        action: root.querySelector('.toast[data-kind="done"] .toast-actions button').getAttribute('aria-label'), actionText: root.querySelector('.toast[data-kind="done"] .toast-actions button').textContent,
        icon: root.querySelector('.pin-button').getAttribute('aria-label'), connection: root.getElementById(menu.getAttribute('aria-describedby') || 'x')?.getAttribute('aria-label') };
    });
    assert.deepEqual(names, { row: null, rowTitle: 'Open pin 1', action: null, actionText: 'See it', icon: 'Toggle pin mode (Ctrl+M)', connection: 'Connection: live' });
  });

  await probe('a request that takes too long keeps the live connection and names the reason', async page => {
    const dot = () => page.locator(ui('.connection')).getAttribute('data-state');
    const tray = text => wait(page, value => document.querySelector('on-spot').shadowRoot.querySelector('.tray-text')?.textContent === value, text);
    await draft(page);
    // The background gives up one request after 30 s. Its stream is still live.
    await page.evaluate(() => __fake.failNext('POST', '/api/batches', 0, 'timeout'));
    await page.locator(ui('.tray .primary')).click();
    await tray('Not sent: The request took too long. Try again.');
    assert.equal(await dot(), 'live', 'one slow request does not mark a live connection as offline');
    assert.deepEqual(await page.evaluate(() => __fake.calls.slice(-2).map(call => call.t)), ['api', 'state'], 'the content script asks the background for its state');
    // A network failure, and the background gives no state: offline.
    await page.evaluate(() => {
      const send = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = message => message.t === 'state' ? Promise.reject(new Error('The background is gone.')) : send(message);
      __fake.failNext('POST', '/api/batches');
    });
    await page.locator(ui('.tray .primary')).click();
    await tray('Not sent: You are offline.');
    assert.equal(await dot(), 'offline');
  });
}

try {
  for (const [name, type] of [['chromium', chromium], ['firefox', firefox]]) {
    if (process.env.HARNESS_BROWSER && process.env.HARNESS_BROWSER !== name) continue;
    const browser = await type.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await serve(context);
    const passed = [];
    const pass = name => { passed.push(name); process.stdout.write(`  PASS ${name}\n`); };
    process.stdout.write(`${name} ${browser.version()}\n`);
    let activePage;
    try {
      // The probes get a context of their own: the pins that they leave must not reach the run below.
      const probeContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
      await serve(probeContext);
      await auditProbes(probeContext, name, pass);
      await probeContext.close();
      if (process.env.HARNESS_ONLY === 'audit') {
        summaries.push(`${name.toUpperCase()}: ${failures.some(item => item.startsWith(name + ':')) ? 'FAIL' : 'PASS'} (${passed.length} audit probes pass)`);
        continue;
      }
      const main = await freshPage(context, '/'); let { page, issues } = main; activePage = page;
      const idle = await page.evaluate(() => ({ calls: __fake.calls, ports: __fake.activePorts, connections: __fake.connections, listeners: __metrics.documentListeners, observers: __metrics.mutations, hosts: document.querySelectorAll('on-spot').length }));
      assert.equal(idle.hosts, 1); assert.equal(idle.ports, 1); assert.equal(idle.connections, 1);
      assert.equal(idle.calls.length, 1); assert.equal(idle.calls[0].path, `/api/pins?host=fixture.koglabs.com&status=all&limit=50`);
      assert.deepEqual(idle.listeners, []); assert.deepEqual(idle.observers, []);
      await page.evaluate(() => { __metrics.rectReads = 0; window.dispatchEvent(new Event('scroll')); });
      await delay(80); assert.equal(await page.evaluate(() => __metrics.rectReads), 0);
      pass('idle: one host, one GET and one port; no document listeners, observer or scroll layout reads');

      const style = await page.locator(ui('.capsule')).evaluate(node => {
        const css = getComputedStyle(node); return { background: css.backgroundColor, width: css.width, height: css.height, font: css.fontFamily };
      });
      assert.equal(style.background, 'rgb(24, 24, 27)'); assert.equal(style.width, '123px'); assert.equal(style.height, '40px'); assert.match(style.font, /system-ui/);
      assert.equal(await page.locator(ui('.menu')).isVisible(), false, 'the menu starts closed');
      await page.locator(ui('.pin-button')).click(); await visible(page, '.overlay');
      assert.equal(await page.locator(ui('.pin-button')).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator(ui('.menu')).isVisible(), false, 'Pin does not open the menu');
      await page.locator(ui('.pin-button')).click(); await gone(page, '.overlay');
      assert.equal(await page.locator(ui('.pin-button')).getAttribute('aria-pressed'), 'false');
      assert.equal(await page.locator(ui('.pin-button')).getAttribute('title'), 'Toggle pin mode (Ctrl+M)');
      await page.keyboard.press('Control+KeyM'); await visible(page, '.overlay');
      await page.keyboard.press('Control+KeyM'); await gone(page, '.overlay');
      await page.keyboard.press('Control+Shift+KeyM'); await delay(60);
      assert.equal(await page.locator(ui('.overlay')).isVisible(), false, 'Ctrl+Shift+M is not the shortcut');
      pass('Ctrl+M (⌘M on a Mac) switches pin mode on and off');
      assert.equal(await page.evaluate(() => __fake.calls.some(call => call.path === '/api/health')), false, 'no version check before the menu opens');
      await page.locator(ui('.menu-button')).click(); await visible(page, '.menu');
      assert.equal(await page.locator(ui('.menu-button')).getAttribute('aria-expanded'), 'true');
      const motion = await page.locator(ui('.menu')).evaluate(node => { const css = getComputedStyle(node); return [css.transitionProperty, css.transitionDuration, css.transitionTimingFunction]; });
      assert.deepEqual(motion, ['transform, opacity', '0.24s, 0.24s', 'cubic-bezier(0.22, 1, 0.36, 1), cubic-bezier(0.22, 1, 0.36, 1)']);
      await waitFor(page, () => getComputedStyle(document.querySelector('on-spot').shadowRoot.querySelector('.menu')).opacity === '1');
      const bars = await page.evaluate(() => { const root = document.querySelector('on-spot').shadowRoot, box = sel => root.querySelector(sel).getBoundingClientRect().toJSON(); return { menu: box('.menu'), capsule: box('.capsule') }; });
      assert.ok(bars.menu.right <= bars.capsule.left && bars.menu.height === 40 && bars.menu.top === bars.capsule.top && bars.menu.width <= 260, JSON.stringify(bars));
      assert.deepEqual(await page.evaluate(() => [...document.querySelector('on-spot').shadowRoot.querySelectorAll('.menu > :not([hidden])')].map(node => node.title)),
        ['Open the log: 0 open pins on this site (Alt+Shift+L)', 'Pause page animations (Alt+Shift+F)', 'Open Settings (Alt+Shift+S)', 'Open the queue in the Triad Pins tab (Alt+Shift+Q)']);
      assert.equal(await page.locator(ui('.menu a[title^="Open the queue"]')).getAttribute('href'), 'https://ai.koglabs.com/triad?tab=pins&host=fixture.koglabs.com');
      const hits = await page.evaluate(() => [...document.querySelector('on-spot').shadowRoot.querySelectorAll('.capsule button, .menu button, .menu a:not([hidden])')].map(node => { const box = node.getBoundingClientRect(); return Math.min(box.width, box.height); }));
      assert.ok(hits.every(size => size >= 32), `hit areas ${hits}`);
      await waitFor(page, () => __fake.calls.some(call => call.path === '/api/health'));
      await delay(60);
      assert.equal(await page.locator(ui('.update')).isVisible(), false, 'same version: no update link');
      assert.equal(await page.locator(ui('.update-dot')).isVisible(), false, 'same version: no update dot');
      assert.equal(await page.locator(ui('.connection')).getAttribute('data-state'), 'live');
      await screenshot(page, name, 'menu');
      await page.keyboard.press('Escape'); await gone(page, '.menu');
      assert.equal(await page.locator(ui('.menu-button')).getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator(ui('.menu')).evaluate(node => getComputedStyle(node).transitionDuration), '0.18s, 0.18s, 0s', 'closing takes 180 ms');
      await openMenu(page); await page.mouse.click(640, 20); await gone(page, '.menu');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await page.locator(ui('.menu')).evaluate(node => getComputedStyle(node).transitionDuration), '0s', 'reduced motion: no slide');
      await openMenu(page); assert.equal(await page.locator(ui('.menu')).evaluate(node => getComputedStyle(node).transform), 'none');
      await page.keyboard.press('Escape'); await gone(page, '.menu');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      assert.equal(await page.evaluate(() => __fake.calls.filter(call => call.path === '/api/health').length), 1, 'one version check per page');
      pass('capsule 123x40: Pin starts pin mode at once; Menu slides the panel out (240 ms, 180 ms back, none with reduced motion); Esc and an outside click close it');

      // The v2 flow: pin mode stays on, each note becomes an unsent pin, one request sends them all.
      await page.locator(ui('.pin-button')).click(); await visible(page, '.overlay');
      await visible(page, '.tray'); assert.equal(await trayText(page), 'Click an element to pin it. Esc stops.');
      const target = await point(page, '#target'); await page.mouse.move(target.x, target.y);
      await visible(page, '.hover-label');
      await waitFor(page, () => document.querySelector('on-spot').shadowRoot.querySelector('.hover-label').textContent.startsWith('h1#target'));
      const rects = await page.evaluate(() => {
        const a = document.querySelector('#target').getBoundingClientRect(), b = document.querySelector('on-spot').shadowRoot.querySelector('.outline:not(.selected)').getBoundingClientRect();
        return { a: { x: a.x, y: a.y, w: a.width, h: a.height }, b: { x: b.x, y: b.y, w: b.width, h: b.height } };
      });
      for (const key of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(rects.a[key] - rects.b[key]) <= 1, `Outline ${key}: ${JSON.stringify(rects)}`);
      await screenshot(page, name, 'hover');
      await page.mouse.click(target.x, target.y); await visible(page, '.popup');
      assert.equal(await page.evaluate(() => document.querySelector('on-spot').shadowRoot.activeElement.name), 'pin-note');
      assert.equal(await page.evaluate(() => __metrics.pageClicks), 0);
      const noteBox = page.locator(ui('textarea[name="pin-note"]'));
      const placeholder = () => noteBox.getAttribute('placeholder');
      assert.equal(await placeholder(), 'What should change?');
      assert.deepEqual(await labelsIn(page, '.popup .seg'), ['Text', 'Style', 'Layout', 'Behaviour', 'Remove', 'Task']);
      assert.deepEqual(await labelsIn(page, '.popup .chips'), ['This only', 'All like it', 'Page', 'Site']);
      assert.deepEqual(await pressedIn(page, '.popup'), []);
      assert.equal(await page.locator(ui('.popup .presets')).count(), 0, 'no presets row without presets');
      await page.locator(ui('.popup button[title="About: Layout (Alt+3)"]')).click();
      assert.deepEqual(await pressedIn(page, '.popup'), ['Layout']); assert.equal(await placeholder(), 'Where should it go, or how big?');
      await page.locator(ui('.popup button[title="About: Layout (Alt+3)"]')).click();
      assert.deepEqual(await pressedIn(page, '.popup'), [], 'a second click clears the tab'); assert.equal(await placeholder(), 'What should change?');
      await noteBox.focus(); await page.keyboard.press('Alt+2');
      assert.deepEqual(await pressedIn(page, '.popup'), ['Style']); assert.equal(await placeholder(), 'How should it look?');
      await page.keyboard.press('Alt+5'); assert.equal(await placeholder(), 'Anything to keep? (optional)');
      await page.keyboard.press('Alt+5'); assert.deepEqual(await pressedIn(page, '.popup'), [], 'Alt+5 again clears it');
      await page.keyboard.press('Alt+2');
      assert.equal(await noteBox.inputValue(), '', 'Alt+digit types nothing');
      await page.locator(ui('.popup button[title="Change this page"]')).click();
      await page.locator(ui('.popup button[title="Change every element like it in the app"]')).click();
      assert.deepEqual(await pressedIn(page, '.popup'), ['Style', 'All like it'], 'one scope at a time');
      await noteBox.fill('Reduce the heading size slightly.');
      await screenshot(page, name, 'popup');
      await page.locator(ui('textarea[name="pin-note"]')).press('Enter');
      await gone(page, '.popup');
      assert.equal(await page.locator(ui('.overlay')).isVisible(), true, 'pin mode stays on after a note');
      await waitTray(page, '1 pin ready');
      assert.deepEqual(await drafts(page), ['1']);
      const draftBox = await page.locator(ui('.marker[data-status="draft"]')).boundingBox();
      const heading = await page.evaluate(() => { const box = document.querySelector('#target').getBoundingClientRect(); return { x: box.x, y: box.y }; });
      assert.ok(Math.abs(draftBox.x + 12 - heading.x) <= 1 && Math.abs(draftBox.y + 12 - heading.y) <= 1, 'draft marker on the corner');
      await pick(page, '#second-target'); await note(page, 'Make this paragraph lighter.');
      await pick(page, '#target', 'Shift'); await pick(page, '#second-target', 'Shift');
      assert.equal(await page.locator(ui('.selection-count')).textContent(), '2 selected');
      await pick(page, '#second-target', 'Shift'); assert.equal(await page.locator(ui('.selection-count')).textContent(), '1 selected');
      await pick(page, '#second-target', 'Shift'); await page.keyboard.press('Enter');
      await note(page, 'Align these two elements.');
      await pick(page, '#nested-child', 'Alt'); await note(page, 'Adjust the parent spacing.');
      await waitTray(page, '4 pins ready');
      assert.deepEqual(await drafts(page), ['1', '2', '3', '4']);
      assert.equal((await posts(page)).length, 0, 'nothing is sent before Submit all');
      assert.equal(await page.locator(ui('.tray .keys')).textContent(), 'Ctrl+↵');
      await screenshot(page, name, 'drafts');
      pass('popup: About tabs (click, second click, Alt+2, Alt+5), placeholders and one Scope; four notes become four unsent pins');

      await page.keyboard.press('Control+Enter');
      await marker(page, 4);
      for (const id of [1, 2, 3]) await marker(page, id);
      assert.deepEqual(await drafts(page), []);
      await waitTray(page, 'Click an element to pin it. Esc stops.');
      await visible(page, '.toast[data-kind="sent"]');
      assert.equal(await shadowText(page, '.toast .toast-title'), '4 pins sent');
      const sent = await page.evaluate(() => {
        const post = __fake.calls.filter(call => call.method === 'POST' && call.path === '/api/batches');
        const box = document.querySelector('#target').getBoundingClientRect();
        const first = post[0].body.pins[0];
        return { count: post.length, key: post[0].body.key, pins: post[0].body.pins.map(pin => [pin.note, pin.targets.length]), first, batch: __fake.db.pins.map(pin => pin.batch),
          matches: document.querySelector(first.targets[0].selector) === document.querySelector('#target'),
          parent: document.querySelector(post[0].body.pins[3].targets[0].selector)?.id,
          rect: { x: Math.round(box.x + scrollX), y: Math.round(box.y + scrollY), w: Math.round(box.width), h: Math.round(box.height) } };
      });
      assert.equal(sent.count, 1); assert.match(sent.key, /^[A-Za-z0-9_-]{8,80}$/);
      assert.deepEqual(sent.pins, [['Reduce the heading size slightly.', 1], ['Make this paragraph lighter.', 1], ['Align these two elements.', 2], ['Adjust the parent spacing.', 1]]);
      assert.deepEqual(sent.batch, [1, 1, 1, 1]);
      assert.equal(sent.matches, true); assert.deepEqual(sent.first.targets[0].rect, sent.rect); assert.equal(sent.parent, 'nested-parent');
      assert.equal(sent.first.targets[0].attrs.class, 'hero-title'); assert.equal(sent.first.url, `${origin}/`); assert.equal(sent.first.viewport.w, 1280);
      assert.deepEqual(await page.evaluate(() => __fake.storage()['kog-pins:drafts:fixture.koglabs.com'].items), []);
      await page.keyboard.press('Escape'); await gone(page, '.overlay'); await gone(page, '.tray');
      pass('Ctrl+Enter sends all four in one batch request; markers turn into queued pins with server numbers');

      const sentPicks = await page.evaluate(() => __fake.calls.find(call => call.path === '/api/batches').body.pins.map(pin => [pin.intent, pin.scope, pin.presets]));
      assert.deepEqual(sentPicks, [['style', 'similar', []], [null, null, []], [null, null, []], [null, null, []]]);
      await page.evaluate(() => {
        __fake.update(1, { status: 'working', agent: 'claude', model: 'opus 5.5 high', attempts: 1, run: 'triad:9', startedAt: new Date(Date.now() - 75000).toISOString() });
        __fake.update(2, { status: 'working', agent: 'claude', model: 'opus', attempts: 1, run: 'triad:12', startedAt: new Date().toISOString() });
      });
      await marker(page, 1, 'working'); await marker(page, 2, 'working');
      assert.equal(await page.locator(ui('.marker[data-pin="1"]')).evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(251, 191, 36)');
      assert.equal(await page.locator(ui('.marker[data-pin="1"]')).evaluate(node => getComputedStyle(node, '::after').animationName), 'onspot-pulse');
      assert.equal(await page.locator(ui('.marker[data-pin="3"]')).evaluate(node => getComputedStyle(node, '::after').animationName), 'none');
      const toastTitles = () => page.evaluate(() => [...document.querySelector('on-spot').shadowRoot.querySelectorAll('.toast[data-kind="working"]')].map(node => [node.querySelector('.toast-title').textContent, node.querySelector('.toast-text')?.textContent ?? '']));
      await waitFor(page, () => document.querySelector('on-spot').shadowRoot.querySelectorAll('.toast[data-kind="working"]').length === 2);
      assert.deepEqual(await toastTitles(), [['Fixing #1 · Opus 5.5 high', ''], ['Fixing #2 · Opus 5.5', '']]);
      await page.evaluate(() => __fake.step(1, 'Found the code in app/page.tsx'));
      await waitFor(page, () => document.querySelector('on-spot').shadowRoot.querySelector('.toast[data-kind="working"] .toast-text')?.textContent === 'Found the code in app/page.tsx');
      await page.evaluate(() => __fake.step(1, 'Change made'));
      await waitFor(page, () => document.querySelector('on-spot').shadowRoot.querySelector('.toast[data-kind="working"] .toast-text')?.textContent === 'Change made');
      await screenshot(page, name, 'working-toast');
      await delay(6500);
      assert.deepEqual(await toastTitles(), [['Fixing #1 · Opus 5.5 high', 'Change made'], ['Fixing #2 · Opus 5.5', '']], 'a run toast stays while its run works');
      pass('a run start shows "Fixing #1 · Opus 5.5 high"; the toast follows the newest step; working markers pulse');

      const detailCalls = () => page.evaluate(() => __fake.calls.filter(call => call.path === '/api/pins/1' && call.method === 'GET').length);
      await page.locator(ui('.marker[data-pin="1"]')).click(); await visible(page, '.thread');
      await waitFor(page, () => document.querySelector('on-spot').shadowRoot.querySelectorAll('.thread .step').length === 2);
      assert.equal((await toastTitles()).length, 1, 'opening the card closes its toast');
      assert.equal(await shadowText(page, '.thread .status'), 'Fixing · Opus 5.5 high');
      assert.deepEqual(await page.evaluate(() => [...document.querySelector('on-spot').shadowRoot.querySelectorAll('.thread .tags .chip')].map(node => node.textContent)), ['Style', 'All like it']);
      const steps = () => page.evaluate(() => [...document.querySelector('on-spot').shadowRoot.querySelectorAll('.thread .step span')].map(node => node.textContent));
      assert.deepEqual(await steps(), ['Found the code in app/page.tsx', 'Change made']);
      assert.equal(await page.locator(ui('.thread .watch')).getAttribute('href'), 'https://ai.koglabs.com/agents?tab=today&run=9');
      const clock = await shadowText(page, '.thread .elapsed');
      assert.match(clock, /^Fixing for 1:[1-5]\d$/);
      await waitFor(page, text => document.querySelector('on-spot').shadowRoot.querySelector('.thread .elapsed').textContent !== text, clock, 3000);
      const before = await detailCalls();
      await page.evaluate(() => __fake.step(1, 'Deploying to staging'));
      await waitFor(page, () => document.querySelector('on-spot').shadowRoot.querySelectorAll('.thread .step').length === 3);
      assert.deepEqual(await steps(), ['Found the code in app/page.tsx', 'Change made', 'Deploying to staging']);
      assert.equal(await detailCalls(), before + 1, 'a new step refetches the steps once');
      await screenshot(page, name, 'working-card');
      await page.evaluate(() => __fake.update(1, { status: 'waiting' }));
      await gone(page, '.thread .run');
      const frozenClock = await shadowText(page, '.thread .elapsed'); await delay(1300);
      assert.equal(await shadowText(page, '.thread .elapsed'), frozenClock, 'the clock stops when the pin stops working');
      await page.evaluate(() => __fake.update(1, { status: 'working' }));
      await visible(page, '.thread .run');
      await page.keyboard.press('Escape'); await gone(page, '.thread');
      pass('working card: model, About and Scope chips, elapsed time that ticks, live steps and the Watch live link');

      await page.evaluate(() => __fake.update(1, { status: 'done', summary: 'Heading is 10% smaller.', commit: 'a1b2c3d4e5', closedAt: new Date().toISOString() }));
      await marker(page, 1, 'done');
      assert.equal(await page.locator(ui('.marker[data-pin="1"]')).evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(74, 222, 128)');
      await visible(page, '.toast[data-kind="done"]');
      assert.equal(await shadowText(page, '.toast[data-kind="done"] .toast-title'), '#1 done');
      assert.equal(await shadowText(page, '.toast[data-kind="done"] .toast-text'), 'Heading is 10% smaller.');
      await screenshot(page, name, 'toasts');
      await delay(4500);
      await marker(page, 1, 'done');
      await page.locator(ui('.marker[data-pin="1"]')).click(); await visible(page, '.thread');
      await waitFor(page, () => document.querySelector('on-spot').shadowRoot.querySelector('.thread .status')?.textContent === 'Done');
      assert.equal(await shadowText(page, '.thread .summary'), 'Heading is 10% smaller.');
      assert.equal(await shadowText(page, '.thread .detail'), 'By Opus 5.5 high · claude');
      for (const title of ['Reload the page and show the change', 'Accept this change', 'Send this pin back for another fix']) {
        assert.equal(await page.locator(ui(`.thread button[title="${title}"]`)).isVisible(), true, title);
      }
      await screenshot(page, name, 'done-card');
      assert.equal(await page.locator(ui('.thread .accepted')).isVisible(), false, 'not accepted yet');
      await page.locator(ui('button[title="Accept this change"]')).click();
      await gone(page, '.thread'); await gone(page, '.marker[data-pin="1"]');
      assert.deepEqual(await page.evaluate(() => __fake.storage()['kog-pins:seen:fixture.koglabs.com']), [1]);
      assert.deepEqual(await page.evaluate(() => __fake.calls.filter(call => call.path === '/api/pins/1/accept').map(({ method, body }) => [method, body])), [['POST', {}]]);
      assert.ok(await page.evaluate(() => __fake.db.pins.find(pin => pin.id === 1).acceptedAt), 'the server stores the acceptance');
      pass('live: amber markers, done toast; a done pin stays green until "Looks good", which sends accept');

      await page.evaluate(() => __fake.update(2, { status: 'done', summary: 'Paragraph is lighter.', commit: 'b2c3d4e', closedAt: new Date().toISOString() }));
      await marker(page, 2, 'done');
      await page.locator(ui('.marker[data-pin="2"]')).click(); await visible(page, '.thread');
      await waitFor(page, () => document.querySelector('on-spot').shadowRoot.querySelector('.thread .status')?.textContent === 'Done');
      assert.equal(await page.locator(ui('textarea[name="pin-reply"]')).isVisible(), false);
      await page.locator(ui('button[title="Send this pin back for another fix"]')).click();
      assert.equal(await page.locator(ui('textarea[name="pin-reply"]')).getAttribute('placeholder'), 'What is still wrong?');
      await page.locator(ui('textarea[name="pin-reply"]')).fill('Still too dark.');
      await page.locator(ui('textarea[name="pin-reply"]')).press('Enter');
      await marker(page, 2, 'queued');
      await waitFor(page, () => document.querySelector('on-spot').shadowRoot.querySelector('.thread .status')?.textContent === 'Queued again');
      const wrong = await page.evaluate(() => __fake.calls.filter(call => call.path === '/api/pins/2/replies').at(-1).body);
      assert.deepEqual(wrong, { body: 'Still too dark.', reopen: true });
      await page.keyboard.press('Escape'); await gone(page, '.thread');
      pass('"Not right" sends a done pin back with the reason, as one reply with reopen');

      await page.evaluate(() => {
        __fake.update(3, { status: 'waiting', agent: 'claude', model: 'sonnet', run: 'triad:10' });
        __fake.reply(3, 'Should the gap be 8px or 16px?');
      });
      await marker(page, 3, 'waiting');
      await waitFor(page, () => document.querySelector('on-spot').shadowRoot.querySelector('.toast[data-kind="waiting"] .toast-text')?.textContent === 'Should the gap be 8px or 16px?');
      assert.equal(await shadowText(page, '.toast[data-kind="waiting"] .toast-title'), '#3 needs you');
      await page.locator(ui('.toast[data-kind="waiting"] button[title="Answer this question"]')).click();
      await visible(page, '.thread');
      await waitFor(page, () => {
        const root = document.querySelector('on-spot').shadowRoot;
        return root.querySelector('.thread .question')?.textContent === 'Should the gap be 8px or 16px?' && root.activeElement?.name === 'pin-reply'
          && root.querySelector('.thread .status')?.textContent === 'Needs you';
      });
      assert.equal(await page.locator(ui(`.marker[data-pin="3"]`)).evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(139, 92, 246)');
      await page.locator(ui('textarea[name="pin-reply"]')).fill('Use 8px.');
      await page.locator(ui('textarea[name="pin-reply"]')).press('Enter');
      await marker(page, 3, 'queued');
      assert.equal(await page.evaluate(() => __fake.db.pins.find(pin => pin.id === 3).status), 'queued');
      await page.keyboard.press('Escape'); await gone(page, '.thread');
      pass('a question arrives as a toast; Answer opens the card with the reply focused; the answer requeues');

      await openMenu(page); await page.locator(ui('.log-button')).click(); await visible(page, '.log');
      assert.equal(await page.locator(ui('.log-button')).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator(ui('.log-button')).textContent(), '3');
      await waitFor(page, () => __fake.calls.some(call => call.path === '/api/pins?host=fixture.koglabs.com&status=all&limit=100'));
      await waitFor(page, () => document.querySelector('on-spot').shadowRoot.querySelectorAll('.log .log-row').length === 4);
      const logView = await page.evaluate(() => {
        const root = document.querySelector('on-spot').shadowRoot;
        return {
          head: root.querySelector('.log-group-head').textContent,
          rows: [...root.querySelectorAll('.log-row')].map(row => [row.querySelector('.log-number').textContent, row.querySelector('.chip').textContent, row.querySelector('.log-detail')?.textContent ?? '']),
        };
      });
      assert.match(logView.head, /^Sent .+ · 4 pins1\/4 done$/);
      assert.deepEqual(logView.rows, [['#4', 'Queued', ''], ['#3', 'Queued', ''], ['#2', 'Queued again', ''], ['#1', 'Done', 'Heading is 10% smaller. · a1b2c3d']]);
      await page.evaluate(() => __fake.update(4, { status: 'working', agent: 'claude', model: 'sonnet', attempts: 1, run: 'triad:11', startedAt: new Date().toISOString() }));
      await waitFor(page, () => [...document.querySelector('on-spot').shadowRoot.querySelectorAll('.log-row')][0].querySelector('.chip').textContent === 'Fixing · Sonnet 5.5');
      assert.match(await shadowText(page, '.log-row[data-key="4"] .log-detail'), /^Started /);
      await page.evaluate(() => __fake.step(4, 'Tests pass'));
      await waitFor(page, () => document.querySelector('on-spot').shadowRoot.querySelector('.log-row[data-key="4"] .log-detail')?.textContent === 'Tests pass');
      await screenshot(page, name, 'log');
      await page.locator(ui('.log-row[data-key="4"]')).click();
      await gone(page, '.log'); await visible(page, '.thread');
      await waitFor(page, () => document.querySelector('on-spot').shadowRoot.querySelector('.thread .panel-title')?.textContent === 'Pin 4');
      await page.keyboard.press('Escape');
      pass('the Log lists the batch with progress, chips per status, summary and commit; a working row shows its newest step; a row opens its pin');

      await openMenu(page); await page.locator(ui('.log-button')).click(); await visible(page, '.log');
      await page.locator(ui('.log-row[data-key="1"]')).click(); await visible(page, '.thread');
      await waitFor(page, () => document.querySelector('on-spot').shadowRoot.querySelector('.thread .status')?.textContent === 'Done');
      await visible(page, '.thread .accepted');
      assert.equal(await shadowText(page, '.thread .accepted'), 'Accepted');
      assert.match(await page.locator(ui('.thread .accepted')).getAttribute('title'), /^You accepted it \d/);
      assert.equal(await page.locator(ui('button[title="Accept this change"]')).isVisible(), false, 'an accepted pin has no Looks good');
      await screenshot(page, name, 'accepted-card');
      await page.keyboard.press('Escape'); await gone(page, '.thread');
      pass('the card of an accepted pin shows "Accepted" next to the status and no Looks good');

      await page.evaluate(() => __fake.update(4, { status: 'queued', agent: null, run: null }));
      await toggle(page); await pick(page, '#action-target'); await note(page, 'Draft to edit.');
      await pick(page, '[data-testid="secondary"]'); await note(page, 'Second draft.');
      await page.keyboard.press('Escape'); await gone(page, '.overlay');
      await waitTray(page, '2 pins ready');
      await page.locator(ui('.marker[data-status="draft"]')).first().click(); await visible(page, '.popup');
      assert.equal(await page.locator(ui('textarea[name="draft-note"]')).inputValue(), 'Draft to edit.');
      await page.locator(ui('textarea[name="draft-note"]')).fill('Edited draft.');
      await page.locator(ui('textarea[name="draft-note"]')).press('Enter'); await gone(page, '.popup');
      assert.match(await page.locator(ui('.marker[data-status="draft"]')).first().getAttribute('title'), /Edited draft\./);
      await page.locator(ui('.marker[data-status="draft"]')).nth(1).click(); await visible(page, '.popup');
      await page.locator(ui('button[title="Discard this unsent pin"]')).click(); await gone(page, '.popup');
      await waitTray(page, '1 pin ready');
      await page.reload(); await visible(page, '.capsule');
      await waitTray(page, '1 pin ready');
      assert.deepEqual(await drafts(page), ['1']);
      await page.evaluate(() => __fake.failNext('POST', '/api/batches'));
      await page.locator(ui('button[title^="Submit all pins"]')).click();
      await waitTray(page, 'Not sent: You are offline.');
      assert.equal(await page.locator(ui('.tray .primary')).textContent(), 'Try again');
      assert.deepEqual(await drafts(page), ['1']);
      await page.evaluate(() => __fake.loseNextResponse());
      await page.locator(ui('.tray .primary')).click();
      await waitTray(page, 'Not sent: You are offline.');
      await page.locator(ui('.tray .primary')).click();
      await gone(page, '.tray');
      const retry = await page.evaluate(() => ({
        keys: __fake.calls.filter(call => call.path === '/api/batches').map(call => call.body.key),
        copies: __fake.db.pins.filter(pin => pin.note === 'Edited draft.').length,
        batches: __fake.db.batches.length,
      }));
      assert.equal(new Set(retry.keys.slice(1)).size, 1, 'every retry repeats the same key');
      assert.equal(retry.copies, 1, 'a lost response does not double the pin');
      assert.equal(retry.batches, 2);
      await marker(page, 5);
      pass('unsent pins: edit, remove, survive a reload; a failed send keeps them; retries reuse one key');

      await toggle(page); await pick(page, '#action-target');
      await page.locator(ui('textarea[name="pin-note"]')).fill('A note that stays.');
      await page.keyboard.press('Escape'); await gone(page, '.popup'); await visible(page, '.overlay');
      await page.keyboard.press('Escape'); await gone(page, '.overlay');
      await page.evaluate(() => { __fake.storageDelay = 400; });
      await toggle(page); await pick(page, '#action-target');
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
      await page.evaluate(() => { __fake.storageDelay = 0; });
      await toggle(page); await pick(page, '#action-target');
      await waitFor(page, () => document.querySelector('on-spot').shadowRoot.querySelector('[name="pin-note"]').value === 'A note that stays.');
      await page.locator(ui('textarea[name="pin-note"]')).fill('');
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
      pass('Escape closes the popup before pin mode; unsent text is restored');

      await page.locator(ui('.capsule button[title^="Hide markers"]')).click(); await gone(page, '.marker');
      assert.equal(await page.locator(ui('.capsule button[title^="Show markers"]')).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator(ui('.capsule button[title^="Show markers"] path')).count(), 3, 'a slashed eye while hidden');
      await page.locator(ui('.capsule button[title^="Show markers"]')).click(); await marker(page, 5);
      assert.equal(await page.locator(ui('.capsule button[title^="Hide markers"]')).getAttribute('aria-pressed'), 'false');
      await page.evaluate(() => document.querySelector('#action-target').remove());
      await waitFor(page, () => document.querySelector('on-spot').shadowRoot.querySelector('.marker[data-pin="5"]')?.dataset.missing === 'true');
      await waitFor(page, () => getComputedStyle(document.querySelector('on-spot').shadowRoot.querySelector('.marker[data-pin="5"]')).opacity === '0.45');
      await page.evaluate(() => history.pushState({}, '', '/second')); await gone(page, '.marker');
      await page.evaluate(() => history.pushState({}, '', '/')); await marker(page, 2);
      pass('the capsule eye hides and shows markers in one click; missing-element fallback and SPA pushState route filtering');

      const beforeConnections = await page.evaluate(() => __fake.connections);
      await page.evaluate(() => __fake.disconnect());
      await waitFor(page, count => __fake.connections === count + 1, beforeConnections);
      assert.equal(await page.evaluate(() => __fake.activePorts), 1);
      await page.evaluate(() => __fake.state('login'));
      assert.equal(await page.locator(ui('.connection')).getAttribute('data-state'), 'login');
      assert.equal(await page.locator(ui('.connection')).evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(220, 38, 38)');
      await openMenu(page); await visible(page, '.login'); assert.match(await page.locator(ui('.login')).getAttribute('href'), /^https:\/\/ai\.koglabs\.com\/login\?next=/);
      await page.evaluate(() => __fake.state('live')); await gone(page, '.login');
      pass('port reconnect, refetch and login recovery');

      await openMenu(page); await page.locator(ui('button[title^="Pause page animations"]')).click();
      await waitFor(page, () => document.querySelector('#animation').getAnimations().every(animation => animation.playState === 'paused'));
      await page.evaluate(() => Promise.all(document.querySelector('#animation').getAnimations().map(animation => animation.ready)));
      const timeA = await page.evaluate(() => document.querySelector('#animation').getAnimations()[0].currentTime);
      await delay(120);
      const timeB = await page.evaluate(() => document.querySelector('#animation').getAnimations()[0].currentTime);
      assert.ok(Math.abs(timeA - timeB) < 1, `Frozen animation moved from ${timeA} to ${timeB}`);
      assert.equal(await page.evaluate(() => document.adoptedStyleSheets.length), 1);
      await page.locator(ui('button[title^="Resume page animations"]')).click();
      await waitFor(page, () => document.querySelector('#animation').getAnimations()[0].playState === 'running');
      assert.equal(await page.evaluate(() => document.adoptedStyleSheets.length), 0);
      pass('Freeze pauses animation time and removes its constructed sheet on resume');

      const invalid = await page.evaluate(async () => chrome.runtime.sendMessage({ t: 'api', method: 'POST', path: '/api/pins', body: { url: location.href, note: 'Missing targets' } }));
      assert.equal(invalid.ok, false); assert.equal(invalid.status, 400);
      await clean(page, issues);
      pass('strict CSP, no page errors, safe DOM, button titles and fake API validation');

      await page.evaluate(() => {
        const pin = __fake.seed({ url: `${location.origin}/`, note: 'Make the last heading green.', targets: [{ selector: '#bottom-target', label: 'h2 "The next chapter"', rect: { x: 100, y: 1400, w: 500, h: 40 } }] });
        __fake.update(pin.id, {});
        __fake.update(pin.id, { status: 'done', summary: 'The last heading is green.', commit: 'c3d4e5f', closedAt: new Date().toISOString() });
      });
      const seeId = await page.evaluate(() => __fake.db.pins.at(-1).id);
      await visible(page, '.toast[data-kind="done"] button[title="See the change on the page"]');
      await page.locator(ui('.toast[data-kind="done"] button[title="See the change on the page"]')).click();
      await page.waitForLoadState('load'); await visible(page, '.thread');
      await waitFor(page, id => location.hash === '' && scrollY > 500 && document.querySelector('on-spot').shadowRoot.querySelector('.thread .panel-title')?.textContent === `Pin ${id}`, seeId);
      await visible(page, '.flash');
      const flashBox = await page.evaluate(() => {
        const a = document.querySelector('#bottom-target').getBoundingClientRect(), b = document.querySelector('on-spot').shadowRoot.querySelector('.flash').getBoundingClientRect();
        return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height));
      });
      assert.ok(flashBox <= 1, `flash sits on the element (${flashBox}px off)`);
      await screenshot(page, name, 'see-it');
      await page.keyboard.press('Escape'); await gone(page, '.thread');
      assert.ok(await page.evaluate(id => __fake.storage()['kog-pins:seen:fixture.koglabs.com'].includes(id), seeId));
      await gone(page, `.marker[data-pin="${seeId}"]`);
      pass('"See it" reloads the page, scrolls to the changed element, highlights it and opens the pin');

      await page.evaluate(() => {
        __fake.reset();
        __fake.seed({ url: `${location.origin}/deep`, note: 'Open this deep link.', targets: [{ selector: '#bottom-target', label: 'h2 "The next chapter"', rect: { x: 100, y: 1400, w: 500, h: 40 } }] });
      });
      await page.goto(`${origin}/deep#kog-pin=1`); await visible(page, '.thread');
      await waitFor(page, () => location.hash === '' && scrollY > 500 && document.querySelector('on-spot').shadowRoot.querySelector('.thread .note').textContent === 'Open this deep link.');
      assert.equal(new URL(page.url()).pathname, '/deep');
      await page.locator(ui('button[title="Edit this note"]')).click();
      await page.locator(ui('textarea[name="edit-note"]')).fill('<img src=x onerror=alert(1)> Keep this sentence.');
      await page.locator(ui('button[title="Save the edited note"]')).click();
      await waitFor(page, () => document.querySelector('on-spot').shadowRoot.querySelector('.thread .note').textContent.startsWith('<img'));
      assert.equal(await page.locator(ui('.thread img')).count(), 0);
      await page.locator(ui('button[title="Dismiss this pin"]')).click();
      await waitFor(page, () => document.querySelector('on-spot').shadowRoot.querySelector('.thread .status').textContent === 'Dismissed');
      await page.locator(ui('button[title="Delete this pin"]')).click();
      assert.equal(await page.evaluate(() => __fake.calls.some(call => call.method === 'DELETE')), false);
      await page.locator(ui('button[title="Keep this pin"]')).click();
      await page.locator(ui('button[title="Delete this pin"]')).click();
      await page.locator(ui('button[title="Confirm deletion of this pin"]')).click();
      await gone(page, '.thread');
      assert.equal(await page.evaluate(() => __fake.db.pins.length), 0);
      await clean(page, issues);
      pass('deep link opens and clears the fragment; safe text edit, dismiss and inline delete confirmation');
      await page.close();

      const nonce = await freshPage(context, '/nonce'); activePage = nonce.page;
      await nonce.page.evaluate(() => { __fake.reset(); __fake.serverExtension = '9.0.0'; });
      await openMenu(nonce.page); await visible(nonce.page, '.update'); await visible(nonce.page, '.update-dot');
      assert.equal(await nonce.page.locator(ui('.update')).getAttribute('href'), 'https://ai.koglabs.com/triad?tab=pins');
      await nonce.page.locator(ui('.pin-button')).click(); await pick(nonce.page, '#target');
      await note(nonce.page, 'Nonce CSP pin.', 'Control+Enter'); await marker(nonce.page, 1);
      assert.equal((await posts(nonce.page)).length, 1);
      await clean(nonce.page, nonce.issues); await nonce.page.close();
      pass('nonce + strict-dynamic CSP: Ctrl+Enter in the note adds and submits; a newer server build shows Update and its dot');

      const complex = await freshPage(context, '/complex'); activePage = complex.page;
      const cp = complex.page;
      await cp.evaluate(() => __fake.reset());
      await toggle(cp); await pick(cp, '#scroll-target'); await note(cp, 'Track this scroll target.');
      await pick(cp, '#shadow-target'); await visible(cp, '.popup');
      assert.match(await cp.locator(ui('.popup .panel-title')).textContent(), /Shadow root target/);
      await note(cp, 'Pin the shadow target.');
      await cp.keyboard.press('Control+Enter'); await marker(cp, 1); await marker(cp, 2);
      const beforeScroll = await cp.locator(ui('.marker[data-pin="1"]')).boundingBox();
      await cp.locator('#scrollbox').evaluate(node => { node.scrollTop = 40; });
      await waitFor(cp, y => Math.abs(document.querySelector('on-spot').shadowRoot.querySelector('.marker[data-pin="1"]').getBoundingClientRect().top - y) < 1, beforeScroll.y - 40);
      const shadowPick = await cp.evaluate(() => __fake.db.pins.find(pin => pin.id === 2).targets[0]);
      assert.match(shadowPick.label, /Shadow root target/); assert.match(shadowPick.selector, / >>> /);
      assert.ok(await cp.evaluate(sel => {
        let scope = document, node = null;
        for (const part of sel.split(' >>> ')) { node = scope?.querySelector(part) ?? null; scope = node?.shadowRoot; }
        return node?.id === 'shadow-target';
      }, shadowPick.selector), 'shadow selector resolves to the picked element');
      // The "2 pins sent" toast can cover the scroll box at this height. Close it first.
      await cp.locator(ui('.toast button[title="Close this message"]')).click(); await gone(cp, '.toast');
      const scroller = await point(cp, '#scroll-target'); await cp.mouse.move(scroller.x, scroller.y); await cp.mouse.wheel(0, 45);
      await waitFor(cp, () => document.querySelector('#scrollbox').scrollTop > 40);
      await cp.keyboard.press('Escape');
      await clean(cp, complex.issues); await cp.close();
      pass('scroll-container and open-shadow-root picks, exact marker tracking and overlay wheel scrolling');

      const legacyURL = `${origin}/legacy`;
      const legacy = await context.newPage(); activePage = legacy;
      await legacy.goto(`${origin}/blank-start`); await visible(legacy, '.capsule');
      await legacy.evaluate(url => __fake.setStorage({ [`kog-pins:pending:${url}`]: [{ key: 'local-1', body: { url, note: 'A v1 send that failed.', targets: [{ selector: '#target', label: 'h1', rect: { x: 1, y: 1, w: 1, h: 1 } }] } }] }), legacyURL);
      await legacy.goto(legacyURL); await visible(legacy, '.capsule');
      await waitTray(legacy, '1 pin ready');
      assert.deepEqual(await drafts(legacy), ['1']);
      assert.deepEqual(await legacy.evaluate(url => __fake.storage()[`kog-pins:pending:${url}`], legacyURL), []);
      await legacy.close();
      pass('a v1 failed send becomes an unsent pin, so nothing is lost on upgrade');

      // Settings: his tabs, defaults and presets. They apply to the next popup at once.
      const prefsPage = await freshPage(context, '/prefs'); activePage = prefsPage.page;
      const sp = prefsPage.page;
      const root = fn => sp.evaluate(fn);
      // Earlier pages left unsent pins in the shared storage. This page starts empty.
      await sp.evaluate(() => { __fake.reset(); localStorage.removeItem('onspot-harness-storage'); });
      await sp.reload(); await visible(sp, '.capsule');
      await openMenu(sp); await sp.locator(ui('button[title^="Open Settings"]')).click(); await visible(sp, '.sheet');
      assert.equal(await sp.locator(ui('button[title^="Open Settings"]')).getAttribute('aria-pressed'), 'true');
      const rowNames = () => root(() => [...document.querySelector('on-spot').shadowRoot.querySelectorAll('.sheet .panel-body:not(.bulk) .row')].filter(node => !node.querySelector('kbd')).map(node => `${node.querySelector('.row-label span').textContent}${node.dataset.off === 'true' ? ' (off)' : ''}`));
      assert.deepEqual(await rowNames(), ['Text', 'Style', 'Layout', 'Behaviour', 'Remove', 'Task']);
      await sp.locator(ui('button[title="Hide the Layout tab"]')).click();
      assert.equal(await sp.locator(ui('button[title="Show the Layout tab"]')).getAttribute('aria-pressed'), 'false');
      assert.equal(await root(() => document.querySelector('on-spot').shadowRoot.activeElement.title), 'Show the Layout tab', 'focus stays on the control');
      await sp.locator(ui('button[title="Move the Task tab up"]')).click(); await sp.keyboard.press('Enter');
      assert.deepEqual(await rowNames(), ['Text', 'Style', 'Layout (off)', 'Task', 'Behaviour', 'Remove']);
      assert.equal(await sp.locator(ui('button[title="Move the Text tab up"]')).isDisabled(), true);
      assert.deepEqual(await labelsIn(sp, '.sheet .seg'), ['Text', 'Style', 'Task', 'Behaviour', 'Remove'], 'a hidden tab cannot be the default');
      await sp.locator(ui('.sheet button[title="Start each note with the Style tab"]')).click();
      await sp.locator(ui('.sheet button[title="Start each note with: Change this page"]')).click();
      assert.deepEqual(await pressedIn(sp, '.sheet .seg, .sheet .chips'), ['Style', 'Page']);
      await sp.locator(ui('button[title="Add a preset"]')).click();
      assert.equal(await root(() => document.querySelector('on-spot').shadowRoot.activeElement.name), 'preset-label');
      await sp.locator(ui('button[title="Save this preset"]')).click();
      assert.equal(await shadowText(sp, '#onspot-preset-error'), 'Write a label and the instruction.');
      await sp.locator(ui('input[name="preset-label"]')).fill('5 agents'); await sp.keyboard.press('Enter');
      await sp.locator(ui('textarea[name="preset-text"]')).fill('Start a thread and delegate 5 agents.'); await sp.keyboard.press('Enter');
      await sp.locator(ui('button[title="Add a preset"]')).click();
      await sp.locator(ui('input[name="preset-label"]')).fill('Staging only');
      await sp.locator(ui('textarea[name="preset-text"]')).fill('Deploy to staging and stop.');
      await sp.locator(ui('button[title="Save this preset"]')).click();
      await sp.locator(ui('button[title="Edit the preset Staging only"]')).click();
      await sp.locator(ui('input[name="preset-label"]')).fill('Staging first'); await sp.locator(ui('button[title="Save this preset"]')).click();
      await sp.locator(ui('button[title="Move the preset Staging first up"]')).click();
      assert.deepEqual((await rowNames()).slice(6), ['Staging first', '5 agents']);
      const presetCount = () => root(() => [...document.querySelector('on-spot').shadowRoot.querySelectorAll('.sheet .sheet-title')].find(node => node.firstChild.data === 'Presets').querySelector('span').textContent);
      assert.equal(await presetCount(), '2/12 · up to 6 per pin');
      await sp.locator(ui('button[title="Add a preset"]')).click(); await sp.locator(ui('input[name="preset-label"]')).fill('Not kept');
      await sp.keyboard.press('Escape'); await gone(sp, 'input[name="preset-label"]'); await visible(sp, '.sheet');
      await screenshot(sp, name, 'settings');
      const sheetBox = await sp.locator(ui('.sheet')).boundingBox(), capsuleBox = await sp.locator(ui('.capsule')).boundingBox();
      assert.ok(inside(sheetBox, 1280, 900) && sheetBox.y + sheetBox.height <= capsuleBox.y, `sheet ${JSON.stringify(sheetBox)} sits above the capsule`);
      await sp.keyboard.press('Escape'); await gone(sp, '.sheet');
      const stored = await sp.evaluate(() => __fake.storage()['kog-pins:prefs']);
      assert.ok(stored.presets.every(preset => typeof preset.id === 'string' && preset.id));
      assert.deepEqual({ ...stored, presets: stored.presets.map(({ label, text }) => [label, text]) }, { v: 1, tabs: ['text', 'style', 'layout', 'task', 'behaviour', 'remove'], hidden: ['layout'], intent: 'style', scope: 'page',
        presets: [['Staging first', 'Deploy to staging and stop.'], ['5 agents', 'Start a thread and delegate 5 agents.']], keys: defaultKeys });
      pass('Settings: hide a tab, reorder, default tab and scope, add, edit and move presets; saved as kog-pins:prefs v1');

      await sp.locator(ui('.pin-button')).click(); await pick(sp, '#target'); await visible(sp, '.popup');
      assert.deepEqual(await labelsIn(sp, '.popup .seg'), ['Text', 'Style', 'Task', 'Behaviour', 'Remove']);
      assert.deepEqual(await labelsIn(sp, '.popup .presets'), ['Staging first', '5 agents']);
      assert.deepEqual(await pressedIn(sp, '.popup'), ['Style', 'Page'], 'the defaults apply to the next popup at once');
      assert.equal(await sp.locator(ui('textarea[name="pin-note"]')).getAttribute('placeholder'), 'How should it look?');
      await sp.keyboard.press('Alt+6'); assert.deepEqual(await pressedIn(sp, '.popup'), ['Style', 'Page'], 'Alt+6 has no sixth tab');
      await sp.keyboard.press('Alt+5');
      await sp.locator(ui('.popup button[title="Change the whole site"]')).click(); await sp.locator(ui('.popup button[title="Change the whole site"]')).click();
      await sp.locator(ui('.popup button[title="Start a thread and delegate 5 agents."]')).click();
      assert.deepEqual(await pressedIn(sp, '.popup'), ['Remove', '5 agents'], 'a second click clears the scope');
      await screenshot(sp, name, 'popup-presets');
      await sp.locator(ui('textarea[name="pin-note"]')).press('Enter'); await gone(sp, '.popup');
      await waitTray(sp, '1 pin ready');
      await pick(sp, '#second-target'); await note(sp, 'Make this lighter.');
      await sp.keyboard.press('Escape'); await gone(sp, '.overlay');
      await sp.locator(ui('.marker[data-status="draft"]')).first().click(); await visible(sp, '.popup');
      assert.equal(await sp.locator(ui('textarea[name="draft-note"]')).inputValue(), 'Remove this element.', 'Remove with an empty note');
      assert.deepEqual(await pressedIn(sp, '.popup'), ['Remove', '5 agents'], 'the edit popup shows the saved choices');
      await sp.locator(ui('.popup button[title="Change every element like it in the app"]')).click();
      await sp.locator(ui('.popup button[title="Deploy to staging and stop."]')).click();
      await sp.locator(ui('textarea[name="draft-note"]')).press('Enter'); await gone(sp, '.popup');
      await sp.locator(ui('button[title^="Submit all pins"]')).click(); await marker(sp, 2);
      const picks = await sp.evaluate(() => __fake.calls.find(call => call.path === '/api/batches').body.pins.map(({ note, intent, scope, presets }) => ({ note, intent, scope, presets })));
      assert.deepEqual(picks, [
        { note: 'Remove this element.', intent: 'remove', scope: 'similar', presets: [{ label: '5 agents', text: 'Start a thread and delegate 5 agents.' }, { label: 'Staging first', text: 'Deploy to staging and stop.' }] },
        { note: 'Make this lighter.', intent: 'style', scope: 'page', presets: [] },
      ]);
      assert.deepEqual(await sp.evaluate(() => __fake.db.pins.map(pin => [pin.intent, pin.scope, pin.presets.length])), [['remove', 'similar', 2], ['style', 'page', 0]], 'the store accepts them');
      await sp.locator(ui('.marker[data-pin="1"]')).click(); await visible(sp, '.thread');
      await waitFor(sp, () => document.querySelector('on-spot').shadowRoot.querySelectorAll('.thread .tags .chip').length === 4);
      assert.deepEqual(await root(() => [...document.querySelector('on-spot').shadowRoot.querySelectorAll('.thread .tags .chip')].map(node => node.textContent)), ['Remove', 'All like it', '5 agents', 'Staging first']);
      await sp.keyboard.press('Escape');
      pass('popup presets and defaults; Remove with an empty note; the edit popup keeps the choices; the batch body holds intent, scope and presets');

      await sp.reload(); await visible(sp, '.capsule');
      await openMenu(sp); await sp.locator(ui('button[title^="Open Settings"]')).click(); await visible(sp, '.sheet');
      assert.deepEqual(await rowNames(), ['Text', 'Style', 'Layout (off)', 'Task', 'Behaviour', 'Remove', 'Staging first', '5 agents']);
      assert.deepEqual(await pressedIn(sp, '.sheet .seg, .sheet .chips'), ['Style', 'Page'], 'a reload keeps the settings');
      await sp.locator(ui('button[title="Remove the preset 5 agents"]')).click();
      assert.deepEqual((await rowNames()).slice(6), ['Staging first']);
      // The limits: 12 presets kept, 6 per pin. With every tab hidden the popup has no tab strip.
      await sp.evaluate(() => __fake.setStorage({ 'kog-pins:prefs': { v: 1, tabs: ['task', 'text'], hidden: ['text', 'style', 'layout', 'behaviour', 'remove', 'task'], intent: 'task', scope: 'site',
        presets: Array.from({ length: 13 }, (_, index) => ({ id: `p${index}`, label: `Preset ${index + 1}`, text: `Instruction ${index + 1}.` })) } }));
      await sp.reload(); await visible(sp, '.capsule');
      await sp.locator(ui('.pin-button')).click(); await pick(sp, '#target'); await visible(sp, '.popup');
      assert.equal(await sp.locator(ui('.popup .seg')).isVisible(), false, 'no tabs: no strip');
      assert.deepEqual(await pressedIn(sp, '.popup'), ['Site'], 'a hidden tab is not the default');
      assert.equal((await labelsIn(sp, '.popup .presets')).length, 12);
      for (let index = 1; index <= 7; index++) await sp.locator(ui(`.popup button[title="Instruction ${index}."]`)).click();
      assert.deepEqual(await pressedIn(sp, '.popup .presets'), ['Preset 1', 'Preset 2', 'Preset 3', 'Preset 4', 'Preset 5', 'Preset 6'], 'a pin takes 6 presets');
      await sp.keyboard.press('Escape'); await sp.keyboard.press('Escape');
      await openMenu(sp); await sp.locator(ui('button[title^="Open Settings"]')).click(); await visible(sp, '.sheet');
      assert.deepEqual((await rowNames()).slice(0, 6), ['Task (off)', 'Text (off)', 'Style (off)', 'Layout (off)', 'Behaviour (off)', 'Remove (off)'], 'missing tab ids are added back');
      assert.equal(await presetCount(), '12/12 · up to 6 per pin');
      assert.equal(await sp.locator(ui('button[title="Add a preset"]')).count(), 0, 'no thirteenth preset');
      await sp.evaluate(() => __fake.setStorage({ 'kog-pins:prefs': { v: 1, tabs: 'x', hidden: [7], intent: ['text'], scope: 'galaxy', presets: [{ id: 1, label: 'x', text: 'y' }, null] } }));
      await sp.reload(); await visible(sp, '.capsule');
      await sp.locator(ui('.pin-button')).click(); await pick(sp, '#target'); await visible(sp, '.popup');
      assert.deepEqual(await labelsIn(sp, '.popup .seg'), ['Text', 'Style', 'Layout', 'Behaviour', 'Remove', 'Task']);
      assert.deepEqual(await pressedIn(sp, '.popup'), []); assert.equal(await sp.locator(ui('.popup .presets')).count(), 0);
      await sp.keyboard.press('Escape'); await sp.keyboard.press('Escape');
      await sp.evaluate(() => __fake.setStorage({ 'kog-pins:prefs': 'garbage' }));
      await sp.reload(); await visible(sp, '.capsule');
      await openMenu(sp); await sp.locator(ui('button[title^="Open Settings"]')).click(); await visible(sp, '.sheet');
      assert.deepEqual(await rowNames(), ['Text', 'Style', 'Layout', 'Behaviour', 'Remove', 'Task']);
      assert.deepEqual(await pressedIn(sp, '.sheet .seg, .sheet .chips'), []);
      await clean(sp, prefsPage.issues); await sp.close();
      pass('a reload keeps the settings; limits (12 presets kept, 6 per pin); bad stored settings fall back to all six tabs, no default and no presets');

      // Before and after shots: bytes from the background, drawn into canvas. This page forbids every image.
      const shotsPage = await freshPage(context, '/shots'); activePage = shotsPage.page;
      const hp = shotsPage.page;
      await hp.evaluate(() => {
        __fake.reset();
        const pin = __fake.seed({ url: `${location.origin}/shots`, note: 'Make the heading green.', targets: [{ selector: '#target', label: 'h1 "Make room"', rect: { x: 100, y: 100, w: 500, h: 50 } }] });
        __fake.update(pin.id, { status: 'working', agent: 'claude', model: 'fable 5.2 xhigh', attempts: 1, run: 'triad:abc-1', startedAt: new Date().toISOString() });
        __fake.shot(pin.id, 'before');
      });
      await marker(hp, 1, 'working'); await hp.locator(ui('.marker[data-pin="1"]')).click(); await visible(hp, '.thread');
      const pixel = kind => hp.evaluate(which => {
        const canvas = document.querySelector('on-spot').shadowRoot.querySelector(`.shot[data-kind="${which}"] canvas`);
        return canvas && canvas.width === 40 ? [canvas.width, canvas.height, ...canvas.getContext('2d').getImageData(20, 15, 1, 1).data] : null;
      }, kind);
      await waitFor(hp, () => document.querySelector('on-spot').shadowRoot.querySelector('.shot[data-kind="before"] canvas')?.width === 40);
      assert.deepEqual(await pixel('before'), [40, 30, 220, 38, 38, 255], 'the before image is drawn');
      assert.equal(await hp.locator(ui('.shot')).count(), 1);
      assert.equal(await shadowText(hp, '.thread .status'), 'Fixing · Fable 5.2 xhigh');
      assert.equal(await hp.locator(ui('.thread .watch')).getAttribute('href'), 'https://ai.koglabs.com/agents?tab=today&run=abc-1');
      await hp.keyboard.press('Escape'); await gone(hp, '.thread');
      await hp.locator(ui('.marker[data-pin="1"]')).click(); await visible(hp, '.thread');
      await waitFor(hp, () => document.querySelector('on-spot').shadowRoot.querySelector('.shot[data-kind="before"] canvas')?.width === 40);
      await hp.evaluate(() => { __fake.shot(1, 'after'); __fake.update(1, { status: 'done', summary: 'The heading is green.', commit: 'd4e5f6a', closedAt: new Date().toISOString() }); });
      await waitFor(hp, () => document.querySelector('on-spot').shadowRoot.querySelector('.shot[data-kind="after"] canvas')?.width === 40);
      assert.deepEqual(await pixel('after'), [40, 30, 22, 163, 74, 255], 'the after image is drawn');
      assert.deepEqual(await pixel('before'), [40, 30, 220, 38, 38, 255]);
      const shotBoxes = () => hp.evaluate(() => { const root = document.querySelector('on-spot').shadowRoot; return ['.thread .panel-body', '.shot[data-kind="before"]', '.shot[data-kind="after"]'].map(sel => { const box = root.querySelector(sel).getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, width: box.width }; }); });
      let [bodyBox, beforeBox, afterBox] = await shotBoxes();
      assert.ok(beforeBox.right <= afterBox.left && beforeBox.top === afterBox.top && Math.abs(beforeBox.width - afterBox.width) <= 1, 'Before and After sit side by side');
      await screenshot(hp, name, 'shots');
      await hp.locator(ui('.shot[data-kind="after"]')).click();
      [bodyBox, beforeBox, afterBox] = await shotBoxes();
      assert.ok(afterBox.width >= bodyBox.width - 26 && beforeBox.width === 0, `full width ${afterBox.width} of ${bodyBox.width}`);
      assert.equal(await hp.locator(ui('.shot[data-kind="after"]')).getAttribute('title'), 'Show both images side by side');
      await hp.locator(ui('.shot[data-kind="after"]')).click();
      [bodyBox, beforeBox, afterBox] = await shotBoxes();
      assert.ok(beforeBox.right <= afterBox.left && beforeBox.width > 0, 'a second click goes back');
      assert.deepEqual(await hp.evaluate(() => __fake.calls.filter(call => call.t === 'shot').map(call => [call.id, call.kind])), [[1, 'before'], [1, 'after']], 'each image is fetched once, also when the card opens again');
      assert.equal(await hp.locator(ui('on-spot img')).count() + await hp.locator('on-spot img').count(), 0, 'no image element');
      assert.deepEqual(await hp.evaluate(() => chrome.runtime.sendMessage({ t: 'shot', id: '1/../2', kind: 'before' })), { ok: false, status: 400 });
      pass("shots: Before and After drawn into canvas under img-src 'none', side by side, full width on a click, cached per upload");

      await hp.evaluate(() => __fake.failNext('POST', '/api/pins/1/accept', 503, 'Try again later'));
      await hp.locator(ui('button[title="Accept this change"]')).click();
      await waitFor(hp, () => document.querySelector('on-spot').shadowRoot.querySelector('#onspot-card-error')?.textContent === 'Try again later');
      assert.equal(await hp.locator(ui('.thread')).isVisible(), true, 'the card stays open with the reason');
      assert.deepEqual(await hp.evaluate(() => __fake.storage()['kog-pins:seen:fixture.koglabs.com']), [1], 'a failed accept still marks the pin seen');
      await gone(hp, '.marker[data-pin="1"]');
      assert.equal(await hp.evaluate(() => __fake.db.pins[0].acceptedAt), null);
      await hp.locator(ui('button[title="Accept this change"]')).click(); await gone(hp, '.thread');
      assert.ok(await hp.evaluate(() => __fake.db.pins[0].acceptedAt), 'a second try accepts it');
      await clean(hp, shotsPage.issues); await hp.close();
      pass('a failed accept shows the reason, keeps Looks good for a retry and still marks the pin seen');

      // Attached images (0.7.0): paste or pick, a thumbnail, remove, submit, and the card strips.
      const imagesPage = await freshPage(context, '/images'); activePage = imagesPage.page;
      const ip = imagesPage.page;
      const pinPng = Buffer.from(png([20, 80, 200]), 'base64');
      const replyPng = Buffer.from(png([200, 160, 20]), 'base64');
      const imageIdRe = /^[A-Za-z0-9_-]{22}$/;
      async function pickImage(buttonSelector, buffer) {
        const [chooser] = await Promise.all([
          ip.waitForEvent('filechooser', { timeout: 8000 }),
          ip.locator(ui(buttonSelector)).click(),
        ]);
        await chooser.setFiles({ name: 'picture.png', mimeType: 'image/png', buffer });
      }
      async function addNoteImage(buffer) {
        let added = false;
        try {
          await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
          await ip.locator(ui('textarea[name="pin-note"]')).click();
          added = await ip.evaluate(async (b64) => {
            const bytes = Uint8Array.from(atob(b64), char => char.charCodeAt(0));
            const write = navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
            await Promise.race([write, new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard')), 1000))]);
            return true;
          }, buffer.toString('base64'));
        } catch { added = false; }
        if (added) {
          await ip.locator(ui('textarea[name="pin-note"]')).press('Control+V');
          try { await ip.locator(ui('.popup .thumb')).waitFor({ timeout: 800 }); } catch { added = false; }
        }
        if (!added || await ip.locator(ui('.popup .thumb')).count() === 0) await pickImage('button.add-image', buffer);
        assert.equal(await ip.locator(ui('.popup .thumb')).count(), 1, 'one thumbnail');
      }
      await ip.evaluate(() => { __fake.reset(); localStorage.removeItem('onspot-harness-storage'); __fake.delay = 30; });
      await ip.reload(); await visible(ip, '.capsule');
      await ip.locator(ui('.pin-button')).click(); await pick(ip, '#target'); await visible(ip, '.popup');
      await ip.locator(ui('textarea[name="pin-note"]')).fill('Make the heading blue.');
      const untrusted = await ip.evaluate(() => {
        const box = document.querySelector('on-spot').shadowRoot.querySelector('textarea[name="pin-note"]');
        const file = new File([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 1)], 'x.png', { type: 'image/png' });
        const data = new DataTransfer();
        data.items.add(file);
        let event;
        try { event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }); }
        catch { event = new ClipboardEvent('paste', { bubbles: true, cancelable: true }); }
        try { Object.defineProperty(event, 'clipboardData', { value: data }); } catch { /* the browser sealed clipboardData */ }
        box.dispatchEvent(event);
        return event.isTrusted;
      });
      assert.equal(untrusted, false, 'a script-made paste is not trusted');
      assert.equal(await ip.locator(ui('.thumb')).count(), 0, 'an untrusted paste adds nothing');
      assert.equal(await ip.evaluate(() => __fake.calls.some(call => call.t === 'upload')), false);
      await ip.evaluate(() => { __fake.delay = 2500; });
      await addNoteImage(pinPng);
      await waitFor(ip, () => document.querySelector('on-spot').shadowRoot.querySelector('.popup .thumb')?.getAttribute('aria-busy') === 'true');
      await ip.locator(ui('textarea[name="pin-note"]')).press('Enter');
      await waitFor(ip, () => document.querySelector('on-spot').shadowRoot.querySelector('#onspot-note-error')?.textContent === 'Wait until the image is uploaded.');
      assert.equal(await ip.locator(ui('.popup')).isVisible(), true, 'Enter during an upload keeps the popup open');
      await ip.evaluate(() => { __fake.delay = 30; });
      await waitFor(ip, () => {
        const thumb = document.querySelector('on-spot').shadowRoot.querySelector('.popup .thumb');
        return thumb?.getAttribute('aria-busy') === 'false' && thumb.querySelector('canvas')?.width > 0;
      });
      await ip.locator(ui('button[title="Remove image 1"]')).click();
      await waitFor(ip, () => document.querySelector('on-spot').shadowRoot.querySelectorAll('.popup .thumb').length === 0);
      await pickImage('button.add-image', pinPng);
      await waitFor(ip, () => {
        const thumb = document.querySelector('on-spot').shadowRoot.querySelector('.popup .thumb');
        return thumb?.getAttribute('aria-busy') === 'false' && thumb.querySelector('canvas')?.width > 0;
      });
      await ip.locator(ui('textarea[name="pin-note"]')).press('Enter');
      await gone(ip, '.popup');
      await visible(ip, '.marker[data-status="draft"]');
      const draft = await ip.evaluate(() => {
        const store = JSON.parse(localStorage.getItem('onspot-harness-storage'));
        return store['kog-pins:drafts:fixture.koglabs.com'].items[0].body;
      });
      assert.equal(draft.note, 'Make the heading blue.');
      assert.equal(draft.images.length, 1);
      assert.match(draft.images[0], imageIdRe);
      await ip.locator(ui('.marker[data-status="draft"]')).click(); await visible(ip, '.popup');
      await waitFor(ip, () => {
        const thumb = document.querySelector('on-spot').shadowRoot.querySelector('.popup .thumb');
        return thumb?.getAttribute('aria-busy') === 'false' && thumb.querySelector('canvas')?.width > 0;
      });
      assert.ok(await ip.evaluate(id => __fake.calls.some(call => call.t === 'image' && call.id === id), draft.images[0]), 'the edit popup fetches the image');
      await ip.locator(ui('textarea[name="draft-note"]')).press('Control+Enter');
      await marker(ip, 1, 'queued');
      const batch = await ip.evaluate(() => __fake.calls.filter(call => call.method === 'POST' && call.path === '/api/batches').at(-1));
      assert.equal(batch.body.pins.length, 1);
      assert.equal(batch.body.pins[0].note, 'Make the heading blue.');
      assert.deepEqual(batch.body.pins[0].images, draft.images);
      await ip.locator(ui('.marker[data-pin="1"]')).click(); await visible(ip, '.thread');
      const pinPixel = () => ip.evaluate(() => {
        const canvas = document.querySelector('on-spot').shadowRoot.querySelector('.panel-body > .images .shot canvas');
        return canvas && canvas.width === 40 ? [...canvas.getContext('2d').getImageData(20, 15, 1, 1).data] : null;
      });
      await waitFor(ip, () => document.querySelector('on-spot').shadowRoot.querySelector('.panel-body > .images .shot canvas')?.width === 40);
      assert.deepEqual(await pinPixel(), [20, 80, 200, 255], 'the pin image is drawn');
      const imageBoxes = () => ip.evaluate(() => {
        const root = document.querySelector('on-spot').shadowRoot;
        const body = root.querySelector('.panel-body').getBoundingClientRect();
        const shot = root.querySelector('.panel-body > .images .shot');
        const box = shot.getBoundingClientRect();
        return { body: body.width, width: box.width, full: shot.dataset.full, title: shot.title };
      });
      await ip.locator(ui('.panel-body > .images .shot')).click();
      let shown = await imageBoxes();
      assert.equal(shown.full, 'true');
      assert.equal(shown.title, 'Show the images in a row');
      assert.ok(shown.width >= shown.body - 26, `full width ${shown.width} of ${shown.body}`);
      await ip.locator(ui('.panel-body > .images .shot')).click();
      shown = await imageBoxes();
      assert.equal(shown.full, 'false');
      assert.equal(shown.title, 'Show image 1 at full width');
      assert.ok(shown.width < shown.body - 40, 'a second click goes back to the row');
      await waitFor(ip, () => {
        const button = document.querySelector('on-spot').shadowRoot.querySelector('.reply-form button.add-image');
        return button && !button.disabled;
      });
      await pickImage('.reply-form button.add-image', replyPng);
      await waitFor(ip, () => {
        const thumb = document.querySelector('on-spot').shadowRoot.querySelector('.reply-form .thumb');
        return thumb?.getAttribute('aria-busy') === 'false' && thumb.querySelector('canvas')?.width > 0;
      });
      await ip.locator(ui('button[title="Send your reply"]')).click();
      await waitFor(ip, () => document.querySelector('on-spot').shadowRoot.querySelector('.reply .images canvas')?.width === 40);
      const replyCall = await ip.evaluate(() => __fake.calls.filter(call => call.method === 'POST' && call.path === '/api/pins/1/replies').at(-1));
      assert.equal(replyCall.body.body, 'See the attached image.');
      assert.equal(replyCall.body.images.length, 1);
      assert.match(replyCall.body.images[0], imageIdRe);
      assert.notEqual(replyCall.body.images[0], draft.images[0]);
      assert.deepEqual(await ip.evaluate(() => {
        const canvas = document.querySelector('on-spot').shadowRoot.querySelector('.reply .images canvas');
        return [...canvas.getContext('2d').getImageData(20, 15, 1, 1).data];
      }), [200, 160, 20, 255], 'the reply image is drawn');
      assert.deepEqual(await pinPixel(), [20, 80, 200, 255], 'the pin image stays');
      assert.equal(await ip.locator(ui('img')).count(), 0, 'no image element');
      await screenshot(ip, name, 'images');
      await clean(ip, imagesPage.issues); await ip.close();
      pass('images: paste or pick, thumbnail, remove, submit sends ids, an untrusted paste adds nothing, the card shows the pin image and a reply image');

      // Go back (0.6.0): the version choice in the card of a closed pin, and the labels of a go back.
      const backPage = await freshPage(context, '/back'); activePage = backPage.page;
      const gp = backPage.page;
      const V = ['a1b2c3d4e5f60718', 'b2c3d4e5f6071829', 'c3d4e5f60718293a'];
      await gp.evaluate(V => {
        __fake.reset(); localStorage.removeItem('onspot-harness-storage');
        const target = { selector: '#target', label: 'h1 "Make room"', rect: { x: 100, y: 100, w: 500, h: 50 } };
        const at = new Date().toISOString(), v = (i, summary) => ({ commit: V[i], summary, at }), first = v(0, 'Title margin 48px to 24px');
        for (const [note, fields] of [
          ['No fix commit.', { status: 'done', summary: 'Nothing to ship.', closedAt: at }],
          ['One fix.', { status: 'done', summary: first.summary, commit: V[0], versions: [first], closedAt: at }],
          ['Three fixes.', { status: 'done', summary: 'Title font 600', commit: V[2], versions: [first, v(1, 'Title colour green'), v(2, 'Title font 600')], closedAt: at }],
          ['Dismissed after a fix.', { status: 'dismissed', summary: 'Not needed.', versions: [first], closedAt: at }],
          ['Go back, please.', { status: 'queued', versions: [first], revert: { commits: [V[0]], at, attempts: 1 } }],
          ['Went back.', { status: 'done', summary: 'Undid a1b2c3d.', commit: 'd4e5f60', revertedAt: at, closedAt: at }],
        ]) __fake.update(__fake.seed({ url: `${location.origin}/back`, note, targets: [target] }).id, { agent: 'claude', model: 'opus 5.5 high', attempts: 1, ...fields });
      }, V);
      await gp.reload(); await visible(gp, '.capsule'); await marker(gp, 5);
      const openBy = async id => {
        await gp.evaluate(id => { location.hash = `#kog-pin=${id}`; }, id);
        await waitFor(gp, id => location.hash === '' && document.querySelector('on-spot').shadowRoot.querySelector('.thread .panel-title')?.textContent === `Pin ${id}`, id);
      };
      const backView = () => gp.evaluate(() => {
        const card = document.querySelector('on-spot').shadowRoot.querySelector('.thread');
        const shown = sel => { const node = card.querySelector(sel); return node && !node.closest('[hidden]') ? node : null; };
        const box = shown('.go-back');
        return { button: Boolean(shown('button[title="Go back to an earlier version of this element"]')), tag: shown('.revert-tag')?.textContent ?? null, edit: Boolean(shown('button[title="Edit this note"]')),
          panel: box && { now: box.querySelector('.detail')?.textContent ?? null, ask: box.querySelector('legend, p:not(.detail)').textContent, options: [...box.querySelectorAll('label')].map(node => [node.textContent, node.querySelector('input').checked]) } };
      });
      const activeIn = () => gp.evaluate(() => { const node = document.querySelector('on-spot').shadowRoot.activeElement; return node ? node.title || `${node.type}:${node.value}:${node.checked}` : ''; });
      const opener = gp.locator(ui('button[title="Go back to an earlier version of this element"]')), submitBack = gp.locator(ui('button[title="Start a run that ships the chosen version"]'));
      const revertCalls = id => gp.evaluate(id => __fake.calls.filter(call => call.path === `/api/pins/${id}/revert`).map(({ method, body }) => [method, body]), id);
      const none = { button: false, tag: null, edit: false, panel: null };
      for (const [id, expected] of [[1, none], [2, { ...none, button: true }], [4, { ...none, button: true }], [5, { ...none, tag: 'Going back' }], [6, { ...none, tag: 'Reverted' }]]) {
        await openBy(id); assert.deepEqual(await backView(), expected, `pin ${id}`);
      }
      assert.equal(await shadowText(gp, '.thread .status'), 'Done');
      await openBy(5);
      assert.equal(await shadowText(gp, '.thread .status'), 'Queued again');
      assert.equal(await gp.locator(ui('button[title="Dismiss this pin"]')).isVisible(), true, 'Dismiss cancels the go back');
      await gp.evaluate(() => __fake.update(5, { revert: null }));
      await waitFor(gp, () => !document.querySelector('on-spot').shadowRoot.querySelector('.thread button[title="Edit this note"]').hidden);
      assert.deepEqual(await backView(), { ...none, edit: true }, 'without the go back the queued card has Edit again');
      await gp.evaluate(V => __fake.update(5, { revert: { commits: [V[0]], at: new Date().toISOString(), attempts: 1 } }), V);
      await waitFor(gp, () => document.querySelector('on-spot').shadowRoot.querySelector('.thread button[title="Edit this note"]').hidden);
      pass('Go back shows only on a done or dismissed card with a version and no go back; "Going back" hides Edit; a done card after a go back says "Reverted"');

      await openBy(2); await opener.click();
      assert.deepEqual(await backView(), { ...none, panel: { now: null, ask: 'Go back to the page before this pin? An agent undoes a1b2c3d and ships the old version.', options: [] } });
      assert.equal(await activeIn(), 'Start a run that ships the chosen version');
      await screenshot(gp, name, 'go-back-one');
      await gp.locator(ui('button[title="Keep the version that is live now"]')).click();
      assert.deepEqual(await backView(), { ...none, button: true }); assert.equal(await activeIn(), 'Go back to an earlier version of this element');
      await opener.click(); await gp.keyboard.press('Escape');
      assert.deepEqual(await backView(), { ...none, button: true }, 'Esc closes the panel'); assert.equal(await gp.locator(ui('.thread')).isVisible(), true, 'and keeps the card');
      const reply = gp.locator(ui('textarea[name="pin-reply"]')), confirmDelete = gp.locator(ui('button[title="Confirm deletion of this pin"]'));
      await opener.click(); await gp.locator(ui('button[title="Send this pin back for another fix"]')).click();
      assert.deepEqual([(await backView()).panel, await reply.isVisible()], [null, true], 'Not right closes the panel');
      await opener.click();
      assert.deepEqual([Boolean((await backView()).panel), await reply.isVisible()], [true, false], 'Go back closes the Not right box');
      await gp.locator(ui('button[title="Delete this pin"]')).click();
      assert.deepEqual([(await backView()).panel, await confirmDelete.isVisible()], [null, true], 'the Delete confirm closes the panel');
      await opener.click();
      assert.deepEqual([Boolean((await backView()).panel), await confirmDelete.isVisible()], [true, false], 'Go back closes the Delete confirm');
      assert.deepEqual(await revertCalls(2), [], 'nothing is sent before Go back');
      pass('Go back with one version: one question names the fix; Keep and Esc close the panel, not the card; it, the Not right box and the Delete confirm close each other');

      await gp.evaluate(() => { __fake.delay = 300; });
      await submitBack.click();
      assert.equal(await submitBack.isDisabled(), true, 'Go back is disabled while the call runs');
      await waitFor(gp, () => document.querySelector('on-spot').shadowRoot.querySelector('.thread .status')?.textContent === 'Queued again');
      await gp.evaluate(() => { __fake.delay = 30; });
      assert.deepEqual(await revertCalls(2), [['POST', { commit: V[0] }]]);
      assert.deepEqual(await backView(), { ...none, tag: 'Going back' });
      assert.deepEqual(await gp.evaluate(() => { const pin = __fake.db.pins.find(item => item.id === 2); return [pin.status, pin.revert.commits]; }), ['queued', [V[0]]]);
      await marker(gp, 2, 'queued');
      pass('"Before this pin" sends POST /api/pins/2/revert { commit: versions[0] }; Go back is disabled while it runs; the card shows the queued pin with "Going back"');

      await openBy(3); await opener.click();
      assert.deepEqual((await backView()).panel, { now: 'Now: fix 3 · c3d4e5f · Title font 600', ask: 'Go back to which version?', options: [
        ['After fix 2 · b2c3d4e · Title colour green', false], ['After fix 1 · a1b2c3d · Title margin 48px to 24px', false], ['Before this pin (the page before any fix)', true]] });
      assert.equal(await activeIn(), `radio:${V[0]}:true`, 'the focus is on the default choice');
      for (const label of ['After fix 2 · b2c3d4e · Title colour green', 'After fix 1 · a1b2c3d · Title margin 48px to 24px', 'Before this pin (the page before any fix)']) {
        assert.equal(await gp.getByRole('radio', { name: label, exact: true }).count(), 1, `a screen reader reads "${label}"`);
      }
      await gp.keyboard.press('ArrowUp');
      assert.equal(await activeIn(), `radio:${V[1]}:true`, 'an arrow key picks the next newer version');
      assert.deepEqual((await backView()).panel.options.map(([, checked]) => checked), [false, true, false]);
      await gp.keyboard.press('Tab'); await gp.keyboard.press('Tab');
      assert.equal(await activeIn(), 'Start a run that ships the chosen version', 'Tab goes on to Keep, then Go back');
      await screenshot(gp, name, 'go-back-three');
      pass('Go back with three versions: the "Now:" line, the choices newest first, "Before this pin" as the default; each radio has its name and the keys reach it');

      await gp.evaluate(() => __fake.failNext('POST', '/api/pins/3/revert', 409, 'That commit is not a version of this pin.'));
      await submitBack.click();
      await waitFor(gp, () => document.querySelector('on-spot').shadowRoot.querySelector('#onspot-card-error')?.textContent === 'That commit is not a version of this pin.');
      assert.equal(await shadowText(gp, '.thread .status'), 'Done');
      assert.deepEqual((await backView()).panel?.options.map(([, checked]) => checked), [false, true, false], 'the panel stays open with the choice');
      assert.equal(await submitBack.isDisabled(), false, 'Go back can be tried again');
      await submitBack.click();
      await waitFor(gp, () => document.querySelector('on-spot').shadowRoot.querySelector('.thread .status')?.textContent === 'Queued again');
      assert.deepEqual(await revertCalls(3), [['POST', { commit: V[1] }], ['POST', { commit: V[1] }]], '"After fix 1" undoes versions[1] and every later fix');
      assert.deepEqual(await backView(), { ...none, tag: 'Going back' });
      assert.equal(await gp.locator(ui('#onspot-card-error')).isVisible(), false);
      assert.deepEqual(await gp.evaluate(() => __fake.db.pins.find(item => item.id === 3).revert.commits), [V[2], V[1]]);
      await gp.keyboard.press('Escape'); await gone(gp, '.thread');
      pass('a failed go back shows the reason in the card and keeps the panel open; "After fix 1" sends POST /api/pins/3/revert { commit: versions[1] }');

      const toastTitle = kind => gp.evaluate(kind => document.querySelector('on-spot').shadowRoot.querySelector(`.toast[data-kind="${kind}"] .toast-title`)?.textContent ?? null, kind);
      await gp.evaluate(() => __fake.update(5, { status: 'working', run: 'triad:77', startedAt: new Date().toISOString() }));
      await waitFor(gp, () => document.querySelector('on-spot').shadowRoot.querySelector('.toast[data-kind="working"]'));
      assert.equal(await toastTitle('working'), 'Going back #5 · Opus 5.5 high');
      await gp.evaluate(() => { const at = new Date().toISOString(); __fake.update(5, { status: 'done', summary: 'Undid a1b2c3d.', commit: 'e5f6071', revert: null, revertedAt: at, versions: [], closedAt: at }); });
      await waitFor(gp, () => document.querySelector('on-spot').shadowRoot.querySelector('.toast[data-kind="done"]'));
      assert.equal(await toastTitle('done'), 'Back to the earlier version · #5');
      await openMenu(gp); await gp.locator(ui('.log-button')).click(); await visible(gp, '.log');
      await waitFor(gp, () => document.querySelector('on-spot').shadowRoot.querySelectorAll('.log .log-row').length === 6);
      assert.deepEqual(await gp.evaluate(() => [...document.querySelector('on-spot').shadowRoot.querySelectorAll('.log-row')].map(row => `${row.dataset.key} ${row.querySelector('.chip').textContent}`)),
        ['6 Reverted', '5 Reverted', '4 Dismissed', '3 Going back', '2 Going back', '1 Done']);
      await screenshot(gp, name, 'go-back-log');
      await gp.keyboard.press('Escape'); await gone(gp, '.log');
      await clean(gp, backPage.issues); await gp.close();
      pass('a revert run toast says "Going back #5 · Opus 5.5 high" and its done toast "Back to the earlier version · #5"; the Log chips say "Going back" and "Reverted"');

      // Bulk mode: server settings in the Settings sheet, and a chip in the tray.
      const bulkPage = await freshPage(context, '/bulk'); activePage = bulkPage.page;
      const bp = bulkPage.page;
      const settingsCalls = () => bp.evaluate(() => __fake.calls.filter(call => call.path === '/api/settings').map(({ method, body }) => body ? [method, body] : [method]));
      const bulkView = () => bp.evaluate(() => {
        const q = sel => document.querySelector('on-spot').shadowRoot.querySelector(`.sheet .bulk ${sel}`);
        const on = q('button[aria-label="Bulk mode"]'), delegate = q('button[aria-label="Delegate"]'), count = q('.count'), error = q('.error');
        return { on: [on.getAttribute('aria-checked'), on.title], delegate: [delegate.getAttribute('aria-checked'), delegate.title], agents: [count.getAttribute('aria-valuenow'), count.textContent],
          fewer: q('button[title="Fewer agents"]').disabled, more: q('button[title="More agents"]').disabled, off: count.closest('.row').dataset.off, error: error.hidden ? '' : error.textContent };
      });
      const chip = () => bp.evaluate(() => { const node = document.querySelector('on-spot').shadowRoot.querySelector('.bulk-chip'); return node.hidden ? null : node.textContent; });
      await bp.evaluate(() => { __fake.reset(); localStorage.removeItem('onspot-harness-storage'); });
      await bp.reload(); await visible(bp, '.capsule'); await delay(100);
      assert.deepEqual(await settingsCalls(), [], 'no settings read before the first interaction');
      await toggle(bp); await visible(bp, '.overlay');
      await waitFor(bp, () => __fake.calls.some(call => call.path === '/api/settings')); await delay(60);
      assert.equal(await chip(), null, 'bulk off: no chip');
      await bp.keyboard.press('Escape'); await gone(bp, '.overlay');
      await toggle(bp); await visible(bp, '.overlay'); await bp.keyboard.press('Escape'); await gone(bp, '.overlay');
      assert.deepEqual(await settingsCalls(), [['GET']], 'pin mode reads the settings once, at its first start');
      await openMenu(bp); await bp.locator(ui('button[title^="Open Settings"]')).click(); await visible(bp, '.sheet');
      await visible(bp, '.sheet button[aria-label="Bulk mode"][aria-checked="false"]');
      assert.deepEqual(await settingsCalls(), [['GET'], ['GET']], 'the sheet reads them each time it opens');
      assert.deepEqual(await bulkView(), { on: ['false', 'Turn bulk mode on'], delegate: ['false', 'Turn delegation on'], agents: ['3', '3'], fewer: true, more: true, off: 'true', error: '' });
      const sizes = await bp.evaluate(() => [...document.querySelector('on-spot').shadowRoot.querySelectorAll('.sheet .bulk button, .sheet .bulk .count')].map(node => { const box = node.getBoundingClientRect(); return Math.min(box.width, box.height); }));
      assert.ok(sizes.length === 5 && sizes.every(size => size >= 32), `bulk hit areas ${sizes}`);
      await bp.locator(ui('button[title="Turn bulk mode on"]')).click();
      await bp.locator(ui('button[title="Turn delegation on"]')).click();
      await waitFor(bp, () => !document.querySelector('on-spot').shadowRoot.querySelector('.sheet button[title="More agents"]').disabled);
      for (let index = 0; index < 5; index++) await bp.locator(ui('button[title="More agents"]')).click();
      assert.equal(await bp.evaluate(() => document.querySelector('on-spot').shadowRoot.activeElement?.className), 'count', 'at 8 the focus moves from + to the value');
      await bp.keyboard.press('Home'); await waitFor(bp, () => document.querySelector('on-spot').shadowRoot.querySelector('.sheet .count').textContent === '1');
      await bp.keyboard.press('ArrowDown'); await bp.keyboard.press('ArrowUp');
      await waitFor(bp, () => __fake.db.settings.bulk.agents === 2); await delay(100);
      assert.deepEqual((await settingsCalls()).filter(([method]) => method === 'PATCH').map(([, body]) => body),
        [{ bulk: { on: true } }, { bulk: { delegate: true } }, ...[4, 5, 6, 7, 8, 1, 2].map(agents => ({ bulk: { agents } }))], 'one PATCH per change with only the changed key; no step below 1 or above 8');
      assert.deepEqual(await bulkView(), { on: ['true', 'Turn bulk mode off'], delegate: ['true', 'Turn delegation off'], agents: ['2', '2'], fewer: false, more: false, off: 'false', error: '' });
      await screenshot(bp, name, 'settings-bulk');
      await bp.evaluate(() => { __fake.delay = 300; __fake.failNext('PATCH', '/api/settings', 503, 'Try again later'); });
      await bp.locator(ui('button[title="Turn delegation off"]')).click();
      assert.deepEqual((await bulkView()).delegate, ['false', 'Turn delegation on'], 'the change shows at once');
      await waitFor(bp, () => document.querySelector('on-spot').shadowRoot.querySelector('#onspot-bulk-error')?.textContent === 'Try again later');
      assert.deepEqual((await bulkView()).delegate, ['true', 'Turn delegation off'], 'an error puts the old value back');
      await bp.evaluate(() => { __fake.delay = 30; });
      assert.equal(await bp.evaluate(() => __fake.db.settings.bulk.delegate), true);
      const refused = await bp.evaluate(() => Promise.all([{ bulk: { agents: 9 } }, { bulk: { agents: 0 } }, { bulk: { agents: 2.5 } }, { bulk: { on: 'yes' } }, { bulk: { colour: 'blue' } }, { theme: 'dark' }, { autofix: 1 }, { bulk: [] }]
        .map(body => chrome.runtime.sendMessage({ t: 'api', method: 'PATCH', path: '/api/settings', body }).then(answer => answer.status))));
      assert.deepEqual(refused, Array(8).fill(400));
      assert.equal((await bp.evaluate(() => chrome.runtime.sendMessage({ t: 'api', method: 'DELETE', path: '/api/settings' }))).status, 400);
      const merged = await bp.evaluate(() => chrome.runtime.sendMessage({ t: 'api', method: 'PATCH', path: '/api/settings', body: { autofix: false } }));
      assert.deepEqual(merged.data, { autofix: false, bulk: { on: true, delegate: true, agents: 2 } }, 'a refused change changes nothing; autofix alone keeps bulk');
      await bp.evaluate(() => __fake.push({ t: 'resync' }));
      await waitFor(bp, () => __fake.calls.filter(call => call.path === '/api/settings' && call.method === 'GET').length === 3);
      pass('Settings bulk mode: switches and the 1-8 stepper send one PATCH each, show the change at once, put the old value back on an error; resync reads again');

      await bp.keyboard.press('Escape'); await gone(bp, '.sheet');
      await toggle(bp); await visible(bp, '.tray');
      await waitFor(bp, () => document.querySelector('on-spot').shadowRoot.querySelector('.bulk-chip')?.textContent === 'Bulk · 2 agents');
      await bp.evaluate(() => __fake.settings({ delegate: false }));
      await waitFor(bp, () => !document.querySelector('on-spot').shadowRoot.querySelector('.bulk-chip').hidden && document.querySelector('on-spot').shadowRoot.querySelector('.bulk-chip').textContent === 'Bulk');
      await bp.evaluate(() => __fake.settings({ delegate: true, agents: 3 }));
      await waitFor(bp, () => document.querySelector('on-spot').shadowRoot.querySelector('.bulk-chip').textContent === 'Bulk · 3 agents');
      await pick(bp, '#target'); await note(bp, 'One agent takes this batch.');
      await waitTray(bp, '1 pin ready');
      assert.equal(await chip(), 'Bulk · 3 agents');
      await screenshot(bp, name, 'tray-bulk');
      await bp.evaluate(() => __fake.settings({ on: false }));
      await waitFor(bp, () => document.querySelector('on-spot').shadowRoot.querySelector('.bulk-chip').hidden);
      await bp.evaluate(() => __fake.settings({ on: true }));
      await waitFor(bp, () => !document.querySelector('on-spot').shadowRoot.querySelector('.bulk-chip').hidden);
      await bp.evaluate(() => __fake.state('offline'));
      assert.equal(await chip(), null, 'offline: the state is unknown, no chip');
      await bp.keyboard.press('Escape'); await gone(bp, '.overlay');
      await openMenu(bp); await bp.locator(ui('button[title^="Open Settings"]')).click(); await visible(bp, '.sheet');
      assert.equal(await shadowText(bp, '.sheet .bulk > p.row-text'), 'Bulk mode needs a connection');
      assert.equal(await bp.locator(ui('.sheet button[aria-label="Bulk mode"]')).isVisible(), false, 'no switches while unknown');
      await screenshot(bp, name, 'settings-bulk-offline');
      await bp.evaluate(() => __fake.state('live'));
      await visible(bp, '.sheet button[aria-label="Bulk mode"][aria-checked="true"]'); await gone(bp, '.sheet .bulk > p.row-text');
      await bp.evaluate(() => __fake.state('login')); await gone(bp, '.sheet button[aria-label="Bulk mode"]');
      await bp.evaluate(() => __fake.state('live'));
      await bp.keyboard.press('Escape'); await gone(bp, '.sheet');
      await bp.setViewportSize({ width: 375, height: 812 });
      await waitFor(bp, () => !document.querySelector('on-spot').shadowRoot.querySelector('.bulk-chip').hidden);
      const narrowTray = await bp.evaluate(() => [...document.querySelector('on-spot').shadowRoot.querySelectorAll('.tray > :not([hidden])')].map(node => { const box = node.getBoundingClientRect(); return [node.className, box.left >= 0 && box.right <= 375]; }));
      assert.ok(narrowTray.every(([, fits]) => fits) && narrowTray.some(([name]) => name.includes('bulk-chip')), JSON.stringify(narrowTray));
      await screenshot(bp, name, 'narrow-tray-bulk');
      await clean(bp, bulkPage.issues); await bp.close();
      pass('tray chip "Bulk" and "Bulk · 3 agents" follow live settings events; offline and login show "needs a connection"; the chip fits at 375 px');

      // Shortcuts: the defaults, the eye state per host, the Settings section, and what the page gets.
      const keysPage = await freshPage(context, '/keys'); activePage = keysPage.page;
      const kp = keysPage.page;
      const hiddenKey = 'kog-pins:hidden:fixture.koglabs.com';
      await kp.evaluate(() => {
        __fake.reset(); localStorage.removeItem('onspot-harness-storage');
        for (const [selector, note] of [['#target', 'First pin.'], ['#second-target', 'Second pin.']]) __fake.seed({ url: `${location.origin}/keys`, note, targets: [{ selector, label: 'p', rect: { x: 1, y: 1, w: 1, h: 1 } }] });
      });
      await kp.reload(); await visible(kp, '.capsule'); await marker(kp, 1); await marker(kp, 2);
      const eyeOf = page => page.evaluate(() => { const node = document.querySelector('on-spot').shadowRoot.querySelector('.capsule button:nth-of-type(2)'); return [node.title, node.getAttribute('aria-pressed'), node.querySelectorAll('path').length]; });
      const eye = () => eyeOf(kp);
      const said = () => kp.evaluate(() => document.querySelector('on-spot').shadowRoot.querySelector('.sr-only').textContent);
      const pageKeys = () => kp.evaluate(() => __metrics.pageKeys.splice(0));
      const hiddenStored = value => waitFor(kp, ([key, wanted]) => __fake.storage()[key] === (wanted ?? undefined), [hiddenKey, value]);
      assert.deepEqual(await eye(), ['Hide markers (Ctrl+K)', 'false', 2]);
      await kp.keyboard.press('Control+KeyK'); await gone(kp, '.marker');
      assert.deepEqual(await eye(), ['Show markers (Ctrl+K)', 'true', 3]);
      assert.equal(await said(), 'Markers hidden');
      await hiddenStored(true);
      assert.deepEqual(await pageKeys(), [], 'the page does not get the matched key');
      for (const combo of ['Control+Shift+KeyK', 'Alt+KeyK', 'Control+Alt+KeyK', 'Meta+KeyK', 'KeyK']) await kp.keyboard.press(combo);
      await delay(60);
      assert.deepEqual(await eye(), ['Show markers (Ctrl+K)', 'true', 3], 'only the exact modifier set matches');
      assert.deepEqual(await pageKeys(), ['Ctrl+Shift+KeyK', 'Alt+KeyK', 'Ctrl+Alt+KeyK', 'Meta+KeyK', 'KeyK']);
      await kp.reload(); await visible(kp, '.capsule');
      await waitFor(kp, () => document.querySelector('on-spot').shadowRoot.querySelector('.badge').textContent === '2');
      assert.deepEqual(await eye(), ['Show markers (Ctrl+K)', 'true', 3], 'the eye state survives a reload');
      assert.equal(await kp.locator(ui('.marker')).count(), 0);
      await kp.keyboard.press('Control+KeyK'); await marker(kp, 1); await marker(kp, 2);
      assert.deepEqual(await eye(), ['Hide markers (Ctrl+K)', 'false', 2]); assert.equal(await said(), 'Markers shown');
      await hiddenStored();
      await kp.evaluate(key => chrome.storage.local.set({ [key]: true }), hiddenKey); await gone(kp, '.marker');
      assert.equal((await eye())[1], 'true', 'the eye of another tab of this host arrives');
      await kp.evaluate(key => chrome.storage.local.remove(key), hiddenKey); await marker(kp, 1);
      assert.equal((await eye())[1], 'false');
      await kp.locator(ui('.capsule button[title^="Hide markers"]')).click(); await gone(kp, '.marker'); await hiddenStored(true);
      await kp.locator(ui('.capsule button[title^="Show markers"]')).click(); await marker(kp, 1); await hiddenStored();
      pass('Ctrl+K (⌘K on a Mac) hides and shows the markers and the Eye button follows; the state is stored per host, survives a reload and follows another tab');

      await kp.locator('#page-input').focus(); await pageKeys();
      await kp.keyboard.type('ok'); await kp.keyboard.press('Control+Period'); await kp.keyboard.press('Alt+Shift+KeyZ');
      assert.deepEqual(await pageKeys(), ['KeyO', 'KeyK', 'Ctrl+Period', 'Alt+Shift+KeyZ'], 'keys without a matching combo reach the page');
      assert.equal(await kp.locator('#page-input').inputValue(), 'ok');
      await kp.keyboard.press('Control+KeyK'); await gone(kp, '.marker');
      await kp.keyboard.press('Control+KeyM'); await visible(kp, '.overlay');
      await kp.keyboard.press('Control+KeyM'); await gone(kp, '.overlay');
      assert.equal(await kp.evaluate(() => document.activeElement.id), 'page-input', 'the focus goes back to the page field');
      await kp.keyboard.press('Control+KeyK'); await marker(kp, 1);
      assert.deepEqual(await pageKeys(), [], 'a matched key never reaches the page');
      assert.equal(await kp.locator('#page-input').inputValue(), 'ok');
      await kp.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); }); // the field sits at the end of the page
      pass('a key typed in a page field without a matching combo reaches the page; a matched key does not');

      const expanded = () => kp.locator(ui('.menu-button')).getAttribute('aria-expanded');
      await kp.keyboard.press('Alt+Shift+KeyM'); await visible(kp, '.menu'); assert.equal(await expanded(), 'true');
      assert.equal(await kp.locator(ui('.menu-button')).getAttribute('title'), 'Close the menu (Alt+Shift+M)');
      await kp.keyboard.press('Alt+Shift+KeyM'); await gone(kp, '.menu'); assert.equal(await expanded(), 'false');
      assert.equal(await kp.locator(ui('.menu-button')).getAttribute('title'), 'Open the menu (Alt+Shift+M)');
      await kp.keyboard.press('Alt+Shift+KeyL'); await visible(kp, '.log');
      await kp.keyboard.press('Alt+Shift+KeyL'); await gone(kp, '.log');
      await kp.keyboard.press('Alt+Shift+KeyF');
      await waitFor(kp, () => document.querySelector('#animation').getAnimations().every(animation => animation.playState === 'paused'));
      assert.equal(await kp.evaluate(() => document.querySelector('on-spot').shadowRoot.querySelector('.menu button[title="Resume page animations (Alt+Shift+F)"]')?.getAttribute('aria-pressed')), 'true');
      await kp.keyboard.press('Alt+Shift+KeyF');
      await waitFor(kp, () => document.querySelector('#animation').getAnimations()[0].playState === 'running');
      const [queueTab] = await Promise.all([context.waitForEvent('page'), kp.keyboard.press('Alt+Shift+KeyQ')]);
      await queueTab.waitForLoadState();
      assert.equal(queueTab.url(), 'https://ai.koglabs.com/triad?tab=pins&host=fixture.koglabs.com');
      assert.equal(await queueTab.evaluate(() => window.opener), null, 'the queue tab has no opener');
      await queueTab.close(); await kp.bringToFront();
      await kp.keyboard.press('Alt+Shift+KeyS'); await visible(kp, '.sheet');
      await kp.keyboard.press('Alt+Shift+KeyS'); await gone(kp, '.sheet');
      assert.deepEqual(await pageKeys(), []);
      pass('the default shortcuts open and close the menu, the Log and Settings, pause the animations and open the queue in a new tab');

      await kp.keyboard.press('Alt+Shift+KeyS'); await visible(kp, '.sheet');
      const keyRowsOf = page => page.evaluate(() => [...document.querySelector('on-spot').shadowRoot.querySelectorAll('.sheet .row')].filter(node => node.querySelector('kbd')).map(node => `${node.querySelector('.row-label span').textContent}: ${node.querySelector('kbd').textContent}`));
      const keyRows = () => keyRowsOf(kp);
      const keyCount = () => kp.evaluate(() => [...document.querySelector('on-spot').shadowRoot.querySelectorAll('.sheet .sheet-title')].find(node => node.firstChild.data === 'Shortcuts').querySelector('span').textContent);
      const focusOf = page => page.evaluate(() => { const node = document.querySelector('on-spot').shadowRoot.activeElement; return node?.title || node?.name || ''; });
      const focused = () => focusOf(kp);
      const keyErrorOf = page => page.evaluate(() => { const node = document.querySelector('on-spot').shadowRoot.querySelector('#onspot-key-error'); return node.hidden ? '' : node.textContent; });
      const keyError = () => keyErrorOf(kp);
      const field = kp.locator(ui('input[name="shortcut-keys"]')), save = kp.locator(ui('button[title="Save this shortcut"]'));
      const reset = 'button[title="Put the default shortcuts back"]';
      const defaults = ['Toggle pin mode: Ctrl+M', 'Hide or show markers: Ctrl+K', 'Open or close the menu: Alt+Shift+M', 'Open or close the Log: Alt+Shift+L', 'Open or close Settings: Alt+Shift+S', 'Pause or resume page animations: Alt+Shift+F', 'Open the queue: Alt+Shift+Q'];
      assert.deepEqual(await keyRows(), defaults); assert.equal(await keyCount(), '7/24');
      assert.equal(await kp.locator(ui(reset)).count(), 0, 'no reset while the list is the default');
      assert.equal(await shadowText(kp, '.sheet .fixed-keys'), 'Fixed keys: ↵ adds the pin, Ctrl+↵ submits all, Shift+↵ starts a new line, Esc closes, Alt+1 to Alt+6 pick the About tab. Alt+Shift+P also toggles pin mode: change it in the browser.');
      await kp.locator(ui('button[title="Add a shortcut"]')).click();
      assert.equal(await focused(), 'shortcut-action');
      assert.deepEqual(await kp.evaluate(() => [...document.querySelector('on-spot').shadowRoot.querySelectorAll('select[name="shortcut-action"] option')].map(node => node.textContent)),
        ['Choose an action', 'Toggle pin mode', 'Hide or show markers', 'Open or close the menu', 'Open or close the Log', 'Open or close Settings', 'Pause or resume page animations', 'Open the queue', 'Submit all']);
      await save.click(); assert.equal(await keyError(), 'Choose an action.'); assert.equal(await focused(), 'shortcut-action');
      await kp.locator(ui('select[name="shortcut-action"]')).selectOption('submit');
      await save.click(); assert.equal(await keyError(), 'Press the keys first.'); assert.equal(await focused(), 'shortcut-keys');
      assert.equal(await field.getAttribute('placeholder'), 'Press the keys');
      await pageKeys();
      for (const [combo, shown, reason] of [['KeyJ', 'J', 'Add Ctrl or Alt to the key.'], ['Alt+ArrowUp', 'Alt+ArrowUp', 'That key cannot be a shortcut.'], ['Control+KeyC', 'Ctrl+C', 'The browser keeps that key.'],
        ['Alt+Digit3', 'Alt+3', 'Alt+1 to Alt+6 pick the About tabs.'], ['Control+KeyK', 'Ctrl+K', 'That key already does: Hide or show markers.'], ['Alt+Shift+KeyL', 'Alt+Shift+L', 'That key already does: Open or close the Log.']]) {
        await field.press(combo);
        assert.equal(await field.inputValue(), shown); assert.equal(await keyError(), '', 'a new key clears the reason');
        await save.click(); assert.equal(await keyError(), reason);
      }
      assert.deepEqual([(await eye())[1], await kp.locator(ui('.log')).count(), await kp.locator(ui('.marker')).count()], ['false', 0, 2], 'no shortcut fires while the key field records');
      assert.deepEqual(await pageKeys(), [], 'the page gets no recorded key');
      await field.press('Shift'); await field.press('Control'); await field.press('Alt');
      assert.equal(await field.inputValue(), 'Alt+Shift+L', 'a bare modifier records nothing');
      await field.press('Control+KeyJ'); assert.equal(await field.inputValue(), 'Ctrl+J');
      await save.click();
      assert.deepEqual(await keyRows(), [...defaults, 'Submit all: Ctrl+J']); assert.equal(await keyCount(), '8/24');
      assert.equal(await focused(), 'Edit the shortcut Ctrl+J: Submit all', 'the focus returns to the row');
      await visible(kp, `.sheet ${reset}`);
      await kp.keyboard.press('Escape'); await gone(kp, '.sheet');
      await kp.keyboard.press('Control+KeyJ'); assert.equal(await said(), 'No unsent pins.');
      await toggle(kp); await pick(kp, '#action-target'); await note(kp, 'Sent with my own shortcut.');
      await kp.keyboard.press('Escape'); await gone(kp, '.overlay');
      await kp.keyboard.press('Control+KeyJ'); await marker(kp, 3);
      assert.equal((await posts(kp)).length, 1, 'the new shortcut submits all at once');
      pass('Settings shortcuts: the form names each reason (no action, no key, no modifier, a key that cannot be one, a browser key, the About keys, a used key); no shortcut fires while the field records; a new shortcut works at once');

      await kp.keyboard.press('Alt+Shift+KeyS'); await visible(kp, '.sheet');
      await kp.locator(ui('button[title="Edit the shortcut Ctrl+K: Hide or show markers"]')).click();
      assert.equal(await kp.locator(ui('select[name="shortcut-action"]')).inputValue(), 'eye'); assert.equal(await field.inputValue(), 'Ctrl+K');
      await field.press('Control+Shift+KeyE'); await save.click();
      assert.equal((await keyRows())[1], 'Hide or show markers: Ctrl+Shift+E');
      assert.equal(await focused(), 'Edit the shortcut Ctrl+Shift+E: Hide or show markers');
      assert.equal((await eye())[0], 'Hide markers (Ctrl+Shift+E)', 'the button title follows');
      await kp.locator(ui('button[title="Remove the shortcut Ctrl+M: Toggle pin mode"]')).click();
      const changed = ['Hide or show markers: Ctrl+Shift+E', ...defaults.slice(2), 'Submit all: Ctrl+J'];
      assert.deepEqual(await keyRows(), changed);
      assert.equal(await focused(), 'Edit the shortcut Ctrl+Shift+E: Hide or show markers', 'after a removal the focus is on the row that took its place');
      assert.equal(await kp.locator(ui('.pin-button')).getAttribute('title'), 'Toggle pin mode', 'no key in the title when the action has none');
      await kp.locator(ui('button[title="Add a shortcut"]')).click(); await field.press('Alt+KeyX'); await kp.keyboard.press('Escape');
      await gone(kp, 'input[name="shortcut-keys"]'); await visible(kp, '.sheet');
      assert.equal(await focused(), 'Add a shortcut', 'Esc cancels the form and the sheet stays open');
      assert.deepEqual(await keyRows(), changed);
      await screenshot(kp, name, 'settings-shortcuts');
      await kp.keyboard.press('Escape'); await gone(kp, '.sheet');
      const works = async () => {
        await kp.keyboard.press('Control+KeyK'); await kp.keyboard.press('Control+KeyM'); await delay(60);
        assert.deepEqual([(await eye())[1], await kp.locator(ui('.overlay')).isVisible()], ['false', false], 'the old key and the removed default do nothing');
        await kp.keyboard.press('Control+Shift+KeyE'); await gone(kp, '.marker');
        await kp.keyboard.press('Control+Shift+KeyE'); await marker(kp, 1);
        await kp.keyboard.press('Control+KeyJ'); assert.equal(await said(), 'No unsent pins.');
      };
      await works();
      await kp.reload(); await visible(kp, '.capsule'); await marker(kp, 1);
      await works();
      assert.equal(await kp.locator(ui('.pin-button')).getAttribute('title'), 'Toggle pin mode', 'a removed default stays removed after a reload');
      assert.deepEqual(await kp.evaluate(() => __fake.storage()['kog-pins:prefs'].keys), [{ action: 'eye', combo: 'Mod+Shift+KeyE' }, ...defaultKeys.slice(2), { action: 'submit', combo: 'Mod+KeyJ' }]);
      pass('Settings shortcuts: edit and remove; the titles follow; the changes work at once and after a reload; a removed default stays removed');

      await kp.keyboard.press('Alt+Shift+KeyS'); await visible(kp, '.sheet');
      assert.deepEqual(await keyRows(), changed);
      await kp.locator(ui(reset)).click(); assert.equal(await focused(), 'Keep your shortcuts');
      await kp.keyboard.press('Escape'); await visible(kp, '.sheet'); assert.equal(await focused(), 'Put the default shortcuts back', 'Esc leaves the question');
      await kp.locator(ui(reset)).click(); await kp.locator(ui('button[title="Keep your shortcuts"]')).click();
      assert.deepEqual(await keyRows(), changed);
      await kp.locator(ui(reset)).click(); await kp.locator(ui('button[title="Confirm: put the default shortcuts back"]')).click();
      assert.deepEqual(await keyRows(), defaults); assert.equal(await keyCount(), '7/24');
      assert.equal(await kp.locator(ui(reset)).count(), 0); assert.equal(await focused(), 'Add a shortcut');
      await waitFor(kp, wanted => JSON.stringify(__fake.storage()['kog-pins:prefs'].keys) === wanted, JSON.stringify(defaultKeys));
      await kp.keyboard.press('Escape'); await gone(kp, '.sheet');
      await kp.keyboard.press('Control+KeyM'); await visible(kp, '.overlay');
      await kp.keyboard.press('Control+KeyM'); await gone(kp, '.overlay');
      // Another tab saves the settings. Bad entries are dropped when the data is read.
      const eyeTitle = title => waitFor(kp, wanted => document.querySelector('on-spot').shadowRoot.querySelector('.capsule button:nth-of-type(2)').title === wanted, title);
      await kp.evaluate(() => chrome.storage.local.set({ 'kog-pins:prefs': { v: 1, keys: [{ action: 'eye', combo: 'Mod+KeyC' }, { action: 'nope', combo: 'Alt+KeyA' }, { action: 'eye', combo: 'Alt+KeyE' }, { action: 'log', combo: 'Alt+KeyE' }, null, { action: 'log', combo: 'Shift+Alt+KeyL' }, { action: 'log', combo: 'KeyL' }] } }));
      await eyeTitle('Hide markers (Alt+E)');
      await kp.keyboard.press('Alt+KeyE'); await gone(kp, '.marker');
      await kp.keyboard.press('Alt+KeyE'); await marker(kp, 1);
      await kp.keyboard.press('Control+KeyK'); await delay(60); assert.equal((await eye())[1], 'false');
      await openMenu(kp); await kp.locator(ui('button[title="Open Settings"]')).click(); await visible(kp, '.sheet');
      assert.deepEqual(await keyRows(), ['Hide or show markers: Alt+E'], 'only the valid entry stays');
      await kp.evaluate(() => chrome.storage.local.set({ 'kog-pins:prefs': { v: 1, keys: [] } }));
      await eyeTitle('Hide markers');
      assert.deepEqual(await keyRows(), [], 'he removed every shortcut: valid'); assert.equal(await keyCount(), '0/24');
      await visible(kp, `.sheet ${reset}`); await visible(kp, '.sheet button[title="Add a shortcut"]');
      await kp.evaluate(() => chrome.storage.local.set({ 'kog-pins:prefs': { v: 1 } }));
      await eyeTitle('Hide markers (Ctrl+K)');
      assert.deepEqual(await keyRows(), defaults, 'data of an older build has no keys: the defaults');
      await clean(kp, keysPage.issues); await kp.close();
      pass('"Reset shortcuts" asks first and puts the defaults back; settings of another tab arrive; bad stored shortcuts are dropped; an empty list is valid');

      // A Mac: Mod is the Command key, the keys show as symbols.
      const macContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
      await macContext.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
      await serve(macContext);
      const mac = await freshPage(macContext, '/mac'); activePage = mac.page;
      const ap = mac.page;
      assert.equal(await ap.locator(ui('.pin-button')).getAttribute('title'), 'Toggle pin mode (⌘M)');
      assert.deepEqual(await eyeOf(ap), ['Hide markers (⌘K)', 'false', 2]);
      await ap.keyboard.press('Control+KeyK'); await delay(60); assert.equal((await eyeOf(ap))[1], 'false', 'Control is not Mod on a Mac');
      await ap.keyboard.press('Meta+KeyK'); assert.deepEqual(await eyeOf(ap), ['Show markers (⌘K)', 'true', 3]);
      await ap.keyboard.press('Meta+KeyK'); assert.equal((await eyeOf(ap))[1], 'false');
      await ap.keyboard.press('Meta+KeyM'); await visible(ap, '.overlay');
      await ap.keyboard.press('Meta+KeyM'); await gone(ap, '.overlay');
      await ap.keyboard.press('Alt+Shift+KeyS'); await visible(ap, '.sheet');
      assert.deepEqual(await keyRowsOf(ap), ['Toggle pin mode: ⌘M', 'Hide or show markers: ⌘K', 'Open or close the menu: ⌥⇧M', 'Open or close the Log: ⌥⇧L', 'Open or close Settings: ⌥⇧S', 'Pause or resume page animations: ⌥⇧F', 'Open the queue: ⌥⇧Q']);
      assert.match(await shadowText(ap, '.sheet .fixed-keys'), /, ⌘↵ submits all, /);
      await ap.locator(ui('button[title="Add a shortcut"]')).click();
      await ap.locator(ui('select[name="shortcut-action"]')).selectOption('submit');
      const macField = ap.locator(ui('input[name="shortcut-keys"]'));
      await macField.press('KeyJ'); await ap.locator(ui('button[title="Save this shortcut"]')).click();
      assert.equal(await keyErrorOf(ap), 'Add ⌘, Ctrl or Alt to the key.');
      await macField.press('Control+Alt+Digit1'); assert.equal(await macField.inputValue(), '⌃⌥1');
      await macField.press('Meta+Shift+Digit1'); assert.equal(await macField.inputValue(), '⇧⌘1');
      await ap.locator(ui('button[title="Save this shortcut"]')).click();
      assert.equal((await keyRowsOf(ap)).at(-1), 'Submit all: ⇧⌘1');
      assert.equal(await focusOf(ap), 'Edit the shortcut ⇧⌘1: Submit all');
      await clean(ap, mac.issues); await macContext.close();
      pass('on a Mac: ⌘K and ⌘M match the Command key, Control does not; the keys show as ⌘K, ⌥⇧L, ⌃⌥1');

      const mobile = await freshPage(context, '/narrow'); activePage = mobile.page;
      const mp = mobile.page;
      await mp.evaluate(() => { __fake.reset(); localStorage.removeItem('onspot-harness-storage'); __fake.setStorage({ 'kog-pins:prefs': { v: 1, tabs: ['text', 'style', 'layout', 'behaviour', 'remove', 'task'], hidden: [], intent: null, scope: null,
        presets: [{ id: 'a', label: '5 agents', text: 'Start a thread and delegate 5 agents.' }, { id: 'b', label: 'Staging first, then ask me', text: 'Deploy to staging and stop.' }, { id: 'c', label: 'Use Fable', text: 'Use fable 5.2 xhigh.' }] } }); });
      await mp.setViewportSize({ width: 375, height: 812 });
      await mp.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
      await mp.reload(); await visible(mp, '.capsule');
      const fits = async (selector, height = 812) => { const box = await mp.locator(ui(selector)).boundingBox(); assert.ok(inside(box, 375, height), `${selector} ${JSON.stringify(box)}`); return box; };
      await fits('.capsule');
      await mp.evaluate(() => __fake.state('login')); await openMenu(mp); await visible(mp, '.login');
      const narrowMenu = await fits('.menu'), narrowCapsule = await fits('.capsule');
      assert.ok(narrowMenu.x + narrowMenu.width <= narrowCapsule.x, 'the menu stays left of the capsule');
      assert.equal(await mp.locator(ui('.menu')).evaluate(node => getComputedStyle(node).transitionDuration), '0s');
      await screenshot(mp, name, 'narrow-menu');
      await mp.evaluate(() => __fake.state('live'));
      await mp.locator(ui('button[title^="Open Settings"]')).click(); await visible(mp, '.sheet');
      await mp.locator(ui('button[title="Add a preset"]')).click();
      const narrowSheet = await fits('.sheet');
      assert.ok(narrowSheet.y + narrowSheet.height <= narrowCapsule.y, 'Settings sits above the capsule');
      assert.equal(await mp.evaluate(() => document.documentElement.scrollWidth <= 375), true, 'no horizontal scroll');
      await screenshot(mp, name, 'narrow-settings');
      await mp.keyboard.press('Escape'); await mp.keyboard.press('Escape'); await gone(mp, '.sheet');
      await toggle(mp); await pick(mp, '#target'); await visible(mp, '.popup');
      await gone(mp, '.menu');
      await fits('.popup');
      assert.deepEqual(await mp.evaluate(() => [...document.querySelector('on-spot').shadowRoot.querySelectorAll('.popup button')].filter(node => { const box = node.getBoundingClientRect(); return box.height < 32 || box.right > 375 || box.left < 0; }).map(node => node.title)), [], 'every popup control fits and is 32 px high or more');
      assert.equal(await mp.locator(ui('.popup')).evaluate(node => getComputedStyle(node).transitionDuration), '0s');
      await screenshot(mp, name, 'narrow-popup');
      await note(mp, 'Narrow screen pin.');
      const tray = await fits('.tray');
      assert.ok(tray.y + tray.height <= narrowCapsule.y, `tray ${JSON.stringify(tray)} overlaps capsule ${JSON.stringify(narrowCapsule)}`);
      await mp.keyboard.press('Escape');
      await mp.evaluate(() => { const pin = __fake.seed({ url: `${location.origin}/narrow`, note: 'Pulse check.', targets: [{ selector: '#second-target', label: 'p', rect: { x: 1, y: 1, w: 1, h: 1 } }] }); __fake.update(pin.id, { status: 'working' }); });
      await marker(mp, 1, 'working');
      assert.equal(await mp.locator(ui('.marker[data-pin="1"]')).evaluate(node => { const css = getComputedStyle(node, '::after'); return `${css.animationName} ${css.opacity}`; }), 'none 0', 'reduced motion: no pulse');
      await openMenu(mp); await mp.locator(ui('.log-button')).click(); await visible(mp, '.log');
      const logBox = await fits('.log');
      assert.ok(logBox.y + logBox.height <= tray.y + 1, JSON.stringify(logBox));
      await screenshot(mp, name, 'narrow-log');
      await clean(mp, mobile.issues); await mp.close();
      pass('375px: capsule, menu, Settings, popup, tray and Log fit without overlap; reduced motion has no slide and no pulse');

      summaries.push(`${name.toUpperCase()}: ${failures.some(item => item.startsWith(name + ':')) ? 'FAIL' : 'PASS'} (${passed.length} passing groups), zero CSP violations, zero page errors`);
    } catch (error) {
      if (activePage && !activePage.isClosed()) {
        await screenshot(activePage, name, 'failure').catch(() => {});
        process.stderr.write(`UI on failure: ${await activePage.locator('on-spot').evaluate(host => host.shadowRoot.textContent.slice(-5000)).catch(() => '')}\n`);
      }
      throw error;
    } finally { await browser.close(); }
  }
  process.stdout.write(`\nBundle: ${bundle.byteLength} bytes (limit ${budget})\n${summaries.join('\n')}\nScreenshots: ${screenshots}/\n`);
  assert.deepEqual(failures, [], 'Incomplete harness checks');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
