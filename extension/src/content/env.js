// Facts of this page and this build, and the limits of the content script.

/* global __ONSPOT_VERSION__ */
export const VERSION = typeof __ONSPOT_VERSION__ === 'string' ? __ONSPOT_VERSION__ : '0.0.0';
export const BATCH_MAX = 30, DRAFT_MAX = 200, SEEN_MAX = 300, RECENT_MS = 24 * 3600e3, LIST_LIMIT = 50;
export const SHOT_CACHE = 6, SHOT_WIDTH = 1280;
export const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const SUBMIT_KEYS = MAC ? '⌘↵' : 'Ctrl+↵';
export const HOST = location.host;
// A name for this tab. A storage event that carries it is this tab's own write.
export const TAB = Math.random().toString(36).slice(2);
// The keys in `ext.storage.local`. Text of an open note and v1 failed sends have a key per page (local.js).
export const PREFS_KEY = 'kog-pins:prefs';
export const draftsKey = `kog-pins:drafts:${HOST}`, seenKey = `kog-pins:seen:${HOST}`, hiddenKey = `kog-pins:hidden:${HOST}`;
