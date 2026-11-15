// What this device keeps (`ext.storage.local`): the write queue, his settings, the first load
// and the changes that other tabs make.
import { ext } from '../shared/protocol.js';
import { DRAFT_MAX, draftsKey, hiddenKey, MAC, PREFS_KEY, seenKey, TAB } from './env.js';
import { cleanPrefs } from './prefs.js';
import { announce } from './dom.js';
import { pageURL } from './routes.js';
import { markersHidden, renderTitles, setHidden } from './capsule.js';
import { draftId, drafts, saveDrafts, takeDrafts, validBody } from './drafts.js';
import { renderAll, renderMarkers, takeSeen } from './pins.js';
import { renderSettings } from './settings.js';

let storageChain = Promise.resolve();
// Our own settings writes come back as storage events. Their JSON is kept here to skip them.
const prefsWrites = new Set();
export let prefs = cleanPrefs(undefined, MAC);

export function textKey(url = pageURL) { return `kog-pins:draft:${url}`; } // unsent textarea text; it does not keep images
function legacyKey(url = pageURL) { return `kog-pins:pending:${url}`; } // v1 failed sends
// Writes run one after the other, so a later write never lands before an earlier one.
function write(task) {
  storageChain = storageChain.catch(() => {}).then(task);
  storageChain.catch(() => announce('Your browser could not save your changes.'));
  return storageChain;
}
export const store = values => write(() => ext.storage.local.set(values));
export const forget = key => write(() => ext.storage.local.remove(key));
export async function read(key) {
  try { await storageChain.catch(() => {}); return (await ext.storage.local.get(key))[key]; }
  catch { return undefined; }
}
export async function loadLocal() {
  const [stored, legacy, seenList, storedPrefs, hidden] = await Promise.all([read(draftsKey), read(legacyKey()), read(seenKey), read(PREFS_KEY), read(hiddenKey)]);
  takeDrafts(stored);
  prefs = cleanPrefs(storedPrefs, MAC);
  if ((hidden === true) !== markersHidden) setHidden(hidden === true);
  takeSeen(seenList);
  // v1 kept a failed send per page. It becomes an unsent pin here, so nothing is lost.
  const moved = Array.isArray(legacy) ? legacy.filter(item => validBody(item?.body)) : [];
  if (moved.length) {
    for (const item of moved) if (drafts.items.length < DRAFT_MAX) drafts.items.push({ id: draftId(), body: item.body, createdAt: new Date().toISOString() });
    store({ [legacyKey()]: [] });
    saveDrafts();
  }
  renderTitles(); renderAll();
}
export function watchStorage() {
  ext.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    const next = changes[draftsKey]?.newValue;
    if (changes[draftsKey] && next?.tab !== TAB) { takeDrafts(next); renderAll(); }
    if (changes[seenKey]) { takeSeen(changes[seenKey].newValue); renderMarkers(); }
    // Settings from another tab. Our own writes come back too; those are skipped.
    if (changes[PREFS_KEY] && !prefsWrites.delete(JSON.stringify(changes[PREFS_KEY].newValue))) { prefs = cleanPrefs(changes[PREFS_KEY].newValue, MAC); renderSettings(); renderTitles(); }
    // The eye of another tab of this host. Our own write comes back with the state we already have.
    if (changes[hiddenKey] && (changes[hiddenKey].newValue === true) !== markersHidden) setHidden(!markersHidden);
  });
}
export function savePrefs(focusKey) {
  const json = JSON.stringify(prefs); // a snapshot: the write waits its turn and `prefs` may change
  prefsWrites.add(json);
  store({ [PREFS_KEY]: JSON.parse(json) }).catch(() => {});
  renderSettings(focusKey); renderTitles();
}
