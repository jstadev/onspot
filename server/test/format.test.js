import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAge, formatDetail, formatLine, formatList } from "../src/format.js";

const now = "2026-10-17T14:04:00.000Z";
const pin = {
  id: 12, status: "queued", host: "crete.koglabs.com", path: "/pricing", title: "Pricing",
  url: "https://crete.koglabs.com/pricing?x=1", note: "Cut the space above the title by half",
  quote: "Choose how you explore", createdAt: "2026-10-17T14:00:00.000Z", replyCount: 2,
  targets: [{
    selector: "main > section:nth-of-type(2) > h2", label: 'h2 "Choose how you explore"',
    rect: { x: 40, y: 1135, w: 1320, h: 96 },
    styles: { font: "600 32px / 38px Inter", color: "rgb(17, 17, 17)", margin: "0px 0px 24px" },
    attrs: { class: "hero-title" }, ancestors: ["section#pricing", "div.wrap"],
  }],
  viewport: { w: 1400, h: 900, dpr: 2, scrollX: 0, scrollY: 640 },
};

test("list matches the contract, keeps two lines per pin, and has no trailing blank line", () => {
  assert.equal(formatList([pin], { now }), '#12 queued crete.koglabs.com/pricing · h2 "Choose how you explore" · 4m · 2 replies\n  Cut the space above the title by half');
  const next = { ...pin, id: 13, replyCount: 1, note: "One line\n  next line" };
  const output = formatList([next, { ...pin, replyCount: 0 }], { now });
  assert.equal(output.split("\n").length, 4);
  assert.match(output, /1 reply\n  One line next line/);
  assert.doesNotMatch(output, /0 replies|\n$/);
  assert.equal(formatLine({ ...pin, status: "done" }), "#12 done");
});

test("empty list", () => {
  assert.equal(formatList([], { now }), "no pins");
});

test("single target detail, quote and replies match the contract", () => {
  const replies = [{ createdAt: "2026-10-17T14:02:00.000Z", kind: "user", author: "sam", body: "also check mobile" }];
  assert.equal(formatDetail(pin, replies), `#12 queued · crete.koglabs.com/pricing · "Pricing"
note: Cut the space above the title by half
quote: "Choose how you explore"
target 1: h2 "Choose how you explore"
  selector: main > section:nth-of-type(2) > h2
  box: 1320x96 at 40,1135 · viewport 1400x900 @2x · scrollY 640
  styles: font 600 32px / 38px Inter; color rgb(17, 17, 17); margin 0px 0px 24px
  attrs: class="hero-title"
  inside: section#pricing > div.wrap
replies:
  14:02 user sam: also check mobile
url: https://crete.koglabs.com/pricing?x=1`);
});

