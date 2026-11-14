// Pin mode: a layer over the page catches the pointer, shows the element under it and picks.
import { elementAt, parentElement } from './target.js';
import { announce, button, el, host, root, setPressed } from './dom.js';
import { schedule, syncWatchers } from './layout.js';
import { pinButton } from './capsule.js';
import { onPageKey } from './keys.js';
import { closePopup, openPopup, popup } from './notes.js';
import { renderTray } from './drafts.js';
import { closeLog } from './log.js';
import { loadSettings, settingsRead } from './settings-bulk.js';
import { closeCard } from './card.js';

export let mode = false, hover = null, selected = [], selectionBoxes = [];
let pointer = null, pressed = null, modeFocus = null;

export const overlay = el('div', 'overlay');
overlay.hidden = true;
overlay.setAttribute('aria-label', 'Select a page element');
export const outline = el('div', 'outline');
outline.hidden = true;
export const hoverLabel = el('div', 'hover-label');
hoverLabel.hidden = true;
export const selectionBar = el('div', 'surface selection-bar');
selectionBar.hidden = true;
const selectionCount = el('span', 'selection-count');
selectionBar.append(selectionCount, button('Write a note for the selected elements', 'Note', () => openPopup(), 'primary'));

overlay.addEventListener('pointermove', event => {
  pointer = { x: event.clientX, y: event.clientY };
  schedule();
});
overlay.addEventListener('pointerleave', () => { pointer = null; hover = null; schedule(); });
overlay.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  event.preventDefault();
  pressed = { el: elementAt(event.clientX, event.clientY, host), alt: event.altKey };
  overlay.setPointerCapture(event.pointerId);
});
overlay.addEventListener('pointerup', event => {
  if (event.button !== 0 || !pressed) return;
  event.preventDefault();
  let target = pressed.el;
  if (pressed.alt || event.altKey) target = parentElement(target) || target;
  pressed = null;
  if (!target) return;
  if (event.shiftKey) {
    if (selected.includes(target)) selected = selected.filter(item => item !== target);
    else if (selected.length < 10) selected.push(target);
    else announce('You can select up to 10 elements.');
    renderSelection();
  } else {
    selected = [target];
    renderSelection();
    openPopup();
  }
});
overlay.addEventListener('pointercancel', () => { pressed = null; });
overlay.addEventListener('contextmenu', event => event.preventDefault());
overlay.addEventListener('wheel', event => {
  if (event.ctrlKey) return; // Keep browser zoom available.
  event.preventDefault();
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
  let dx = event.deltaX * scale, dy = event.deltaY * scale;
  let node = elementAt(event.clientX, event.clientY, host);
  while (node && node !== document.documentElement && node !== document.body) {
    const css = getComputedStyle(node);
    const x = /auto|scroll|overlay/.test(css.overflowX), y = /auto|scroll|overlay/.test(css.overflowY);
    if (x || y) {
      const beforeX = node.scrollLeft, beforeY = node.scrollTop;
      node.scrollBy({ left: x ? dx : 0, top: y ? dy : 0, behavior: 'instant' });
      dx -= node.scrollLeft - beforeX;
      dy -= node.scrollTop - beforeY;
    }
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) break;
    node = parentElement(node);
  }
  if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  schedule();
}, { passive: false });
// The read part of a layout frame: the element under the pointer and its box, or null.
export function readHover() {
  if (mode && pointer && !popup) hover = elementAt(pointer.x, pointer.y, host);
  return mode && hover?.isConnected && !popup ? hover.getBoundingClientRect() : null;
}
export function clearSelection() { selected = []; renderSelection(); }
export function toggleMode() {
  if (mode) { closePopup(); setMode(false); return; }
  const selection = window.getSelection();
  let quote = '', target = null;
  if (selection?.rangeCount && !selection.isCollapsed) {
    quote = selection.toString().trim().slice(0, 2000);
    const common = selection.getRangeAt(0).commonAncestorContainer;
    target = common.nodeType === 1 ? common : common.parentElement;
    if (target?.getRootNode() === root || target === host) target = null;
  }
  closeCard(); closeLog();
  setMode(true);
  if (quote && target) { selected = [target]; renderSelection(); openPopup({ quote }); }
}
export function setMode(value) {
  if (mode === value) return;
  mode = value;
  overlay.hidden = !mode;
  setPressed(pinButton, mode);
  if (mode) {
    modeFocus = document.activeElement;
    document.addEventListener('keydown', onPageKey, true);
    pinButton.focus({ preventScroll: true });
    if (!settingsRead) loadSettings(); // the tray shows bulk mode; never read before pin mode (item 16)
  } else {
    document.removeEventListener('keydown', onPageKey, true);
    pointer = null; hover = null; pressed = null; selected = [];
    renderSelection();
    if (modeFocus?.isConnected && modeFocus !== host) modeFocus.focus?.({ preventScroll: true });
  }
  renderTray(); syncWatchers(); schedule();
}
function renderSelection() {
  selectionBoxes.forEach(node => node.remove());
  selectionBoxes = selected.map(() => {
    const node = el('div', 'outline selected');
    root.append(node); return node;
  });
  selectionCount.textContent = `${selected.length} selected`;
  selectionBar.hidden = !mode || !selected.length || Boolean(popup);
  schedule();
}
