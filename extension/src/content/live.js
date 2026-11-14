// The background script: one-shot API calls, the live port and the life of the page.
import { ext, LOGIN_URL, MSG, PING_MS, PORT_NAME, STATE } from '../shared/protocol.js';
import { HOST } from './env.js';
import { setTitle } from './dom.js';
import { cancelFrame, schedule, stopObserver } from './layout.js';
import { loadLocal } from './local.js';
import { stopRoutes, withoutHash } from './routes.js';
import { connection, loginLink } from './capsule.js';
import { frozen, toggleFreeze } from './freeze.js';
import { toggleMode } from './picker.js';
import { popup, saveText } from './notes.js';
import { acceptPin, onReply, refetch } from './pins.js';
import { loadHistory, log } from './log.js';
import { loadSettings, renderBulk, settingsRead, takeSettings } from './settings-bulk.js';

export let connectionState = STATE.CONNECTING;
// true while the page is hidden for good or sits in the page cache: no frames, no reconnect.
export let suspended = false;
let port = null, reconnectTimer = 0, heartbeat = 0;

export async function api(method, path, body) {
  try {
    const message = { t: MSG.API, method, path };
    if (body !== undefined) message.body = body;
    const response = await ext.runtime.sendMessage(message);
    if (!response?.ok) {
      if (response?.status === 401) { setState(STATE.LOGIN); throw new Error('Log in first.'); }
      if (response?.status) throw new Error(response.data?.error || response.error || 'The request failed.');
      // Status 0: this request got no answer. The stream can still be live, so the background
      // says what the connection is. No answer to that question means offline.
      setState(await ext.runtime.sendMessage({ t: MSG.STATE }).then(answer => answer?.state, () => STATE.OFFLINE));
      throw new Error(response?.error === 'timeout' ? 'The request took too long. Try again.' : 'You are offline.');
    }
    return response.data;
  } catch (error) {
    throw error instanceof Error ? error : new Error('The request failed. Try again.');
  }
}
export function setState(state) {
  connectionState = Object.values(STATE).includes(state) ? state : STATE.OFFLINE;
  connection.dataset.state = connectionState;
  setTitle(connection, `Connection: ${connectionState}`);
  loginLink.hidden = connectionState !== STATE.LOGIN;
  loginLink.href = `${LOGIN_URL}?next=${encodeURIComponent(withoutHash())}`;
  renderBulk();
}
// After a (re)connect: the pins again, and the settings once pin mode or the sheet has read them.
function resync() { refetch(); if (log) loadHistory(); if (settingsRead) loadSettings(); }
export function connect() {
  if (suspended || port) return;
  setState(STATE.CONNECTING);
  try {
    const current = ext.runtime.connect({ name: PORT_NAME }); port = current;
    current.onMessage.addListener(message => {
      if (port !== current) return;
      if (message.t === MSG.STATE) setState(message.state);
      if (message.t === MSG.RESYNC) resync();
      if (message.t === MSG.SETTINGS) takeSettings(message.settings);
      if (message.t === MSG.PIN) acceptPin(message.pin, message.action);
      if (message.t === MSG.REPLY && message.pin?.host === HOST) onReply(message.pin, message.reply);
    });
    current.onDisconnect.addListener(() => {
      if (port !== current) return;
      port = null; setState(STATE.OFFLINE);
      if (!suspended) reconnectTimer = setTimeout(() => { reconnectTimer = 0; connect(); resync(); }, 1000);
    });
    current.postMessage({ t: MSG.SUB, host: HOST });
  } catch {
    port = null; setState(STATE.OFFLINE);
    if (!suspended) reconnectTimer = setTimeout(() => { reconnectTimer = 0; connect(); resync(); }, 1000);
  }
}
// The listeners and the timer that live as long as the page.
export function startLive() {
  heartbeat = setInterval(() => {
    if (document.visibilityState === 'visible' && port) {
      try { port.postMessage({ t: MSG.PING }); } catch { /* onDisconnect reconnects the port. */ }
    }
  }, PING_MS);
  ext.runtime.onMessage.addListener(message => { if (message?.t === MSG.TOGGLE) toggleMode(); });
  window.addEventListener('pagehide', event => {
    if (popup) saveText(popup);
    suspended = true; clearTimeout(reconnectTimer); cancelFrame();
    const old = port; port = null; old?.disconnect();
    if (frozen) toggleFreeze();
    if (!event.persisted) { clearInterval(heartbeat); stopRoutes(); stopObserver(); }
  });
  // Back from the page cache: storage changes did not arrive while the page was frozen.
  window.addEventListener('pageshow', event => { if (event.persisted) { suspended = false; loadLocal(); connect(); resync(); schedule(); } });
}
