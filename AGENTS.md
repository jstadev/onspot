# OnSpot

This file is for agents that work on the maintainer's deployment (koglabs.com). Outside contributors: read `CONTRIBUTING.md`.

OnSpot (named Kog Pins until 2026-11-14; the hub project key stays `kog-pins`) puts feedback pins on any koglabs.com page. The Chairman clicks an element in the browser extension (Chrome and Firefox), types a note and submits his pins as one batch. He sets his own keyboard shortcuts in the extension Settings (⌘K hides or shows the markers, ⌘M toggles pin mode). The server (`127.0.0.1:4750`, REST, SSE, MCP, `node:sqlite`) stores them. The runner starts one Claude session per pin in Triad at once (Opus 5.5 high; a model named in the note wins). The session does exactly what the note says, also sessions, threads and lanes, posts progress steps and before/after shots, and resolves the pin with the commit; the marker on the page turns green. The queue is the Pins tab in Triad (https://ai.koglabs.com/agents?tab=pins). The input is pins and replies. The output is fix runs, pin status, steps, shots and a log per pin.

## Read first

- `/var/lib/project-notes/kog-pins.md` (read only).
- `/root/.claude/memory-store/projects/kog-pins/MEMORY.md` and `state.md`.
- `PLAN.md`, `deploy/project.json`.
- `docs/protocol.md`: the contract between server, extension, runner, CLI and the Triad tab. Read it before you change any part.
- The rule for agents that work pins: `/root/.claude/memory-store/rules/feedback_ui_pins.md`.

## Run and test

Node 22 (`/opt/studio/bin/node`; `node:sqlite` needs 22.13 or later). The server and the runner have no npm dependencies. The extension build needs esbuild.

```sh
export PATH=/opt/studio/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset NODE_ENV   # with NODE_ENV=production npm skips esbuild
npm --prefix extension ci && npm --prefix extension run build   # release.build (writes extension/dist and the two ZIPs)
npm test                                                        # release.test: server 154, runner 139, extension 78, e2e helpers 12
npm run harness                                                 # extension UI harness: 53 groups in Chromium, 53 in Firefox
node deploy/caddy.check.mjs                                     # the proxy rules with a real Caddy
```

`npm run e2e` (`e2e/run.mjs [chrome|firefox|brave|all] [url ...]`) and `e2e/autofix.mjs` run against the live service and start a real fix run. Run them only on purpose; `run.mjs` switches auto-fix off while it runs, so his pins wait: for a short check use one URL and `E2E_IDLE_MS=0` (under a minute). The e2e signs in with the hub login module `/root/.config/onspot/e2e-login.mjs` (outside the repo, mode 0600; `E2E_LOGIN` names another file). It holds the hub SSO cookie code; never copy it into the repo. `brave` runs the Chrome build in Brave (`/opt/brave.com/brave/brave-browser`, apt repo brave-browser-release) with Shields on.

Health: `curl -s http://127.0.0.1:4750/api/health` returns `{"ok":true,...}` after a store query, else 500.

## Release

- Contract: `proj release kog-pins prod`. **Not adopted yet: do not run it.** The template unit starts on an empty database and the release stops the live unit when it fails (2026-11-10). First do the adopt steps in `PLAN.md`. OnSpot is on ai.koglabs.com only, so it has no staging channel and no approval step.
- Today both units run from `/srv/hub/pins`. Work in `/srv/work/onspot-<task>` from `origin/main`, merge, then pull into `/srv/hub/pins`, rebuild the extension and restart `onspot` (and `onspot-runner` after runner changes).
- The repository `jstadev/onspot` is public. Commit as `28742201+jstadev@users.noreply.github.com` and write no Claude line in a commit or a PR body; the hooks in `/srv/hub/pins/.git/hooks` refuse both. The old private history is `jstadev/kog-pins-old`: no push, no deploy.
- Back up `pins.db` before a schema change. The store migrates on open.
- A new extension build needs the Chairman to load it once (Triad Pins tab download, or `extension/dist/`).
- Never edit `/srv/apps/kog-pins` by hand.

## Secrets

The variable names live in `.env.example`. The values live only in the env files that `deploy/project.json` lists. Never write a value into the repo, a log, a test or a client bundle. The runner reads the Triad token by path (`TRIAD_TOKEN_FILE`); never copy its content. The Chrome extension private key stays in `/root/.config/onspot/`; `extension/manifest/chrome-key.txt` is the public key that fixes the extension ID.

## Rules

- Pins become agent work orders. The hub SSO (admin) in `deploy/onspot.caddy` is the only browser gate; never drop it.
- Caddy allows only the Origins `https://ai.koglabs.com`, the Chrome ID `djdijfjclpkhleoeaedeglfbbbmhmbff` and `moz-extension://<uuid>`, refuses blind writes, strips `X-Pins-Agent` and `Origin`, and never serves `/pins/mcp`. The server refuses any Origin. Keep both layers.
- MCP and the `pins` CLI are for local agents on loopback only.
- The extension does all network in the background script and all CSS in constructed sheets: Firefox applies page CSP to content scripts.
- The runner is a harness: no git writes, no deploy. It reads the file list of an earlier pin commit (`git diff-tree`) for the source hints. No run limits by default (`MAX_RUNS*` = 0). A retry raises the effort one step. A model named in the note (opus, sonnet, haiku, fable) runs the session itself; Triad accepts every model name (triad #46, order 2026-11-12). Grok stays out of the automation.
- A `server.js` change in Triad needs a Triad restart; use `triad-restart-when-idle.sh`.

## Where things are

- `server/`: REST, SSE, MCP, the store (`node:sqlite`) and the `pins` CLI (`bin/pins.js`), with `pins ship` (`src/ship.js`), the snap code (`src/snap.js`) and the element facts and verdict (`src/facts.js`).
- `runner/`: the auto-fix runner (one run per pin, model choice, budget, Triad client, prompt), the pin brief (`src/brief.js`) and the start profile (`src/profile.js`).
- `extension/`: the MV3 extension source, manifests, build script (`build.mjs`, with the `ONSPOT_*` build variables) and tests. New in 0.4.0: the shortcuts (`src/content/shortcuts.js`, `keys.js`, `settings-keys.js`) and the message guard (`src/bg/request.js`).
- `e2e/`: live end-to-end checks; `lib.mjs` holds the one cleanup (`endRun`), tested by `lib.test.mjs`.
- `deploy/`: the manifest, contract unit templates (`deploy/units`), the live unit files, the Caddy snippet and its check (`caddy.check.mjs`), and the CLI wrapper.
- `docs/protocol.md`: the contract.
