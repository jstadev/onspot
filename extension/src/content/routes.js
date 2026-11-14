// The address of the page: route changes of single-page apps and the deep link `#kog-pin=<id>`.
import { connectionState, setState } from './live.js';
import { setMode } from './picker.js';
import { closePopup } from './notes.js';
import { renderMarkers } from './pins.js';
import { card, closeCard, openCard } from './card.js';

let href = location.href, routeTimer = 0;
// The page URL without the fragment. Pins and unsent text belong to it.
export let pageURL = withoutHash();

export function withoutHash() { const url = new URL(location.href); url.hash = ''; return url.href; }
export async function deepLink() {
  const match = /^#kog-pin=([1-9][0-9]{0,11})$/.exec(location.hash);
  if (!match) return;
  const id = Number(match[1]);
  const original = location.href;
  await openCard(id, true);
  if (location.href === original && card?.id === id && card.pin) {
    history.replaceState(history.state, '', withoutHash());
    href = location.href;
  }
}
function routeChanged() {
  if (location.href === href) return;
  href = location.href;
  const next = withoutHash();
  if (next !== pageURL) {
    closePopup(false); closeCard(false); setMode(false);
    pageURL = next; renderMarkers();
    setState(connectionState);
  }
  deepLink();
}
// Single-page apps change the URL without a load: the Navigation API tells us, else a 1 s check.
export function watchRoutes() {
  if (window.navigation) window.navigation.addEventListener('currententrychange', routeChanged);
  else routeTimer = setInterval(routeChanged, 1000);
  window.addEventListener('hashchange', routeChanged);
}
export function stopRoutes() { clearInterval(routeTimer); }
