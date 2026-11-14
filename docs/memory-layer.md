# OnSpot memory layer: design proposal (2026-11-10)

Status: **built 2026-11-11** (protocol v3.2) on his order "ok make the improvements. remember, make it faster, cheaper, imrpoving the result and the accuracy". The section "What is built" says what is live. The text above it is the proposal and its measurements, kept as the record.
Updated 22:45 for his order: "i dont want queue pins to wait more than a minute. instant find/planning/execution".

## Summary

1. Target: no queue wait, instant find, plan and execution. The queue wait is now under 1 s (run limits removed, onspot #10). A simple pin today: first edit 20 s after the start (11 s on a repeat element), live after 119 to 141 s.
2. 80% of that time is the ship path: the test gate runs 2 or 3 times (41 to 63 s), the release takes 43 to 48 s, the PR steps 16 s. Find and plan take 6 to 15 s. The model thinks for 24 s in total.
3. The layer is a **brief** that the harness builds before the session starts: a project card, 3 source hints with their code lines, and the before shot. Estimate: first edit about 10 s after submit, for a first-time element too.
4. The fastest step to live is one `pins ship` command that runs the test gate once: about 70 s to live (estimate). Under 60 s needs a faster `proj release`.
5. Cost, on 9 fresh v3 pins (26.9M input tokens): 50% is the start context read again on each call. By pin, 54% sits in one creative pin and 34% in three small pins whose tests collided. A lean start plus the brief cut a simple pin from 586k to about 250k input tokens. A memory of elements alone saves about 3%.

## Measurements

Source: eta ledger (`run`, `call`), pins.db and the session transcripts. Scripts (read-only, digests only): `measure.py` and `timeline.py` in the thread scratch dir. A Bash call with several commands counts in parts for each class. The v3 pins were simple ("make this red", Sonnet 5.5 high); the v2 pins were harder. 98% of all input is cache reads.

| Group | Runs | Pins | Calls per pin | Input tokens per pin | Seconds per pin | Tokens per call |
|---|---|---|---|---|---|---|
| v3, one session per pin (#170, #171) | 2 | 2 | 11 | 0.58M | 131 to 152 | 53k |
| v2, one pin per run | 11 | 11 | 31.7 | 3.14M | 762 | 99k |
| v2, many pins per run | 11 | 45 | 18.3 | 3.69M | 378 | 201k |

**Time line of a simple pin** (seconds; both runs on xslop; model time 24 to 26 s over 11 calls):

| Stage | #170, first time | #171, repeat element |
|---|---|---|
| Queue wait (v2: median 20 s single pin, 440 s batch; now under 1 s) | 0 | 0 |
| Process start to first model call (median of 25 runs: 5 s) | 5 | 5 |
| Find and plan, to the first edit | 15 (3 calls) | 6 (1 call) |
| Install, build and test in the worktree | 63 (the tests ran twice) | 41 |
| Commit, push, PR, merge | 16 | 17 (2 calls lost on a wrong release call) |
| `proj release` to staging (it builds and tests the commit again) | 43 | 48 |
| After shot, live check, close, report | 11 | 12 |
| **First edit at / live at / end at** | **20 / 141 / 152** | **11 / 119 / 131** |


**Where the tool calls go** (1,373 calls): search 20%, code reads 17%, live check 11%, edits 9%, git 9%, build and test 6%, memory and docs 5%, pins CLI 3%, deploy 1%, other 20%. In v3 the ship steps lead: pins CLI 22%, git 19%, build 6%, deploy 5% of 23 calls. Waits: 129 poll calls (9%) took 8,570 s, 53% of all tool time (64 on test and build logs, 54 on releases). Each poll is a model call on the full context. **Before the first edit** (23 runs): 254 calls = 22% of the calls and 11% of the input tokens; median 10 calls. They are code reads 35%, search 27%, memory 14%. #171 had the "Earlier on this element" line in its prompt and needed 2 calls, against 4 for #170. The idea works; today it fires only on an exact selector match.

**Start context**: 48.5k tokens = about 130k characters before any work. Rules = 9.1k tokens by chars / 4, or about 13.6k by share. On a simple pin, 11 calls x 48.5k = 91% of the input. Each session writes 35k to 37k of new cache on call 1.

| Part | Characters | Share |
|---|---|---|
| Standing rules (`CLAUDE.md`, `SHARED_AGENT_RULES.md`, `rules/MEMORY.md`) | 36.4k | 28% |
| Tool definitions (13 tools) | 30.5k | 23% |
| Skill list (61 skills) | 27.1k | 21% |
| Deferred tool names, MCP instructions, agent list | 14.9k | 11% |
| System prompt, pin prompt, project `AGENTS.md`, hooks, git status | 21.0k | 16% |

**How often you return** (78 pins): same selector as an earlier pin 6 (8%); same id, class or test id 15 (19%); same page 63 (81%). headerx: 84 different files in 17 runs, so a page-to-files map is too loose. **Test of a harness grep** (id, classes, attributes and text of the element over the project source, rare matches first): in the 13 one-pin runs, a file that the run changed was hint 1 for 5 pins and in the top 3 for 12 (92%). Multi-pin runs: top 3 for 35 of 44 pins.

**Fresh v3 data** (9 real pins on xslop, Opus 5.5 unless named; 278 calls, 26.9M input, notional $12.64):
- Start: a pin that only dismisses costs $0.30 (the write of about 36k start tokens into the cache). A simple pin costs $0.48 to $0.52 on Opus (#176, #179: 10 to 11 calls, 103 to 145 s) and $0.25 on Sonnet (#170, #171). 48.6k x 278 calls = 50% of all input.
- One creative pin (#173, xhigh): 14.5M input, $6.09, 97 calls, 27 min. Its context grew from 49k to 210k. 69% of its tokens are in the edit, build and look loop (66 calls).
- Test collisions (#168, #169, #178; two were "remove this"): 9.05M input, $4.35, and 35, 84 and 21 min. The xslop browser tests (`test:e2e`) took 500 to 880 s when two sessions ran them at once, hit the 600 s tool limit and failed on timeouts; the sessions ran them again and polled.
- First-pass %: no signal yet. The eta pin table holds 0 accepts and 0 reopens in 83 pins.

## Fastest path (target: instant find, plan, execution)

| Step | Change | Basis | Result (estimate) |
|---|---|---|---|
| Queue | Done: no run limits | v2 waited 20 s to 76 min | under 1 s |
| Find | The brief holds 3 hints and their code lines; the edit is in call 1 or 2 | #171: 1 call, 6 s; grep top 3 = 92% | first edit about 10 s, was 20 s |
| Plan | The runner takes the before shot at pin start; worktree and edit go in one call | shot 3 s, worktree 2 s, 1 model call each today | no extra call |
| Execute 1 | `pins ship`: one blocking command for commit, push, PR, merge, release, after shot, close | 5 round trips; second test run 24 s (#170); 2 lost calls (#171) | live at about 110 s, was 141 s |
| Execute 2 | Run the test gate once: the release builds and tests the commit before the switch | worktree run 41 to 63 s | live at about 70 s |
| Execute 3 | Faster `proj release` (install cache when the lockfile did not change) | release 43 to 48 s, install 8 s | live at about 60 s |

- The floor is the process start (5 s) plus the release. Under 60 s to live is a `proj` change, outside this layer.
- Execute 2 changes a gate: a commit reaches main before its tests run. The release still refuses a failed build, and `pins ship` must then revert that commit in code. This needs your yes.
- Many pins at once: measured, and worse than expected. Parallel sessions on one project collide in the browser tests (#168, #169, #178: 21 to 84 min, against about 2 min alone). With no run limits this happens more often. The gate and the release need one lane per project, in code: sessions edit in parallel, one test and one release take all commits that wait.
- Hard pins: the blocking ship removes the polls (53% of the tool time), and the hints cut the calls before the edit from about 10 to about 5 (estimate).

## Options

Baseline: a simple v3 pin, 11 calls, 586k input tokens, live at 119 to 141 s.

| Option | Saves | Risk | Verdict |
|---|---|---|---|
| A. Lean start: no skill list, no MCP, 6 tools (Claude flags, set by Triad) | About 22k tokens per call (estimate): -40% input. Little time | A pin that needs a skill, MCP or the Agent tool. Code falls back to the full start when the note names one | Step 3 |
| B. Project card in the prompt (folder, worktree, test, release, live URL, from the manifest) | 1 to 3 calls: the memory read and the release search (#171) | A wrong manifest. Built at each start, so never stale | Step 1 |
| C. Source hints: live grep plus learned map | 9 s and 2 calls on a simple pin; about 5 calls on a hard pin (estimate) | A wrong hint costs one read. The prompt says "hints, verify" | Step 1, map in step 4 |
| D. `pins ship` | 30 to 70 s to live; 5 ship calls to 1 or 2; no polls | It chains existing commands. `proj release <key> staging` keeps staging first. Gate once is the open point | Step 2 |
| H. One test-and-release lane per project (lock in `pins ship`; one release for all waiting commits) | The collision waste: 34% of the fresh input tokens, and 21 to 84 min to about 2 min | A stuck lock; it needs a timeout and an owner check | Step 2, first |
| E. One warm session per project | The cache write and the search | Context grows: 201k per call in v2 against 53k. Stale knowledge. One crash stops all pins | Rejected |
| F. Visual gate in `pins snap` and `pins done` | No model call. Catches "wrong element" and "nothing changed" | False alarms on pins with no visible change. Warn, do not block | Step 5 |
| G. Bulk reuse | Hints group the pins by file: lanes without conflicts, one ship, one release | Above about 4 pins per session the context growth costs more | With bulk mode |

## Recommended design: the pin brief

This section is the proposal text. Not built: `atlas.db`, `runner/src/atlas.js` and every stored row. "Changes against the proposal" says what the code does.

One layer between the pin and the session. The runner builds a brief for each pin, in parallel with the session start, and puts it in the prompt. The session starts with the answer to "where is it and how do I ship it".

**1. Project card** (about 600 characters). Folder, repo, worktree command, source roots, test command, ship command, live URL. Built at each start from `deploy/project.json` and the memory-store `project.json`. Nothing is stored.

**2. Source hints** (at most 3: path, line number, evidence count, and about 15 code lines from the repo). Two sources, one ranking:
- Live grep of the element's id, test id, class names, attributes and text start. It runs on the current code, so it is never older than the code.
- Learned map: where the fix landed for earlier pins with the same anchor. This is the memory. It lifts the right file to hint 1 (grep alone: 5 of 13).

**Data model** (`/var/lib/onspot-runner/atlas.db`, `node:sqlite`, no new dependency):

```
hint(project, kind, anchor, file, pin_id, commit, weight, hits, misses, created_at, last_ok_at)
     primary key (project, kind, anchor, file)   kind: selector | id | testid | class | text
brief(pin_id, hints, repeat, hit, created_at)    one row per run: what the brief held, was a hinted file in the commit
```

**Who writes**: only the runner (`runner/src/atlas.js`), never an agent. When a pin is `done` with a commit, the runner reads the file list of that commit (`git diff-tree --name-only`, read-only) and writes one row per anchor and file at weight 0.5. "Looks good", or 48 h with no reopen, sets weight 1. "Not right" deletes the rows of that pin. It skips a commit with more than 8 files, an unknown commit and any file outside the source roots.

**Self-maintenance**: check on read (a learned file must exist and still hold one of the anchors; 2 misses delete the row; the live grep finds moved code and the next commit teaches the new place). Rows not confirmed for 90 days go. Cap 2,000 rows per project, under 2 MB. Prune at runner start and every 24 h.

**Security**:
- The store holds paths, line numbers, anchors and commit ids. No secrets: paths that match `.env`, `*.key` or `secrets` are skipped, and each path must resolve inside the project folder.
- Page text stays untrusted. Anchors are only grep needles (fixed strings, argument array, no shell). The hints block shows repo paths and repo code; page text stays inside `<page-data>`. The memory never runs a command: the commands in the card come from the repo manifest, not from the store.
- A bad run cannot poison it: rows come from the commit, need your accept or 48 h for full weight, go on a reopen, and are checked against the code on each read.

**How eta proves it** (harness facts, per pin, in the eta pin table):
- Time: queue wait (`startedAt` - `createdAt`), first edit (transcript), live (`shots.after` - `createdAt`), done (`closedAt` - `createdAt`). Cost: calls, tokens_in, first-call tokens. Quality: `hit` (a hinted file is in the commit), `repeat` (a learned row matched), accepted or reopened.
- Baseline now: queue under 1 s; first edit 20 s (11 s repeat); live 119 to 141 s; 11 calls; 586k input; start 48.5k.
- Targets: queue under 1 s; first edit at most 10 s; live at most 75 s on a simple pin; at most 6 calls and 250k input; hint in the top 3 for at least 85%; first-pass % not lower.

## Rollout (ordered by seconds saved)

0. Done: no run limits (onspot #10). Still needed for the baseline: the eta pin table and v3.1 (accept, reopen).
1. Brief v1: card, live-grep hints with code lines, before shot by the runner. No storage. Protocol v3.2.
2. `pins ship` with one test-and-release lane per project. First with both test runs kept (live at about 110 s), then gate once after your yes (about 70 s).
3. Lean start: Triad accepts `profile: "pin"` and adds `--disable-slash-commands --strict-mcp-config --tools "Bash,Read,Edit,Write,Grep,Glob"`. The rules stay whole.
4. Learned map: `atlas.db`, write on done, accept and reopen, check on read, prune.
5. Visual gate; install cache in `proj release`.

## What is built (2026-11-11)

| Part | Where | Checked |
|---|---|---|
| Lean start: Triad `profile: "pin"` | triad #41, `runner/src/profile.js` | One real call in /srv/projects/xslop: 24,634 start tokens (was 48.5k), cache write 19.5k (was 35k to 37k) |
| Brief: project card and 3 source hints with code lines | `runner/src/brief.js` | 76 real past pins: a changed file is hint 1 for 68% and in the top 3 for 82% (xslop 94%, headerx 73%); slowest 0.2 s; about 500 tokens |
| Memory: files of earlier pin commits on the same element | `runner.js` reads the done pins of the host; `brief.js` reads `git diff-tree` | It lifts the top 3 from 72% to 82%; 12 of the 76 pins got a boost |
| Before shot by the runner, in its own unit | `runner/src/index.js` | Works from inside the runner sandbox (128 MB cap) in 2.3 s |
| `pins ship`: commit, gate one time, push, merge, staging release, after shot, check, close; one test lane and one release lane per project | `server/src/ship.js` | 13 module tests and 2 command-line round trips with real git |
| Element check: verdict in `pins snap ... after`, `pins check`, warning in `pins done` | `server/src/facts.js`, `server/src/snap.js` | 12 tests in `facts.test.js`, 1 in `snap.test.js`, 3 command-line tests in `cli.test.js`; a hidden element counts as gone; no page value in the verdict text |

**Live proof** (2026-11-11, two test pins on the xslop staging 404 page, Opus 5.5 high; #201 changed one sentence, #202 put it back):

| | Before (simple pin) | #201, full start | #202, lean start |
|---|---|---|---|
| Model calls | 11 | 4 | 4 |
| Input tokens | 586k | 200k | 111k |
| Start context | 48.5k | 49.4k | 27.4k |
| First edit after the pin | 20 s (11 s repeat) | 5 s | 8 s |
| Pin done after the pin | 131 to 152 s | 110 s | 103 s |
| Notional cost (Opus) | $0.48 to $0.52 | $0.35 | $0.22 |

- The brief took 13 and 20 ms. For #202 it used the commit of #201 (the memory: 1 earlier pin on this element).
- `pins ship` took 95 and 91 s in one call: gate 38 and 34 s, merge, release (v1.0.27, v1.0.29), after shot, verdict "changed text", close, worktree removed.
- What is left of the time is the gate before the merge and the release (it builds and tests again). Question 5b (gate once) would save about 35 s more.
- #201 looked at the live page a second time after the ship; the prompt now says that the ship output is the live check, and #202 did not.

Changes against the proposal:
- No `atlas.db`. The memory is read from the pins store and from git at each start, so there is no second store to keep in step, and a bad run cannot leave rows behind. A reopened pin counts again only when it is done again.
- The card holds the key, the repo, the folder, the gate (`release.build && release.test`) and the staging and live addresses, from `deploy/project.json` only. The worktree and the ship command are steps of the prompt, not card lines.
- A hint holds up to 13 code lines (hint 1) or 7 (hints 2 and 3). The hints block is at most 3000 characters.
- The brief is built before the session starts, not in parallel with it: it is part of the prompt. It has 2.5 s; after 10 s the runner starts the run without it.
- The lean start has no fallback list in the prompt; code picks the full start for a task pin and for a note or a preset that names a skill, MCP, a sub-agent, a workflow, the design kit or a slash command. Bulk runs keep the full start and ship by hand.
- `pins ship` keeps the test run before the merge (your yes for "gate once" is still open). The session no longer runs the tests itself, so the gate runs 2 times (ship, release), not 3.
- Not built: Sonnet for simple pins (Opus stays, your order), `test:e2e` in the xslop gate (the manifest `release.test` is the one gate), the install cache in `proj release`.

Tests: server 135, runner 105, extension 29, all pass (before: 105, 76, 29). Triad: 228 tests, the same 22 known failures as main.

## Questions for you

Built on your order: 1 (lean start, rules stay), 2 (all pins at once), 4 (the runner reads git, it writes nothing), 5 (`pins ship`). Not needed any more: 3 (no stored rows, so no 48 h rule). Still open: 5b, 6, 7, 8.

1. Lean start removes the skill list, the MCP servers and the Agent tool from pin sessions. The rules stay. OK? May a 2k "pin rules" card also replace the rules index (14% of the start)? **Answered by the order for the lean start:** it is built and the rules stay whole. **Open:** the 2k card; it is not built.
2. A/B for 2 weeks, or all pins at once? **Answered by the order (my reading):** every pin gets the fast path. eta compares with today's baseline, and repeat against first time.
3. Full weight for a learned row needs "Looks good" or 48 h without a reopen. Do you press "Looks good"? Is 48 h right? **Not needed any more:** nothing is stored. An earlier pin counts 1 when it is accepted, else 0.6 (`brief.js`).
4. The runner rule is "no git". The map needs read-only git (`git diff-tree`). May the rule become "no git writes"? **Answered by the order:** the brief reads `git diff-tree`; the runner writes no git state.
5. Do you want `pins ship`? **Answered in direction:** instant execution needs it, so it moves from step 4 to step 2. **New, open (5b):** may the test gate run once, inside the release, with an automatic revert on a failure? It saves 41 to 63 s.
6. In bulk mode, may the harness group the pins by hinted file? **Open.** With no run limits, each pin starts at once also without bulk.
7. Which test is the gate on xslop: `npm test` (the manifest; 4 pins ran only this) or also `test:e2e` (3 pins ran it, and it collided)? **New, open.**
8. Simple text and remove pins took the same calls and time on Sonnet and Opus, at half the notional cost on Sonnet (2 pins each). Keep Opus for every pin until accept data exists? **New, open.**
