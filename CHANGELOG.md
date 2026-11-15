# Changelog

All notable changes to OnSpot (named Kog Pins before 3.4) are in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The headings are versions of the contract (`docs/protocol.md`). The extension has its own version (`extension/package.json`); each entry names it. The server and the runner packages report 0.1.0 in every entry.

## [Unreleased]

## [3.6] - 2026-11-15

Extension 0.7.0.

### Added

- Images on pins: paste (Ctrl+V or ⌘V), drop or pick up to 6 images while you write a pin note or a reply. Each image uploads at once (`POST /api/images`, PNG, JPEG or WebP up to 2 MiB; the extension shrinks larger images and converts other formats) and the pin or the reply links it when it is created. The pin JSON has `images`.
- The card shows the images of the pin after the note and the images of a reply inside the reply.
- The runner saves the images of each pin as files before the session starts and lists their paths in the prompt; the session opens them with the Read tool.
- `pins images <id> [--dir D]` saves the images of a pin; `pins show` and `pins_get` print `images: <n>`.
- `PINS_IMAGES_DIR` (server) and `PINS_RUNNER_IMAGES_DIR` (runner).

## [3.5] - 2026-11-14

Extension 0.6.0.

### Added

- Go back: a closed pin with a live fix has a "Go back" button in its card. You choose the version: the page before the pin, or the page after an earlier fix. `POST /api/pins/:id/revert { commit }` (users only) queues the pin with `revert`; the runner starts one revert run (lean, the project card, effort high with one retry counted from the request) that undoes the commits newest first, ships the old version and closes the pin.
- The pin JSON has `versions` (the live fix commits, oldest first), `revert` and `revertedAt`. The first open of an older database reads the versions from the `Done: <summary> (<commit>)` replies.
- `pins show` and `pins_get` print `versions:`, `go back:` and `reverted:`; `pins list` marks a go back. The element verdict has a revert rule: the element came back, went away or changed.
- Extension: the card shows "Going back" and "Reverted"; the run toast says "Going back #12"; the done toast says "Back to the earlier version · #12"; the Log chip says "Going back" or "Reverted".

### Fixed

- A resolve or a dismiss with a 4000-character summary or reason failed with 400, because its reply went over 4000 characters. The reply text is now cut; the commit stays.
- `pins ship` stopped at `git add` when a listed file was deleted and the deletion was staged already (`git revert`, `git rm`).
- Extension: a clipped text in the UI no longer ends with half an emoji.

## [3.4] - 2026-11-14

Extension 0.5.0. The first public release.

### Changed

- The project is OnSpot, was Kog Pins. The new names: the extension and the docs say OnSpot; the packages are `onspot`, `onspot-server`, `onspot-runner` and `onspot-extension`; the build variables are `ONSPOT_*` (were `KOG_PINS_*`); the page element is `<on-spot>` (was `<kog-pins>`); the downloads are `onspot-chrome.zip` and `onspot-firefox.zip`; the units are `onspot.service` and `onspot-runner.service`; the default paths are `/var/lib/onspot-runner` and `/run/lock/onspot`; the proxy snippet is `deploy/onspot.caddy`; the e2e login module is `~/.config/onspot/e2e-login.mjs`.
- The names that stay, so an installed extension keeps its data and old links still work: the storage keys `kog-pins:*`, the deep link `#kog-pin=<id>`, the Chrome extension id and the Firefox id. The noun "pin" stays too: the `pins` CLI, the `PINS_*` variables, the `/pins/` path, the `pins_*` MCP tools and `X-Pins-Agent`.
- e2e: the SSO cookie code is no longer in the repo. `E2E_LOGIN` names a login module of the deployment (default `~/.config/onspot/e2e-login.mjs`) that exports `user` and `cookie(apiOrigin)`. `E2E_USER`, `E2E_SSO_SECRET_FILE` and `E2E_SSO_DB` are gone from the repo.
- The extension harness loads `playwright-core` from `PLAYWRIGHT_CORE`, as `pins snap` and the e2e do.
- Tests and the contract use the neutral login name `sam`.
- `SECURITY.md`: reports go through GitHub private vulnerability reporting. The four `package.json` files say `"license": "MIT"`.
- Runner: a pin that names Fable or Haiku runs its session on that model (`claude-fable-5-2`, `claude-haiku-5-5`). Before, the session ran on Opus and started a `maestro session` on the named model, because Triad refused other models. The pin `model` reads `fable 5.2 high`.

