// His settings (`kog-pins:prefs`): the pure part. No DOM and no storage, so node tests it.
import { cleanKeys, defaultKeys } from './shortcuts.js';

export const PRESET_MAX = 12, PRESET_PICK = 6;
// About tabs: id -> [name, note placeholder]. Scope: id -> [name, title].
export const ABOUT = {
  text: ['Text', 'The new text, or what to change in the words'], style: ['Style', 'How should it look?'],
  layout: ['Layout', 'Where should it go, or how big?'], behaviour: ['Behaviour', 'What should happen?'],
  remove: ['Remove', 'Anything to keep? (optional)'], task: ['Task', 'What should the agent do?'],
};
export const SCOPE = {
  element: ['This only', 'Change only this element'], similar: ['All like it', 'Change every element like it in the app'],
  page: ['Page', 'Change this page'], site: ['Site', 'Change the whole site'],
};
export const known = (map, id) => typeof id === 'string' && Object.hasOwn(map, id);
export const validPreset = item => typeof item?.id === 'string' && [[item.label, 40], [item.text, 500]].every(([text, max]) => typeof text === 'string' && text.trim() && text.length <= max);

// The stored settings as the code uses them. Missing or bad data falls back to the defaults:
// all six tabs, no default tab or scope, no presets, the default shortcuts.
export function cleanPrefs(value, mac) {
  const prefs = { v: 1, tabs: Object.keys(ABOUT), hidden: [], intent: null, scope: null, presets: [], keys: defaultKeys() };
  if (value?.v !== 1) return prefs;
  prefs.keys = cleanKeys(value.keys, mac);
  const ids = list => [...new Set(Array.isArray(list) ? list : [])].filter(id => known(ABOUT, id));
  prefs.tabs = [...new Set([...ids(value.tabs), ...prefs.tabs])];
  prefs.hidden = ids(value.hidden);
  if (known(ABOUT, value.intent) && !prefs.hidden.includes(value.intent)) prefs.intent = value.intent;
  if (known(SCOPE, value.scope)) prefs.scope = value.scope;
  if (Array.isArray(value.presets)) prefs.presets = value.presets.filter(validPreset).slice(0, PRESET_MAX).map(({ id, label, text }) => ({ id, label, text }));
  return prefs;
}
