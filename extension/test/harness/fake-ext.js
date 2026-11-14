import { API_METHODS, API_PATH_RE, MSG, PIN_ID_RE, PORT_NAME, SETTINGS_METHODS, SHOT_KINDS, STATE } from '../../src/shared/protocol.js';

/* global __ONSPOT_VERSION__, __SHOTS__ */
const INTENTS = ['text', 'style', 'layout', 'behaviour', 'remove', 'task'], SCOPES = ['element', 'similar', 'page', 'site'];

const listeners = new Set(), ports = new Set();
const persisted = JSON.parse(localStorage.getItem('onspot-harness-db') || 'null');
const defaultSettings = () => ({ autofix: true, bulk: { on: false, delegate: false, agents: 3 } });
const db = persisted || { pins: [], replies: [], steps: [], batches: [], nextPin: 1, nextReply: 1, nextStep: 1, nextBatch: 1, settings: defaultSettings() };
const calls = [], portMessages = [], failures = [], answers = [], storageListeners = new Set();
let lostResponses = 0;
let connections = 0;
const copy = value => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const save = () => localStorage.setItem('onspot-harness-db', JSON.stringify(db));
const success = (data, status = 200) => ({ ok: true, status, data });
const failure = (error, status = 400) => ({ ok: false, status, data: { error }, error });
const publish = message => { for (const port of ports) for (const listener of port.messages) listener(copy(message)); };
function text(value, field, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`Invalid ${field}`);
  return value.trim();
}
function validateCreate(body) {
  const url = new URL(body.url);
  if (url.protocol !== 'https:' || !(url.hostname === 'koglabs.com' || url.hostname.endsWith('.koglabs.com')) || body.url.length > 2048) throw new Error('Invalid url');
  if (!Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > 10) throw new Error('Invalid targets');
  for (const target of body.targets) {
    text(target.selector, 'selector', 500);
    text(target.label, 'label', 160);
    if (!target.rect || !['x', 'y', 'w', 'h'].every(key => Number.isInteger(target.rect[key]))) throw new Error('Invalid rect');
  }
  text(body.note, 'note');
  // The same limits as the store: a name from the list or null; 0 to 6 presets of exactly { label, text }.
  if (body.intent != null && !INTENTS.includes(body.intent)) throw new Error('Invalid intent');
  if (body.scope != null && !SCOPES.includes(body.scope)) throw new Error('Invalid scope');
  if (body.presets !== undefined) {
    if (!Array.isArray(body.presets) || body.presets.length > 6) throw new Error('Invalid presets');
    for (const preset of body.presets) {
      if (Object.keys(preset || {}).sort().join() !== 'label,text') throw new Error('Invalid preset');
      text(preset.label, 'preset label', 40); text(preset.text, 'preset text', 500);
    }
  }
  return url;
}
function create(body, batch = null) {
  const url = validateCreate(body);
  url.hash = '';
  const pin = {
    id: db.nextPin++, status: 'queued', url: url.href, host: url.host.toLowerCase(), path: url.pathname,
    title: (body.title || '').slice(0, 300), note: body.note.trim(), quote: body.quote?.slice(0, 2000) || null,
    targets: copy(body.targets), viewport: body.viewport || null, author: 'tester', agent: null,
    summary: null, commit: null, run: null, batch, model: null, attempts: 0, acceptedAt: null, reopens: 0, versions: [], revert: null, revertedAt: null,
    intent: body.intent ?? null, scope: body.scope ?? null, presets: copy(body.presets ?? []), progress: null, shots: { before: null, after: null }, replyCount: 0, createdAt: now(), updatedAt: now(), startedAt: null, closedAt: null,
  };
  db.pins.push(pin); save(); return pin;
}
function createBatch(body) {
  if (!Array.isArray(body?.pins) || body.pins.length < 1 || body.pins.length > 30) throw new Error('pins must hold 1 to 30 pins');
  if (body.key !== undefined && !/^[A-Za-z0-9_-]{8,80}$/.test(body.key)) throw new Error('Invalid key');
  const existing = body.key && db.batches.find(batch => batch.key === body.key);
  if (existing) return [{ batch: copy(existing), pins: copy(db.pins.filter(pin => pin.batch === existing.id)) }, 200];
  const hosts = new Set(body.pins.map(item => validateCreate(item).host));
  if (hosts.size !== 1) throw new Error('all pins in a batch must be on one host');
  const batch = { id: db.nextBatch++, key: body.key || null, host: [...hosts][0], count: body.pins.length, createdAt: now() };
  db.batches.push(batch);
  const pins = body.pins.map(item => create(item, batch.id));
  return [{ batch: copy(batch), pins: copy(pins) }, 201];
}
function reply(pin, body, kind = 'user') {
  const item = { id: db.nextReply++, pinId: pin.id, kind, author: kind === 'agent' ? 'test-agent' : 'tester', body: text(body, 'body'), createdAt: now() };
  db.replies.push(item); pin.replyCount++; pin.updatedAt = now(); save(); return item;
}
// A user reopen, as the store does it: clears the run, the acceptance and the go back result, counts the reopen.
function reopenPin(pin) {
  Object.assign(pin, { status: 'queued', agent: null, summary: null, commit: null, run: null, startedAt: null, closedAt: null, acceptedAt: null, revertedAt: null });
  pin.reopens++;
}
// PATCH /api/settings merges. An unknown key, a wrong type or agents outside 1 to 8 is 400 and changes nothing.
function patchSettings(body) {
  const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
  if (!keys(body, ['autofix', 'bulk']) || ('autofix' in body && typeof body.autofix !== 'boolean')) throw new Error('Invalid settings');
  if ('bulk' in body) {
    const bulk = body.bulk;
    if (!keys(bulk, ['on', 'delegate', 'agents']) || ['on', 'delegate'].some(key => key in bulk && typeof bulk[key] !== 'boolean')) throw new Error('Invalid bulk settings');
    if ('agents' in bulk && !(Number.isInteger(bulk.agents) && bulk.agents >= 1 && bulk.agents <= 8)) throw new Error('agents must be 1 to 8');
  }
  if ('autofix' in body) db.settings.autofix = body.autofix;
  Object.assign(db.settings.bulk, body.bulk);
  save(); publish({ t: MSG.SETTINGS, settings: copy(db.settings) });
  return copy(db.settings);
}
function handle({ method, path, body }) {
  if (!API_METHODS.includes(method) || !API_PATH_RE.test(path) || (path.startsWith('/api/settings') && !SETTINGS_METHODS.includes(method))) return failure('Refused path or method');
  const url = new URL(path, 'https://ai.koglabs.com');
  if (url.pathname === '/api/health') return success({ ok: true, version: 'fake', extension: __fake.serverExtension, open: {} });
  if (url.pathname === '/api/settings') return success(method === 'GET' ? copy(db.settings) : patchSettings(body));
  if (url.pathname === '/api/batches') {
    if (method !== 'POST') return failure('Method not allowed', 405);
    const [data, status] = createBatch(body);
    if (lostResponses > 0) { lostResponses--; return { ok: false, status: 0, data: null, error: 'offline' }; }
    return success(data, status);
  }
  const match = /^\/api\/pins(?:\/([1-9][0-9]{0,11})(?:\/(start|resolve|dismiss|ask|reopen|replies|accept|revert))?)?$/.exec(url.pathname);
  if (!match) return failure('Not found', 404);
  if (!match[1]) {
    if (method === 'GET') {
      const query = url.searchParams, status = query.get('status') || 'open';
      const statuses = status === 'open' ? ['queued', 'working', 'waiting'] : status === 'all' ? ['queued', 'working', 'waiting', 'done', 'dismissed'] : status.split(',');
      if (statuses.some(value => !['queued', 'working', 'waiting', 'done', 'dismissed'].includes(value))) return failure('Invalid status');
      const limit = Number(query.get('limit') || 200);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) return failure('Invalid limit');
      const pins = db.pins.filter(pin => statuses.includes(pin.status) && (!query.has('host') || pin.host === query.get('host')) && (!query.has('path') || pin.path === query.get('path')) && (!query.has('before') || pin.id < Number(query.get('before'))) && (!query.has('batch') || pin.batch === Number(query.get('batch')))).sort((a, b) => b.id - a.id).slice(0, limit);
      return success({ pins: copy(pins) });
    }
    if (method === 'POST') return success({ pin: copy(create(body)) }, 201);
    return failure('Method not allowed', 405);
  }
  const pin = db.pins.find(item => item.id === Number(match[1]));
  if (!pin) return failure('Not found', 404);
  const action = match[2];
  if (!action) {
    if (method === 'GET') return success({ pin: copy(pin), replies: copy(db.replies.filter(item => item.pinId === pin.id)), steps: copy(db.steps.filter(item => item.pinId === pin.id)) });
    if (method === 'PATCH') {
      if (pin.status !== 'queued') return failure('Pin is not queued', 409);
      pin.note = text(body?.note, 'note'); pin.updatedAt = now(); save(); return success({ pin: copy(pin) });
    }
    if (method === 'DELETE') {
      db.pins = db.pins.filter(item => item.id !== pin.id); db.replies = db.replies.filter(item => item.pinId !== pin.id); save(); return success(null, 204);
    }
  }
  if (method !== 'POST') return failure('Method not allowed', 405);
  if (action === 'replies') {
    if (body?.reopen !== undefined && typeof body.reopen !== 'boolean') return failure('reopen must be true or false');
    const reopen = pin.status === 'waiting' || (body?.reopen === true && ['done', 'dismissed'].includes(pin.status));
    const item = reply(pin, body?.body);
    if (reopen) reopenPin(pin);
    save();
    return success({ reply: copy(item), pin: copy(pin) }, 201);
  }
  const allowed = { start: ['queued'], resolve: ['queued', 'working', 'waiting'], dismiss: ['queued', 'working', 'waiting'], ask: ['queued', 'working'], reopen: ['working', 'waiting', 'done', 'dismissed'], accept: ['done'], revert: ['done', 'dismissed'] };
  if (!allowed[action]?.includes(pin.status)) return failure('Status conflict', 409);
  pin.updatedAt = now();
  if (action === 'start') {
    pin.status = 'working'; pin.agent = 'test-agent'; pin.startedAt = now();
    pin.run = typeof body?.run === 'string' && body.run.trim() ? body.run.trim().slice(0, 200) : null;
  }
  if (action === 'resolve') {
    pin.summary = text(body?.summary, 'summary'); pin.commit = body?.commit || null; pin.status = 'done'; pin.closedAt = now();
    // The revert run removes the fixes that it undid; any other resolve adds a version.
    const reverted = Boolean(pin.revert);
    if (reverted) { pin.versions = pin.versions.filter(item => !pin.revert.commits.includes(item.commit)); pin.revert = null; pin.revertedAt = now(); }
    else if (pin.commit) pin.versions = [...pin.versions, { commit: pin.commit, summary: pin.summary, at: now() }].slice(-30);
    reply(pin, `${reverted ? 'Reverted' : 'Done'}: ${pin.summary}${pin.commit ? ` (${pin.commit})` : ''}`, 'agent');
  }
  if (action === 'dismiss') { pin.status = 'dismissed'; pin.summary = body?.reason || null; pin.closedAt = now(); pin.revert = null; }
  // Go back: the chosen commit and every later fix are undone, newest first.
  if (action === 'revert') {
    if (typeof body?.commit !== 'string' || !body.commit) return failure('commit is required');
    const at = pin.versions.findIndex(item => item.commit === body.commit);
    if (at < 0) return failure('That commit is not a version of this pin.', 409);
    const commits = pin.versions.slice(at).map(item => item.commit).reverse();
    pin.revert = { commits, at: now(), attempts: pin.attempts };
    reopenPin(pin);
    reply(pin, `Go back to ${at ? `fix ${at} (${pin.versions[at - 1].commit.slice(0, 7)})` : 'the version before this pin'}: undo ${commits.map(commit => commit.slice(0, 7)).join(', ')}.`);
  }
  if (action === 'ask') { pin.status = 'waiting'; reply(pin, text(body?.question, 'question'), 'agent'); }
  if (action === 'reopen') reopenPin(pin);
  if (action === 'accept') pin.acceptedAt ??= now(); // once; a second accept changes nothing
  save(); return success({ pin: copy(pin) });
}