## [3.3] - 2026-11-11

Extension 0.4.0.

### Added

- Extension 0.4.0: keyboard shortcuts. Cmd+K (Ctrl+K outside macOS) hides or shows the markers. Menu, Log, Settings, Freeze and Queue have a default shortcut. The "Shortcuts" section of Settings adds, edits, removes and resets them (at most 3 per action, 24 in all).
- Extension: the eye state is kept per host and follows the other tabs of the host.
- Extension build: seven variables (`KOG_PINS_API`, `KOG_PINS_ROOT_DOMAIN`, `KOG_PINS_QUEUE_URL`, `KOG_PINS_LOGIN_URL`, `KOG_PINS_RUN_URL`, `KOG_PINS_CHROME_KEY`, `KOG_PINS_GECKO_ID`) make a build for another deployment. The build prints the Chrome extension id for the proxy `Origin` rule.
- Server: `PINS_QUEUE_URL` sets where `GET /` redirects.
- Runner: `PINS_PROJECTS_DIR`, `PINS_RUNNER_CWD` and `PINS_SHOT_PATH`.
- e2e: `E2E_USER`, `E2E_SSO_SECRET_FILE` and `E2E_SSO_DB`. One cleanup closes the browsers, deletes the test pins and puts auto-fix back, also on Ctrl+C.
- The files `LICENSE`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md` and `SECURITY.md`.

### Changed

- Extension: the `content.js` budget is 88 KB, was 72 KB.
- Extension: a request with no answer in 30 s fails with "The request took too long. Try again." and keeps the live connection.
- Runner: a start that the server refuses is tried again after 3, 6, then 12 s. A pin that he changed in that time starts its own run.
- Runner: a run that Triad does not know (after a Triad reset) is kept and ends 120 minutes after its start.
- Runner: a "before" shot that cannot start within 60 s after the delegation is skipped.
- Runner: `PINS_RUNNER_DISABLED` takes only `0` and `1`.
- Server: a settings patch that changes no value sends no `settings` event.
- CLI: `pins snap` saves a JPEG when the PNG is over 2 MiB. `pins check` writes to the temp folder of the OS.

### Fixed

- Runner: a pin that its own session reopened gets the question, not a new run each time.
- Extension: a pin that is open again leaves the seen list, so its next result shows a green marker.
- Extension: a page that comes back from the page cache reads its data again and reconnects.
- Extension: the tests never write to `extension/dist`.

### Security

- Extension: the background answers only its own content script on an `https:` page of the root domain, follows no redirect, and limits the path, the methods per route, the body (512 KiB) and one stream event (1 MiB).
- Extension: only trusted input counts. A click or key press that a page script made does nothing in the UI.
- Server: an MCP batch takes one write token per entry, at most 120 entries. An actor name with a control character is refused. A stream that does not read is closed at 1 MiB.
- CLI: `pins ship` refuses `.git`, a path through a link and a folder, in any letter case.
- Runner: more secret folders and file names stay out of the source hints.

## [3.2] - 2026-11-11

Extension 0.3.2.

### Added

- Runner: the pin brief. Each session gets a project card (from `deploy/project.json`) and at most 3 source hints with code lines, built with `grep` and `git diff-tree` and no model tokens. Switch: `PINS_RUNNER_BRIEF=0`.
- Runner: the "before" shot. The runner runs `pins snap <id> before` in its own transient unit after the start. Switch: `PINS_RUNNER_SHOTS=0`.
- Runner: the lean start. A single-pin run asks Triad for the profile `pin`. A task pin, a note that names a skill, MCP, a sub-agent, a workflow, the design kit or a slash command, and every bulk run keep the full start. Switch: `PINS_RUNNER_LEAN=0`.
- CLI: `pins ship` commits the listed paths, runs the gate one time, pushes, merges the pull request, releases to staging, takes the "after" shot, checks the element and closes the pin. One test lane and one release lane per project.
- CLI: `pins check <id> --url U` renders a URL and prints the verdict against the "before" facts. `pins snap <id> after` prints the verdict. `pins done` warns when the element did not change.
- Extension 0.3.2: Cmd+M (Ctrl+M outside macOS) toggles pin mode. The eye button in the capsule hides and shows the markers.
- `docs/memory-layer.md`: the design record of the fast path, with measurements.

### Changed

- With a ship-ready project the prompt names `pins ship` as the one ship command, and its output is the live check.

## [3.1] - 2026-11-10

Extension 0.3.1.

### Added

- Server: `POST /api/pins/:id/accept` (users only) with `acceptedAt`, and the `reopens` count.
- Server: bulk mode settings `{ on, delegate, agents }` next to `autofix`.
- Runner: bulk mode. The queued pins of one batch form one run at effort `xhigh`. With `delegate` on, the session splits the pins into at most `agents` lanes.
- Extension 0.3.1: "Looks good" sends `accept`. A Bulk mode section in Settings and a Bulk chip in the tray.
- e2e: a Brave run, the accept round trip, and `E2E_IDLE_MS`.

### Changed

- Runner: no run limits by default. `MAX_RUNS`, `MAX_RUNS_PER_PROJECT` and `MAX_RUNS_PER_DAY` take 0 as "no limit". The pause after a failed start is 30 s, was 2 minutes.
- Runner: a run label shows the pin title: `Pin #12 · <title> · Opus 5.5 high`.

