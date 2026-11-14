import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS, KEYS_MAX, KEYS_PER_ACTION, actionFor, actionName, cleanKeys, comboFromEvent, defaultKeys, firstKey, formatCombo,
  isDefaultKeys, parseCombo, shortcutError,
} from "../src/content/shortcuts.js";

const MAC = true, PC = false;
// A key press as the browser reports it. `mods` holds the flags that are down.
const press = (code, mods = "", extra = {}) => ({
  code, ctrlKey: mods.includes("c"), metaKey: mods.includes("m"), altKey: mods.includes("a"), shiftKey: mods.includes("s"), ...extra,
});
const key = (action, combo) => ({ action, combo });
// 24 valid combos that no default uses: Alt+Shift+Digit0..9 and Alt+F1..F12 and two more.
const spare = [...Array.from({ length: 10 }, (_, n) => `Alt+Shift+Digit${n}`), ...Array.from({ length: 12 }, (_, n) => `Alt+F${n + 1}`), "Alt+Comma", "Alt+Period"];
const ids = ACTIONS.map(([id]) => id);

test("the action list and the defaults are the contract table", () => {
  assert.deepEqual(ACTIONS, [
    ["mode", "Toggle pin mode", "Mod+KeyM"],
    ["eye", "Hide or show markers", "Mod+KeyK"],
    ["menu", "Open or close the menu", "Alt+Shift+KeyM"],
    ["log", "Open or close the Log", "Alt+Shift+KeyL"],
    ["settings", "Open or close Settings", "Alt+Shift+KeyS"],
    ["freeze", "Pause or resume page animations", "Alt+Shift+KeyF"],
    ["queue", "Open the queue", "Alt+Shift+KeyQ"],
    ["submit", "Submit all", ""],
  ]);
  assert.deepEqual(defaultKeys(), [
    key("mode", "Mod+KeyM"), key("eye", "Mod+KeyK"), key("menu", "Alt+Shift+KeyM"), key("log", "Alt+Shift+KeyL"),
    key("settings", "Alt+Shift+KeyS"), key("freeze", "Alt+Shift+KeyF"), key("queue", "Alt+Shift+KeyQ"),
  ]);
  assert.notEqual(defaultKeys(), defaultKeys(), "each call gives a new list");
  assert.equal(actionName("eye"), "Hide or show markers");
  for (const bad of ["", "nope", "constructor", undefined, null, 7, {}]) assert.equal(actionName(bad), "");
  assert.equal(KEYS_PER_ACTION, 3);
  assert.equal(KEYS_MAX, 24);
  // Every default passes its own rules on both platforms.
  for (const mac of [MAC, PC]) assert.deepEqual(cleanKeys(defaultKeys(), mac), defaultKeys());
});

test("parseCombo reads the modifiers in the fixed order and refuses anything else", () => {
  assert.deepEqual(parseCombo("Mod+KeyK", PC), { mod: true, ctrl: false, alt: false, shift: false, code: "KeyK" });
  assert.deepEqual(parseCombo("Mod+Ctrl+Alt+Shift+F12", MAC), { mod: true, ctrl: true, alt: true, shift: true, code: "F12" });
  assert.deepEqual(parseCombo("Alt+Shift+KeyL", MAC), { mod: false, ctrl: false, alt: true, shift: true, code: "KeyL" });
  assert.deepEqual(parseCombo("Enter", PC), { mod: false, ctrl: false, alt: false, shift: false, code: "Enter" });
  assert.equal(parseCombo("Ctrl+KeyK", PC), null, "Ctrl exists only on a Mac");
  assert.equal(parseCombo("Ctrl+Alt+Digit1", PC), null);
  assert.ok(parseCombo("Ctrl+Alt+Digit1", MAC));
  for (const bad of ["", "Shift+Alt+KeyL", "Alt+Mod+KeyK", "Mod+", "Mod+Mod+KeyK", "mod+KeyK", "Mod + KeyK", "Mod+KeyK+", "Mod+Key K", "Meta+KeyK", "Mod+KeyK\n", undefined, null, 7, ["Mod+KeyK"], {}]) {
    assert.equal(parseCombo(bad, MAC), null, JSON.stringify(bad));
  }
});

