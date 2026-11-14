// Renders a pin's page and measures its element. Used by `pins snap` and `pins check`.
import { pathToFileURL } from "node:url";
import { cleanFacts } from "./facts.js";
import { oneLine } from "./format.js";
import { SHOT_MAX } from "./shots.js";

const SNAP_MS = 45000;

// Runs in the page: finds the element (">>>" enters an open shadow root), scrolls it into view and measures it.
function measure({ selector, scrollX, scrollY }) {
  let el = null;
  try {
    let root = document;
    for (const part of selector.split(">>>")) {
      el = root?.querySelector(part.trim()) ?? null;
      root = el?.shadowRoot;
    }
  } catch { el = null; }
  const page = { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight };
  if (!el) {
    window.scrollTo(scrollX, scrollY);
    return { page };
  }
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const words = (el.innerText ?? "").replace(/\s+/g, " ").trim();
  return {
    page, text: words.slice(0, 300),
    label: el.localName + (words ? ` "${words.slice(0, 80)}"` : ""),
    rect: { x: rect.left + window.scrollX, y: rect.top + window.scrollY, w: rect.width, h: rect.height },
    styles: {
      color: style.color, background: style.backgroundColor, font: style.font, margin: style.margin, padding: style.padding,
      display: style.display, gap: style.gap, radius: style.borderRadius, opacity: style.opacity,
      border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
    },
  };
}

// The element box plus the pad, inside the page, at most 1600 x 1200 CSS px. Null when nothing is left.
function clipOf(rect, page, pad) {
  const x = Math.max(0, Math.floor(rect.x - pad));
  const y = Math.max(0, Math.floor(rect.y - pad));
  const width = Math.min(Math.ceil(rect.x + rect.w + pad), page.w, x + 1600) - x;
  const height = Math.min(Math.ceil(rect.y + rect.h + pad), page.h, y + 1200) - y;
  return width >= 1 && height >= 1 ? { x, y, width, height } : null;
}

const bound = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * Renders the pin's page as a signed-out visitor. playwright-core loads only here; the server has no dependencies.
 * options: url (default the pin URL), selector (default the first target), pad (CSS px, default 40).
 * Returns { bytes, text, facts }: the image, the one-line result, and what it measured.
 */
export async function snapPin(pin, options) {
  const path = process.env.PLAYWRIGHT_CORE || "/srv/design-kit/node_modules/playwright-core/index.mjs";
  const { chromium } = await import(pathToFileURL(path).href).catch((error) => {
    throw error.code === "ERR_MODULE_NOT_FOUND" ? new Error(`playwright-core is not at ${path}`) : error;
  });
  const started = Date.now();
  const browser = await chromium.launch({ timeout: SNAP_MS });
  let expired = false;
  const timer = setTimeout(() => { expired = true; browser.close().catch(() => {}); }, Math.max(0, SNAP_MS - (Date.now() - started)));
  try {
    const view = pin.viewport ?? {};
    const url = options.url ?? pin.url;
    const page = await browser.newPage({
      viewport: { width: bound(view.w ?? 1280, 320, 3840), height: bound(view.h ?? 800, 320, 2160) },
      deviceScaleFactor: bound(view.dpr ?? 1, 1, 2),
    });
    await page.goto(url, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    const found = await page.evaluate(measure, { selector: options.selector ?? pin.targets[0].selector, scrollX: view.scrollX ?? 0, scrollY: view.scrollY ?? 0 });
    const clip = found.rect && clipOf(found.rect, found.page, Number(options.pad ?? 40));
    const shoot = (form) => page.screenshot(clip ? { ...form, fullPage: true, clip } : form);
    // The first form that fits the shot limit: PNG, JPEG, then JPEG with one image pixel per CSS pixel
    // (a detailed box at dpr 2 is over 4 MiB as a JPEG), then that one at a lower quality.
    let bytes;
    for (const form of [{}, { type: "jpeg", quality: 80 }, { type: "jpeg", quality: 80, scale: "css" }, { type: "jpeg", quality: 50, scale: "css" }]) {
      bytes = await shoot(form);
      if (bytes.length <= SHOT_MAX) break;
    }
    // The values come from the page: keep them on one short line, with no control character.
    const line = (value) => oneLine(value).slice(0, 200);
    const text = clip
      ? `found ${line(found.label)} ${Math.round(found.rect.w)}x${Math.round(found.rect.h)} · color ${line(found.styles.color)} · font ${line(found.styles.font)}`
      : "element not found, viewport saved";
    // A box with no size (display: none) is not on the page.
    const facts = cleanFacts({ found: Boolean(found.rect) && (found.rect.w >= 1 || found.rect.h >= 1), text: found.text, rect: found.rect, styles: found.styles, url, at: new Date().toISOString() });
    return { bytes, text, facts };
  } catch (error) {
    // A Playwright message continues with a call log; the first line says what failed.
    throw new Error(expired ? "snap took more than 45 s" : String(error.message).split("\n", 1)[0]);
  } finally {
    clearTimeout(timer);
    await browser.close();
  }
}
