// Words and numbers as he reads them: the pure part. No DOM and no storage, so node tests it.

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const clip = (text, max) => { const s = String(text ?? '').replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
export function when(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}
export function newer(a, b) {
  const parse = v => String(v ?? '').split('.').map(n => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}
export function isOpen(pin) { return pin.status === 'queued' || pin.status === 'working' || pin.status === 'waiting'; }
// "opus 5.5 high" shows as "Opus 5.5 high"; an old bare "opus" or "sonnet" shows as "Opus 5.5".
export function modelName(pin) {
  const model = String(pin.model || '').trim();
  return model && model[0].toUpperCase() + model.slice(1) + (/^(opus|sonnet)$/i.test(model) ? ' 5.5' : '');
}
export function statusText(pin) {
  if (pin.status === 'queued') return pin.attempts ? 'Queued again' : 'Queued';
  if (pin.status === 'working') return `Fixing${modelName(pin) ? ` · ${modelName(pin)}` : pin.agent ? ` · ${pin.agent}` : ''}`;
  if (pin.status === 'waiting') return 'Needs you';
  if (pin.status === 'done') return 'Done';
  if (pin.status === 'dismissed') return 'Dismissed';
  return pin.status || '';
}
export function elapsed(pin) {
  const seconds = Math.floor((Date.now() - Date.parse(pin.startedAt)) / 1000);
  if (!(seconds >= 0)) return '';
  const minutes = Math.floor(seconds / 60), two = n => String(n % 60).padStart(2, '0');
  return `Fixing for ${minutes < 60 ? minutes : `${Math.floor(minutes / 60)}:${two(minutes)}`}:${two(seconds)}`;
}
