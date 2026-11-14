// The mount point and the small builders for our elements. All text goes in as `textContent`,
// all CSS lives in the constructed sheet. This module imports no other part of the UI.
import { CSS_TEXT } from './styles.js';

// group -> pick(index): Alt+1 to Alt+6 pick a tab without a made click.
const pickers = new WeakMap();

export const host = document.createElement('on-spot');
export const root = host.attachShadow({ mode: 'open' });
const sheet = new CSSStyleSheet();
sheet.replaceSync(CSS_TEXT);
root.adoptedStyleSheets = [sheet];

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const paths = {
  pin: ['M9 3h6l-1 5 3 3v2H7v-2l3-3-1-5Z', 'M12 13v8'],
  close: ['m6 6 12 12', 'M18 6 6 18'],
  gear: ['M10.1 4.9l0.5 -2.4h2.8l0.5 2.4l1.8 0.8l2 -1.4l2 2l-1.4 2l0.8 1.8l2.4 0.5v2.8l-2.4 0.5l-0.8 1.8l1.4 2l-2 2l-2 -1.4l-1.8 0.8l-0.5 2.4h-2.8l-0.5 -2.4l-1.8 -0.8l-2 1.4l-2 -2l1.4 -2l-0.8 -1.8l-2.4 -0.5v-2.8l2.4 -0.5l0.8 -1.8l-1.4 -2l2 -2l2 1.4Z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z'],
  sliders: ['M4 7h10', 'M18 7h2', 'M4 17h2', 'M10 17h10', 'M16 5v4', 'M8 15v4'],
  external: ['M8 16 16 8', 'M9 8h7v7'],
  up: ['m6 15 6-6 6 6'], down: ['m6 9 6 6 6-6'], plus: ['M12 5v14', 'M5 12h14'], minus: ['M5 12h14'],
  edit: ['M4 20h4L19 9l-4-4L4 16v4Z'],
  freeze: ['M9 5v14', 'M15 5v14'],
  eye: ['M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
  eyeOff: ['M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0', 'M3 3l18 18'],
  log: ['M8 6h12', 'M8 12h12', 'M8 18h12', 'M3 6h1', 'M3 12h1', 'M3 18h1'],
};
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  for (const d of paths[name]) {
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
export function setTitle(node, title) {
  node.title = title;
  node.setAttribute('aria-label', title);
}
export function setPressed(node, value) { node.setAttribute('aria-pressed', String(value)); return node; }
// A button with text is named by its text and the title describes it. An icon button is named
// by its title.
export function button(title, text, action, className = '') {
  const node = el('button', className, text);
  node.type = 'button';
  if (text) node.title = title; else setTitle(node, title);
  node.addEventListener('click', action);
  return node;
}
export function iconButton(title, name, action, className = '') {
  const node = button(title, undefined, action, `icon ${className}`);
  node.append(icon(name));
  return node;
}
// Like `button`: a link with text is named by its text.
export function link(title, url, className = 'link', text) {
  const node = el('a', className, text);
  node.href = url;
  node.target = '_blank';
  node.rel = 'noopener noreferrer';
  if (text) node.title = title; else setTitle(node, title);
  return node;
}
export function field(tag, name, label, max) {
  const node = el(tag);
  node.name = name;
  node.setAttribute('aria-label', label);
  node.autocomplete = 'off';
  node.maxLength = max;
  node.placeholder = label;
  return node;
}
export const textarea = (name, label, max = 4000) => field('textarea', name, label, max);
// One choice or none: a second click clears it. `state[key]` holds the chosen id.
export function choice(className, label, options, state, key, changed) {
  const group = el('div', className);
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  group.hidden = !options.length;
  const sync = () => { for (const node of group.children) setPressed(node, node.dataset.id === state[key]); };
  const pick = id => { state[key] = state[key] === id ? null : id; sync(); changed?.(); };
  for (const [id, text, title] of options) {
    const node = button(title, text, () => pick(id));
    node.dataset.id = id;
    node.dataset.key = `${key}:${id}`;
    group.append(node);
  }
  sync();
  pickers.set(group, index => { if (options[index]) pick(options[index][0]); });
  return group;
}
export const pickAt = (group, index) => pickers.get(group)(index);
export function errorNode(id) {
  const node = el('p', 'error');
  node.id = id;
  node.setAttribute('role', 'alert');
  node.hidden = true;
  return node;
}
export const modifier = event => event.metaKey || event.ctrlKey;
export const live = el('span', 'sr-only');
live.setAttribute('role', 'status');
live.setAttribute('aria-live', 'polite');
export const announce = text => { live.textContent = text; };
export function panelShell(className, titleText, onClose, closeTitle = 'Close the card') {
  const panel = el('section', `surface panel ${className}`);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', titleText);
  panel.tabIndex = -1; // a click on its text keeps the focus inside, so Esc still closes it
  const head = el('div', 'panel-head');
  const title = el('h2', 'panel-title', titleText);
  const close = iconButton(closeTitle, 'close', onClose);
  head.append(title, close);
  panel.append(head);
  root.append(panel);
  return { panel, title, head, close };
}
export function row(text, detail, controls, off = false) {
  const node = el('div', 'row'), label = el('span', 'row-label');
  node.dataset.off = String(off);
  label.append(el('span', '', text));
  if (detail) label.append(el('span', 'row-text', detail));
  node.append(label, ...controls);
  return node;
}
export function heading(text, detail) {
  const node = el('h3', 'sheet-title', text);
  if (detail) node.append(el('span', '', detail));
  return node;
}
export function addButton(text, key, action) {
  const node = button(text, undefined, action, 'add');
  node.append(icon('plus'), el('span', '', text));
  node.dataset.key = key;
  return node;
}
