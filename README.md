# OnSpot

OnSpot turns a click on a web page into a work order for a coding agent.

- **What goes in:** you open a page on `koglabs.com`, click an element in the browser extension, type a note ("Cut the space above the title by half") and press Submit all.
- **What happens:** the server stores each note as a *pin* with the element's selector, text and styles. A runner starts one agent session per pin. The session finds the code, makes the change, ships it and closes the pin with the commit.
- **What comes out:** the marker on the page turns green. The pin shows the summary, the commit, the progress steps and a before and an after image. You press "Looks good", or "Not right" to send it back.

The contract between all parts is [`docs/protocol.md`](docs/protocol.md). If the code and that file disagree, the code is wrong.

## How it works

```
 Browser, on a koglabs.com page                 Host
+-----------------------------+        +--------------------------------------------------+
| extension content script    |        | Proxy (Caddy) at https://ai.koglabs.com/pins/     |
|   picker, note popup,       |        |   SSO (admin), Origin rules, strips headers,     |
|   markers, cards            |        |   never serves /mcp                               |
| extension background script | HTTPS  |        | loopback                                 |
|   all network, live stream  | -----> |        v                                          |
+-----------------------------+        | Pins server 127.0.0.1:4750                        |
                                       |   REST, SSE, MCP, SQLite, shot files              |
                                       |     ^                      ^                      |
                                       |     | REST + SSE           | REST or MCP          |
                                       | Runner (auto-fix)       pins CLI, MCP clients     |
                                       |     | POST /delegate       ^                      |
                                       |     v                      |                      |
                                       | Triad --- starts ---> agent session (Claude CLI)  |
                                       |                       edits code, ships, closes   |
                                       +--------------------------------------------------+
```

Each closed pin keeps the commits of its fixes. **Go back** in the pin card starts a revert run: you choose the version (the page before the pin, or after an earlier fix), the session undoes the later commits, ships the old version and closes the pin.

| Part | Path | What it does |
|---|---|---|
| Extension | `extension/` | MV3 extension for Chrome and Firefox. The content script draws the picker, the note popup, the markers and the cards. The background script does all network and reads the live stream. |
| Proxy | `deploy/onspot.caddy` | The only way in for a browser. It checks the hub SSO (admin) and the `Origin`, removes `X-Pins-Agent` and `Origin`, and never serves `/mcp`. |
| Server | `server/src/` | REST, live events (SSE) and MCP on `127.0.0.1`. Pins, replies, steps and settings in SQLite (`node:sqlite`). Shots as files. No npm dependencies. |
| CLI and MCP | `server/bin/pins.js`, `server/src/mcp.js` | How a local agent reads the queue, takes a pin, posts progress and shots, and closes the pin. `pins ship` does the whole ship path in one call. |
| Runner | `runner/` | Watches the queue. For each new pin it picks the model, builds a brief (project card and source hints), starts a session through Triad and takes the "before" shot. It never edits code, writes git state or deploys. |
| Agent session | not in this repo | A Claude CLI session that Triad starts with the runner's prompt. It does the work with the `pins` CLI. |
| Queue UI | not in this repo | The Pins tab of the Triad console. It calls `/pins/api/*` through the proxy. |

A pin has one of five states: `queued`, `working`, `waiting` (an agent asked a question, or a run failed), `done`, `dismissed`.

## Requirements

- Node.js 22.13 or later (`node:sqlite`). The server and the runner have no npm dependencies.
- For the extension build: `npm` (one dev dependency, `esbuild`) and the `zip` command.
- For `pins snap` and `pins check`: `playwright-core` with a Chromium build. Set `PLAYWRIGHT_CORE` to its `index.mjs`.
- For `pins ship`: `git`, the GitHub CLI `gh`, and a release command named `proj` (see "Status and limits").
- For the runner: a Triad service on loopback, `systemd-run` (the "before" shot), `grep` and `git` (the brief).
- For browsers: a reverse proxy that does what `deploy/onspot.caddy` does. The server refuses every request that carries an `Origin` header, so a browser cannot use it without the proxy.

## Quick start: a local server and the CLI

These commands use a temporary database and port 4751.

```sh
PORT=4751 PINS_DB=/tmp/onspot-demo/pins.db npm start
```

