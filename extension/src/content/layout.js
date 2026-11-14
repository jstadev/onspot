// Where things sit: one batch of layout reads and writes per frame, and the watchers that ask
// for a frame (scroll, resize, page DOM changes). No watcher runs while there is nothing to place.
import { resolveTarget, shortName } from './target.js';
import { el, host, root } from './dom.js';
import { suspended } from './live.js';
import { menu } from './capsule.js';
import { hover, hoverLabel, mode, outline, readHover, selected, selectionBoxes } from './picker.js';
import { popup } from './notes.js';
import { markers } from './pins.js';
import { settings } from './settings.js';
import { card } from './card.js';

let frame = 0, dirtySelectors = true, watching = false, observing = false, mutationTimer = 0;
// The highlight of "See it": { node, target, element }.
let flash = null;
const observedRoots = new Set();

const mutationObserver = new MutationObserver(records => {
  if (!markers.size || records.every(record => record.target === host || root.contains(record.target))) return;
  if (!mutationTimer) mutationTimer = setTimeout(() => { mutationTimer = 0; dirtySelectors = true; schedule(); }, 250);
});
function observeRoot(node) {
  if (!observing || observedRoots.has(node)) return;
  observedRoots.add(node);
  mutationObserver.observe(node, { subtree: true, childList: true, attributes: true, characterData: true });
  if (node !== document.documentElement) node.addEventListener('scroll', schedule, { capture: true, passive: true });
}
export function syncWatchers() {
  const need = Boolean(mode || markers.size || popup || card || settings || flash);
  if (need !== watching) {
    watching = need;
    if (need) { window.addEventListener('scroll', schedule, { capture: true, passive: true }); window.addEventListener('resize', schedule); }
    else { window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); }
  }
  if (Boolean(markers.size) !== observing) {
    observing = Boolean(markers.size);
    if (observing) observeRoot(document.documentElement);
    else {
      mutationObserver.disconnect(); clearTimeout(mutationTimer); mutationTimer = 0;
      for (const node of observedRoots) if (node !== document.documentElement) node.removeEventListener('scroll', schedule, true);
      observedRoots.clear();
    }
  }
}
export function schedule() { if (!frame && !suspended) frame = requestAnimationFrame(position); }
// The marker selectors are looked up again in the next frame.
export function markDirty() { dirtySelectors = true; }
// The page goes away or into the page cache.
export function cancelFrame() { cancelAnimationFrame(frame); frame = 0; }
export function stopObserver() { mutationObserver.disconnect(); }
function targetRect(target, element) {
  if (element?.isConnected) return element.getBoundingClientRect();
  const rect = target?.rect || { x: 8, y: scrollY + 8, w: 0, h: 0 };
  return { left: rect.x - scrollX, top: rect.y - scrollY, right: rect.x - scrollX + rect.w, bottom: rect.y - scrollY + rect.h, width: rect.w, height: rect.h };
}
function placeBox(node, rect) {
  node.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
  node.style.setProperty('width', `${rect.width}px`);
  node.style.setProperty('height', `${rect.height}px`);
}
function position() {
  frame = 0;
  // Read first, then write. Pointer events and scroll events only schedule this batch.
  const hoverRect = readHover();
  const selectionRects = selected.map(node => node.isConnected ? node.getBoundingClientRect() : null);
  const markerRects = [];
  for (const entry of markers.values()) {
    if (dirtySelectors || !entry.element?.isConnected) entry.element = resolveTarget(entry.data.target);
    if (entry.element) {
      for (let node = entry.element; node?.getRootNode().host; node = node.getRootNode().host) observeRoot(node.getRootNode());
    }
    markerRects.push([entry, targetRect(entry.data.target, entry.element)]);
  }
  dirtySelectors = false;
  let flashRect = null;
  if (flash) {
    if (!flash.element?.isConnected) flash.element = resolveTarget(flash.target);
    flashRect = targetRect(flash.target, flash.element);
  }
  const panels = [];
  if (popup) panels.push([popup.panel, popup.edit ? targetRect(popup.draft.body.targets[0], resolveTarget(popup.draft.body.targets[0])) : targetRect(null, popup.elements[0])]);
  if (card) {
    const target = card.pin?.targets[0];
    panels.push([card.panel, targetRect(target, target && resolveTarget(target))]);
  }
  // The Settings sheet sits above the menu. On a narrow screen the menu can take two lines.
  const menuHeight = settings ? menu.offsetHeight : 0;
  const panelPositions = panels.map(([panel, rect]) => {
    const width = panel.offsetWidth, height = panel.offsetHeight;
    let x = rect.right + 12;
    if (x + width > innerWidth - 8) x = rect.left;
    let y = rect.top;
    if (y + height > innerHeight - 8) y = rect.bottom - height;
    return [panel, Math.max(8, Math.min(x, innerWidth - width - 8)), Math.max(8, Math.min(y, innerHeight - height - 8))];
  });
  outline.hidden = !hoverRect; hoverLabel.hidden = !hoverRect;
  if (hoverRect) {
    placeBox(outline, hoverRect);
    hoverLabel.textContent = `${shortName(hover)} ${Math.round(hoverRect.width)}×${Math.round(hoverRect.height)}`;
    hoverLabel.style.transform = `translate(${Math.max(8, hoverRect.left)}px, ${Math.max(4, hoverRect.top - 28)}px)`;
  }
  selectionBoxes.forEach((node, i) => { node.hidden = !selectionRects[i]; if (selectionRects[i]) placeBox(node, selectionRects[i]); });
  // Centre the 24px marker on the element's top-left corner, so it covers less of the content.
  // Markers that would cover each other (pins on one element) line up to the right.
  const placed = [];
  for (const [entry, rect] of markerRects) {
    let x = Math.max(2, rect.left - 12);
    const y = Math.max(2, rect.top - 12);
    while (placed.some(([px, py]) => Math.abs(px - x) < 22 && Math.abs(py - y) < 22)) x += 26;
    placed.push([x, y]);
    entry.node.style.transform = `translate(${x}px, ${y}px)`;
    entry.node.dataset.missing = String(!entry.element?.isConnected);
  }
  if (flashRect && flash) placeBox(flash.node, flashRect);
  for (const [panel, x, y] of panelPositions) panel.style.transform = `translate(${x}px, ${y}px)`;
  if (settings) {
    settings.panel.style.setProperty('bottom', `calc(var(--edge-b) + ${menuHeight + 8}px)`);
    settings.panel.style.setProperty('max-height', `calc(100dvh - var(--edge-b) - ${menuHeight + 20}px)`);
  }
}
export function showFlash(target, element) {
  flash?.node.remove();
  const node = el('div', 'flash');
  root.append(node);
  flash = { node, target, element };
  setTimeout(() => { if (flash?.node === node) { node.remove(); flash = null; } }, 2600);
  schedule();
}
export function setError(node, text = '') {
  node.textContent = text;
  node.hidden = !text;
  schedule();
}
