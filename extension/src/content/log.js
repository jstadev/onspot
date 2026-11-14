// The Log: the unsent pins and the sent pins of this host, grouped by batch.
import { HOST, SUBMIT_KEYS } from './env.js';
import { resolveTarget } from './target.js';
import { clip, plural, statusText, when } from './format.js';
import { button, el, link, panelShell, root, setPressed } from './dom.js';
import { schedule, syncWatchers } from './layout.js';
import { api } from './live.js';
import { logButton, menuButton, menuOpen, queueURL } from './capsule.js';
import { closePopup, openPopup } from './notes.js';
import { draftPath, drafts, submitAll, submitting } from './drafts.js';
import { openPin, pins, questions, renderAll, revision, revisions } from './pins.js';
import { closeSettings } from './settings.js';
import { closeCard } from './card.js';

export let log = null;
let historyRequest = null;

export function toggleLog(force) {
  if (log && force !== true) { closeLog(true); return; }
  openLog();
}
function openLog() {
  closePopup(false); closeCard(false); closeSettings(false);
  if (!log) {
    const instance = panelShell('log', 'Log', () => closeLog(true), 'Close the log');
    instance.title.textContent = 'Log';
    instance.title.append(el('span', 'log-host', HOST));
    instance.list = el('div', 'log-body');
    const footer = el('div', 'log-footer');
    footer.append(link('Open every site\'s pins in the Triad Pins tab', queueURL, 'link', 'All pins in Triad'));
    instance.panel.append(instance.list, footer);
    log = instance;
    setPressed(logButton, true);
  }
  renderLog(); loadHistory();
  log.close.focus({ preventScroll: true });
  syncWatchers(); schedule();
}
export function closeLog(restoreFocus = false) {
  if (!log) return;
  log.panel.remove(); log = null;
  setPressed(logButton, false);
  if (restoreFocus) (menuOpen ? logButton : menuButton).focus({ preventScroll: true });
  syncWatchers(); schedule();
}
export async function loadHistory() {
  if (historyRequest) return historyRequest;
  const started = revision;
  historyRequest = (async () => {
    try {
      const data = await api('GET', `/api/pins?host=${encodeURIComponent(HOST)}&status=all&limit=100`);
      for (const pin of data.pins) if ((revisions.get(pin.id) || 0) <= started) pins.set(pin.id, pin);
      renderAll();
    } catch (error) { if (log) log.list.prepend(el('p', 'error', error.message)); }
    finally { historyRequest = null; }
  })();
  return historyRequest;
}
function logRow(key, status, number, note, meta, detail, action, title) {
  const row = button(title, undefined, action, 'log-row');
  row.removeAttribute('aria-label'); // a screen reader reads the row itself: status, number, note, detail
  row.dataset.key = key;
  row.dataset.status = status.key;
  const head = el('span', 'log-row-head');
  const chip = el('span', 'chip', status.text);
  chip.dataset.status = status.key;
  head.append(chip, el('span', 'log-number', number));
  row.append(head, el('span', 'log-note', note), el('span', 'log-meta', meta));
  if (detail) row.append(el('span', `log-detail${status.key === 'waiting' ? ' ask' : ''}`, detail));
  return row;
}
export function renderLog() {
  if (!log) return;
  const focused = root.activeElement?.closest?.('.log-row')?.dataset.key;
  const list = el('div', 'log-list');
  if (drafts.items.length) {
    const section = el('section', 'log-group');
    const head = el('div', 'log-group-head');
    head.append(el('span', '', `Not sent · ${drafts.items.length}`));
    head.append(button(`Submit all pins (${SUBMIT_KEYS})`, submitting ? 'Sending…' : 'Submit all', () => submitAll(), 'primary small'));
    section.append(head);
    drafts.items.forEach((draft, index) => {
      const path = draftPath(draft);
      section.append(logRow(draft.id, { key: 'draft', text: 'Unsent' }, String(index + 1), draft.body.note,
        `${clip(draft.body.targets[0]?.label, 60)} · ${path}`, '', () => focusDraft(draft), `Edit unsent pin ${index + 1}`));
    });
    list.append(section);
  }
  const sent = [...pins.values()].sort((a, b) => b.id - a.id).slice(0, 100);
  const groups = new Map();
  for (const pin of sent) {
    const key = pin.batch ? `b${pin.batch}` : `p${pin.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pin);
  }
  for (const [key, items] of groups) {
    const section = el('section', 'log-group');
    const done = items.filter(pin => pin.status === 'done').length;
    const head = el('div', 'log-group-head');
    head.append(el('span', '', `Sent ${when(items.at(-1).createdAt)} · ${plural(items.length, 'pin')}`), el('span', 'log-progress', `${done}/${items.length} done`));
    section.dataset.batch = key;
    section.append(head);
    for (const pin of items) {
      const detail = pin.status === 'done' ? `${clip(pin.summary, 200)}${pin.commit ? ` · ${String(pin.commit).slice(0, 7)}` : ''}`
        : pin.status === 'waiting' ? clip(questions.get(pin.id) || 'Open it to answer.', 200)
        : pin.status === 'dismissed' ? clip(pin.summary || '', 160)
        : pin.status === 'working' ? clip(pin.progress?.text, 200) || `Started ${when(pin.startedAt)}` : '';
      section.append(logRow(String(pin.id), { key: pin.status, text: statusText(pin) }, `#${pin.id}`, pin.note,
        `${clip(pin.targets[0]?.label, 60)} · ${pin.path}`, detail, () => openPin(pin), `Open pin ${pin.id}`));
    }
    list.append(section);
  }
  if (!list.childElementCount) list.append(el('p', 'log-empty', 'No pins yet. Press Pin, click an element and write what should change. Add more, then Submit all.'));
  log.list.replaceChildren(list);
  if (focused) log.list.querySelector(`.log-row[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  schedule();
}
function focusDraft(draft) {
  if (draftPath(draft) !== location.pathname) { location.assign(draft.body.url); return; }
  const element = resolveTarget(draft.body.targets[0]);
  element?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  closeLog();
  openPopup({ draft });
}
