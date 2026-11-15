// Unsent pins: the list of this host (on every page of it), the tray, and "Submit all".
import { keepImages } from '../shared/image.js';
import { BATCH_MAX, DRAFT_MAX, draftsKey, HOST, SUBMIT_KEYS, TAB } from './env.js';
import { plural } from './format.js';
import { announce, button, el } from './dom.js';
import { store } from './local.js';
import { api } from './live.js';
import { pinButton } from './capsule.js';
import { mode } from './picker.js';
import { acceptPin, refetch, renderAll } from './pins.js';
import { toast } from './toasts.js';
import { toggleLog } from './log.js';
import { bulkKnown } from './settings-bulk.js';

// `submit` is the key and the draft ids of a send that has no confirmed answer yet: a retry
// repeats that key, so the server never doubles it.
export let drafts = { items: [], submit: null };
export let submitting = false, submitError = '';
let serial = 0;
// During a send: the ids that went out, and the pins that another tab added in that time.
const sentIds = new Set(), lateDrafts = [];

export const tray = el('div', 'surface tray');
tray.setAttribute('role', 'region');
tray.setAttribute('aria-label', 'Unsent pins');
tray.hidden = true;
const trayText = el('span', 'tray-text');
const bulkChip = el('span', 'chip bulk-chip');
bulkChip.hidden = true;
const trayKeys = el('kbd', 'keys', SUBMIT_KEYS);
export const discardButton = button('Discard all unsent pins', 'Discard', () => { discardConfirm.hidden = false; discardButton.hidden = true; keepButton.focus(); }, 'subtle');
const submitButton = button(`Submit all pins (${SUBMIT_KEYS})`, 'Submit all', () => submitAll(), 'primary');
export const discardConfirm = el('span', 'confirm-inline');
const keepButton = button('Keep the unsent pins', 'Keep', () => { discardConfirm.hidden = true; renderTray(); submitButton.focus(); });
discardConfirm.append(el('span', '', 'Discard all?'), keepButton, button('Confirm: discard all unsent pins', 'Discard', discardAll, 'danger'));
discardConfirm.hidden = true;
tray.append(trayText, bulkChip, trayKeys, discardButton, discardConfirm, submitButton);

