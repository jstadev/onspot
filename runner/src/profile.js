// Picks the start of a pin session (docs/memory-layer.md, option A). "pin" is the lean start: no
// skill list, no MCP tools, no Agent tool. null is the full start. A task pin, or a note or preset
// that names a skill, MCP, an agent tool or a slash command, needs the full start. The rule is
// code, so the same pin always gets the same answer.

import { wordsOf } from "./model.js";

const FULL = /\b(skills?|mcp|sub-?agents?|workflows?|design[- ]?kit|hallmark|motion[- ]?reel|game[- ]?build)\b/i;
// "/hallmark", also in brackets or before punctuation ("run /box."). A path like /srv/x is none.
const SLASH = /(^|[\s("'])\/[a-z][a-z-]{2,}(?=[\s.,;:!?)"']|$)/;

/** Returns "pin" or null for one pin. */
export function chooseProfile(pin) {
  if (pin.intent === "task") return null;
  return wordsOf(pin).some((text) => FULL.test(text) || SLASH.test(text)) ? null : "pin";
}
