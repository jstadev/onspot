import { API, ROOT_DOMAIN } from "../shared/protocol.js";

// The one place where the background script calls `fetch`. Every request goes to the API with
// the hub cookie. It follows no redirect: a redirect could carry the cookie or a pin to another
// address.
export function apiFetch(fetchRequest, path, options) {
  return fetchRequest(API + path, { ...options, credentials: "include", redirect: "manual" });
}

// A 401 or a redirect means that the session is gone: the proxy sends a signed-out request to
// the login page, and the API itself never redirects.
export const loggedOut = (response) => response.status === 401 || response.type === "opaqueredirect";

function pinnable(url) {
  if (typeof url !== "string") return false;
  try {
    const { protocol, hostname } = new URL(url);
    // Chrome also runs the content script on a host name with one dot at the end ("koglabs.com.").
    const host = hostname.replace(/\.$/, "");
    return protocol === "https:" && (host === ROOT_DOMAIN || host.endsWith(`.${ROOT_DOMAIN}`));
  } catch {
    return false;
  }
}

// Only the content script of this extension, on a page of the root domain or a subdomain, may
// send a message or open a port. The browser fills `sender`; a page cannot set it. An extension
// page has this id too, but another URL scheme. `tab` is not checked: a page in a sidebar or a
// side panel has none. The frame id is not checked: Chrome gives a prerendered page another id
// than 0.
export function trustedSender(sender, extensionId) {
  return Boolean(extensionId) && sender?.id === extensionId && pinnable(sender.url);
}
