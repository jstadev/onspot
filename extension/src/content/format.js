// Words and numbers as he reads them: the pure part. No DOM and no storage, so node tests it.

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// One line of at most `max` characters. The cut never keeps half a character (a lone first unit of a surrogate pair).
export const clip = (text, max) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim(), end = max - 1 - /[\uD800-\uDBFF]/.test(s[max - 2]);
  return s.length > max ? `${s.slice(0, end)}…` : s;
};
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
// Go back (v3.5). The short sha is the first 7 characters of the commit.
export const sha7 = commit => String(commit ?? '').slice(0, 7);
// The tag next to the status: a go back that is not complete, or the result of one.
export const revertTag = pin => pin.revert ? 'Going back' : pin.status === 'done' && pin.revertedAt ? 'Reverted' : '';
const fixLine = (k, version) => [`fix ${k}`, sha7(version?.commit), clip(version?.summary, 80)].filter(Boolean).join(' · ');
// What the Go back panel shows, or null when the card has no Go back. Version k is the page after
// fix k (versions[k - 1]); going back to it undoes versions[k] and every later fix, so the commit
// to send is versions[k].commit. The choices are newest first; the last one is the default.
export function goBack(pin) {
  const list = Array.isArray(pin.versions) ? pin.versions : [], n = list.length;
  if (!n || pin.revert || (pin.status !== 'done' && pin.status !== 'dismissed')) return null;
  const choices = [];
  for (let k = n - 1; k > 0; k--) choices.push({ label: `After ${fixLine(k, list[k - 1])}`, commit: list[k]?.commit });
  choices.push({ label: 'Before this pin (the page before any fix)', commit: list[0]?.commit });
  return {
    now: n > 1 ? `Now: ${fixLine(n, list[n - 1])}` : '',
    ask: n > 1 ? 'Go back to which version?' : `Go back to the page before this pin? An agent undoes ${sha7(list[0]?.commit)} and ships the old version.`,
    choices,
  };
}