test("comboFromEvent: Mod is Command on a Mac and Control elsewhere", () => {
  assert.equal(comboFromEvent(press("KeyK", "m"), MAC), "Mod+KeyK");
  assert.equal(comboFromEvent(press("KeyK", "c"), MAC), "Ctrl+KeyK");
  assert.equal(comboFromEvent(press("KeyK", "mc"), MAC), "Mod+Ctrl+KeyK");
  assert.equal(comboFromEvent(press("Digit1", "ca"), MAC), "Ctrl+Alt+Digit1");
  assert.equal(comboFromEvent(press("F2", "mcas"), MAC), "Mod+Ctrl+Alt+Shift+F2");
  assert.equal(comboFromEvent(press("KeyK", "c"), PC), "Mod+KeyK");
  assert.equal(comboFromEvent(press("KeyL", "as"), PC), "Alt+Shift+KeyL");
  assert.equal(comboFromEvent(press("KeyL", "cas"), PC), "Mod+Alt+Shift+KeyL");
  assert.equal(comboFromEvent(press("KeyK"), PC), "KeyK");
  assert.equal(comboFromEvent(press("Enter", "s"), MAC), "Shift+Enter");
});

test("comboFromEvent gives nothing for a bare modifier, the Windows key off a Mac, AltGr and an unknown key", () => {
  for (const code of ["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "OSLeft", "OSRight"]) {
    for (const mac of [MAC, PC]) assert.equal(comboFromEvent(press(code, "cas"), mac), "", code);
  }
  assert.equal(comboFromEvent(press("KeyK", "m"), PC), "", "the Windows or Super key is never part of a combo");
  assert.equal(comboFromEvent(press("KeyK", "mc"), PC), "");
  assert.equal(comboFromEvent(press("KeyQ", "ca", { getModifierState: name => name === "AltGraph" }), PC), "", "AltGr types characters");
  assert.equal(comboFromEvent(press("KeyQ", "ca", { getModifierState: () => false }), PC), "Mod+Alt+KeyQ");
  assert.equal(comboFromEvent(press("", "c"), PC), "");
  assert.equal(comboFromEvent(press(undefined, "c"), PC), "");
});

test("formatCombo: symbols without a plus on a Mac, words with a plus elsewhere", () => {
  const shown = [
    ["Mod+KeyK", "⌘K", "Ctrl+K"], ["Alt+Shift+KeyL", "⌥⇧L", "Alt+Shift+L"], ["Mod+Shift+Digit1", "⇧⌘1", "Ctrl+Shift+1"],
    ["Alt+F2", "⌥F2", "Alt+F2"], ["Mod+Alt+Shift+F12", "⌥⇧⌘F12", "Ctrl+Alt+Shift+F12"], ["Mod+Minus", "⌘-", "Ctrl+-"],
    ["Mod+Equal", "⌘=", "Ctrl+="], ["Alt+BracketLeft", "⌥[", "Alt+["], ["Alt+BracketRight", "⌥]", "Alt+]"], ["Alt+Backslash", "⌥\\", "Alt+\\"],
    ["Alt+Semicolon", "⌥;", "Alt+;"], ["Alt+Quote", "⌥'", "Alt+'"], ["Alt+Comma", "⌥,", "Alt+,"], ["Alt+Period", "⌥.", "Alt+."],
    ["Alt+Slash", "⌥/", "Alt+/"], ["Alt+Backquote", "⌥`", "Alt+`"], ["Alt+Digit0", "⌥0", "Alt+0"], ["Alt+KeyZ", "⌥Z", "Alt+Z"],
    ["Shift+Enter", "⇧Enter", "Shift+Enter"], ["KeyK", "K", "K"], ["Alt+ArrowUp", "⌥ArrowUp", "Alt+ArrowUp"],
  ];
  for (const [combo, mac, pc] of shown) {
    assert.equal(formatCombo(combo, MAC), mac, combo);
    assert.equal(formatCombo(combo, PC), pc, combo);
  }
  assert.equal(formatCombo("Ctrl+Alt+Digit1", MAC), "⌃⌥1");
  assert.equal(formatCombo("Mod+Ctrl+KeyK", MAC), "⌃⌘K");
  for (const bad of ["", "Shift+Alt+KeyL", undefined, null, 7, "Mod+constructor "]) assert.equal(formatCombo(bad, MAC), "");
  assert.equal(formatCombo("Mod+constructor", PC), "Ctrl+constructor", "an object key name is only text");
});

test("rule 1: a combo needs Mod, Ctrl or Alt", () => {
  for (const combo of ["KeyK", "Shift+KeyK", "F5", "Shift+F5", "Enter"]) {
    assert.equal(shortcutError([], key("log", combo), -1, MAC), "Add ⌘, Ctrl or Alt to the key.", combo);
    assert.equal(shortcutError([], key("log", combo), -1, PC), "Add Ctrl or Alt to the key.", combo);
  }
  for (const combo of ["Mod+KeyK", "Alt+KeyK", "Mod+Shift+F5"]) for (const mac of [MAC, PC]) assert.equal(shortcutError([], key("log", combo), -1, mac), "", combo);
  assert.equal(shortcutError([], key("log", "Ctrl+KeyK"), -1, MAC), "");
});

test("rule 2: only the allowed key codes", () => {
  const good = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map(letter => `Key${letter}`).concat(Array.from({ length: 10 }, (_, n) => `Digit${n}`),
    Array.from({ length: 12 }, (_, n) => `F${n + 1}`), ["Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Comma", "Period", "Slash", "Backquote"]);
  assert.equal(good.length, 59);
  for (const code of good) assert.equal(shortcutError([], key("log", `Alt+Shift+${code}`), -1, PC), "", code);
  for (const code of ["Enter", "Escape", "Tab", "Space", "Backspace", "Delete", "ArrowUp", "Home", "PageDown", "F0", "F13", "F1x", "Keya", "KeyAA", "Digit10", "Numpad1", "IntlBackslash", "CapsLock", "constructor", "toString", "hasOwnProperty"]) {
    for (const mac of [MAC, PC]) assert.equal(shortcutError([], key("log", `Alt+${code}`), -1, mac), "That key cannot be a shortcut.", code);
  }
  assert.equal(shortcutError([], key("log", "Ctrl+KeyK"), -1, PC), "That key cannot be a shortcut.", "Ctrl off a Mac is not a combo");
  for (const combo of ["Shift+Alt+KeyL", "Mod+", "Alt+Key K", 7, {}, ["Alt+KeyK"]]) assert.equal(shortcutError([], key("log", combo), -1, MAC), "That key cannot be a shortcut.", JSON.stringify(combo));
});

test("rule 3: the browser keys and Alt+1 to Alt+6 are reserved", () => {
  for (const letter of "ACVXZYWTNQ") {
    for (const mac of [MAC, PC]) {
      assert.equal(shortcutError([], key("log", `Mod+Key${letter}`), -1, mac), "The browser keeps that key.", letter);
      assert.equal(shortcutError([], key("log", `Mod+Shift+Key${letter}`), -1, mac), "The browser keeps that key.", letter);
      assert.equal(shortcutError([], key("log", `Mod+Alt+Key${letter}`), -1, mac), "", "another modifier frees it");
      assert.equal(shortcutError([], key("log", `Alt+Key${letter}`), -1, mac), "");
    }
    assert.equal(shortcutError([], key("log", `Mod+Ctrl+Key${letter}`), -1, MAC), "");
    assert.equal(shortcutError([], key("log", `Ctrl+Key${letter}`), -1, MAC), "", "Control alone is free on a Mac");
  }
  for (const letter of "BDEFGHIJKLMOPRSU") assert.equal(shortcutError([], key("log", `Mod+Key${letter}`), -1, PC), "", letter);
  for (let n = 1; n <= 6; n++) {
    for (const mac of [MAC, PC]) {
      assert.equal(shortcutError([], key("log", `Alt+Digit${n}`), -1, mac), "Alt+1 to Alt+6 pick the About tabs.");
      assert.equal(shortcutError([], key("log", `Alt+Shift+Digit${n}`), -1, mac), "");
      assert.equal(shortcutError([], key("log", `Mod+Alt+Digit${n}`), -1, mac), "");
    }
    assert.equal(shortcutError([], key("log", `Ctrl+Alt+Digit${n}`), -1, MAC), "");
  }
  for (const n of [0, 7, 8, 9]) assert.equal(shortcutError([], key("log", `Alt+Digit${n}`), -1, PC), "");
});

test("rule 4: a combo belongs to one shortcut", () => {
  const keys = defaultKeys();
  assert.equal(shortcutError(keys, key("log", "Mod+KeyK"), -1, MAC), "That key already does: Hide or show markers.");
  assert.equal(shortcutError(keys, key("eye", "Mod+KeyK"), -1, PC), "That key already does: Hide or show markers.", "also for the same action");
  assert.equal(shortcutError(keys, key("submit", "Alt+Shift+KeyQ"), -1, PC), "That key already does: Open the queue.");
  assert.equal(shortcutError(keys, key("eye", "Mod+KeyK"), 1, PC), "", "an edit may keep its own combo");
  assert.equal(shortcutError(keys, key("log", "Mod+KeyK"), 1, PC), "", "an edit may move its combo to another action");
  assert.equal(shortcutError(keys, key("log", "Mod+KeyK"), 0, PC), "That key already does: Hide or show markers.");
  assert.equal(shortcutError(keys, key("log", "Mod+Shift+KeyK"), -1, PC), "", "another modifier set is another combo");
});

test("rule 5: at most 3 shortcuts per action and 24 in all", () => {
  const three = spare.slice(0, 3).map(combo => key("log", combo));
  assert.equal(shortcutError(three, key("log", spare[3]), -1, PC), "An action takes up to 3 shortcuts.");
  assert.equal(shortcutError(three, key("eye", spare[3]), -1, PC), "");
  assert.equal(shortcutError(three, key("log", spare[3]), 2, PC), "", "an edit of the third is not a fourth");
  const full = spare.map((combo, index) => key(ids[Math.floor(index / 3)], combo));
  assert.equal(full.length, 24);
  assert.deepEqual(cleanKeys(full, PC), full, "24 shortcuts, 3 per action, are valid");
  assert.equal(shortcutError(full.slice(0, 23), key("submit", "Mod+KeyK"), -1, PC), "");
  assert.equal(shortcutError(full, key("submit", "Mod+KeyK"), 23, PC), "", "an edit at the limit");
  const all = [...spare.slice(0, 21).map((combo, index) => key(ids[Math.floor(index / 3)], combo)), key("submit", spare[21]), key("submit", spare[22]), key("submit", spare[23])];
  assert.equal(shortcutError(all, key("mode", "Mod+KeyM"), -1, PC), "An action takes up to 3 shortcuts.");
  const mixed = [...all.slice(0, 23), key("submit", spare[23])].map((item, index) => index < 2 ? key("eye", item.combo) : item); // mode has 1, eye has 5: only to reach 24
  assert.equal(shortcutError(mixed, key("mode", "Mod+KeyM"), -1, PC), "You can keep up to 24 shortcuts.");
});

test("a shortcut needs a known action and a key", () => {
  for (const action of ["", "nope", undefined, null, 7, "constructor"]) assert.equal(shortcutError([], key(action, "Mod+KeyK"), -1, PC), "Choose an action.");
  for (const combo of ["", undefined, null]) assert.equal(shortcutError([], key("log", combo), -1, PC), "Press the keys first.");
  for (const entry of [undefined, null, 7, "x"]) assert.equal(shortcutError([], entry, -1, PC), "Choose an action.");
});

test("cleanKeys: missing data gives the defaults, an empty list stays empty", () => {
  for (const missing of [undefined, null, "garbage", 7, {}, { 0: key("log", "Alt+KeyL"), length: 1 }]) assert.deepEqual(cleanKeys(missing, MAC), defaultKeys(), JSON.stringify(missing));
  assert.deepEqual(cleanKeys([], MAC), [], "he removed every shortcut");
  assert.deepEqual(cleanKeys([key("eye", "Mod+KeyK")], PC), [key("eye", "Mod+KeyK")], "a removed default stays removed");
});

test("cleanKeys drops each bad entry and keeps the order of the rest", () => {
  const stored = [
    key("log", "Alt+KeyL"),
    null, 7, "Alt+KeyK", [], {},
    key("nope", "Alt+KeyA"), // unknown action
    key("log", "KeyL"), // no modifier
    key("log", "Alt+Enter"), // key not allowed
    key("log", "Shift+Alt+KeyB"), // wrong modifier order
    key("log", "Mod+KeyC"), // the browser keeps it
    key("log", "Alt+Digit3"), // About tabs
    key("eye", "Alt+KeyL"), // a second use of a combo
    { action: "eye", combo: "Mod+KeyK", extra: "dropped field" },
    key("log", "Alt+KeyM"), key("log", "Alt+KeyN"),
    key("log", "Alt+KeyO"), // the fourth of one action
    key("submit", 12), key("submit", ""),
    key("submit", "Mod+Shift+Digit1"),
  ];
  assert.deepEqual(cleanKeys(stored, PC), [key("log", "Alt+KeyL"), key("eye", "Mod+KeyK"), key("log", "Alt+KeyM"), key("log", "Alt+KeyN"), key("submit", "Mod+Shift+Digit1")]);
  assert.deepEqual(cleanKeys([key("eye", "Ctrl+KeyK"), key("log", "Ctrl+Alt+Digit1")], MAC), [key("eye", "Ctrl+KeyK"), key("log", "Ctrl+Alt+Digit1")]);
  assert.deepEqual(cleanKeys([key("eye", "Ctrl+KeyK"), key("log", "Ctrl+Alt+Digit1")], PC), [], "Ctrl combos mean nothing off a Mac");
  const many = [...spare, "Alt+Slash", "Alt+Quote"].map((combo, index) => key(ids[Math.floor(index / 3) % 8], combo));
  assert.equal(cleanKeys(many, PC).length, 24, "the list stops at 24");
});

test("actionFor matches the exact modifier set only", () => {
  const keys = defaultKeys();
  assert.equal(actionFor(keys, press("KeyK", "m"), MAC), "eye");
  assert.equal(actionFor(keys, press("KeyK", "c"), PC), "eye");
  assert.equal(actionFor(keys, press("KeyM", "m"), MAC), "mode");
  assert.equal(actionFor(keys, press("KeyM", "c"), PC), "mode");
  assert.equal(actionFor(keys, press("KeyL", "as"), MAC), "log");
  assert.equal(actionFor(keys, press("KeyQ", "as"), PC), "queue");
  // An extra modifier, a missing modifier, the other platform's key.
  for (const [code, mods, mac] of [["KeyK", "ms", MAC], ["KeyK", "ma", MAC], ["KeyK", "mc", MAC], ["KeyK", "c", MAC], ["KeyK", "", MAC], ["KeyK", "cs", PC], ["KeyK", "ca", PC],
    ["KeyK", "m", PC], ["KeyK", "mc", PC], ["KeyK", "", PC], ["KeyL", "a", PC], ["KeyL", "s", PC], ["KeyL", "cas", PC], ["KeyL", "mas", PC], ["KeyJ", "c", PC], ["ShiftLeft", "as", PC]]) {
    assert.equal(actionFor(keys, press(code, mods), mac), undefined, `${code} ${mods} ${mac}`);
  }
  assert.equal(actionFor([], press("KeyK", "c"), PC), undefined, "no shortcuts, no match");
  assert.equal(actionFor(keys, press("KeyL", "ca", { getModifierState: name => name === "AltGraph" }), PC), undefined);
  assert.equal(actionFor([key("submit", "Mod+Shift+Digit1")], press("Digit1", "cs", { key: "!" }), PC), "submit", "the code counts, not the character");
});

test("firstKey shows the first combo of an action, or nothing", () => {
  const keys = [key("log", "Alt+KeyL"), key("eye", "Mod+KeyK"), key("log", "Alt+Shift+KeyL")];
  assert.equal(firstKey(keys, "log", MAC), "⌥L");
  assert.equal(firstKey(keys, "log", PC), "Alt+L");
  assert.equal(firstKey(keys, "eye", MAC), "⌘K");
  assert.equal(firstKey(keys, "submit", MAC), "");
  assert.equal(firstKey([], "mode", PC), "");
});

test("isDefaultKeys is true only for the default list in its order", () => {
  assert.equal(isDefaultKeys(defaultKeys()), true);
  assert.equal(isDefaultKeys([]), false);
  assert.equal(isDefaultKeys(defaultKeys().slice(1)), false);
  assert.equal(isDefaultKeys(defaultKeys().reverse()), false);
  assert.equal(isDefaultKeys([...defaultKeys(), key("submit", "Alt+KeyS")]), false);
});
