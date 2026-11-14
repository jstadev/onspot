// Keys: his shortcuts (one window listener) and the fixed keys of our UI (Esc, Enter, Tab,
// Alt+1 to Alt+6).
import { MAC } from './env.js';
import { actionFor } from './shortcuts.js';
import { announce, host, modifier, pickAt, root } from './dom.js';
import { prefs } from './local.js';
import { menuButton, menuOpen, queueURL, setMenu, toggleEye } from './capsule.js';
import { toggleFreeze } from './freeze.js';
import { mode, selected, setMode, toggleMode } from './picker.js';
import { closePopup, openPopup, popup } from './notes.js';
import { discardButton, discardConfirm, drafts, renderTray, submitAll } from './drafts.js';
import { closeLog, log, toggleLog } from './log.js';
import { closeSettings, renderSettings, settings, toggleSettings } from './settings.js';
import { closeKeyForm } from './settings-keys.js';
import { card, closeCard } from './card.js';

// What each shortcut action does (the list is in shortcuts.js).
const actions = {
  mode: toggleMode, eye: toggleEye, menu: () => setMenu(!menuOpen), log: () => toggleLog(), settings: toggleSettings, freeze: toggleFreeze,
  queue: () => window.open(queueURL, '_blank', 'noopener,noreferrer'),
  submit: () => { if (drafts.items.length) submitAll(); else announce('No unsent pins.'); },
};
// One window listener for every shortcut. Capture runs first, also in our own fields, and the
// page never gets a matched key. A plain key leaves at the first test.
export function onShortcut(event) {
  if (!event.isTrusted || !(event.ctrlKey || event.metaKey || event.altKey) || event.isComposing || root.activeElement?.name === 'shortcut-keys') return;
  const action = actionFor(prefs.keys, event, MAC);
  if (!action) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (!event.repeat) actions[action]();
}
export function onPageKey(event) {
  if (!event.isTrusted || event.composedPath().includes(host)) return;
  onKey(event);
}
export function onKey(event) {
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation();
    if (!discardConfirm.hidden) { discardConfirm.hidden = true; renderTray(); discardButton.focus({ preventScroll: true }); }
    else if (popup) closePopup();
    else if (card) closeCard();
    else if (settings?.keyForm) closeKeyForm();
    else if (settings?.reset) { settings.reset = false; renderSettings('key-reset'); }
    else if (settings?.form) { settings.form = null; renderSettings('add'); }
    else if (settings) closeSettings();
    else if (log) closeLog(true);
    else if (menuOpen) { setMenu(false); menuButton.focus({ preventScroll: true }); }
    else if (mode) setMode(false);
    return;
  }
  // Alt+1 to Alt+6 pick the visible About tabs. `code`, because macOS Option changes `key`.
  if (popup && event.altKey && !modifier(event) && /^Digit[1-6]$/.test(event.code)) {
    event.preventDefault(); event.stopPropagation();
    pickAt(popup.tabs, event.code.slice(5) - 1);
    return;
  }
  const panel = (popup || card || settings || log)?.panel;
  if (event.key === 'Tab' && panel) {
    const controls = [...panel.querySelectorAll('button, textarea, input, select, a[href]')].filter(node => !node.disabled && !node.closest('[hidden]'));
    const active = root.activeElement;
    if (controls.length && (event.shiftKey ? active === controls[0] : active === controls.at(-1))) {
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls[0]).focus();
    }
  }
  if (event.key === 'Enter' && !event.isComposing && !popup && !card) {
    if (modifier(event) && drafts.items.length && (mode || root.activeElement)) { event.preventDefault(); event.stopPropagation(); submitAll(); }
    else if (mode && selected.length && !modifier(event)) { event.preventDefault(); event.stopPropagation(); openPopup(); }
  }
}