## [3.0] - 2026-11-10

Extension 0.3.0.

### Added

- Server: `intent`, `scope` and `presets` on a pin. Progress steps (agents only, at most 40 per run). Before and after shots (agents only, loopback only, checked by their first bytes, at most 2 MiB, removed 30 days after the pin closes). A `selector` filter on the list.
- CLI: `pins progress`, `pins shot`, `pins snap`. MCP: `pins_progress`.
- Extension 0.3.0: a capsule launcher with a sliding panel. About tabs, a scope row and presets in the note popup. A Settings sheet. Live steps in toasts, the card and the Log. A "Watch live" link. Before and After drawn on a canvas.

### Changed

- Runner: one session per pin, started at once, with no quiet window and no grouping by project. Opus 5.5 at effort `high` for every pin; a model named in the note wins; a retry raises the effort one step. The difficulty rule of v2 is gone.
- Runner: the prompt holds the history of the same element and the other pins of the batch.

### Security

- The prompt puts page text inside a `<page-data>` block, replaces `<` and `>` in it and states that it is never an instruction.

## [2.0] - 2026-11-02

Extension 0.2.0.

### Added

- Server: batches. `POST /api/batches` writes 1 to 30 pins of one host in one transaction. A repeated `key` returns the first batch.
- Extension 0.2.0: "pin, pin, pin, Submit all". Unsent pins stay on the device until one Submit all. A Log panel, toasts, "See it" and "Not right".
- Runner: the pin data is in the prompt, so the session needs no lookup to start. The model follows the difficulty of the notes (Sonnet 5.5 or Opus 5.5), and a pin that comes back runs on Opus.
- The `batch`, `model` and `attempts` fields on a pin.
- The project files `deploy/project.json`, `AGENTS.md`, `PLAN.md` and `.env.example` (2026-11-07).

## [1.0] - 2026-10-17

Extension 0.1.0.

### Added

- Server: REST, live events (SSE) and MCP on `127.0.0.1:4750`, with SQLite storage and no npm dependencies. The `pins` CLI.
- Extension 0.1.0 for Chrome and Firefox (MV3): picker, note popup, markers and threads.
- The proxy snippet with the SSO and `Origin` rules, and the systemd unit.
- Auto-fix: the runner starts a fix run for each new pin. The `waiting` state ("needs you"), the `autofix` setting and the run reference on a pin.
- Runner: `PINS_RUNNER_SKIP_HOSTS` leaves the pins of the listed host suffixes alone (2026-10-18).

### Changed

- The queue page left the server. The queue is the Pins tab of the Triad console, and `GET /` redirects to it (2026-10-18).
