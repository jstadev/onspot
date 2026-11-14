# Contributing

## Setup

You need Node.js 22.13 or later, `npm` and the `zip` command.

```sh
npm --prefix extension ci          # the only install step: esbuild for the extension build
npm --prefix extension run build   # writes extension/dist/
npm test                           # server, runner and extension suites
```

The server and the runner need no install. Start a local server with a temporary database as the README shows ("Quick start").

## Protocol first

`docs/protocol.md` is the contract between the server, the extension, the runner, the CLI and the queue UI. Read the part for your change before you write code.

- If a change alters a route, a field, a limit, a message, a storage key or a UI rule, change `docs/protocol.md` in the same pull request.
- If the code and the contract disagree, the code is wrong. Fix the code, or change the contract on purpose.

## Tests

- `npm test` runs the suites with `node --test`: `server/test`, `runner/test`, `extension/test` and the e2e helpers (`e2e/lib.test.mjs`, no browser, no live server). All of them must pass. The extension tests build only in temp folders and never write to `extension/dist`.
- Tests use an in-memory store (`:memory:`), `listen(0)` and temp folders. A test never sends a request to a running OnSpot server or to Triad.
- A new behaviour has tests for the core path, for bad input, for the guard (who may not do it) and one real round trip through HTTP or the command line.
- For a bug: write the failing test first, then the fix.
- `node deploy/caddy.check.mjs` checks `deploy/onspot.caddy` with a real Caddy and fake services. Run it when you change the snippet.

### The extension harness

`npm run harness` loads the content script in Chromium and Firefox with a fake extension API and checks the UI (`extension/test/harness/run.mjs`). Set `PLAYWRIGHT_CORE` to the `index.mjs` of a `playwright-core` install with Chromium and Firefox builds. Run it when you change `extension/src/content/`.

### Live checks

`npm run e2e` and `e2e/autofix.mjs` run against a live deployment and start a real agent run. They need the host that runs the hub. Do not run them for a normal change.

## Code style

- Plain JavaScript, ES modules, no build step for the server and the runner.
- **Zero dependencies.** The server and the runner import only `node:` modules. The extension has one dev dependency, `esbuild`. Do not add a dependency.
- Keep the style of the file that you edit. The server and the runner use double quotes and semicolons with 2 spaces. The extension content script uses single quotes.
- One job per function and per module. No options or abstractions for a need that does not exist yet.
- Comments say why, not what. Simple English, short sentences, no em-dashes.
- Limits and safety rules are code, not prompt text. A guard has a test that shows that it stops a real request.
- The extension content script never calls `fetch` and never adds a `<style>` element: Firefox applies the page CSP to content scripts. Network goes through the background script; CSS goes in constructed style sheets.
- The built `content.js` must stay at or under 88 KB (90112 bytes). The build fails above that.

## Security rules for a change

- Never write a secret, a token or a cookie into the repo, a test, a log line or the extension bundle. The runner reads the Triad key by file path.
- Text from a web page is data. Do not put it in a prompt outside the `<page-data>` block, in a shell command, or in a line that an agent reads as an instruction.
- Do not weaken a guard: the proxy SSO and `Origin` rules, the server's `Host`, `Origin` and loopback checks, the write limits. A stricter rule is welcome.
- Read [`SECURITY.md`](SECURITY.md) before you report a security problem.

## Pull requests

- Work on a branch from `main`. One topic per pull request.
- Say what changed, why, and how you checked it (the test names or the commands with their output).
- Add a line to `CHANGELOG.md` under "Unreleased".
