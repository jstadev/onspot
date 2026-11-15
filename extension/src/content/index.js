// The content script. One isolated mount: no page classes, stylesheets or DOM patches.
// Each module has one job; this file puts the parts on the page and starts them.
//
// Load order rule for every module: code that runs at load time (outside a function) may use
// only dom.js, env.js, the pure modules (prefs.js, format.js, shortcuts.js, target.js) and
// functions of other modules. The state and the elements of another module are read inside
// functions only: at load time they may not exist yet.
import { ext, STATE } from '../shared/protocol.js';
import { host, live, root } from './dom.js';
import { loadLocal, watchStorage } from './local.js';
import { connect, setState, startLive } from './live.js';
import { deepLink, watchRoutes } from './routes.js';
import { capsule, menu } from './capsule.js';
import { onKey, onShortcut } from './keys.js';
import { hoverLabel, outline, overlay, selectionBar } from './picker.js';
import { tray } from './drafts.js';
import { refetch } from './pins.js';
import { toastBox } from './toasts.js';

if (ext?.runtime && !document.querySelector('on-spot')) mount();

function mount() {
  document.documentElement.append(host);
  // The order of these nodes is the Tab order.
  root.append(live, menu, capsule, tray, toastBox, overlay, outline, hoverLabel, selectionBar);
  // Only his own input counts. A page script can reach an open shadow root and make events there.
  // An event that a script made (`isTrusted` false) stops here, before any of our handlers.
  // `change` is not in this list: the file input checks it itself, and a select uses `change` too.
  for (const type of ['click', 'pointerdown', 'pointerup', 'keydown', 'paste', 'drop']) {
    root.addEventListener(type, event => {
      if (event.isTrusted) return;
      event.stopImmediatePropagation();
      event.preventDefault();
    }, true);
  }
  // Events stop at the UI boundary. Page element handlers never receive picks.
  for (const type of ['click', 'dblclick', 'pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'mousemove', 'contextmenu', 'wheel', 'input', 'change']) {
    root.addEventListener(type, event => event.stopPropagation());
  }
  root.addEventListener('keydown', event => {
    onKey(event);
    event.stopPropagation();
  });
  window.addEventListener('keydown', onShortcut, true);
  watchStorage(); watchRoutes(); startLive();
  setState(STATE.CONNECTING);
  loadLocal(); refetch(); connect(); deepLink();
}