function answer(message) {
  if (message.t === MSG.STATE) return { state: STATE.LIVE };
  if (message.t === MSG.SHOT) {
    if (!PIN_ID_RE.test(String(message.id)) || !SHOT_KINDS.includes(message.kind)) return { ok: false, status: 400 };
    const pin = db.pins.find(item => item.id === Number(message.id));
    return pin?.shots[message.kind] ? { ok: true, status: 200, type: 'image/png', data: __SHOTS__[message.kind] } : { ok: false, status: 404 };
  }
  if (message.t !== MSG.API) return failure('Unknown message');
  const failed = failures.findIndex(item => item.method === message.method && item.path === message.path);
  if (failed >= 0) { const item = failures.splice(failed, 1)[0]; return failure(item.error, item.status); }
  try {
    const result = handle(message);
    const other = answers.findIndex(item => item.method === message.method && item.path === message.path);
    if (other < 0) return result;
    const item = answers.splice(other, 1)[0];
    return success(item.data, item.status);
  } catch (error) { return failure(error.message); }
}

globalThis.__fake = {
  calls, portMessages, db,
  get connections() { return connections; },
  get activePorts() { return ports.size; },
  delay: 30,
  storageDelay: 0,
  serverExtension: __ONSPOT_VERSION__,
  loseNextResponse() { lostResponses++; },
  failNext(method, path, status = 0, error = 'offline') { failures.push({ method, path, status, error }); },
  // The server does the work, but the next answer for this call holds `data` instead.
  answerNext(method, path, data, status = 200) { answers.push({ method, path, data, status }); },
  // true: the answer is made when the call arrives and then travels for `delay` ms, so it can be old on arrival.
  answerFirst: false,
  toggle() { for (const listener of listeners) listener({ t: MSG.TOGGLE }); },
  push(message) { publish(message); },
  state(state) { publish({ t: MSG.STATE, state }); },
  update(id, fields, action = 'updated') {
    const pin = db.pins.find(item => item.id === id);
    Object.assign(pin, fields, { updatedAt: now() });
    if (action === 'deleted') db.pins = db.pins.filter(item => item.id !== id);
    save(); publish({ t: MSG.PIN, action, pin });
  },
  reply(id, body) { const pin = db.pins.find(item => item.id === id); const item = reply(pin, body, 'agent'); publish({ t: MSG.REPLY, pin, reply: item }); },
  // A progress step of the run, as `POST /api/pins/:id/progress` stores and announces it.
  step(id, body) {
    db.steps.push({ id: db.nextStep++, pinId: id, author: 'claude', body, createdAt: now() });
    __fake.update(id, { progress: { text: body, at: now(), count: db.steps.filter(item => item.pinId === id).length } });
  },
  // A settings change by another client (the Triad tab, another browser): the store emits `settings`.
  settings(bulk) { patchSettings({ bulk }); },
  shot(id, kind) { const pin = db.pins.find(item => item.id === id); __fake.update(id, { shots: { ...pin.shots, [kind]: now() } }); },
  disconnect() { for (const port of [...ports]) port.disconnect(); },
  seed(body) { return copy(create(body)); },
  reset() { db.pins = []; db.replies = []; db.steps = []; db.batches = []; db.nextPin = 1; db.nextReply = 1; db.nextStep = 1; db.nextBatch = 1; db.settings = defaultSettings(); save(); },
  storage: () => JSON.parse(localStorage.getItem('onspot-harness-storage') || '{}'),
  setStorage(values) {
    const all = JSON.parse(localStorage.getItem('onspot-harness-storage') || '{}');
    Object.assign(all, values); localStorage.setItem('onspot-harness-storage', JSON.stringify(all));
  },
};
globalThis.chrome = {
  runtime: {
    async sendMessage(message) {
      calls.push(copy(message));
      const early = __fake.answerFirst ? answer(message) : null;
      await new Promise(resolve => setTimeout(resolve, __fake.delay));
      return early ?? answer(message);
    },
    connect({ name }) {
      if (name !== PORT_NAME) throw new Error('Wrong port name');
      connections++;
      const port = {
        messages: new Set(), disconnects: new Set(),
        onMessage: { addListener(listener) { port.messages.add(listener); } },
        onDisconnect: { addListener(listener) { port.disconnects.add(listener); } },
        postMessage(message) {
          portMessages.push(copy(message));
          if (message.t === MSG.SUB) queueMicrotask(() => {
            for (const listener of port.messages) listener({ t: MSG.STATE, state: STATE.LIVE });
          });
          else if (message.t !== MSG.PING) throw new Error('Unknown port message');
        },
        disconnect() { if (!ports.delete(port)) return; for (const listener of port.disconnects) listener(); },
      };
      ports.add(port); return port;
    },
    onMessage: { addListener(listener) { listeners.add(listener); } },
  },
  storage: {
    local: {
      async get(key) {
        if (__fake.storageDelay) await new Promise(resolve => setTimeout(resolve, __fake.storageDelay));
        const all = JSON.parse(localStorage.getItem('onspot-harness-storage') || '{}'); return { [key]: all[key] };
      },
      async set(values) {
        const all = JSON.parse(localStorage.getItem('onspot-harness-storage') || '{}');
        const changes = Object.fromEntries(Object.entries(copy(values)).map(([key, value]) => [key, { oldValue: all[key], newValue: value }]));
        Object.assign(all, copy(values)); localStorage.setItem('onspot-harness-storage', JSON.stringify(all));
        for (const listener of storageListeners) queueMicrotask(() => listener(copy(changes), 'local'));
      },
      async remove(key) {
        const all = JSON.parse(localStorage.getItem('onspot-harness-storage') || '{}');
        if (!Object.hasOwn(all, key)) return;
        const changes = { [key]: { oldValue: all[key] } };
        delete all[key]; localStorage.setItem('onspot-harness-storage', JSON.stringify(all));
        for (const listener of storageListeners) queueMicrotask(() => listener(copy(changes), 'local'));
      },
    },
    onChanged: { addListener(listener) { storageListeners.add(listener); } },
  },
};

// Instrumentation is confined to fixtures. The production bundle patches no APIs.
globalThis.__metrics = { rectReads: 0, documentListeners: [], mutations: [], csp: [], pageClicks: 0, pageKeys: [] };
document.addEventListener('securitypolicyviolation', event => __metrics.csp.push(`${event.violatedDirective}: ${event.blockedURI}`));
const nativeRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function () { __metrics.rectReads++; return nativeRect.call(this); };
const nativeListen = document.addEventListener;
document.addEventListener = function (name, ...args) { __metrics.documentListeners.push(name); return nativeListen.call(this, name, ...args); };
const NativeObserver = MutationObserver;
globalThis.MutationObserver = class extends NativeObserver {
  observe(target, options) {
    // Playwright itself observes Document while polling selectors.
    if (target !== document) __metrics.mutations.push(target.localName || '#shadow');
    return super.observe(target, options);
  }
};
