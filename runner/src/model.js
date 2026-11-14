// Picks the model for one pin (docs/protocol.md, Auto-fix runner, item 6). Every pin runs on
// Opus 5.5 at effort high. A model that he names in the note or in a preset text wins: the
// session runs on that model. The rule is code, so the same pin always gets the same model.

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const MODELS = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", fable: "claude-fable-5-2" };

// The effort counts only right after the model words: "to high here" names no effort. The version
// is "5.5" or "5.2", or "-5-5" as in a model id ("claude-sonnet-5-5 max").
const NAMED = /\b(opus|sonnet|haiku|fable)\b(?:[\s-]+5[.-]\d+)?(?:\s+(low|medium|high|xhigh|max)\b)?/i;

/** His words on one pin, in the order that counts: the note, then each preset text. */
export const wordsOf = (pin) => [pin.note, ...(Array.isArray(pin.presets) ? pin.presets.map((preset) => preset?.text) : [])]
  .map((text) => String(text ?? ""));

// The first model that he names in the note, then in the preset texts, or null.
function named(pin) {
  for (const text of wordsOf(pin)) {
    const match = NAMED.exec(text);
    if (match) return match;
  }
  return null;
}

function choice(family, effort) {
  // The version comes from the model id: "claude-fable-5-2" gives "5.2".
  const version = MODELS[family].split("-").slice(2).join(".");
  const short = `${family} ${version} ${effort}`;
  return { id: MODELS[family], family, version, effort, label: short[0].toUpperCase() + short.slice(1), short };
}

/** Returns { id, family, version, effort, label, short } for one pin. */
export function chooseModel(pin) {
  const match = named(pin);
  let step = EFFORTS.indexOf(match?.[2]?.toLowerCase() ?? "high");
  // A retry raises the effort one step.
  if (Number(pin.attempts) > 0) step = Math.min(step + 1, EFFORTS.length - 1);
  return choice(match?.[1].toLowerCase() ?? "opus", EFFORTS[step]);
}

/** The model of one bulk run (Bulk mode, item 3): always effort xhigh, also on a retry; the first
 *  pin in id order that names a model sets it. A named effort does not count. */
export function chooseBulkModel(pins) {
  const match = [...pins].sort((a, b) => a.id - b.id).map(named).find(Boolean);
  return choice(match?.[1].toLowerCase() ?? "opus", "xhigh");
}
