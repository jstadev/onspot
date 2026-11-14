# Plan
Current version: v3.4.0 (2026-11-14, the first public release; the units run `/srv/hub/pins`)
Goal: not recorded

## Next release: v1.0.0
- [ ] Extension: a closed shadow root for the UI, so a page script cannot change it (source: SECURITY.md "Known limits")
- [ ] Extension: a card whose pin did not load must not send a reply (source: audit review C2)
- [ ] Sign the Firefox add-on on AMO (unlisted); it needs his AMO API keys, and until then the add-on is temporary (source: state.md open item)

## Open source (prepared 2026-11-14)
- [x] No private data in the tree: the tests and the contract use the login name `sam`; the hub SSO cookie code is in `/root/.config/onspot/e2e-login.mjs`, outside the repo (`E2E_LOGIN`). gitleaks: no leaks in the tracked files.
- [x] `SECURITY.md`: reports go through GitHub private vulnerability reporting. `LICENSE` is MIT; the four `package.json` files say `"license": "MIT"` and stay `"private": true` (no npm publish).
- [x] CI: `.github/workflows/test.yml` (Node 22, `npm --prefix extension ci`, `npm test`). It passed 3 of 3 runs in a clean `node:22-bookworm` container as a non-root user.
- [x] The name is OnSpot (his pick, 2026-11-14). Contract v3.4, extension 0.5.0: the names, units, paths, build variables, page element and downloads are renamed; the storage keys, the deep link and the extension ids stay.
- [x] Published 2026-11-14 with `/root/.config/onspot/publish.sh onspot v3.4.0` (outside the repo; `DRY_RUN=1` first). It makes one fresh commit with the tree of the private main (noreply author, no AI line, gitleaks), renames the private repo to `jstadev/kog-pins-old` (the archive: no push, no deploy), creates the public `jstadev/onspot`, switches on private vulnerability reporting, Dependabot alerts, secret scanning and push protection, and points `/srv/hub/pins` at the new repo with the commit hooks of the xslop flow.
- [x] Every change follows the xslop flow (noreply author, no Claude line in commits and PR bodies, PR, CI, squash). The hooks of `/srv/hub/pins/.git/hooks` enforce it.

## Later
- His feedback on v1 (source: state.md open item)
- Run both units as the service user `onspot`; the runner then needs read access to the Triad token and the memory store (source: project contract; see the adopt plan)
- Adopt the project contract release (`proj release kog-pins prod`): back up `pins.db`, move the data to the release folder, give the service user what the runner needs, point the `pins` wrapper at the release, create the env file, then release and check. Until then the command must not run (source: `AGENTS.md` "Release"; the unit template headers in `deploy/units`)

## Done
- v3.4.0 (2026-11-14): OnSpot (was Kog Pins), first public release at https://github.com/jstadev/onspot.
