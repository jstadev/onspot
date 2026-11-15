/** One line of plain text: runs of whitespace and control characters (also ESC) become one space. */
export const oneLine = (value) => String(value ?? "").replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
const text = oneLine;
const quoted = (value) => JSON.stringify(text(value));
const entries = (value) => Object.entries(value ?? {}).filter(([, v]) => text(v));
const clock = (iso) => iso?.slice(11, 16);
const short = (sha) => text(sha).slice(0, 7);

export function formatAge(iso, now = Date.now()) {
  const age = new Date(now).getTime() - new Date(iso).getTime();
  if (!Number.isFinite(age)) return "";
  const seconds = Math.max(0, Math.floor(age / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function formatLine(pin) {
  return `#${pin.id} ${pin.status}`;
}

export function formatList(pins, { now = Date.now() } = {}) {
  if (!pins.length) return "no pins";
  return pins.map((pin) => {
    const parts = [
      `${formatLine(pin)} ${pin.host}${pin.path}`,
      text(pin.targets?.[0]?.label),
      text(pin.intent),
      pin.revert ? "go back" : "",
      formatAge(pin.createdAt, now),
      pin.replyCount > 0 ? `${pin.replyCount} ${pin.replyCount === 1 ? "reply" : "replies"}` : "",
    ];
    return `${parts.filter(Boolean).join(" · ")}\n  ${text(pin.note)}`;
  }).join("\n");
}

export function formatDetail(pin, replies = [], steps = []) {
  const lines = [[formatLine(pin), `${pin.host}${pin.path}`, pin.title ? quoted(pin.title) : ""].filter(Boolean).join(" · ")];
  if (text(pin.note)) lines.push(`note: ${text(pin.note)}`);
  const about = [pin.intent && `about: ${text(pin.intent)}`, pin.scope && `scope: ${text(pin.scope)}`].filter(Boolean);
  if (about.length) lines.push(about.join(" · "));
  if (pin.presets?.length) lines.push(`presets: ${pin.presets.map((preset) => `${text(preset.label)}: ${text(preset.text)}`).join(" · ")}`);
  if (text(pin.quote)) lines.push(`quote: ${quoted(pin.quote)}`);
  if (pin.images?.length) lines.push(`images: ${pin.images.length} (pins images ${pin.id} saves them)`);
  for (const key of ["agent", "model", "summary", "commit", "run", "batch"]) {
    if (text(pin[key])) lines.push(`${key}: ${text(pin[key])}`);
  }
  if (pin.versions?.length) lines.push(`versions: ${pin.versions.map((v) => `${short(v.commit)} ${text(v.summary).slice(0, 80)}`).join(" · ")}`);
  if (pin.revert?.commits?.length) lines.push(`go back: undo ${pin.revert.commits.map(short).join(", ")}`);
  if (pin.revertedAt) lines.push(`reverted: ${clock(pin.revertedAt)}`);
  for (const [index, target] of (pin.targets ?? []).entries()) {
    lines.push(`target ${index + 1}: ${text(target.label)}`);
    if (text(target.selector)) lines.push(`  selector: ${text(target.selector)}`);
    const box = [];
    const rect = target.rect;
    if (rect && [rect.w, rect.h, rect.x, rect.y].every(Number.isFinite)) {
      box.push(`box: ${rect.w}x${rect.h} at ${rect.x},${rect.y}`);
    }
    const viewport = pin.viewport;
    if (viewport && Number.isFinite(viewport.w) && Number.isFinite(viewport.h)) {
      box.push(`viewport ${viewport.w}x${viewport.h}${Number.isFinite(viewport.dpr) ? ` @${viewport.dpr}x` : ""}`);
    }
    if (Number.isFinite(viewport?.scrollY)) box.push(`scrollY ${viewport.scrollY}`);
    if (box.length) lines.push(`  ${box.join(" · ")}`);
    const styles = entries(target.styles).map(([key, value]) => `${key} ${text(value)}`);
    if (styles.length) lines.push(`  styles: ${styles.join("; ")}`);
    const attrs = entries(target.attrs).map(([key, value]) => `${key}=${quoted(value)}`);
    if (attrs.length) lines.push(`  attrs: ${attrs.join(" ")}`);
    const ancestors = (target.ancestors ?? []).map(text).filter(Boolean);
    if (ancestors.length) lines.push(`  inside: ${ancestors.join(" > ")}`);
  }
  if (replies.length) {
    lines.push("replies:");
    for (const reply of replies) {
      const who = [clock(reply.createdAt), reply.kind, text(reply.author)].filter(Boolean).join(" ");
      lines.push(`  ${who}: ${text(reply.body)}`);
    }
  }
  if (steps.length) {
    lines.push("steps:");
    for (const step of steps) lines.push(`  ${[clock(step.createdAt), text(step.body)].filter(Boolean).join(" ")}`);
  }
  const shots = entries(pin.shots).map(([kind, at]) => `${kind} ${clock(at)}`);
  if (shots.length) lines.push(`shots: ${shots.join(" · ")}`);
  if (pin.url) lines.push(`url: ${pin.url}`);
  return lines.join("\n");
}
