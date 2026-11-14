// Freeze: pauses the CSS animations and transitions of the page, and the running animations.
import { root, setPressed } from './dom.js';
import { schedule } from './layout.js';
import { freezeButton, renderTitles } from './capsule.js';

export let frozen = false;
let freezeSheet = null, pausedAnimations = [];

export function toggleFreeze() {
  frozen = !frozen;
  setPressed(freezeButton, frozen);
  renderTitles();
  if (frozen) {
    pausedAnimations = document.getAnimations().filter(animation => animation.playState === 'running' && animation.effect?.target?.getRootNode() !== root);
    pausedAnimations.forEach(animation => animation.pause());
    freezeSheet = new CSSStyleSheet();
    freezeSheet.replaceSync('*, *::before, *::after { animation-play-state: paused !important; transition: none !important; }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, freezeSheet];
  } else {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(item => item !== freezeSheet);
    freezeSheet = null;
    for (const animation of pausedAnimations) if (animation.playState === 'paused') animation.play();
    pausedAnimations = [];
  }
  schedule();
}
