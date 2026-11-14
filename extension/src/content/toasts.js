// Toasts: short messages for live changes of a pin. At most 3 show.
import { clip } from './format.js';
import { button, el, iconButton } from './dom.js';

export const toasts = new Map();
export const toastBox = el('div', 'toasts');

export function toast({ key, pin, kind, title, text, actions = [], ms = 8000 }) {
  let item = toasts.get(key);
  if (!item) {
    item = { node: el('div', 'surface toast'), timer: 0 };
    item.node.setAttribute('role', kind === 'waiting' ? 'alert' : 'status');
    item.node.addEventListener('pointerenter', () => clearTimeout(item.timer));
    item.node.addEventListener('pointerleave', () => { if (item.ms) item.timer = setTimeout(() => dropToast(key), 3000); });
    toasts.set(key, item);
    toastBox.append(item.node);
    while (toasts.size > 3) dropToast(toasts.keys().next().value);
  }
  item.node.dataset.kind = item.kind = kind;
  item.pin = pin;
  const body = el('div', 'toast-body');
  body.append(el('strong', 'toast-title', title));
  if (text) body.append(el('span', 'toast-text', clip(text, 220)));
  const row = el('div', 'toast-actions');
  for (const [label, name, action] of actions) row.append(button(label, name, () => { dropToast(key); action(); }, 'small'));
  if (actions.length) body.append(row);
  item.node.replaceChildren(body, iconButton('Close this message', 'close', () => dropToast(key)));
  clearTimeout(item.timer);
  item.ms = ms; // 0 = stays until its pin changes or he closes it
  if (ms) item.timer = setTimeout(() => dropToast(key), ms);
}
export function dropToast(key) {
  const item = toasts.get(key);
  if (!item) return;
  clearTimeout(item.timer); item.node.remove(); toasts.delete(key);
}
