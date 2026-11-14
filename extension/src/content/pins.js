// The pins that the server holds for this host: the live copy, the markers on the page, and
// the fetch that fills them.
import { HOST, LIST_LIMIT, RECENT_MS, SEEN_MAX, seenKey } from './env.js';
import { clip, isOpen, modelName, statusText } from './format.js';
import { announce, button, root, setTitle } from './dom.js';
import { markDirty, schedule, syncWatchers } from './layout.js';
import { store } from './local.js';
import { api } from './live.js';
import { markersHidden, updateCount } from './capsule.js';
import { openPopup } from './notes.js';
import { draftPath, drafts, renderTray, submitting } from './drafts.js';
import { dropToast, toast, toasts } from './toasts.js';
import { renderLog } from './log.js';
import { appendReply, card, closeCard, loadCard, openCard, refreshCard } from './card.js';

export const pins = new Map(), markers = new Map(), questions = new Map(), revisions = new Map();
// Each change of a pin gets a number. A fetch that started before a change does not undo it.
export let revision = 0;
// The done pins that he looked at: their green markers are gone.
let seen = new Set();
let loaded = false, listRequest = null, listAgain = false;

export const takeSeen = list => { seen = new Set(Array.isArray(list) ? list.filter(Number.isSafeInteger) : []); };
const saveSeen = () => store({ [seenKey]: [...seen].slice(-SEEN_MAX) }).catch(() => {});
export function markSeen(id) {
  dropToast(`pin:${id}`);
  if (seen.has(id)) return;
  seen.add(id);
  saveSeen();
  renderMarkers();
}
const recentDone = pin => pin.status === 'done' && !seen.has(pin.id) && Date.now() - Date.parse(pin.closedAt || 0) < RECENT_MS;
export function acceptPin(pin, action = 'updated') {
  if (!pin || pin.host !== HOST) return;
  revisions.set(pin.id, ++revision);
  const previous = pins.get(pin.id);
  if (action === 'deleted') {
    pins.delete(pin.id); questions.delete(pin.id);
    dropToast(`pin:${pin.id}`);
    if (card?.id === pin.id) { closeCard(); announce(`Pin ${pin.id} deleted.`); }
  } else {
    pins.set(pin.id, pin);
    // "Seen" belongs to one result. A pin that is open again shows its next result.
    if (pin.status !== 'done' && seen.delete(pin.id)) saveSeen();
    if (loaded && previous) notify(previous, pin);
    if (card?.id === pin.id) refreshCard(card, pin);
  }
  renderMarkers(); renderLog();
}
// Live changes become toasts: a run starts, a pin is done or dismissed. Questions come with
// their reply event (see onReply), so the toast can show the question itself.
function notify(previous, pin) {
  const key = `pin:${pin.id}`;
  // The run toast stays while the run works and shows its newest step. Closed by hand, it stays closed.
  const working = () => toast({ key, pin: pin.id, kind: 'working', title: `${pin.revert ? 'Going back' : 'Fixing'} #${pin.id}${modelName(pin) ? ` · ${modelName(pin)}` : ''}`, text: pin.progress?.text, ms: 0 });
  if (previous.status === pin.status) {
    if (pin.status === 'working' && toasts.has(key) && previous.progress?.count !== pin.progress?.count) working();
    return;
  }
  dropToast(key); // a toast about the old status is stale now
  if (pin.status === 'working') working();
  else if (pin.status === 'done') {
    toast({ key, pin: pin.id, kind: 'done', title: pin.revertedAt ? `Back to the earlier version · #${pin.id}` : `#${pin.id} done`, text: pin.summary || pin.note, ms: 16000, actions: [
      ['See the change on the page', 'See it', () => seeIt(pin)], ['Open this pin', 'Open', () => openPin(pin)],
    ] });
  } else if (pin.status === 'dismissed') {
    toast({ key, pin: pin.id, kind: 'dismissed', title: `#${pin.id} dismissed`, text: pin.summary || pin.note, ms: 8000 });
  }
}
export function onReply(pin, reply) {
  acceptPin(pin);
  if (reply.kind === 'agent') questions.set(pin.id, reply.body);
  if (loaded && pin.status === 'waiting' && reply.kind === 'agent') {
    toast({ key: `pin:${pin.id}`, pin: pin.id, kind: 'waiting', title: `#${pin.id} needs you`, text: reply.body, ms: 20000, actions: [['Answer this question', 'Answer', () => openPin(pin)]] });
  }
  if (card?.id === pin.id) appendReply(card, reply);
  renderLog();
}
export function renderMarkers() {
  updateCount();
  const desired = new Map();
  if (!markersHidden) {
    for (const pin of pins.values()) {
      if (pin.path === location.pathname && (isOpen(pin) || recentDone(pin))) {
        desired.set(String(pin.id), { pin, target: pin.targets[0], status: pin.status, label: String(pin.id) });
      }
    }
    drafts.items.forEach((draft, index) => {
      if (draftPath(draft) === location.pathname) desired.set(draft.id, { draft, target: draft.body.targets[0], status: 'draft', label: String(index + 1) });
    });
  }
  for (const [key, entry] of markers) {
    if (!desired.has(key)) { entry.node.remove(); markers.delete(key); }
  }
  for (const [key, data] of desired) {
    let entry = markers.get(key);
    if (!entry) {
      const node = button('', '', () => {
        const current = markers.get(key)?.data;
        if (!current || submitting) return;
        if (current.draft) openPopup({ draft: current.draft });
        else openCard(current.pin.id);
      }, 'marker');
      node.dataset.pin = key;
      entry = { node, element: null, data };
      markers.set(key, entry); root.append(node);
    }
    if (entry.data.target.selector !== data.target.selector) entry.element = null;
    entry.data = data;
    entry.node.dataset.status = data.status;
    entry.node.textContent = data.label;
    setTitle(entry.node, data.draft ? `Unsent pin ${data.label}: ${clip(data.draft.body.note, 80)}` : `Open pin ${data.pin.id}: ${statusText(data.pin)}`);
  }
  markDirty();
  renderTray(); syncWatchers(); schedule();
}
export function renderAll() { renderMarkers(); renderLog(); }
// The newest pins of this host (open and closed) in one request; a busy host pages its open pins.
// A call during a fetch asks for one more: the answer on its way can be older than the reason
// for the second call (a resync after the stream came back).
export async function refetch() {
  if (listRequest) { listAgain = true; return listRequest; }
  const started = revision;
  listRequest = (async () => {
    try {
      const received = new Map();
      const first = await api('GET', `/api/pins?host=${encodeURIComponent(HOST)}&status=all&limit=${LIST_LIMIT}`);
      if (!Array.isArray(first?.pins)) throw new Error('The answer holds no pins.');
      for (const pin of first.pins) received.set(pin.id, pin);
      let before = first.pins.length === LIST_LIMIT ? `&before=${first.pins.at(-1).id}` : '';
      while (before) {
        const data = await api('GET', `/api/pins?host=${encodeURIComponent(HOST)}&status=open${before}`);
        for (const pin of data.pins) received.set(pin.id, pin);
        before = data.pins.length === 200 ? `&before=${data.pins.at(-1).id}` : '';
      }
      // A pin that should be in this answer and is not was deleted. Older closed pins that the
      // Log loaded stay: the first page holds only the newest ones.
      const oldest = first.pins.length === LIST_LIMIT ? first.pins.at(-1).id : 0;
      for (const [id, pin] of pins) {
        if (!received.has(id) && (revisions.get(id) || 0) <= started && (id >= oldest || isOpen(pin))) pins.delete(id);
      }
      let unseen = false;
      for (const [id, pin] of received) {
        if ((revisions.get(id) || 0) > started) continue;
        pins.set(id, pin);
        if (pin.status !== 'done' && seen.delete(id)) unseen = true;
      }
      if (unseen) saveSeen();
      loaded = true;
      // A toast speaks about one status of its pin. The pin may have moved on, or be gone.
      for (const [key, item] of toasts) if (item.pin && pins.get(item.pin)?.status !== item.kind) dropToast(key);
      renderAll();
      if (card) loadCard(card);
    } catch (error) { announce(`Pins: ${error.message}`); }
    finally {
      listRequest = null;
      if (listAgain) { listAgain = false; refetch(); }
    }
  })();
  return listRequest;
}
export function openPin(pin) {
  if (pin.path !== location.pathname) { location.assign(`${pin.url}#kog-pin=${pin.id}`); return; }
  openCard(pin.id, true);
}
export function seeIt(pin) {
  const url = new URL(pin.url);
  url.hash = `kog-pin=${pin.id}`;
  if (url.pathname === location.pathname && url.search === location.search) {
    history.replaceState(history.state, '', url.href);
    location.reload();
  } else location.assign(url.href);
}
