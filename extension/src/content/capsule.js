// The capsule (Pin, Eye, Menu) and the menu that slides out of it.
import { QUEUE_URL } from '../shared/protocol.js';
import { hiddenKey, HOST, MAC, VERSION } from './env.js';
import { firstKey } from './shortcuts.js';
import { isOpen, newer, plural } from './format.js';
import { announce, button, el, host, icon, iconButton, link, root, setPressed, setTitle } from './dom.js';
import { schedule } from './layout.js';
import { forget, prefs, store } from './local.js';
import { api } from './live.js';
import { frozen, toggleFreeze } from './freeze.js';
import { overlay, toggleMode } from './picker.js';
import { drafts } from './drafts.js';
import { pins, renderMarkers } from './pins.js';
import { toggleLog } from './log.js';
import { toggleSettings } from './settings.js';

export let menuOpen = false, markersHidden = false;
let healthChecked = false;

// Pin starts pin mode at once, Eye hides the markers, Menu opens the sliding menu.
export const capsule = el('div', 'surface capsule');
capsule.setAttribute('role', 'group');
export const pinButton = setPressed(iconButton('Toggle pin mode', 'pin', toggleMode, 'pin-button'), false);
// The eye sits in the capsule: one click hides or shows every marker (order 2026-11-10).
const hideButton = setPressed(iconButton('Hide markers', 'eye', toggleEye), false);
export const menuButton = iconButton('Open the menu', 'gear', () => setMenu(!menuOpen), 'menu-button');
export const connection = el('span', 'dot connection');
connection.setAttribute('role', 'img');
connection.id = 'onspot-connection';
menuButton.setAttribute('aria-describedby', connection.id); // the button has its own name; this adds the state
const updateDot = el('span', 'dot update-dot');
updateDot.title = 'A new OnSpot version is ready';
updateDot.hidden = true;
menuButton.append(connection, updateDot);
const badge = el('span', 'badge', '0');
badge.hidden = true;
capsule.append(pinButton, hideButton, menuButton, badge);
export const menu = el('div', 'surface menu');
menu.setAttribute('role', 'toolbar');
menu.setAttribute('aria-label', 'OnSpot menu');
menu.inert = true;
export const logButton = setPressed(button('Open the log', undefined, () => toggleLog(), 'log-button'), false);
const logCount = el('span', '', '0');
logButton.append(icon('log'), logCount);
export const freezeButton = setPressed(iconButton('Pause page animations', 'freeze', toggleFreeze), false);
export const settingsButton = setPressed(iconButton('Open Settings', 'sliders', toggleSettings), false);
export const queueURL = `${QUEUE_URL}&host=${encodeURIComponent(HOST)}`;
const queueLink = link('Open the queue in the Triad Pins tab', queueURL, 'link icon');
queueLink.append(icon('external'));
export const loginLink = link('Log in to OnSpot', '', 'link login', 'Log in');
loginLink.hidden = true;
const updateLink = link('A new OnSpot version is ready. Open the Pins tab to download it.', QUEUE_URL, 'link update', 'Update');
updateLink.hidden = true;
menu.append(logButton, freezeButton, settingsButton, queueLink, loginLink, updateLink);

export function setMenu(value) {
  menuOpen = value;
  menu.dataset.open = String(value);
  menu.inert = !value;
  menuButton.setAttribute('aria-expanded', String(value));
  renderTitles();
  document.removeEventListener('pointerdown', onOutside, true);
  // The closed menu is inert: the focus must not stay inside it.
  if (!value) { if (menu.contains(root.activeElement)) menuButton.focus({ preventScroll: true }); return; }
  document.addEventListener('pointerdown', onOutside, true);
  logButton.focus({ preventScroll: true });
  if (!healthChecked) checkVersion();
}
// A click outside our UI closes the menu. The pin layer counts as the page.
function onOutside(event) {
  const path = event.composedPath();
  if (!path.includes(host) || path.includes(overlay)) setMenu(false);
}
async function checkVersion() {
  healthChecked = true;
  try {
    const data = await api('GET', '/api/health');
    updateLink.hidden = updateDot.hidden = !newer(data?.extension, VERSION);
    schedule(); // the menu may take a second line now
  } catch { healthChecked = false; }
}
// Button titles show the first shortcut of their action, or no key when it has none.
function keyed(text, action) {
  const keys = firstKey(prefs.keys, action, MAC);
  return keys ? `${text} (${keys})` : text;
}
export function renderTitles() {
  setTitle(pinButton, keyed('Toggle pin mode', 'mode'));
  setTitle(hideButton, keyed(markersHidden ? 'Show markers' : 'Hide markers', 'eye'));
  setTitle(menuButton, keyed(menuOpen ? 'Close the menu' : 'Open the menu', 'menu'));
  setTitle(freezeButton, keyed(frozen ? 'Resume page animations' : 'Pause page animations', 'freeze'));
  setTitle(settingsButton, keyed('Open Settings', 'settings'));
  setTitle(queueLink, keyed('Open the queue in the Triad Pins tab', 'queue'));
  updateCount();
}
export function setHidden(value) {
  markersHidden = value;
  setPressed(hideButton, value);
  hideButton.replaceChildren(icon(value ? 'eyeOff' : 'eye'));
  renderTitles(); renderMarkers();
}
// The eye state stays per host (`kog-pins:hidden:<host>`: true or absent), also after a reload.
export function toggleEye() {
  setHidden(!markersHidden);
  if (markersHidden) store({ [hiddenKey]: true }).catch(() => {});
  else forget(hiddenKey).catch(() => {});
  announce(markersHidden ? 'Markers hidden' : 'Markers shown');
}
export function updateCount() {
  const count = [...pins.values()].filter(pin => pin.host === HOST && isOpen(pin)).length;
  badge.textContent = String(count + drafts.items.length);
  badge.hidden = !count && !drafts.items.length;
  badge.dataset.drafts = String(drafts.items.length > 0);
  logCount.textContent = String(count);
  setTitle(logButton, keyed(`Open the log: ${plural(count, 'open pin')} on this site`, 'log'));
  capsule.setAttribute('aria-label', `OnSpot, ${plural(count, 'open pin')}, ${drafts.items.length} unsent`);
}