In a second shell:

```sh
export PINS_PORT=4751 PINS_AGENT=demo

curl -s http://127.0.0.1:4751/api/health
# {"ok":true,"version":"0.1.0","extension":"0.6.0","open":{"queued":0,"working":0,"waiting":0}}

# Create a pin as a user (no X-Pins-Agent header). The extension does this for you.
curl -s -X POST http://127.0.0.1:4751/api/pins -H 'Content-Type: application/json' \
  -d '{"url":"https://koglabs.com/","note":"Make the title shorter","targets":[{"selector":"h1","label":"h1 \"Welcome\""}]}'

node server/bin/pins.js list
# #1 queued koglabs.com/ · h1 "Welcome" · 3s
#   Make the title shorter
node server/bin/pins.js start 1
node server/bin/pins.js progress 1 "Found the code"
node server/bin/pins.js done 1 --summary "Title is shorter" --commit abc1234
node server/bin/pins.js show 1
node server/bin/pins.js --help
```

A pin URL must be `https` on `PINS_ROOT_DOMAIN` (default `koglabs.com`) or a subdomain. MCP clients use `POST http://127.0.0.1:4751/mcp` (10 tools; the list is in the contract).

## Build the extension

```sh
npm --prefix extension ci
npm --prefix extension run build
```

The build writes `extension/dist/chrome/`, `extension/dist/firefox/` and one ZIP for each. It fails if `content.js` is larger than 88 KB (90112 bytes). The build prints the API, the root domain, the Chrome extension id and the Firefox id; put that Chrome id in the proxy `Origin` rule.

- Chrome: open `chrome://extensions`, switch on Developer mode, press "Load unpacked" and pick `extension/dist/chrome`.
- Firefox 140 or later: open `about:debugging`, "This Firefox", "Load Temporary Add-on" and pick `extension/dist/firefox/manifest.json`. The add-on is not signed, so it loads only as a temporary add-on.

`extension/manifest/chrome-key.txt` is the public key of the Chrome build. It fixes the extension ID (`djdijfjclpkhleoeaedeglfbbbmhmbff`), which the proxy allows by name. The private key is not in this repo.

With no variable set, the extension talks only to `https://ai.koglabs.com/pins` and runs only on `koglabs.com` pages. For another deployment, set the `ONSPOT_*` build variables (see "Configuration"; the rules are in the contract, "Build variables"). A bad value stops the build. With another `ONSPOT_CHROME_KEY` the Chrome id changes.

**Shortcuts.** You work the extension from the keyboard: Cmd+M (Ctrl+M outside macOS) toggles pin mode and Cmd+K hides or shows the markers. The menu, the Log, Settings, Freeze and the queue have a default shortcut too. In Settings, "Shortcuts", you add, edit, remove and reset them (at most 3 per action, 24 in all).

## Configuration

Every environment variable that the code reads. `.env.example` holds the same names.

