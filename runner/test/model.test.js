import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseModel } from "../src/model.js";

const pin = (note, extra = {}) => ({ id: 1, note, attempts: 0, presets: [], ...extra });
const pick = (note, extra) => {
  const { id, short } = chooseModel(pin(note, extra));
  return [id, short];
};
const OPUS = "claude-opus-5-5", SONNET = "claude-sonnet-5-5", HAIKU = "claude-haiku-5-5", FABLE = "claude-fable-5-2";

test("every pin runs on Opus 5.5 at effort high when he names no model", () => {
  assert.deepEqual(chooseModel(pin("make it blue")), {
    id: OPUS, family: "opus", version: "5.5", effort: "high", label: "Opus 5.5 high", short: "opus 5.5 high",
  });
  for (const note of ["the brightness is to high", "the brightness is to high here", "max width 400px", "κάνε το μπλε", ""]) {
    assert.deepEqual(pick(note), [OPUS, "opus 5.5 high"], note);
  }
  assert.deepEqual(pick(undefined, { presets: null }), [OPUS, "opus 5.5 high"], "a bare pin");
});

test("a model that he names wins; the effort counts only right after the model words", () => {
  const cases = {
    "use only opus 5.5 xhigh": [OPUS, "opus 5.5 xhigh"],
    "Use Fable": [FABLE, "fable 5.2 high"],
    "fable 5.2 max": [FABLE, "fable 5.2 max"],
    "claude-fable-5-2 xhigh": [FABLE, "fable 5.2 xhigh"],
    "opus 5.9": [OPUS, "opus 5.5 high"],
    "1 opus 5.5 xhigh agent and 1 sonnet 5.5 xhigh agent": [OPUS, "opus 5.5 xhigh"],
    "SONNET\nLow": [SONNET, "sonnet 5.5 low"],
    "a haiku medium session": [HAIKU, "haiku 5.5 medium"],
    "sonnet is too high on the page": [SONNET, "sonnet 5.5 high"],
    "sonnets and opuses": [OPUS, "opus 5.5 high"],
    // A model word inside another word names no model. A hyphen ends a word, as in a model id.
    "the octopus and the fabled haikus": [OPUS, "opus 5.5 high"],
    "opus_card and sonnet2 classes": [OPUS, "opus 5.5 high"],
    "use claude-sonnet-5-5 max": [SONNET, "sonnet 5.5 max"],
    "claude-opus-5-5 xhigh please": [OPUS, "opus 5.5 xhigh"],
    "sonnet-5.5 low": [SONNET, "sonnet 5.5 low"],
    "Sonnet": [SONNET, "sonnet 5.5 high"],
    "fable max": [FABLE, "fable 5.2 max"],
    // An effort without a model, or not right after it, names nothing.
    "run it at xhigh": [OPUS, "opus 5.5 high"],
    "max effort with sonnet": [SONNET, "sonnet 5.5 high"],
    "opus, max": [OPUS, "opus 5.5 high"],
    "opus 4.1 max": [OPUS, "opus 5.5 high"],
  };
  for (const [note, expected] of Object.entries(cases)) assert.deepEqual(pick(note), expected, note);
});

test("the note comes before the presets, and the first preset that names a model counts", () => {
  const presets = [{ label: "Plain", text: "Keep the look." }, { label: "Cheap", text: "Sonnet xhigh" }, { label: "Big", text: "opus max" }];
  assert.deepEqual(pick("make it blue", { presets }), [SONNET, "sonnet 5.5 xhigh"]);
  assert.deepEqual(pick("use fable", { presets }), [FABLE, "fable 5.2 high"]);
  assert.equal(chooseModel(pin("use fable", { presets })).label, "Fable 5.2 high");
  assert.equal(chooseModel(pin("make it blue", { presets })).label, "Sonnet 5.5 xhigh");
});

test("a retry raises the effort one step and stops at max", () => {
  assert.equal(chooseModel(pin("make it blue", { attempts: 1 })).effort, "xhigh");
  assert.equal(chooseModel(pin("make it blue", { attempts: 5 })).effort, "xhigh");
  assert.equal(chooseModel(pin("opus max", { attempts: 1 })).effort, "max");
  assert.equal(chooseModel(pin("sonnet low", { attempts: 1 })).short, "sonnet 5.5 medium");
  assert.deepEqual(pick("fable xhigh", { attempts: 2 }), [FABLE, "fable 5.2 max"]);
});
