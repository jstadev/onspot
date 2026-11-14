// Keyboard shortcuts: the pure part. No DOM and no storage, so node tests every rule.
//
// A combo is a string: the modifiers `Mod+`, `Ctrl+`, `Alt+`, `Shift+` in this order, then one
// `KeyboardEvent.code`. `Mod` is the Command key on a Mac and the Control key elsewhere. `Ctrl`
// (the real Control key) exists only on a Mac. The code, not the character: a Greek layout works.

// The fixed list of actions: id, name in the UI, default combo ('' = none).
export const ACTIONS = [
  ['mode', 'Toggle pin mode', 'Mod+KeyM'],
  ['eye', 'Hide or show markers', 'Mod+KeyK'],
  ['menu', 'Open or close the menu', 'Alt+Shift+KeyM'],
  ['log', 'Open or close the Log', 'Alt+Shift+KeyL'],
  ['settings', 'Open or close Settings', 'Alt+Shift+KeyS'],
  ['freeze', 'Pause or resume page animations', 'Alt+Shift+KeyF'],
  ['queue', 'Open the queue', 'Alt+Shift+KeyQ'],
  ['submit', 'Submit all', ''],
];
export const KEYS_PER_ACTION = 3, KEYS_MAX = 24;

const PUNCTUATION = { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`' };
const COMBO = /^(Mod\+)?(Ctrl\+)?(Alt\+)?(Shift\+)?([A-Za-z0-9]+)$/;
const ALLOWED = /^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2]))$/;
const MODIFIER = /^(?:Shift|Control|Alt|Meta|OS)(?:Left|Right)$/;
// Mod + one of these, with or without Shift, belongs to the browser (copy, paste, close, new tab).
const BROWSER = /^Key[ACVXZYWTNQ]$/;

export const actionName = id => ACTIONS.find(([action]) => action === id)?.[1] || '';
export const defaultKeys = () => ACTIONS.filter(([, , combo]) => combo).map(([action, , combo]) => ({ action, combo }));
export const isDefaultKeys = keys => JSON.stringify(keys) === JSON.stringify(defaultKeys());

// The parts of a combo string, or null when it is not one. Off a Mac there is no `Ctrl`.
export function parseCombo(combo, mac) {
  const match = typeof combo === 'string' && COMBO.exec(combo);
  if (!match || (match[2] && !mac)) return null;
  return { mod: Boolean(match[1]), ctrl: Boolean(match[2]), alt: Boolean(match[3]), shift: Boolean(match[4]), code: match[5] };
}

// The combo of a key press, or '' for a press that can never be one: a bare modifier, the
// Windows or Super key off a Mac, and AltGr (it types characters on many layouts).
export function comboFromEvent(event, mac) {
  const code = event.code;
  if (!code || MODIFIER.test(code) || (!mac && event.metaKey) || event.getModifierState?.('AltGraph')) return '';
  return `${(mac ? event.metaKey : event.ctrlKey) ? 'Mod+' : ''}${mac && event.ctrlKey ? 'Ctrl+' : ''}${event.altKey ? 'Alt+' : ''}${event.shiftKey ? 'Shift+' : ''}${code}`;
}

// What he reads: "⌘K" and "⌥⇧L" on a Mac (the order of the macOS menus), "Ctrl+K" elsewhere.
export function formatCombo(combo, mac) {
  const parts = parseCombo(combo, true);
  if (!parts) return '';
  const key = Object.hasOwn(PUNCTUATION, parts.code) ? PUNCTUATION[parts.code] : parts.code.replace(/^(?:Key|Digit)(.)$/, '$1');
  return mac ? `${parts.ctrl ? '⌃' : ''}${parts.alt ? '⌥' : ''}${parts.shift ? '⇧' : ''}${parts.mod ? '⌘' : ''}${key}`
    : [parts.mod && 'Ctrl', parts.alt && 'Alt', parts.shift && 'Shift', key].filter(Boolean).join('+');
}

// Why `entry` cannot join `keys`, or '' when it can. `at` is the index that it replaces (-1 = new).
export function shortcutError(keys, entry, at, mac) {
  const { action, combo } = entry || {};
  if (!actionName(action)) return 'Choose an action.';
  if (!combo) return 'Press the keys first.';
  const parts = parseCombo(combo, mac);
  if (!parts) return 'That key cannot be a shortcut.';
  if (!parts.mod && !parts.ctrl && !parts.alt) return mac ? 'Add ⌘, Ctrl or Alt to the key.' : 'Add Ctrl or Alt to the key.';
  if (!ALLOWED.test(parts.code) && !Object.hasOwn(PUNCTUATION, parts.code)) return 'That key cannot be a shortcut.';
  if (parts.mod && !parts.ctrl && !parts.alt && BROWSER.test(parts.code)) return 'The browser keeps that key.';
  if (parts.alt && !parts.mod && !parts.ctrl && !parts.shift && /^Digit[1-6]$/.test(parts.code)) return 'Alt+1 to Alt+6 pick the About tabs.';
  const others = keys.filter((_, index) => index !== at);
  const used = others.find(item => item.combo === combo);
  if (used) return `That key already does: ${actionName(used.action)}.`;
  if (others.filter(item => item.action === action).length >= KEYS_PER_ACTION) return `An action takes up to ${KEYS_PER_ACTION} shortcuts.`;
  if (others.length >= KEYS_MAX) return `You can keep up to ${KEYS_MAX} shortcuts.`;
  return '';
}

// The stored list. Missing (an older build) or not a list: the defaults. An empty list is valid:
// he removed every shortcut. A bad entry is dropped.
export function cleanKeys(value, mac) {
  if (!Array.isArray(value)) return defaultKeys();
  const keys = [];
  for (const item of value) {
    const entry = { action: item?.action, combo: item?.combo };
    if (!shortcutError(keys, entry, -1, mac)) keys.push(entry);
  }
  return keys;
}

// The action of a key press, or undefined. The modifier set must be exact.
export function actionFor(keys, event, mac) {
  const combo = comboFromEvent(event, mac);
  return combo ? keys.find(item => item.combo === combo)?.action : undefined;
}

// The first combo of an action as he reads it, or '' when it has none.
export function firstKey(keys, action, mac) {
  return formatCombo(keys.find(item => item.action === action)?.combo, mac);
}
