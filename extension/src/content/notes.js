// The note popup: what he writes about the picked elements, with the About tab, the scope and
// his presets. A saved note becomes an unsent pin (drafts.js).
import { DRAFT_MAX, SUBMIT_KEYS } from './env.js';
import { describeTarget, labelFor } from './target.js';
import { ABOUT, known, PRESET_PICK, SCOPE, validPreset } from './prefs.js';
import { plural } from './format.js';
import { announce, button, choice, el, errorNode, modifier, panelShell, setPressed, textarea } from './dom.js';
import { schedule, setError, syncWatchers } from './layout.js';
import { prefs, read, store, textKey } from './local.js';
import { pageURL } from './routes.js';
import { pinButton } from './capsule.js';
import { clearSelection, mode, selected, selectionBar } from './picker.js';
import { addDraft, drafts, removeDraft, saveDrafts, submitAll } from './drafts.js';
import { renderAll } from './pins.js';
import { closeSettings } from './settings.js';
import { closeCard } from './card.js';

export let popup = null;

export function openPopup({ quote = '', draft = null } = {}) {
  if (!draft && !selected.length) return;
  closePopup(false); closeCard(false); closeSettings(false);
  const edit = Boolean(draft);
  const instance = panelShell('popup', edit ? draft.body.targets.map(target => target.label).join(' · ') : selected.length === 1 ? labelFor(selected[0]) : `${selected.length} elements`,
    () => closePopup(), edit ? 'Close without saving' : 'Close the note');
  instance.panel.setAttribute('aria-modal', 'true');
  const from = edit ? draft.body : prefs;
  Object.assign(instance, { edit, draft, url: edit ? draft.body.url : pageURL, elements: edit ? [] : [...selected], quote: edit ? draft.body.quote : quote || null, textLoaded: edit, touched: false,
    intent: known(ABOUT, from.intent) ? from.intent : null, scope: known(SCOPE, from.scope) ? from.scope : null,
    presets: edit && Array.isArray(draft.body.presets) ? draft.body.presets.filter(item => validPreset({ ...item, id: '' })).map(({ label, text }) => ({ label, text })) : [] });
  instance.body = el('div', 'panel-body');
  instance.input = textarea(edit ? 'draft-note' : 'pin-note', 'What should change?');
  const placeholder = () => { instance.input.placeholder = ABOUT[instance.intent]?.[1] || 'What should change?'; };
  placeholder();
  // His tabs in his order. An unsent pin keeps a tab that he hid later.
  instance.tabs = choice('seg', 'About', prefs.tabs.filter(id => !prefs.hidden.includes(id) || id === instance.intent)
    .map((id, index) => [id, ABOUT[id][0], `About: ${ABOUT[id][0]} (Alt+${index + 1})`]), instance, 'intent', placeholder);
  instance.body.append(instance.tabs, choice('chips', 'Scope', Object.entries(SCOPE).map(([id, [name, title]]) => [id, name, title]), instance, 'scope'));
  // His presets, plus those an unsent pin holds that Settings no longer has.
  const same = (a, b) => a.label === b.label && a.text === b.text;
  const options = [...prefs.presets, ...instance.presets.filter(item => !prefs.presets.some(preset => same(preset, item)))];
  if (options.length) {
    const row = el('div', 'chips presets');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Presets');
    for (const { label, text } of options) {
      const chosen = () => instance.presets.findIndex(item => same(item, { label, text }));
      const node = setPressed(button(text, label, () => {
        if (chosen() >= 0) instance.presets.splice(chosen(), 1);
        else if (instance.presets.length < PRESET_PICK) instance.presets.push({ label, text });
        else announce(`A pin takes up to ${PRESET_PICK} presets.`);
        setPressed(node, chosen() >= 0);
      }), chosen() >= 0);
      row.append(node);
    }
    instance.body.append(row);
  }
  if (instance.quote) instance.body.append(el('blockquote', 'quote', instance.quote));
  if (edit) instance.input.value = draft.body.note;
  instance.error = errorNode('onspot-note-error');
  instance.input.setAttribute('aria-describedby', instance.error.id);
  instance.input.addEventListener('input', () => { instance.touched = true; saveText(instance); setError(instance.error); instance.input.removeAttribute('aria-invalid'); });
  instance.input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); savePopup(instance, modifier(event)); }
  });
  const footer = el('div', 'panel-footer');
  footer.append(el('span', 'hint', `↵ ${edit ? 'save' : 'add'} · ${SUBMIT_KEYS} submit all`));
  if (edit) footer.append(button('Discard this unsent pin', 'Discard', () => { removeDraft(draft.id); closePopup(); }, 'danger'));
  footer.append(button(edit ? 'Save this unsent pin' : 'Add this pin to the batch', edit ? 'Save' : 'Add pin', () => savePopup(instance, false), 'primary'));
  instance.body.append(instance.input, instance.error, footer);
  instance.panel.append(instance.body);
  popup = instance;
  selectionBar.hidden = true;
  if (!edit) {
    read(textKey(instance.url)).then(text => {
      instance.textLoaded = true;
      if (popup === instance && !instance.touched && typeof text === 'string') instance.input.value = text.slice(0, 4000);
    });
  }
  syncWatchers(); schedule();
  instance.input.focus({ preventScroll: true });
}
export function saveText(instance) {
  if (instance.edit || (!instance.textLoaded && !instance.touched)) return;
  store({ [textKey(instance.url)]: instance.input.value }).catch(() => {});
}
export function closePopup(restoreFocus = true, save = true) {
  if (!popup) return;
  if (save) saveText(popup);
  popup.panel.remove(); popup = null;
  selectionBar.hidden = !mode || !selected.length;
  if (restoreFocus) pinButton.focus({ preventScroll: true });
  syncWatchers(); schedule();
}
function savePopup(instance, thenSubmit) {
  if (popup !== instance) return;
  // With the Remove tab the note may be empty.
  const note = instance.input.value.trim() || (instance.intent === 'remove' ? 'Remove this element.' : '');
  const picks = { intent: instance.intent, scope: instance.scope, presets: instance.presets };
  if (!note) {
    // An empty note with ⌘↵ submits the pins that are already there.
    if (thenSubmit && !instance.edit && drafts.items.length) { closePopup(false, false); clearSelection(); submitAll(); return; }
    setError(instance.error, 'Write what should change.');
    instance.input.setAttribute('aria-invalid', 'true'); instance.input.focus(); return;
  }
  if (instance.edit) {
    const draft = drafts.items.find(item => item.id === instance.draft.id);
    if (draft) { draft.body = { ...draft.body, note, ...picks }; saveDrafts(); }
    closePopup();
    announce('Unsent pin saved.');
  } else {
    if (drafts.items.length >= DRAFT_MAX) { setError(instance.error, `Submit your pins first. You can keep up to ${DRAFT_MAX}.`); return; }
    let targets;
    try { targets = instance.elements.map(describeTarget); }
    catch (error) { setError(instance.error, error.message); return; }
    addDraft({
      url: instance.url, title: document.title.slice(0, 300), note, quote: instance.quote, targets,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, scrollX, scrollY }, ...picks,
    });
    store({ [textKey(instance.url)]: '' }).catch(() => {});
    closePopup(false, false);
    clearSelection();
    announce(`Pin added. ${plural(drafts.items.length, 'pin')} ready to submit.`);
  }
  renderAll();
  if (thenSubmit) submitAll();
}