test("multiple targets keep their selectors and geometry", () => {
  const next = { selector: "#button", label: 'button "Join"', rect: { x: 0, y: 0, w: 100, h: 20 }, attrs: {}, styles: {}, ancestors: [] };
  const output = formatDetail({ ...pin, targets: [...pin.targets, next] });
  assert.match(output, /target 2: button "Join"\n  selector: #button\n  box: 100x20 at 0,0 · viewport 1400x900 @2x · scrollY 640\nurl:/);
  assert.doesNotMatch(output, /replies:|undefined|null/);
});

test("detail omits empty optional parts", () => {
  const minimal = { ...pin, title: null, quote: null, agent: null, summary: null, commit: null, run: null, viewport: null, targets: [{ selector: "h1", label: "h1" }] };
  assert.equal(formatDetail(minimal), `#12 queued · crete.koglabs.com/pricing
note: Cut the space above the title by half
target 1: h1
  selector: h1
url: https://crete.koglabs.com/pricing?x=1`);
  const partial = formatDetail({ ...minimal, viewport: { w: 800, h: 600, scrollY: 0 } }, []);
  assert.match(partial, /  viewport 800x600 · scrollY 0\n/);
  assert.doesNotMatch(partial, /@undefined|box:|attrs:|styles:|inside:/);
});

test("done detail includes agent, summary, commit and replies in order", () => {
  const replies = [
    { createdAt: "2026-10-17T14:02:00.000Z", kind: "user", author: "sam", body: "also check mobile" },
    { createdAt: "2026-10-17T14:03:00.000Z", kind: "agent", author: "codex", body: "Done: spacing fixed (abc123)" },
  ];
  const output = formatDetail({ ...pin, status: "done", agent: "codex", summary: "spacing fixed", commit: "abc123" }, replies);
  assert.match(output, /^#12 done/);
  assert.match(output, /agent: codex\nsummary: spacing fixed\ncommit: abc123\n/);
  assert.match(output, /14:02 user sam: also check mobile\n  14:03 agent codex: Done: spacing fixed \(abc123\)\nurl:/);
});

test("waiting uses the status word and details show a run only when present", () => {
  const waiting = { ...pin, status: "waiting", run: "triad:42" };
  assert.equal(formatLine(waiting), "#12 waiting");
  assert.match(formatList([waiting], { now }), /^#12 waiting crete.koglabs.com\/pricing/);
  assert.match(formatDetail(waiting), /^#12 waiting · crete.koglabs.com\/pricing/);
  assert.match(formatDetail(waiting), /\nrun: triad:42\ntarget 1:/);
  assert.doesNotMatch(formatDetail({ ...waiting, run: null }), /\nrun:/);
});

test("quote and attribute values preserve quotes and Unicode", () => {
  const output = formatDetail({ ...pin, quote: 'Καλώς "hello" 👋', targets: [{ selector: "h1", label: "h1", attrs: { title: 'a "quote"' } }] }, []);
  assert.ok(output.includes(`quote: ${JSON.stringify('Καλώς "hello" 👋')}`));
  assert.ok(output.includes(`attrs: title=${JSON.stringify('a "quote"')}`));
});

test("ages use seconds, minutes, hours and days with fixed boundaries", () => {
  const end = Date.parse(now);
  const cases = [[0, "0s"], [59000, "59s"], [60000, "1m"], [3599999, "59m"], [3600000, "1h"], [86399999, "23h"], [86400000, "1d"], [10 * 86400000, "10d"], [-60000, "0s"]];
  for (const [age, expected] of cases) assert.equal(formatAge(new Date(end - age).toISOString(), end), expected);
  assert.equal(formatAge(pin.createdAt, new Date(now)), "4m");
  assert.equal(formatAge(pin.createdAt, now), "4m");
  assert.equal(formatAge("invalid", now), "");
});

test("v3 detail matches the contract: about, presets, steps and shots lines", () => {
  const v3 = {
    ...pin, intent: "style", scope: "element",
    presets: [{ label: "5 agents", text: "Start a thread and delegate 5 agents." }],
    shots: { before: "2026-10-17T14:01:10.000Z", after: null },
  };
  const replies = [{ createdAt: "2026-10-17T14:02:00.000Z", kind: "user", author: "sam", body: "also check mobile" }];
  const steps = [{ createdAt: "2026-10-17T14:03:00.000Z", author: "claude", body: "Found the code in app/pricing/page.tsx" }];
  assert.equal(formatDetail(v3, replies, steps), `#12 queued · crete.koglabs.com/pricing · "Pricing"
note: Cut the space above the title by half
about: style · scope: element
presets: 5 agents: Start a thread and delegate 5 agents.
quote: "Choose how you explore"
target 1: h2 "Choose how you explore"
  selector: main > section:nth-of-type(2) > h2
  box: 1320x96 at 40,1135 · viewport 1400x900 @2x · scrollY 640
  styles: font 600 32px / 38px Inter; color rgb(17, 17, 17); margin 0px 0px 24px
  attrs: class="hero-title"
  inside: section#pricing > div.wrap
replies:
  14:02 user sam: also check mobile
steps:
  14:03 Found the code in app/pricing/page.tsx
shots: before 14:01
url: https://crete.koglabs.com/pricing?x=1`);
});

test("v3 lines appear only with content; the list adds the intent after the label", () => {
  const empty = formatDetail({ ...pin, intent: null, scope: null, presets: [], shots: { before: null, after: null } }, [], []);
  assert.doesNotMatch(empty, /about:|scope:|presets:|steps:|shots:/);
  assert.match(formatDetail({ ...pin, intent: "remove" }), /\nabout: remove\nquote:/);
  assert.match(formatDetail({ ...pin, scope: "site" }), /\nscope: site\nquote:/);
  const two = formatDetail({
    ...pin, presets: [{ label: "A", text: "First\n line" }, { label: "B", text: "Second" }],
    shots: { before: "2026-10-17T14:01:10.000Z", after: "2026-10-17T14:09:59.000Z" },
  }, [], [{ createdAt: "2026-10-17T14:03:00.000Z", body: "one" }, { createdAt: "2026-10-17T14:05:00.000Z", body: "two\nlines" }]);
  assert.match(two, /\npresets: A: First line · B: Second\n/);
  assert.match(two, /\nsteps:\n  14:03 one\n  14:05 two lines\nshots: before 14:01 · after 14:09\nurl:/);
  assert.equal(formatList([{ ...pin, intent: "text" }], { now }), '#12 queued crete.koglabs.com/pricing · h2 "Choose how you explore" · text · 4m · 2 replies\n  Cut the space above the title by half');
});
