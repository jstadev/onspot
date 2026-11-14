import test from "node:test";
import assert from "node:assert/strict";
import { chooseProfile } from "../src/profile.js";

const pin = (note, extra = {}) => ({ id: 1, note, intent: "style", presets: [], ...extra });

test("a plain pin gets the lean start", () => {
  for (const note of ["make this red", "Remove this element.", "use sonnet 5.5 max", "start a session for the footer with 2 lanes",
    "see /srv/x and https://a.koglabs.com/b", "a/b testing", "/x is short", "the mcpanel title", "", "path /srv/x.", "3/4 of the width", "skillful design"]) {
    assert.equal(chooseProfile(pin(note)), "pin", note);
  }
  assert.equal(chooseProfile({ id: 2 }), "pin", "a pin without note and presets");
  for (const intent of [null, undefined, "text", "style", "layout", "behaviour", "remove"]) assert.equal(chooseProfile(pin("x", { intent })), "pin", String(intent));
});

test("a task pin, a named skill, MCP, agent tool or kit, or a slash command gets the full start", () => {
  assert.equal(chooseProfile(pin("make this red", { intent: "task" })), null);
  for (const note of ["use the design kit", "Design-kit please", "use the designkit", "run the hallmark skill", "use skills here",
    "check it with MCP", "start 3 subagents", "use a sub-agent", "a Workflow for this", "run workflows", "make a motion reel",
    "motion-reel of it", "game build", "game-build a level", "/hallmark audit", "please run /design-kit", "then /code-review", "/box",
    "then run /box.", "/check, then ship", "use (/post) after it", "run '/bench'", "what about /triad?"]) {
    assert.equal(chooseProfile(pin(note)), null, note);
  }
  assert.equal(chooseProfile(pin("make it red", { presets: [{ label: "Kit", text: "Use the design kit." }] })), null, "a preset counts");
  assert.equal(chooseProfile(pin("make it red", { presets: [{ label: "Dark", text: "Check the dark theme too." }] })), "pin");
});

test("the same pin always gets the same answer", () => {
  const subject = pin("use MCP for this");
  for (let i = 0; i < 3; i++) assert.equal(chooseProfile(subject), null);
});