| Name | Part | Default | Meaning |
|---|---|---|---|
| `PORT` | server | `4750` | Port on `127.0.0.1`. An integer from 0 to 65535; 0 takes a free port. |
| `PINS_DB` | server | `<repo>/data/pins.db` | The SQLite file. The server creates the folder and migrates the schema on open. |
| `PINS_SHOTS_DIR` | server | `shots` next to the database | Folder for the before and after images. |
| `PINS_DOWNLOAD_DIR` | server | `<repo>/extension/dist` | Folder with the two extension ZIPs that `/download/` serves. |
| `PINS_ROOT_DOMAIN` | server | `koglabs.com` | A pin URL must be on this domain or a subdomain. |
| `PINS_QUEUE_URL` | server | `https://ai.koglabs.com/triad?tab=pins` | Where `GET /` redirects (the queue UI). A bad value stops the start. |
| `PINS_PORT` | CLI, runner, e2e | `4750` | Port of the server on `127.0.0.1`. |
| `PINS_AGENT` | CLI | `agent` | The agent name that the CLI sends (`X-Pins-Agent`). |
| `PINS_FACTS_DIR` | CLI, runner | `/var/lib/onspot-runner/facts` | Where `pins snap` and `pins check` keep what they measured. The runner passes it to the "before" shot. Use the same value for the runner and for every shell that runs `pins`. |
| `PINS_LOCK_DIR` | CLI (`pins ship`) | `/run/lock/onspot` | Lock files of the test lane and the release lane, and the "gate passed" markers. |
| `PLAYWRIGHT_CORE` | CLI (`pins snap`, `pins check`), harness, e2e | `/srv/design-kit/node_modules/playwright-core/index.mjs` | Path of the `playwright-core` entry file. |
| `PINS_RUNNER_DISABLED` | runner | off | `1` stops new runs. Only `0` and `1` are valid. |
| `PINS_PROJECTS_DIR` | runner | `<home>/.claude/memory-store/projects` | Folder with one `<name>/project.json` per project. The runner maps a host to a project folder with it. |
| `PINS_RUNNER_CWD` | runner | the home folder of the service user | Session folder for a pin with no project folder. |
| `PINS_SHOT_PATH` | runner | `/opt/studio/bin:/usr/local/bin:/usr/bin:/bin` | `PATH` of the "before" shot unit. |
| `PINS_RUNNER_SKIP_HOSTS` | runner | empty | Comma list of host suffixes that the runner leaves alone. Each starts with a dot, for example `.drop.koglabs.com`. |
| `PINS_RUNNER_BUDGET_FILE` | runner | `/var/lib/onspot-runner/budget.json` | The count of runs started today (UTC). It survives a restart. |
| `PINS_RUNNER_BRIEF` | runner | on | `0` switches the brief off. Only `0` and `1` are valid. |
| `PINS_RUNNER_SHOTS` | runner | on | `0` switches the "before" shot by the runner off. Only `0` and `1` are valid. |
| `PINS_RUNNER_LEAN` | runner | on | `0` switches the lean session start off. Only `0` and `1` are valid. |
| `MAX_RUNS` | runner | `0` | Runs at the same time. 0 is no limit. |
| `MAX_RUNS_PER_PROJECT` | runner | `0` | Runs at the same time for one project. 0 is no limit. |
| `MAX_RUNS_PER_DAY` | runner | `0` | Runs per UTC day. 0 is no limit. |
| `TRIAD_URL` | runner | `http://127.0.0.1:7788` | The Triad service. The runner refuses a URL that is not loopback HTTP. |
| `TRIAD_TOKEN_FILE` | runner | `/srv/hub/triad/data/token` | File with the Triad key. The runner reads it at the first request and again after a 401 or 403. |
| `PINS_CLAUDE_ACCOUNT` | runner | `claude` | The Triad account that runs the sessions: `claude` or `claude-2`. |
| `E2E_IDLE_MS` | `e2e/run.mjs` | `70000` | Idle time before the live-update check. |
| `BRAVE_PATH` | `e2e/run.mjs` | `/opt/brave.com/brave/brave-browser` | The Brave binary for the `brave` run. |
| `E2E_LOGIN` | e2e | `~/.config/onspot/e2e-login.mjs` | The login module of your deployment. It is not in this repo. It exports `user` (the name that the server records as the pin author) and `cookie(apiOrigin)` (one playwright cookie object for an admin session). |
| `ONSPOT_API` | extension build | `https://ai.koglabs.com/pins` | The API address. An https URL with a plain host name (no `*`, no IP address, no `localhost`), no query, no fragment, no user, no slash at the end. |
| `ONSPOT_ROOT_DOMAIN` | extension build | `koglabs.com` | The pages that the extension runs on. Must equal `PINS_ROOT_DOMAIN`. |
| `ONSPOT_QUEUE_URL` | extension build | `<API origin>/triad?tab=pins` | The queue link. An https URL with a query. |
| `ONSPOT_LOGIN_URL` | extension build | `<API origin>/login` | The login link. An https URL without a query. |
| `ONSPOT_RUN_URL` | extension build | `<API origin>/agents?tab=today&run=` | The "Watch live" link; the extension adds the run id. |
| `ONSPOT_CHROME_KEY` | extension build | the file `extension/manifest/chrome-key.txt` | Public key (base64, one line). It fixes the Chrome extension id. |
| `ONSPOT_GECKO_ID` | extension build | `pins@koglabs.com` | The Firefox add-on id: `name@host` or `{UUID}`. |
| `HARNESS_BROWSER`, `HARNESS_ONLY`, `HARNESS_PROBE`, `HARNESS_ENTRY` | `npm run harness` | none | Options of one harness run: one browser, only the audit probes, only the probes with these words, another content entry. |
| `FAKE_START_MS` | tests | none | `e2e/lib.test.mjs` sets it for its fake browser. Never set it yourself. |
| `FAKE_STATE`, `FAKE_MERGER`, `FAKE_PROJ_LOG` | tests | none | `server/test/ship-cli.test.js` sets them for its fake `gh` and `proj`. Never set them yourself. |