export const saveDrafts = () => store({ [draftsKey]: { tab: TAB, items: drafts.items, submit: drafts.submit } }).catch(() => {});
// A stored pin body that the rest of the code can use: an https URL of this host, a note, and
// targets that each hold a selector and a label.
export function validBody(body) {
  try {
    const url = new URL(body.url);
    const ok = url.protocol === 'https:' && url.host === HOST && typeof body.note === 'string' && Boolean(body.note.trim())
      && Array.isArray(body.targets) && body.targets.length > 0 && body.targets.every(target => typeof target?.selector === 'string' && typeof target.label === 'string');
    // Bad image ids are dropped here. At most six remain. The text draft per page keeps none.
    if (ok) keepImages(body);
    return ok;
  } catch { return false; }
}
function cleanDrafts(value) {
  const items = Array.isArray(value?.items) ? value.items.filter(item => typeof item?.id === 'string' && validBody(item.body)).slice(0, DRAFT_MAX) : [];
  const ids = new Set(items.map(item => item.id));
  const submit = typeof value?.submit?.key === 'string' && Array.isArray(value.submit.ids) && value.submit.ids.some(id => ids.has(id)) ? value.submit : null;
  return { items, submit };
}
export const draftId = () => `d${Date.now().toString(36)}${(++serial).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export function draftPath(draft) { try { return new URL(draft.body.url).pathname; } catch { return ''; } }
// The stored list replaces ours. During a send this tab keeps its own list; a pin that another
// tab adds now waits in `lateDrafts`: it joins the list after the send and stays unsent.
export function takeDrafts(value) {
  const theirs = cleanDrafts(value);
  if (submitting) lateDrafts.push(...theirs.items.filter(item => !sentIds.has(item.id) && ![...drafts.items, ...lateDrafts].some(mine => mine.id === item.id)));
  else drafts = theirs;
}
export function addDraft(body) {
  drafts.items.push({ id: draftId(), createdAt: new Date().toISOString(), body });
  submitError = '';
  saveDrafts();
}
export function removeDraft(id) {
  drafts.items = drafts.items.filter(item => item.id !== id);
  if (drafts.submit && !drafts.submit.ids.some(item => drafts.items.some(draft => draft.id === item))) drafts.submit = null;
  saveDrafts(); renderAll();
  announce('Unsent pin removed.');
}
function discardAll() {
  drafts = { items: [], submit: null };
  submitError = '';
  discardConfirm.hidden = true;
  saveDrafts(); renderAll();
  pinButton.focus({ preventScroll: true }); // the button that had the focus is gone
  announce('Unsent pins discarded.');
}
export async function submitAll() {
  if (submitting || !drafts.items.length) return;
  submitting = true; submitError = '';
  sentIds.clear();
  renderTray();
  let sent = 0;
  try {
    while (drafts.items.length) {
      if (!drafts.submit) {
        drafts.submit = { key: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`, ids: drafts.items.slice(0, BATCH_MAX).map(item => item.id) };
        await saveDrafts();
      }
      const ids = new Set(drafts.submit.ids);
      const chunk = drafts.items.filter(item => ids.has(item.id));
      const data = await api('POST', '/api/batches', { key: drafts.submit.key, pins: chunk.map(item => item.body) });
      for (const id of ids) sentIds.add(id);
      drafts = { items: drafts.items.filter(item => !ids.has(item.id)), submit: null };
      await saveDrafts();
      // The pins are sent when the request passes. An answer without them needs a fetch.
      const made = Array.isArray(data?.pins) ? data.pins : [];
      for (const pin of made) acceptPin(pin);
      if (made.length < chunk.length) refetch();
      sent += chunk.length;
    }
    toast({ key: 'sent', kind: 'sent', title: `${plural(sent, 'pin')} sent`, text: 'Fixing starts now. The Log shows each step.', actions: [['Open the log', 'Log', () => toggleLog(true)]], ms: 5000 });
    announce(`${plural(sent, 'pin')} sent. Fixing starts now.`);
  } catch (error) {
    submitError = error.message;
    announce(`Pins not sent: ${error.message} They are kept.`);
  } finally {
    submitting = false;
    if (lateDrafts.length) { drafts.items.push(...lateDrafts.splice(0)); saveDrafts(); }
    renderAll();
  }
}
export function renderTray() {
  const count = drafts.items.length;
  tray.hidden = !count && !mode;
  tray.dataset.state = submitting ? 'sending' : submitError ? 'error' : count ? 'ready' : 'hint';
  trayText.textContent = submitting ? `Sending ${plural(count, 'pin')}…`
    : submitError ? `Not sent: ${submitError}`
    : count ? `${plural(count, 'pin')} ready`
    : 'Click an element to pin it. Esc stops.';
  const showActions = count > 0 && discardConfirm.hidden;
  discardButton.hidden = !showActions || submitting;
  submitButton.hidden = !count || !discardConfirm.hidden;
  trayKeys.hidden = !count || submitting || !discardConfirm.hidden;
  submitButton.disabled = submitting;
  submitButton.textContent = submitError ? 'Try again' : 'Submit all';
  const b = bulkKnown();
  bulkChip.hidden = !b?.on || !discardConfirm.hidden;
  if (!b?.on) return;
  bulkChip.textContent = b.delegate ? `Bulk · ${plural(b.agents, 'agent')}` : 'Bulk';
  bulkChip.title = `Bulk mode: one agent takes all these pins${b.delegate ? ` and splits them between up to ${plural(b.agents, 'agent')}` : ''}`;
}
