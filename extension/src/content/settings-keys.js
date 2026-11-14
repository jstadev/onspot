// Settings, section "Shortcuts": one row per shortcut, the form that records a key, the reset
// and the line with the fixed keys. The rules are in shortcuts.js.
import { MAC, SUBMIT_KEYS } from './env.js';
import { actionName, ACTIONS, comboFromEvent, defaultKeys, formatCombo, isDefaultKeys, KEYS_MAX, shortcutError } from './shortcuts.js';
import { addButton, button, el, errorNode, heading, iconButton, row } from './dom.js';
import { setError } from './layout.js';
import { prefs, savePrefs } from './local.js';
import { renderSettings, settings } from './settings.js';

// The row of the shortcut that the open form edits, or -1 (a new one, or another tab removed it).
const keyFormRow = form => form.from ? prefs.keys.findIndex(item => item.action === form.from.action && item.combo === form.from.combo) : -1;
export function closeKeyForm() {
  const at = keyFormRow(settings.keyForm);
  settings.keyForm = null;
  renderSettings(at >= 0 ? `key:${at}` : 'key-add');
}
// Settings, section "Shortcuts": one row per shortcut, the form, the reset and the fixed keys.
export function renderKeys(body) {
  const keys = prefs.keys, form = settings.keyForm;
  body.append(heading('Shortcuts', `${keys.length}/${KEYS_MAX}`), ...keys.map((item, index) => {
    const shown = formatCombo(item.combo, MAC), name = actionName(item.action);
    const edit = iconButton(`Edit the shortcut ${shown}: ${name}`, 'edit', () => { settings.keyForm = { from: item, action: item.action, combo: item.combo }; renderSettings('key-action'); });
    edit.dataset.key = `key:${index}`;
    const node = row(name, '', [el('kbd', 'keys', shown), edit, iconButton(`Remove the shortcut ${shown}: ${name}`, 'close', () => {
      keys.splice(index, 1);
      savePrefs(keys.length ? `key:${Math.min(index, keys.length - 1)}` : 'key-add');
    })]);
    node.classList.add('key-row');
    return node;
  }));
  if (form) {
    const action = el('select'), field = el('input'), error = errorNode('onspot-key-error');
    action.name = 'shortcut-action';
    action.setAttribute('aria-label', 'Action of the shortcut');
    action.dataset.key = 'key-action';
    for (const [id, name] of [['', 'Choose an action'], ...ACTIONS]) {
      const option = el('option', '', name);
      option.value = id; option.disabled = !id;
      action.append(option);
    }
    action.value = form.action;
    action.addEventListener('change', () => { form.action = action.value; setError(error); });
    field.name = 'shortcut-keys';
    field.dataset.key = 'key-field';
    field.readOnly = true;
    field.placeholder = 'Press the keys';
    field.setAttribute('aria-label', 'Keys of the shortcut. Press the keys');
    field.setAttribute('aria-describedby', error.id);
    field.value = formatCombo(form.combo, MAC);
    // While this field has the focus, the next key press with a real key becomes the combo.
    // Esc and Tab keep their jobs. No shortcut fires here (see onShortcut).
    field.addEventListener('keydown', event => {
      if (event.key === 'Escape' || event.key === 'Tab' || event.isComposing) return;
      event.preventDefault(); event.stopPropagation();
      const combo = comboFromEvent(event, MAC);
      if (!combo) return;
      form.combo = combo;
      field.value = formatCombo(combo, MAC);
      setError(error);
    });
    const save = () => {
      const at = keyFormRow(form), entry = { action: form.action, combo: form.combo };
      const reason = shortcutError(keys, entry, at, MAC);
      if (reason) { setError(error, reason); (form.action ? field : action).focus(); return; }
      if (at >= 0) keys[at] = entry; else keys.push(entry);
      settings.keyForm = null;
      savePrefs(`key:${at >= 0 ? at : keys.length - 1}`);
    };
    const footer = el('div', 'panel-footer');
    footer.append(button('Cancel this shortcut', 'Cancel', closeKeyForm), button('Save this shortcut', 'Save', save, 'primary'));
    body.append(action, field, error, footer);
    footer.scrollIntoView({ block: 'nearest' });
  } else if (keys.length < KEYS_MAX) {
    body.append(addButton('Add a shortcut', 'key-add', () => { settings.keyForm = { from: null, action: '', combo: '' }; renderSettings('key-action'); }));
  }
  if (!isDefaultKeys(keys)) {
    const reset = el('div', 'confirm-inline reset');
    const ask = value => { settings.reset = value; renderSettings(value ? 'key-keep' : 'key-reset'); };
    if (settings.reset) {
      const keep = button('Keep your shortcuts', 'Keep', () => ask(false));
      keep.dataset.key = 'key-keep';
      reset.append(el('span', '', 'Reset all shortcuts?'), keep, button('Confirm: put the default shortcuts back', 'Reset', () => {
        prefs.keys = defaultKeys(); settings.reset = false; settings.keyForm = null;
        savePrefs('key-add');
      }, 'danger'));
    } else {
      const start = button('Put the default shortcuts back', 'Reset shortcuts', () => ask(true), 'subtle');
      start.dataset.key = 'key-reset';
      reset.append(start);
    }
    body.append(reset);
  } else settings.reset = false;
  body.append(el('p', 'row-text fixed-keys', `Fixed keys: ↵ adds the pin, ${SUBMIT_KEYS} submits all, Shift+↵ starts a new line, Esc closes, Alt+1 to Alt+6 pick the About tab. Alt+Shift+P also toggles pin mode: change it in the browser.`));
}