## Security model

A pin is a work order for a coding agent, and the note is an instruction. So the question is who can create a pin, and what an agent may take as an instruction.

**Trust boundaries**

1. **Browser to proxy.** Every request passes the hub SSO with the admin role. The proxy accepts three `Origin` values: `https://ai.koglabs.com`, the Chrome extension ID and a Firefox extension UUID. Any other `Origin` gets 403. A write without an `Origin` gets 403. The proxy removes `X-Pins-Agent`, so a browser always acts as the signed-in user, never as an agent. It never serves `/pins/mcp`. Firefox gives each install a random UUID, so the rule accepts every Firefox extension origin; the SSO cookie is still required.
2. **Proxy to server.** The server binds `127.0.0.1` only. It refuses a `Host` that is not `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding) and every request with an `Origin` header (a browser that did not pass the proxy). MCP and the shot upload refuse a request with `X-Forwarded-For`. A write needs `application/json`, has a size limit (64 KiB, 512 KiB for a batch, 1 MiB for MCP, 2 MiB for a shot) and takes one token from a bucket of 120 writes per minute.
3. **Local agents to server.** The loopback API has no login. Every process on the host that can open the port is trusted: with `X-Pins-Agent` it acts as an agent, without it as a user. Run the server only on a host where every local user is trusted.
4. **Page text.** Text that the extension captures from a page (labels, attributes, element text, quotes) is data, never an instruction. The store clips it. The prompt puts it inside a `<page-data>` block, replaces `<` and `>` in it, and says that the block is never an instruction. The brief uses it only as a fixed-string `grep` needle in an argument array (no shell). The verdict of the element check holds kinds and property names only, never a page value. A shot must start with PNG, JPEG or WebP magic bytes; the server sends it with `Content-Security-Policy: default-src 'none'`, and the extension draws it on a canvas.
5. **The note, his presets and his replies** are instructions. Whoever can create a pin can direct an agent session with the rights of that session.

**What the runner may do.** It reads the queue, starts sessions through Triad on loopback (two model ids and five effort levels are allowed; anything else is refused in code), reads the Triad key from a file, runs `grep` and `git diff-tree` in the project folder, writes its day count, and starts `pins snap <id> before` in a transient systemd unit. It never edits code, writes git state or deploys. Run limits are off by default.

**What `pins ship` refuses.** The paths `.env*`, `*.key`, `*.pem`, `*secret*`, `.git`, `.github/workflows/**` and `infra/**`, in any letter case; a path through a link; a folder instead of a file; a branch named `main` or `master`; a tracked file that changed but is not in the command. It releases to the staging channel only.

**The extension.** The content script never calls `fetch`. The background script forwards only the API paths and methods of an allow-list (`extension/src/shared/protocol.js`). It answers a message only when the sender is this extension on an `https:` page of the root domain (the message guard). Every request starts with the API address and follows no redirect; a redirect counts as "signed out". Limits: a path of 2048 characters, a body of 512 KiB, a shot of 2 MiB, one stream event of 1 MiB, 30 s for an answer. The UI lives in one open shadow root with constructed style sheets, and it takes only trusted input: an event that a page script made does nothing (see "Known limits" in [`SECURITY.md`](SECURITY.md)). Permissions: `storage`, and host access to `https://ai.koglabs.com/*` (the host of the API).

To report a problem, read [`SECURITY.md`](SECURITY.md).

## Tests

```sh
npm --prefix extension ci    # one time: the extension tests run the build
npm test                     # server 166, runner 143, extension 84, e2e helpers 12 tests
node deploy/caddy.check.mjs  # the proxy rules against a real Caddy (needs the caddy binary)
npm run harness              # the extension UI: 59 groups in Chromium and 59 in Firefox
```

- The tests use an in-memory store, ports that the system picks and temp folders. They send nothing to a running server.
- `server/test/snap.test.js` renders a page in Chromium. It is skipped when `playwright-core` is not at `PLAYWRIGHT_CORE`.
- `npm run harness` and the `e2e/` scripts load `playwright-core` from `PLAYWRIGHT_CORE`, as `pins snap` does.
- The extension tests build only in temp folders. They never write to `extension/dist`.
- `npm run e2e` and `e2e/autofix.mjs` run against a live deployment and start a real fix run. They need the login module of that deployment (`E2E_LOGIN`).

## Repository layout

| Path | Content |
|---|---|
| `server/src/` | `index.js` (start), `app.js` (guards and routing), `http.js`, `id.js`, `api.js` (REST), `events.js` (SSE), `mcp.js`, `store.js` (SQLite, validation), `static.js` (downloads), `format.js` (text output), `shots.js`, `snap.js`, `facts.js` (element facts and the verdict), `ship.js` |
| `server/bin/pins.js` | The `pins` CLI |
| `runner/src/` | `index.js` (start), `runner.js` (queue, runs, limits), `model.js`, `profile.js`, `projects.js` (host to project), `brief.js`, `prompt.js`, `triad.js` (client), `pins.js` (client of the Pins server), `shots.js` (the "before" shot), `budget.js`, `config.js`, `sse.js` |
| `extension/` | `src/content/` (UI), `src/bg/` and `src/background.js` (network, live stream), `src/shared/protocol.js` (constants), `manifest/`, `build.mjs`, `test/` |
| `e2e/` | Live end-to-end checks (`run.mjs`, `autofix.mjs`), their helpers (`lib.mjs`) and the helper tests (`lib.test.mjs`) |
| `deploy/` | systemd units, the Caddy snippet and its check, the CLI wrapper, the project manifest |
| `docs/protocol.md` | The contract |
| `docs/memory-layer.md` | The design record of the v3.2 fast path, with its measurements |

## Deployment files

- `deploy/onspot.service` and `deploy/onspot-runner.service` are plain systemd units with the paths of the current host (`/srv/hub/pins`, Node in `/opt/studio/bin`). Change the paths, copy them to `/etc/systemd/system/` and run `systemctl enable --now onspot onspot-runner`.
- `deploy/units/*.service` are templates with `{{PLACEHOLDER}}` values for the `proj` release tool.
- `deploy/onspot.caddy` is the proxy snippet. It names the SSO service (`127.0.0.1:3000`), the server (`127.0.0.1:4750`), the public host and the Chrome extension ID. `node deploy/caddy.check.mjs` checks a changed copy.
- `deploy/pins` is the wrapper that puts the CLI on `PATH`.

## Status and limits

OnSpot runs in one deployment today. These parts are tied to it.

- **Triad.** The runner starts sessions only through Triad (`POST /delegate`, `GET /api/task/<id>`), and the queue UI is a tab of the Triad console. Triad is not in this repo. Without it the server, the CLI, MCP and the extension work, and the runner starts nothing.
- **Claude CLI.** The sessions are Claude CLI sessions. The model ids `claude-opus-5-5` and `claude-sonnet-5-5` are fixed in `runner/src/model.js`.
- **Prompt text.** The prompt names tools and paths of the current host: `maestro session`, `/root/triad/bin/triad delegate`, worktrees under `/srv/work`, `https://ai.koglabs.com/dev` (`runner/src/prompt.js`).
- **`pins ship`.** It needs `deploy/project.json` in the target project and the command `proj release <key> staging`. `proj` is not in this repo. Without them the command says "ship by hand".
- **The "before" shot.** The runner starts it with `/usr/bin/systemd-run` (`runner/src/index.js`).
- **Versions.** The contract is at v3.5 and the extension at 0.6.0. The server and the runner report 0.1.0.
- **Firefox.** The add-on is not signed.

## Licence

MIT. See [`LICENSE`](LICENSE).
