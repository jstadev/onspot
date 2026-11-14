// Constants shared by the content script and the background script (docs/protocol.md).

// Deployment values. `build.mjs` replaces each `__ONSPOT_*__` name with the value of its build
// variable, or with `undefined` when the variable is not set. The last value on each line is the
// default; it also applies when the file runs without the build (the unit tests).
/* global __ONSPOT_ROOT_DOMAIN__, __ONSPOT_API_ORIGIN__, __ONSPOT_API__, __ONSPOT_QUEUE_URL__, __ONSPOT_LOGIN_URL__, __ONSPOT_RUN_URL__ */
export const ROOT_DOMAIN = typeof __ONSPOT_ROOT_DOMAIN__ === "string" ? __ONSPOT_ROOT_DOMAIN__ : "koglabs.com"; // pins live on this domain and its subdomains
export const API_ORIGIN = typeof __ONSPOT_API_ORIGIN__ === "string" ? __ONSPOT_API_ORIGIN__ : "https://ai.koglabs.com";
export const API = typeof __ONSPOT_API__ === "string" ? __ONSPOT_API__ : `${API_ORIGIN}/pins`; // REST at API + "/api/..."
export const QUEUE_URL = typeof __ONSPOT_QUEUE_URL__ === "string" ? __ONSPOT_QUEUE_URL__ : `${API_ORIGIN}/triad?tab=pins`; // the Pins tab in the Triad console
export const LOGIN_URL = typeof __ONSPOT_LOGIN_URL__ === "string" ? __ONSPOT_LOGIN_URL__ : `${API_ORIGIN}/login`;
export const RUN_URL = typeof __ONSPOT_RUN_URL__ === "string" ? __ONSPOT_RUN_URL__ : `${API_ORIGIN}/agents?tab=today&run=`; // + the Triad task id: the live view of a run
export const PORT_NAME = "pins-live";
export const PING_MS = 25000;

// Paths the background script forwards; anything else is refused. `/api/settings` takes only SETTINGS_METHODS.
export const API_PATH_RE = /^\/api\/(health|stats|batches|settings|pins(\/[1-9][0-9]{0,11}(\/(start|resolve|dismiss|reopen|replies|accept|revert))?)?)(\?[^#]*)?$/;
export const API_METHODS = ["GET", "POST", "PATCH", "DELETE"];
export const SETTINGS_METHODS = ["GET", "PATCH"];

// Before/after images of a run: fetched by the background script, drawn by the content script.
export const PIN_ID_RE = /^[1-9][0-9]{0,11}$/;
export const SHOT_KINDS = ["before", "after"];
export const SHOT_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const SHOT_MAX = 2 * 1024 * 1024;

export const MSG = {
  API: "api", // content -> bg, one-shot
  STATE: "state", // content -> bg one-shot ({ state } back); bg -> content on the port
  SHOT: "shot", // content -> bg, one-shot: { id, kind } -> { ok, status, type, data (base64) }
  SUB: "sub", // content -> bg on the port
  PING: "ping", // content -> bg on the port
  PIN: "pin", // bg -> content: { action, pin }
  REPLY: "reply", // bg -> content: { pin, reply }
  RESYNC: "resync", // bg -> content: refetch
  SETTINGS: "settings", // bg -> content on every port: { settings } (the whole server settings)
  TOGGLE: "toggle", // bg -> tab: pin mode on/off
};

export const STATE = { LIVE: "live", CONNECTING: "connecting", OFFLINE: "offline", LOGIN: "login" };

// Firefox exposes promise-based `browser`; Chrome MV3 `chrome` returns promises too.
export const ext = globalThis.browser ?? globalThis.chrome;
