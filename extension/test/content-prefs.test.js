import test from "node:test";
import assert from "node:assert/strict";
import { ABOUT, PRESET_MAX, PRESET_PICK, SCOPE, cleanPrefs, known, validPreset } from "../src/content/prefs.js";
import { defaultKeys } from "../src/content/shortcuts.js";

const tabs = ["text", "style", "layout", "behaviour", "remove", "task"];
const defaults = () => ({ v: 1, tabs, hidden: [], intent: null, scope: null, presets: [], keys: defaultKeys() });
const preset = (id, label = "5 agents", text = "Start a thread and delegate 5 agents.") => ({ id, label, text });

test("the tabs, the scopes and the limits are the contract", () => {
  assert.deepEqual(Object.keys(ABOUT), tabs);
  assert.deepEqual(Object.keys(SCOPE), ["element", "similar", "page", "site"]);
  for (const entry of [...Object.values(ABOUT), ...Object.values(SCOPE)]) assert.ok(entry.length === 2 && entry.every(text => typeof text === "string" && text));
  assert.equal(PRESET_MAX, 12);
  assert.equal(PRESET_PICK, 6);
});

test("known takes only an own name of the map", () => {
  assert.equal(known(ABOUT, "text"), true);
  for (const id of ["Text", "", "constructor", "toString", "__proto__", 7, null, undefined, ["text"], {}]) assert.equal(known(ABOUT, id), false, String(id));
});

test("missing or bad data gives the defaults", () => {
  for (const value of [undefined, null, "garbage", 7, [], {}, { v: 2, hidden: ["text"] }, { v: "1" }]) assert.deepEqual(cleanPrefs(value, false), defaults(), JSON.stringify(value));
  assert.deepEqual(cleanPrefs({ v: 1 }, false), defaults(), "v 1 with no other field");
  assert.deepEqual(cleanPrefs({ v: 1, tabs: "x", hidden: [7], intent: ["text"], scope: "galaxy", presets: [{ id: 1, label: "x", text: "y" }, null], keys: "x" }, false), defaults());
  const one = cleanPrefs(undefined, false), two = cleanPrefs(undefined, false);
  one.tabs.push("x"); one.keys.pop(); one.presets.push(1);
  assert.deepEqual(two, defaults(), "each call gives new lists");
});

test("tabs keep his order, lose unknown and double ids, and get the missing ids back", () => {
  assert.deepEqual(cleanPrefs({ v: 1, tabs: ["task", "text", "nope", "task", 7] }, false).tabs, ["task", "text", "style", "layout", "behaviour", "remove"]);
  assert.deepEqual(cleanPrefs({ v: 1, tabs: [...tabs].reverse() }, false).tabs, [...tabs].reverse());
  assert.deepEqual(cleanPrefs({ v: 1, hidden: ["layout", "nope", "layout", null] }, false).hidden, ["layout"]);
});

test("the default tab must be known and not hidden; the default scope must be known", () => {
  assert.equal(cleanPrefs({ v: 1, intent: "style" }, false).intent, "style");
  assert.equal(cleanPrefs({ v: 1, intent: "style", hidden: ["style"] }, false).intent, null);
  assert.equal(cleanPrefs({ v: 1, intent: "nope" }, false).intent, null);
  assert.equal(cleanPrefs({ v: 1, scope: "site" }, false).scope, "site");
  for (const scope of ["Site", "toString", 1, null]) assert.equal(cleanPrefs({ v: 1, scope }, false).scope, null);
});

test("presets: only valid ones, at most 12, only id, label and text", () => {
  assert.equal(validPreset(preset("a")), true);
  for (const bad of [null, {}, preset(1), preset("a", ""), preset("a", "   "), preset("a", "x".repeat(41)), preset("a", "ok", ""), preset("a", "ok", "x".repeat(501)), preset("a", 5), { id: "a", label: "ok" }]) assert.equal(Boolean(validPreset(bad)), false, JSON.stringify(bad));
  assert.equal(validPreset(preset("a", "x".repeat(40), "y".repeat(500))), true, "the limits themselves pass");
  const stored = [preset("a"), null, preset(2), { ...preset("b", "Staging"), extra: "dropped", onclick: "x" }, preset("c", "")];
  assert.deepEqual(cleanPrefs({ v: 1, presets: stored }, false).presets, [preset("a"), preset("b", "Staging")]);
  const many = Array.from({ length: 15 }, (_, index) => preset(`p${index}`, `Preset ${index}`));
  assert.deepEqual(cleanPrefs({ v: 1, presets: many }, false).presets, many.slice(0, 12));
  assert.deepEqual(cleanPrefs({ v: 1, presets: "x" }, false).presets, []);
});

test("keys: no field gives the defaults, an empty list stays empty, the platform counts", () => {
  assert.deepEqual(cleanPrefs({ v: 1 }, true).keys, defaultKeys());
  assert.deepEqual(cleanPrefs({ v: 1, keys: [] }, true).keys, []);
  const stored = [{ action: "eye", combo: "Ctrl+KeyK" }, { action: "log", combo: "Alt+KeyL" }, { action: "nope", combo: "Alt+KeyN" }];
  assert.deepEqual(cleanPrefs({ v: 1, keys: stored }, true).keys, stored.slice(0, 2), "a Mac keeps the Ctrl combo");
  assert.deepEqual(cleanPrefs({ v: 1, keys: stored }, false).keys, [stored[1]], "off a Mac the Ctrl combo is dropped");
});
