const primary = document.querySelector('#target');
primary.addEventListener('click', () => __metrics.pageClicks++);
document.querySelector('#route').addEventListener('click', () => history.pushState({}, '', '/second'));
// Every key press that reaches the page, as the page reads it. A window listener: the idle check counts document listeners.
window.addEventListener('keydown', event => {
  if (!/^(Shift|Control|Alt|Meta|OS)(Left|Right)$/.test(event.code)) __metrics.pageKeys.push(`${event.ctrlKey ? 'Ctrl+' : ''}${event.metaKey ? 'Meta+' : ''}${event.altKey ? 'Alt+' : ''}${event.shiftKey ? 'Shift+' : ''}${event.code}`);
});
const shadowHost = document.querySelector('#shadow-host');
if (shadowHost) {
  const root = shadowHost.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(':host { display:block; } button { display:block; border:2px solid #607c68; border-radius:8px; padding:20px; background:#f0f8f1; color:#203328; font:600 16px system-ui; width:260px; margin:0; }');
  root.adoptedStyleSheets = [sheet];
  const button = document.createElement('button'); button.id = 'shadow-target'; button.textContent = 'Shadow root target';
  root.append(button);
}
