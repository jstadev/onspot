// The Settings sheet: the About tabs, the defaults and his presets. The bulk section and the
// shortcuts section have their own modules.
import { ABOUT, PRESET_MAX, PRESET_PICK, SCOPE, validPreset } from './prefs.js';
import { clip } from './format.js';
import { addButton, button, choice, el, errorNode, field, heading, iconButton, panelShell, root, row, setPressed, textarea } from './dom.js';
import { setError, syncWatchers } from './layout.js';
import { prefs, savePrefs } from './local.js';
import { menuButton, menuOpen, settingsButton } from './capsule.js';
import { closePopup } from './notes.js';
import { draftId } from './drafts.js';
import { closeLog } from './log.js';
import { renderKeys } from './settings-keys.js';
import { bulkSection, loadSettings, renderBulk } from './settings-bulk.js';
import { closeCard } from './card.js';

export let settings = null;

function openSettings() {
  closePopup(false); closeCard(false); closeLog();
  settings = panelShell('sheet', 'Settings', () => closeSettings(), 'Close Settings');
  settings.bulk = bulkSection();
  settings.body = el('div', 'panel-body');
  settings.panel.append(settings.bulk.node, settings.body);
  setPressed(settingsButton, true);
  renderSettings(); renderBulk(); syncWatchers();
  settings.close.focus({ preventScroll: true });
  loadSettings(); // each time the sheet opens
}
export function closeSettings(restoreFocus = true) {
  if (!settings) return;
  settings.panel.remove(); settings = null;
  setPressed(settingsButton, false);
  syncWatchers();
  if (restoreFocus) (menuOpen ? settingsButton : menuButton).focus({ preventScroll: true });
}
export function toggleSettings() { if (settings) closeSettings(); else openSettings(); }
// Up and down for one item of `list`. Each change is saved and applies to the next popup.
function moveButtons(list, index, what, key) {
  return [[-1, 'up'], [1, 'down']].map(([step, name]) => {
    const node = iconButton(`Move ${what} ${name}`, name, () => {
      [list[index], list[index + step]] = [list[index + step], list[index]];
      savePrefs(`${key}:${name}`);
    });
    node.dataset.key = `${key}:${name}`;
    node.disabled = !list[index + step];
    return node;
  });
}
export function renderSettings(focusKey = root.activeElement?.dataset?.key) {
  if (!settings) return;
  const body = settings.body, form = settings.form;
  const shown = prefs.tabs.filter(id => !prefs.hidden.includes(id));
  body.replaceChildren(heading('About tabs'), ...prefs.tabs.map((id, index) => {
    const name = ABOUT[id][0], on = shown.includes(id);
    const show = setPressed(iconButton(`${on ? 'Hide' : 'Show'} the ${name} tab`, 'eye', () => {
      prefs.hidden = on ? [...prefs.hidden, id] : prefs.hidden.filter(item => item !== id);
      if (prefs.intent === id) prefs.intent = null;
      savePrefs(`show:${id}`);
    }), on);
    show.dataset.key = `show:${id}`;
    return row(name, '', [show, ...moveButtons(prefs.tabs, index, `the ${name} tab`, `tab:${id}`)], !on);
  }),
  heading('Default tab'), choice('seg', 'Default tab', shown.map(id => [id, ABOUT[id][0], `Start each note with the ${ABOUT[id][0]} tab`]), prefs, 'intent', () => savePrefs()),
  heading('Default scope'), choice('chips', 'Default scope', Object.entries(SCOPE).map(([id, [name, title]]) => [id, name, `Start each note with: ${title}`]), prefs, 'scope', () => savePrefs()),
  heading('Presets', `${prefs.presets.length}/${PRESET_MAX} · up to ${PRESET_PICK} per pin`), ...prefs.presets.map((preset, index) => {
    const what = `the preset ${clip(preset.label, 24)}`;
    const edit = iconButton(`Edit ${what}`, 'edit', () => { settings.form = { ...preset }; renderSettings('preset-label'); });
    edit.dataset.key = `edit:${preset.id}`;
    return row(preset.label, clip(preset.text, 120), [edit, ...moveButtons(prefs.presets, index, what, `preset:${preset.id}`),
      iconButton(`Remove ${what}`, 'close', () => { prefs.presets.splice(index, 1); savePrefs('add'); })]);
  }));
  if (form) {
    const label = field('input', 'preset-label', 'Label, for example: 5 agents', 40);
    const text = textarea('preset-text', 'The instruction that goes with the pin', 500);
    const error = errorNode('onspot-preset-error');
    label.value = form.label; text.value = form.text;
    label.dataset.key = 'preset-label';
    label.addEventListener('input', () => { form.label = label.value; });
    text.addEventListener('input', () => { form.text = text.value; });
    const save = () => {
      const preset = { id: form.id, label: label.value.trim(), text: text.value.trim() };
      if (!validPreset(preset)) { setError(error, 'Write a label and the instruction.'); (preset.label ? text : label).focus(); return; }
      const at = prefs.presets.findIndex(item => item.id === preset.id);
      if (at >= 0) prefs.presets[at] = preset; else prefs.presets.push(preset);
      settings.form = null;
      savePrefs(at >= 0 ? `edit:${preset.id}` : 'add');
    };
    label.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); text.focus(); } });
    text.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); save(); } });
    const footer = el('div', 'panel-footer');
    footer.append(button('Cancel this preset', 'Cancel', () => { settings.form = null; renderSettings('add'); }), button('Save this preset', 'Save', save, 'primary'));
    body.append(label, text, error, footer);
    footer.scrollIntoView({ block: 'nearest' });
  } else if (prefs.presets.length < PRESET_MAX) {
    body.append(addButton('Add a preset', 'add', () => { settings.form = { id: draftId(), label: '', text: '' }; renderSettings('preset-label'); }));
  }
  renderKeys(body);
  if (focusKey) (body.querySelector(`[data-key="${CSS.escape(focusKey)}"]:not(:disabled)`) || settings.close).focus({ preventScroll: true });
}
