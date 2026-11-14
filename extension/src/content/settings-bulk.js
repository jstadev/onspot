// Bulk mode: a server setting (not `kog-pins:prefs`). It shows in the Settings sheet and as a
// chip in the tray.
import { STATE } from '../shared/protocol.js';
import { plural } from './format.js';
import { button, el, errorNode, heading, iconButton, root, row } from './dom.js';
import { setError } from './layout.js';
import { api, connectionState } from './live.js';
import { renderTray } from './drafts.js';
import { settings } from './settings.js';

// `bulkServer` is the last server answer, `bulk` what the sheet shows (with changes still on
// the way); both are null while unknown.
let bulk = null, bulkServer = null, bulkPending = 0, bulkError = '';
// true after the first read. Before that the page asks for nothing (quiet when idle).
export let settingsRead = false;

// Bulk mode: server settings, so the section updates in place and the presets below keep focus.
const cleanBulk = b => typeof b?.on === 'boolean' && typeof b.delegate === 'boolean' && Number.isInteger(b.agents) && b.agents >= 1 && b.agents <= 8
  ? { on: b.on, delegate: b.delegate, agents: b.agents } : null;
// Offline or logged out, the last answer may be old: the state counts as unknown.
export const bulkKnown = () => connectionState === STATE.OFFLINE || connectionState === STATE.LOGIN ? null : bulk;
export function takeSettings(data) {
  bulkServer = cleanBulk(data?.bulk);
  if (!bulkPending) bulk = bulkServer;
  renderBulk();
}
export async function loadSettings() {
  settingsRead = true;
  try { takeSettings(await api('GET', '/api/settings')); }
  catch (error) { bulkError = error.message; renderBulk(); }
}
// The change shows at once. On an error the last server answer comes back with the reason.
async function changeBulk(key, value) {
  const b = bulkKnown();
  if (!b || b[key] === value || (key === 'agents' && !(value >= 1 && value <= 8))) return;
  bulk = { ...b, [key]: value }; bulkError = ''; bulkPending++;
  renderBulk();
  let data = null;
  try { data = await api('PATCH', '/api/settings', { bulk: { [key]: value } }); }
  catch (error) { bulkError = error.message; }
  bulkPending--;
  if (data) takeSettings(data);
  else { if (!bulkPending) bulk = bulkServer; renderBulk(); }
}
function switchButton(name, what, key) {
  const node = button(name, undefined, () => changeBulk(key, !bulk?.[key]), 'switch');
  node.setAttribute('role', 'switch');
  node.dataset.what = what;
  return node;
}
export function bulkSection() {
  bulkError = '';
  const ui = { node: el('div', 'panel-body bulk'), rows: el('div'), needs: el('p', 'row-text', 'Bulk mode needs a connection'), error: errorNode('onspot-bulk-error'),
    on: switchButton('Bulk mode', 'bulk mode', 'on'), delegate: switchButton('Delegate', 'delegation', 'delegate'),
    fewer: iconButton('Fewer agents', 'minus', () => changeBulk('agents', bulk?.agents - 1)),
    more: iconButton('More agents', 'plus', () => changeBulk('agents', bulk?.agents + 1)), count: el('span', 'count') };
  const count = ui.count;
  count.tabIndex = 0;
  count.setAttribute('role', 'spinbutton');
  count.setAttribute('aria-label', 'Agents');
  count.setAttribute('aria-valuemin', '1');
  count.setAttribute('aria-valuemax', '8');
  count.addEventListener('keydown', event => {
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, Home: -7, End: 7 }[event.key];
    if (!step) return;
    event.preventDefault();
    if (bulk?.delegate) changeBulk('agents', Math.max(1, Math.min(8, bulk.agents + step)));
  });
  ui.agents = row('Agents', 'The most agents it starts', [ui.fewer, count, ui.more]);
  ui.rows.append(row('Bulk mode', 'One agent takes all pins of a Submit all, at effort xhigh', [ui.on]),
    row('Delegate', 'It splits the pins between agents', [ui.delegate]), ui.agents);
  ui.node.append(heading('Fix runs', 'For every page'), ui.needs, ui.rows, ui.error);
  return ui;
}
export function renderBulk() {
  renderTray();
  if (!settings) return;
  const ui = settings.bulk, b = bulkKnown();
  ui.needs.hidden = Boolean(b); ui.rows.hidden = !b;
  setError(ui.error, bulkError);
  if (!b) return;
  for (const node of [ui.on, ui.delegate]) {
    const on = b[node === ui.on ? 'on' : 'delegate'];
    node.setAttribute('aria-checked', String(on));
    node.title = `Turn ${node.dataset.what} ${on ? 'off' : 'on'}`;
  }
  ui.agents.dataset.off = String(!b.delegate);
  ui.count.textContent = String(b.agents);
  ui.count.setAttribute('aria-valuenow', String(b.agents));
  ui.count.setAttribute('aria-disabled', String(!b.delegate));
  ui.count.title = b.delegate ? `Up to ${plural(b.agents, 'agent')}` : 'Turn on Delegate first';
  const focused = root.activeElement;
  ui.fewer.disabled = !b.delegate || b.agents <= 1;
  ui.more.disabled = !b.delegate || b.agents >= 8;
  if (focused?.disabled && (focused === ui.fewer || focused === ui.more)) ui.count.focus({ preventScroll: true });
}
