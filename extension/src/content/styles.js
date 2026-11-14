export const CSS_TEXT = `
:host {
  all: initial !important; position: fixed !important; inset: 0 auto auto 0 !important;
  width: 0 !important; height: 0 !important; z-index: 2147483647 !important;
  pointer-events: none !important; color-scheme: dark;
  --surface: #18181b; --raised: #27272a; --line: #3f3f46; --text: #fafafa; --well: #111113;
  --muted: #b4b4bd; --accent: #2563eb; --focus: #93c5fd;
  --queued: #2563eb; --working: #fbbf24; --waiting: #8b5cf6; --done: #4ade80; --failed: #dc2626;
  --font: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --ease-out: cubic-bezier(.23,1,.32,1); --ease-slide: cubic-bezier(.22,1,.36,1); --duration: 150ms;
  --edge-b: max(16px, env(safe-area-inset-bottom)); --edge-r: max(16px, env(safe-area-inset-right));
}
*, *::before, *::after { box-sizing: border-box; }
* { font-family: var(--font); font-size: 13px; line-height: 1.45; letter-spacing: normal; text-transform: none; }
[hidden] { display: none !important; }
button, a, textarea, input, select { font-family: var(--font); font-size: 13px; line-height: 1.45; color: inherit; }
button, a { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
button { border: 0; cursor: pointer; background: transparent; margin: 0; }
button:disabled { cursor: wait; opacity: .55; }
button, .link { min-height: 32px; border-radius: 6px; padding: 5px 9px; }
button:focus-visible, a:focus-visible, textarea:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
button:active:not(:disabled) { opacity: .8; }
@media (hover: hover) { button:hover:not(:disabled), .link:hover { background: var(--raised); } }
svg { width: 17px; height: 17px; display: block; flex: none; }
.icon { display: inline-flex; align-items: center; justify-content: center; width: 32px; padding: 5px; flex: none; }
.surface { pointer-events: auto; background: var(--surface); color: var(--text); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 4px 20px #00000024; }
.capsule, .menu { position: fixed; bottom: var(--edge-b); z-index: 8; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 20px; }
.capsule { right: var(--edge-r); }
.capsule .icon { position: relative; width: 37px; }
.capsule button, .menu button, .menu a { border-radius: 16px; white-space: nowrap; }
.badge { position: absolute; top: -7px; left: -7px; background: var(--queued); color: white; border: 2px solid var(--surface); border-radius: 20px; min-width: 19px; padding: 0 3px; font-size: 10px; line-height: 15px; font-weight: 650; text-align: center; pointer-events: none; }
.badge[data-drafts='true'] { background: var(--focus); color: #18181b; }
.dot { position: absolute; right: 4px; width: 7px; height: 7px; border-radius: 50%; box-shadow: 0 0 0 1.5px var(--surface); }
.connection { top: 4px; background: var(--working); }
.connection[data-state='live'] { background: var(--done); }
.connection[data-state='offline'], .connection[data-state='login'] { background: var(--failed); }
.update-dot { bottom: 4px; background: var(--focus); }
.menu { right: calc(var(--edge-r) + 131px); flex-wrap: wrap; justify-content: flex-end; max-width: calc(100vw - var(--edge-r) - 139px); opacity: 0; visibility: hidden; transform: translateX(16px); transition: transform 180ms var(--ease-out), opacity 180ms var(--ease-out), visibility 0s 180ms; }
.menu[data-open='true'] { opacity: 1; visibility: visible; transform: none; transition: transform 240ms var(--ease-slide), opacity 240ms var(--ease-slide); }
.log-button { display: flex; gap: 5px; align-items: center; font-variant-numeric: tabular-nums; }
[aria-pressed='true'], .menu-button[aria-expanded='true'] { background: var(--raised); color: var(--focus); }
.pin-button[aria-pressed='true'], .primary { background: var(--accent); color: white; }
@media (hover: hover) { .primary:hover:not(:disabled), .pin-button[aria-pressed='true']:hover { background: #1d4ed8; } }
.link { display: inline-flex; align-items: center; gap: 5px; text-decoration: none; }
.login, .update, .watch { font-size: 12px; }
.update, .watch, .add { color: var(--focus); }
.small { padding: 3px 9px; font-size: 12px; }
.subtle { color: var(--muted); }
.keys { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; line-height: 18px; font-family: var(--font); white-space: nowrap; }
.hint { margin-right: auto; color: var(--muted); font-size: 11px; }
.tray { position: fixed; bottom: var(--edge-b); left: 50%; transform: translateX(-50%); z-index: 8; display: flex; align-items: center; gap: 6px; padding: 3px 3px 3px 14px; min-height: 40px; max-width: calc(100vw - 32px); }
.tray-text { font-size: 13px; font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; margin-right: 4px; }
.tray[data-state='hint'] .tray-text { color: var(--muted); font-weight: 400; padding-right: 11px; }
.tray[data-state='error'] .tray-text { color: #fca5a5; white-space: normal; }
.confirm-inline { display: flex; align-items: center; gap: 4px; font-size: 12px; }
.toasts { position: fixed; left: max(16px, env(safe-area-inset-left)); bottom: var(--edge-b); z-index: 9; display: flex; flex-direction: column; gap: 8px; width: min(340px, calc(100vw - 32px)); pointer-events: none; }
.toast { display: flex; align-items: flex-start; gap: 4px; padding: 10px 6px 10px 12px; border-left: 3px solid var(--queued); }
.toast[data-kind='done'] { border-left-color: var(--done); }
.toast[data-kind='working'] { border-left-color: var(--working); }
.toast[data-kind='waiting'] { border-left-color: var(--waiting); }
.toast[data-kind='dismissed'] { border-left-color: var(--line); }
.toast-body { flex: 1; min-width: 0; display: grid; gap: 3px; }
.toast-title { font-weight: 650; }
.toast-text { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.toast-actions { display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap; }
.toast-actions button { background: var(--raised); }
.flash { position: fixed; top: 0; left: 0; border: 2px solid var(--done); border-radius: 6px; box-shadow: 0 0 0 4px #4ade8033; pointer-events: none; z-index: 3; animation: onspot-flash 1.2s var(--ease-out) 2; }
@keyframes onspot-flash { 0% { opacity: 0; } 30% { opacity: 1; } 100% { opacity: .2; } }
.overlay { position: fixed; inset: 0; cursor: crosshair; pointer-events: auto; background: transparent; z-index: 1; touch-action: none; }
.outline { position: fixed; top: 0; left: 0; border: 2px solid var(--accent); background: #2563eb0a; pointer-events: none; z-index: 2; }
.outline.selected { border-style: dashed; background: #2563eb06; }
.hover-label { position: fixed; top: 0; left: 0; padding: 3px 7px; max-width: calc(100vw - 16px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: var(--accent); color: white; font-size: 11px; border-radius: 4px; pointer-events: none; z-index: 3; }
.selection-bar { position: fixed; bottom: calc(var(--edge-b) + 52px); right: var(--edge-r); z-index: 8; padding: 3px; display: flex; align-items: center; gap: 12px; }
.selection-count { padding-left: 8px; color: var(--muted); font-size: 12px; }
.marker { position: fixed; top: 0; left: 0; z-index: 4; pointer-events: auto; width: 24px; height: 24px; min-height: 24px; padding: 0; border-radius: 50%; background: var(--queued); color: white; border: 1px solid #ffffffa0; box-shadow: 0 1px 5px #0002; font-size: 11px; line-height: 22px; font-weight: 650; transition: opacity var(--duration) var(--ease-out); font-variant-numeric: tabular-nums; }
.marker::before, .marker[data-status='working']::after { content: ''; position: absolute; inset: -4px; border-radius: 50%; }
.marker[data-status='working']::after { inset: -1px; border: 2px solid var(--working); opacity: 0; pointer-events: none; animation: onspot-pulse 1.8s var(--ease-out) infinite; }
@keyframes onspot-pulse { from { transform: scale(1); opacity: .7; } to { transform: scale(1.9); opacity: 0; } }
.marker[data-status='working'] { background: var(--working); color: #18181b; }
.marker[data-status='waiting'] { background: var(--waiting); color: white; }
.marker[data-status='done'] { background: var(--done); color: #18181b; }
.marker[data-status='draft'] { background: var(--surface); color: var(--text); border: 2px dashed var(--focus); line-height: 20px; }
.marker[data-missing='true'] { opacity: .45; }
@media (hover: hover) { .marker:hover { filter: brightness(1.12); background: var(--queued); } .marker[data-status='working']:hover { background: var(--working); } .marker[data-status='waiting']:hover { background: var(--waiting); } .marker[data-status='done']:hover { background: var(--done); } .marker[data-status='draft']:hover { background: var(--raised); } }
.panel { position: fixed; top: 0; left: 0; z-index: 7; width: min(320px, calc(100vw - 16px)); max-height: calc(100dvh - 24px); overflow-y: auto; overscroll-behavior: contain; }
.panel.popup, .panel.sheet { width: min(344px, calc(100vw - 16px)); }
.panel-head { display: flex; gap: 8px; align-items: center; padding: 7px 7px 6px 13px; border-bottom: 1px solid var(--line); }
.panel-title { flex: 1; min-width: 0; font-weight: 600; margin: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel-body { padding: 12px; }
.panel.log, .panel.sheet { left: auto; right: var(--edge-r); }
.panel.log { top: max(12px, env(safe-area-inset-top)); width: min(380px, calc(100vw - 24px)); max-height: calc(100dvh - 88px); display: flex; flex-direction: column; overflow: hidden; }
.panel.sheet { top: auto; bottom: calc(var(--edge-b) + 48px); max-height: calc(100dvh - var(--edge-b) - 60px); }
.log-host { margin-left: 8px; color: var(--muted); font-weight: 400; }
.log-body { flex: 1; overflow-y: auto; overscroll-behavior: contain; min-height: 60px; }
.log-group + .log-group { border-top: 6px solid #0f0f11; }
.log-group-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 9px 12px 7px; color: var(--muted); font-size: 11.5px; font-weight: 600; }
.log-progress { font-weight: 500; font-variant-numeric: tabular-nums; }
.log-row { display: grid; gap: 3px; width: 100%; text-align: left; padding: 9px 12px; border-radius: 0; border-top: 1px solid var(--line); }
.log-row-head { display: flex; align-items: center; gap: 7px; }
.log-number { color: var(--muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.log-note { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.log-meta { color: var(--muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.log-detail { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.log-row[data-status='done'] .log-detail { color: #bbf7d0; }
.log-row[data-status='working'] .log-detail { color: #fde68a; }
.log-detail.ask { color: #ddd6fe; }
.log-empty { color: var(--muted); padding: 14px 12px; margin: 0; }
.log-footer { border-top: 1px solid var(--line); padding: 6px 8px; display: flex; justify-content: flex-end; }
.log-footer .link { font-size: 12px; color: var(--muted); }
.chip { font-size: 10.5px; font-weight: 650; padding: 1px 7px; border-radius: 20px; background: var(--raised); color: var(--muted); white-space: nowrap; }
.chip[data-status='queued'] { background: #1e3a8a; color: #bfdbfe; }
.chip[data-status='working'] { background: #78350f; color: #fde68a; }
.chip[data-status='waiting'] { background: #4c1d95; color: #ddd6fe; }
.chip[data-status='done'] { background: #14532d; color: #bbf7d0; }
.chip[data-status='draft'], .chip.preset { background: transparent; color: var(--focus); border: 1px dashed var(--focus); }
.chip.preset { color: var(--muted); border-color: var(--line); overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.seg, .chips, .tags { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 8px; }
.seg { gap: 2px; padding: 2px; border: 1px solid var(--line); border-radius: 9px; background: var(--well); }
.seg button, .chips button { padding: 0 7px; font-size: 12px; color: var(--muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seg button { flex: 1 1 auto; }
.chips button { padding: 0 11px; border: 1px solid var(--line); border-radius: 16px; max-width: 100%; }
.presets button { border-style: dashed; }
.seg [aria-pressed='true'], .chips [aria-pressed='true'] { color: var(--focus); }
.chips [aria-pressed='true'] { border: 1px solid var(--focus); }
.tags { margin: -4px 0 12px; }
.popup textarea { min-height: 92px; }
textarea, input, select { display: block; width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--well); color: var(--text); caret-color: var(--focus); font-size: 13px; margin: 0; }
textarea { resize: vertical; min-height: 68px; max-height: 35dvh; }
input, select { height: 36px; padding-block: 0; margin-bottom: 6px; }
textarea::placeholder, input::placeholder { color: var(--muted); }
.panel-footer { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-top: 10px; }
.quote { border-left: 2px solid var(--focus); color: var(--muted); padding-left: 9px; margin: 0 0 12px; max-height: 90px; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
.error { color: #fca5a5; font-size: 12px; margin: 8px 0 0; overflow-wrap: anywhere; }
.status { color: var(--focus); font-size: 11px; font-weight: 600; max-width: 58%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status[data-status='working'] { color: var(--working); }
.status[data-status='waiting'] { color: #c4b5fd; }
.status[data-status='done'] { color: var(--done); }
.status[data-status='dismissed'] { color: var(--muted); }
.accepted, .revert-tag { color: var(--done); font-size: 11px; font-weight: 600; white-space: nowrap; }
.note { margin: 0 0 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.summary { margin: 0 0 10px; color: #bbf7d0; white-space: pre-wrap; overflow-wrap: anywhere; }
.question { margin: -6px 0 12px; color: #ddd6fe; white-space: pre-wrap; overflow-wrap: anywhere; }
.target-label, .detail { color: var(--muted); font-size: 12px; margin: 0 0 8px; overflow-wrap: anywhere; }
.detail strong { color: var(--text); font-size: 12px; font-weight: 500; }
.run { margin: 0 0 12px; padding-left: 10px; border-left: 2px solid var(--working); }
.run-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 32px; }
.elapsed { color: var(--working); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.steps { list-style: none; margin: 0; padding: 0 0 2px; display: grid; gap: 4px; }
.step { display: flex; gap: 8px; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.step:last-child { color: var(--text); }
.step time { flex: none; font-size: 11px; line-height: 17px; font-variant-numeric: tabular-nums; }
.shots { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 0 0 12px; }
.shot { display: grid; gap: 4px; padding: 0; min-width: 0; text-align: left; cursor: zoom-in; }
.shot[data-full='true'] { grid-column: 1 / -1; cursor: zoom-out; }
.shot-name { font-size: 11px; font-weight: 600; color: var(--muted); }
.shot canvas { display: block; width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; background: var(--well); }
.actions { display: flex; flex-wrap: wrap; gap: 3px; border-top: 1px solid var(--line); padding: 7px 9px; }
.actions button { font-size: 12px; }
.danger { color: #fca5a5; }
.replies { list-style: none; padding: 0; margin: 12px 0; }
.reply { border-top: 1px solid var(--line); padding: 10px 0; }
.reply-meta { display: flex; gap: 6px; flex-wrap: wrap; color: var(--muted); font-size: 11px; margin-bottom: 4px; }
.reply-body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.reply-form { margin-top: 12px; }
.confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; padding: 0 12px 10px; }
.confirm span { flex: 1; font-size: 12px; }
.go-back { padding: 0 12px 10px; display: grid; gap: 6px; }
.go-back p, .go-back fieldset { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.go-back fieldset { border: 0; padding: 0; min-width: 0; display: grid; gap: 2px; }
.go-back legend { padding: 0 0 4px; font-size: 12px; font-weight: 600; }
.go-back label { display: flex; align-items: flex-start; gap: 8px; min-height: 32px; padding: 6px 4px; border-radius: 6px; cursor: pointer; font-size: 12px; }
@media (hover: hover) { .go-back label:hover { background: var(--raised); } }
.go-back input { flex: none; width: 16px; height: 16px; margin: 1px 0 0; padding: 0; accent-color: var(--accent); cursor: pointer; }
.sheet-title { display: flex; justify-content: space-between; margin: 16px 0 6px; font-size: 11px; font-weight: 600; color: var(--muted); }
.sheet-title:first-child { margin-top: 0; }
.row { display: flex; align-items: center; gap: 2px; min-height: 40px; border-top: 1px solid var(--line); }
.row-label { flex: 1; min-width: 0; display: grid; }
.row-label span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-text, .row[data-off='true'] .row-label { color: var(--muted); }
.row-text { font-size: 11.5px; }
.row button:disabled { cursor: default; opacity: .3; }
.add { display: flex; align-items: center; gap: 5px; margin-top: 6px; padding-left: 5px; }
.row .keys { display: block; flex: none; margin: 0 4px; }
.reset { justify-content: flex-end; margin-top: 6px; }
.fixed-keys { margin: 12px 0 0; }
.panel-body.bulk { padding-bottom: 0; }
.bulk .row-label span, .key-row .row-label span { white-space: normal; }
.bulk .row[data-off='true'] .count { color: var(--muted); }
.switch { position: relative; width: 46px; padding: 0; flex: none; }
.switch::before, .switch::after { content: ''; position: absolute; top: 50%; border-radius: 9px; transition: transform var(--duration) var(--ease-out), background var(--duration) var(--ease-out); }
.switch::before { left: 8px; width: 30px; height: 18px; margin-top: -9px; background: var(--line); }
.switch::after { left: 10px; width: 14px; height: 14px; margin-top: -7px; background: var(--text); }
.switch[aria-checked='true']::before { background: var(--accent); }
.switch[aria-checked='true']::after { transform: translateX(12px); }
.count { min-width: 32px; line-height: 32px; border-radius: 6px; text-align: center; font-weight: 600; font-variant-numeric: tabular-nums; }
.count:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.bulk-chip { color: var(--focus); flex: none; }
.sr-only { position: fixed; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
@media (pointer: coarse) { textarea, input, select { font-size: 16px; } .panel button, .tray button { min-height: 44px; } }
@media (max-width: 719px) { .tray { left: 8px; right: 8px; transform: none; max-width: none; bottom: calc(var(--edge-b) + 52px); } .tray-text { flex: 1; } .toasts { top: max(8px, env(safe-area-inset-top)); bottom: auto; left: 8px; width: calc(100vw - 16px); } .panel.log { right: 8px; top: 8px; width: calc(100vw - 16px); max-height: calc(100dvh - 136px); } .panel.sheet { right: 8px; } .keys { display: none; } .selection-bar { bottom: calc(var(--edge-b) + 108px); } }
@media (max-width: 419px) { .tray { flex-wrap: wrap; justify-content: flex-end; padding-top: 6px; } .tray-text { flex: 1 1 100%; } }
`;
