import test from "node:test";
import assert from "node:assert/strict";
import { apiFetch, loggedOut, trustedSender } from "../src/bg/request.js";
import { API, ROOT_DOMAIN } from "../src/shared/protocol.js";

const ID = "onspotextensionid";
const sender = (overrides = {}) => ({ id: ID, tab: { id: 7 }, frameId: 0, url: "https://crete.koglabs.com/pricing", ...overrides });

test("a sender is trusted only as this extension on an https page of the root domain", () => {
  assert.equal(ROOT_DOMAIN, "koglabs.com");
  // Chrome also runs the content script on a host name with one dot at the end.
  const trusted = ["https://koglabs.com/", "https://crete.koglabs.com/pricing?x=1#y", "https://a.b.c.koglabs.com/", "https://KogLabs.com/", "https://ai.koglabs.com:8443/agents",
    "https://koglabs.com./", "https://crete.koglabs.com./pricing"];
  for (const url of trusted) assert.equal(trustedSender(sender({ url }), ID), true, url);
  // A page outside a tab (a sidebar, a side panel) has no `tab`; the id and the URL are the rule.
  for (const tab of [undefined, null]) assert.equal(trustedSender(sender({ tab }), ID), true, `tab ${tab}`);
  // A prerendered page has another frame id than 0 in Chrome; the frame id is not part of the rule.
  assert.equal(trustedSender(sender({ frameId: 1234 }), ID), true);
  const refused = [
    "http://koglabs.com/", "http://crete.koglabs.com/", "https://evil.example/", "https://koglabs.com.evil.example/", "https://notkoglabs.com/",
    "https://evil.example/koglabs.com", "https://evil.example/?u=https://koglabs.com/", "https://evil.example/#https://koglabs.com/",
    "https://koglabs.com@evil.example/", "https://koglabs.com../", "https://evil.example./", "https://koglabs.com.evil.example./",
    "https://koglabs.co/", "https://xn--koglabs-.com/", "wss://koglabs.com/",
    "file:///koglabs.com/", "about:blank", "data:text/html,koglabs.com", "blob:https://koglabs.com/1", `chrome-extension://${ID}/popup.html`,
    "moz-extension://2f1e8a5c-0000-4000-8000-000000000000/", "koglabs.com", "", " https://evil.example/", undefined, null, 7, {}, ["https://koglabs.com/"],
  ];
  for (const url of refused) assert.equal(trustedSender(sender({ url }), ID), false, String(url));
  // An extension page has another URL scheme, with or without a tab.
  for (const url of [`chrome-extension://${ID}/popup.html`, "moz-extension://2f1e8a5c-0000-4000-8000-000000000000/"]) assert.equal(trustedSender({ id: ID, url }, ID), false, url);
  for (const bad of [undefined, null, {}, "sender", { id: ID }, sender({ id: "another-extension" }), sender({ id: undefined }), sender({ id: "another-extension", tab: undefined }),
    sender({ url: "https://evil.example/", tab: undefined })]) {
    assert.equal(trustedSender(bad, ID), false, JSON.stringify(bad));
  }
  // No extension id (a broken runtime) trusts nobody, also a sender without an id.
  for (const id of [undefined, null, ""]) assert.equal(trustedSender(sender({ id }), id), false);
});

test("apiFetch sends every request to the API with the cookie and follows no redirect", async () => {
  const calls = [];
  const signal = AbortSignal.abort();
  await apiFetch(async (...args) => { calls.push(args); }, "/api/pins/12", { method: "PATCH", signal, credentials: "omit", redirect: "follow" });
  assert.deepEqual(calls, [[`${API}/api/pins/12`, { method: "PATCH", signal, credentials: "include", redirect: "manual" }]]);
  assert.equal(new URL(calls[0][0]).origin, new URL(API).origin);
});

test("a 401 and a redirect mean that the session is gone; other answers do not", () => {
  assert.equal(loggedOut({ status: 401, type: "basic" }), true);
  assert.equal(loggedOut({ status: 0, type: "opaqueredirect" }), true);
  for (const status of [200, 204, 302, 403, 404, 500]) assert.equal(loggedOut({ status, type: "basic" }), false, String(status));
});
