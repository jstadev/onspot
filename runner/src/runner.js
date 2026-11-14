// The auto-fix runner (docs/protocol.md, "Auto-fix runner" and "Bulk mode"). It watches the pin
// queue, starts one Triad run per pin (or per batch in bulk mode), claims the pins for that run,
// watches the run and, when it ends without a result, tries one more time or asks the Chairman.
// It is a harness: it never edits code, writes git state or deploys.
import { readEvents } from "./sse.js";
import { chooseModel, chooseBulkModel } from "./model.js";
import { buildBulkPrompt, buildRevertPrompt, pinTitle, PROMPT_BYTES } from "./prompt.js";
import { chooseProfile } from "./profile.js";
import { readConfig } from "./config.js";
import { createShots } from "./shots.js";
import { createPins, API_MS } from "./pins.js";

const POLL = 30_000, WATCH = 15_000, HISTORY = 14 * 86_400_000;
// A pin gets this many runs before a failed run hands it to the Chairman. The second run has a
// higher effort.
const MAX_ATTEMPTS = 2;
// A bulk run holds at most the pins of one batch (docs/protocol.md, Bulk mode, item 1).
const BULK_MAX = 30;
// A brief that takes longer does not hold the decision queue: the run starts without it.
const BRIEF_MS = 10_000;
// A claim that failed is tried again this soon: until then the session cannot post steps or ship.
// Each refused pass doubles the wait up to the longest one, because the write limit of the Pins
// server is one bucket for the runner, every session and his browser.
const CLAIM_RETRY = 3_000, CLAIM_RETRY_MAX = 12_000;
// How many ended runs the runner remembers. A late event comes seconds after the end of its run.
const ENDED_MAX = 1000;
// Triad stops every task after 105 minutes (its agents.json, timeoutMs). A task that Triad does
// not know (HTTP 404 after its timeline reset) can still run until then, so such a run ends only
// this long after its start: the limit plus 15 minutes.
const RUN_LIMIT = 120 * 60_000;
// The end of a run that Triad does not know. Nobody knows what its session did, so it never retries.
const GONE = { status: "gone", exitCode: null, lastLine: "Triad does not know this task" };
const runId = (pin) => /^triad:([1-9][0-9]*)$/.exec(pin.run || "")?.[1];
const generation = (pin) => `${pin.updatedAt || pin.createdAt}:${pin.replyCount || 0}`;
const utcDay = (time) => new Date(time).toISOString().slice(0, 10);
const errorCode = (error) => Number.isInteger(error.status) ? `http=${error.status}` : "unavailable";
// The server counts in `reopens` only the times that he sent a pin back. A count that is higher
// than when the run took the pin says that he did it. A reopen by an agent (a session on its own
// pin) leaves the count as it is, and so does a pin from before the count (null).
const sentBack = (pin, taken) => Number.isInteger(pin.reopens) && Number.isInteger(taken) && pin.reopens > taken;
// The runs of a go back count from his request (docs/protocol.md, item 16): the first revert run
// has effort high and one retry, also when the pin had fix runs before.
const runsOf = (pin) => (pin.revert ? { ...pin, attempts: Math.max(0, Number(pin.attempts) - (Number(pin.revert.attempts) || 0)) } : pin);

/** clock supplies now(), setTimeout(fn, ms), clearTimeout(id). start/stop are async.
 *  brief({ pin, project, earlier }) builds the pin brief; shoot(pinId) takes the "before" shot.
 *  Both are optional; a config switch set to false turns each off. */
export function createRunner({ fetch, clock, triad, resolveProject, buildPrompt, brief, shoot, config = {} }) {
  const options = { ...readConfig({}), ...config };
  // Validate injected configuration too; no alternate path bypasses the limits.
  readConfig({ PINS_PORT: options.port, MAX_RUNS: options.maxRuns,
    MAX_RUNS_PER_PROJECT: options.maxRunsPerProject, MAX_RUNS_PER_DAY: options.maxRunsPerDay });
  const { base, call: api, pages } = createPins({ fetch, clock, port: options.port });
  const log = options.log || console.log;
  const makeBrief = options.brief ? brief : null;
  const shots = options.shots && shoot ? createShots({ shoot, clock, log }) : null;
  // Each map and set below has a bound; sizes() shows them (runner/test/state.test.js, "memory").
  // pending: queued pins that can start. attempted: the queue generation of a pin that already got
  // a delegation. Both hold queued pins only; every poll drops the others.
  const pending = new Map(), attempted = new Map(), timers = new Map();
  // Live runs, by the task id that the pins hold: { id, task, since, adopted, model, key, oldest,
  // pins, unclaimed, nextCheck, nextClaim, claimWait, retryAfter, unknown, end }. task is the Triad
  // task to ask; it differs from id after a failover. since is the time when that task started, as
  // far as the runner knows. pins maps each pin id to the `reopens` count of the pin when the run
  // took it (see sentBack). unclaimed holds the pins whose claim did not work yet.
  const runs = new Map();
  // Questions that the Pins server did not take yet (pin id -> text), for queued pins only.
  const owed = new Map();
  // The run ids of one UTC day, for the daily limit. Another day starts a new set.
  let counted = { day: null, ids: new Set() };
  // Runs that ended in this process, the newest ENDED_MAX. A late SSE event can still show a pin
  // "working" in one of them; such an event must not adopt the finished run again.
  const endedRuns = new Set();
  let enabled = false, started = false, stopping = false, bootstrapped = false, queue = Promise.resolve();
  let bulk = { on: false, delegate: false, agents: 3 };
  // A pin of a batch waits for the bulk run of its batch while bulk mode is on. A go back never does.
  const inBulk = (pin) => bulk.on && Boolean(pin.batch) && !pin.revert;
  let budget = { day: null, used: 0 };
  let startAfter = 0, owedAfter = 0;
  let streamController, streamJob, retry = 3000;

  function timer(name, delay, fn) {
    clock.clearTimeout(timers.get(name));
    if (stopping) return;
    timers.set(name, clock.setTimeout(() => {
      timers.delete(name);
      fn();
    }, Math.max(0, delay)));
  }

  // Every state change, including work resumed after I/O, runs in this single queue.
  function enqueue(fn) {
    queue = queue.then(async () => {
      if (stopping) return;
      try {
        try { await fn(); await drive(); }
        catch (error) {
          startAfter = clock.now() + POLL;
          log(`runner decision failed ${errorCode(error)}`);
        }
        plan();
      } catch { /* A log or a timer that throws must not end the queue: no later step would run. */ }
    });
    return queue;
  }

  // The whole settings object; bulk keys that are absent or invalid take their defaults.
  function apply(value) {
    enabled = value?.autofix === true;
    const next = value?.bulk ?? {};
    bulk = { on: next.on === true, delegate: next.delegate === true,
      agents: Number.isInteger(next.agents) && next.agents >= 1 && next.agents <= 8 ? next.agents : 3 };
  }

  async function settings() {
    try {
      apply(await api("/api/settings"));
    } catch (error) {
      enabled = false;
      log(`settings check failed ${errorCode(error)}`);
    }
  }

  function count(id, date) {
    const time = Date.parse(date), today = utcDay(clock.now());
    if (!Number.isFinite(time) || utcDay(time) !== today) return;
    if (counted.day !== today) counted = { day: today, ids: new Set() };
    counted.ids.add(id);
  }
  function dailyCount() {
    const today = utcDay(clock.now());
    return Math.max(budget.day === today ? budget.used : 0, counted.day === today ? counted.ids.size : 0);
  }
  const held = (id) => [...runs.values()].some((run) => run.pins.has(id));
  // A pin that left the queue keeps no state here.
  const forget = (id) => { pending.delete(id); attempted.delete(id); owed.delete(id); };

  async function ingest(pin, deleted = false) {
    if (deleted) { forget(pin.id); return; }
    const id = runId(pin);
    if (id) count(id, pin.startedAt);
    // An ended run whose cleanup still retries takes no pin back from a late event.
    if (pin.status === "working" && id && !endedRuns.has(id) && !runs.get(id)?.end) {
      const project = await resolveProject(pin.host, pin.path);
      let run = runs.get(id);
      if (!run) {
        run = { id, task: id, since: clock.now(), adopted: true, model: null, key: null, oldest: Infinity,
          pins: new Map(), unclaimed: new Set(), nextCheck: clock.now() + WATCH, nextClaim: Infinity };
        runs.set(id, run);
        log(`adopted run triad:${id} pin=${pin.id}`);
      }
      // An adopted run started when its first pin did. A pin with no start time changes nothing.
      if (run.adopted && Date.parse(pin.startedAt) < run.since) run.since = Date.parse(pin.startedAt);
      // The project of a run is the project of its oldest pin.
      if (pin.id <= run.oldest) Object.assign(run, { key: project.name || pin.host, oldest: pin.id });
      run.pins.set(pin.id, pin.reopens);
    }
    if (pin.status !== "queued") { forget(pin.id); return; }
    const skipped = options.skipHosts.some((suffix) => String(pin.host).toLowerCase().endsWith(suffix));
    if (skipped || held(pin.id) || attempted.get(pin.id) === generation(pin)) {
      pending.delete(pin.id);
      return;
    }
    const existing = pending.get(pin.id);
    if (existing && generation(existing.pin) === generation(pin)) return;
    const project = await resolveProject(pin.host, pin.path);
    pending.set(pin.id, { pin, project, key: project.name || pin.host });
    // He changed the pin: a new order. A question about the earlier one is void.
    owed.delete(pin.id);
  }

  async function sync() {
    await settings();
    try {
      // The first scan reads every pin: closed runs restore today's budget after a restart. Pins
      // that are not queued go in page by page; only the queued pins are kept, and they go in
      // last, so adoption comes before any start, whatever the list order.
      const queued = [];
      const take = async (page) => {
        for (const pin of page) {
          if (pin.status === "queued") queued.push(pin);
          else await ingest(pin);
        }
      };
      if (!bootstrapped) await pages("all", take);
      else { await pages("working", take); await pages("queued", take); }
      const ids = new Set(queued.map((pin) => pin.id));
      for (const id of [...pending.keys(), ...attempted.keys(), ...owed.keys()]) if (!ids.has(id)) forget(id);
      for (const pin of queued) await ingest(pin);
      bootstrapped = true;
    } catch (error) {
      enabled = false;
      log(`pins poll failed ${errorCode(error)}`);
    }
  }

  function limit(key) {
    if (options.maxRunsPerDay && dailyCount() >= options.maxRunsPerDay) return "daily";
    if (options.maxRunsPerProject && [...runs.values()].filter((run) => run.key === key).length >= options.maxRunsPerProject) return "project";
    if (options.maxRuns && runs.size >= options.maxRuns) return "concurrent";
    return null;
  }

  // What the prompt says about earlier pins on the element and about the other pins of the
  // batch. A failed read costs the session a lookup; it never stops the run.
  async function read(pin, query, keep) {
    try {
      const { pins } = await api(`/api/pins?${new URLSearchParams(query)}`);
      return (Array.isArray(pins) ? pins : []).filter((other) => other.id !== pin.id && keep(other));
    } catch (error) {
      log(`context read failed pin=${pin.id} ${errorCode(error)}`);
      return [];
    }
  }
  async function history(pin) {
    const selector = pin.targets?.[0]?.selector, since = clock.now() - HISTORY;
    return selector
      ? (await read(pin, { host: pin.host, selector, status: "done", limit: 10 }, (other) => Date.parse(other.closedAt) >= since)).slice(0, 3)
      : [];
  }
  async function context(pin) {
    return {
      history: await history(pin),
      siblings: pin.batch ? await read(pin, { batch: pin.batch, status: "all", limit: 30 }, () => true) : [],
    };
  }
  // Where the code is and how it ships (docs/memory-layer.md). A failed brief costs the session a
  // search; it never stops the run. The log line holds numbers only.
  async function briefOf(pin, project) {
    if (!makeBrief) return null;
    // A revert run uses the project card only: the earlier pins teach no source hint it needs.
    const earlier = pin.revert ? [] : await read(pin, { host: pin.host, status: "done", limit: 200 }, () => true);
    let timeout;
    try {
      const facts = await Promise.race([
        makeBrief({ pin, project, earlier }),
        new Promise((_, reject) => { timeout = clock.setTimeout(() => reject(new Error("Brief timeout")), BRIEF_MS); }),
      ]);
      const stats = facts?.stats ?? {};
      log(`brief pin=${pin.id} hints=${Math.min(Number(stats.files) || 0, 3)} learned=${Number(stats.learned) || 0} ms=${Number(stats.ms) || 0}`);
      return facts ?? null;
    } catch {
      log(`brief failed pin=${pin.id}`);
      return null;
    } finally { clock.clearTimeout(timeout); }
  }

  // A poll snapshot or queued SSE event can already be stale. Re-read the claim.
  async function reread(id) {
    try {
      const result = await api(`/api/pins/${id}`);
      await ingest(result.pin);
      return Array.isArray(result.replies) ? result.replies : [];
    } catch (error) {
      if (error.status !== 404) throw error;
      forget(id);
      return [];
    }
  }

  async function launch(entry) {
    const replies = await reread(entry.pin.id);
    const current = pending.get(entry.pin.id);
    if (!current || stopping || limit(current.key)) return;
    await settings();
    // The mode counts at the start: with bulk now on, the pin waits for the run of its batch.
    if (!enabled || options.disabled || stopping || inBulk(current.pin)) return;
    const { pin, project, key } = current;
    const choice = chooseModel(runsOf(pin));
    if (pin.revert) {
      // A go back (item 16): the lean start, the project card, no history and no siblings.
      const profile = options.lean ? "pin" : null;
      const facts = await briefOf(pin, project);
      const prompt = buildRevertPrompt({ pin, project, choice, replies, brief: facts, shot: Boolean(shots), lean: profile === "pin" });
      await begin([pin], key, project, choice, `Pin #${pin.id} · Go back: ${pinTitle(pin)} · ${choice.label}`, prompt, profile);
      return;
    }
    // The lean start, unless the pin needs the full one (runner/src/profile.js).
    const profile = options.lean ? chooseProfile(pin) : null;
    const known = await context(pin);
    const facts = await briefOf(pin, project);
    const prompt = buildPrompt({ pin, project, choice, replies, ...known, brief: facts, shot: Boolean(shots), lean: profile === "pin" });
    await begin([pin], key, project, choice, `Pin #${pin.id} · ${pinTitle(pin)} · ${choice.label}`, prompt, profile);
  }

  // Bulk mode: the queued pins of one batch form one run (docs/protocol.md, Bulk mode). Its
  // project is the project of its oldest pin. The setting counts only at this start.
  async function launchBulk(entry) {
    const batch = entry.pin.batch;
    const { pins: listed } = await api(`/api/pins?${new URLSearchParams({ batch, status: "queued", limit: 500 })}`);
    if (!Array.isArray(listed)) throw new Error("Invalid pins list");
    for (const pin of listed) await ingest(pin);
    const members = () => [...pending.values()].filter((other) => other.pin.batch === batch && !other.pin.revert).sort((a, b) => a.pin.id - b.pin.id);
    const replies = new Map();
    for (const { pin } of members()) replies.set(pin.id, await reread(pin.id));
    const group = members().slice(0, BULK_MAX);
    if (!group.length || stopping || limit(group[0].key)) return;
    await settings();
    if (!enabled || options.disabled || stopping || !bulk.on) return;
    const { project, key } = group[0];
    const items = [];
    for (const { pin, project: own } of group) {
      items.push({ pin, replies: replies.get(pin.id), history: await history(pin), brief: await briefOf(pin, own) });
    }
    // A prompt over the Triad limit takes fewer pins. The others stay queued for the next bulk run.
    let choice, prompt;
    for (;;) {
      choice = chooseBulkModel(items.map(({ pin }) => pin));
      prompt = buildBulkPrompt({ items, project, choice, bulk, account: triad.account, shot: Boolean(shots) });
      if (items.length === 1 || Buffer.byteLength(prompt) <= PROMPT_BYTES) break;
      items.pop();
    }
    const pins = items.map(({ pin }) => pin);
    const more = pins.length > 1 ? ` +${pins.length - 1}` : "";
    await begin(pins, key, project, choice, `Pins ${pins.map((pin) => `#${pin.id}`).join(" ")} · ${pinTitle(pins[0])}${more} · ${choice.label} · bulk`, prompt);
  }

  // One Triad run for these pins: reserve the budget, delegate, then claim each pin. A bulk run
  // has no profile (the full start).
  async function begin(pins, key, project, choice, label, prompt, profile = null) {
    const reservation = { day: utcDay(clock.now()), used: dailyCount() + 1 };
    await options.budget?.save(reservation);
    budget = reservation;
    if (stopping) return;
    const names = pins.map((pin) => pin.id).join(",");
    let id;
    try {
      id = String(await triad.delegate({ model: choice.id, effort: choice.effort, cwd: project.dir || options.cwd, label, prompt, profile }));
      if (!/^[1-9][0-9]*$/.test(id)) throw new Error("Invalid Triad task id");
    } catch (error) {
      // A lost POST response may hide a running task, so the runner never delegates these pins
      // again: they go to the Chairman ("Needs you"). New runs pause for 30 seconds, so no
      // queued pin waits a minute.
      startAfter = clock.now() + POLL;
      log(`delegation failed pin=${names} ${errorCode(error)}`);
      for (const pin of pins) {
        attempted.set(pin.id, generation(pin));
        pending.delete(pin.id);
        owed.set(pin.id, `Auto-fix could not start a fix run (${errorCode(error)}). Reply to retry, or dismiss it.`);
      }
      await sendOwed();
      return;
    }
    count(id, new Date(clock.now()).toISOString());
    const run = { id, task: id, since: clock.now(), model: choice.short, key, oldest: pins[0].id,
      pins: new Map(pins.map((pin) => [pin.id, pin.reopens])), unclaimed: new Set(), nextCheck: clock.now() + WATCH,
      nextClaim: Infinity, claimWait: CLAIM_RETRY, retryAfter: 0 };
    runs.set(id, run);
    for (const pin of pins) {
      attempted.set(pin.id, generation(pin));
      pending.delete(pin.id);
    }
    log(`started run triad:${id} pin=${names} model=${choice.short}`);
    // Finish recording accepted delegation even during SIGTERM so restart can adopt it.
    for (const pin of pins) await claim(run, pin.id);
    scheduleClaim(run);
  }

  // When the next claim pass of the run comes: 3 s after the first refusal, and each refused pass
  // doubles the wait (6, then 12 s). A 429 names the least wait (Retry-After). A pass that
  // claims every pin ends the passes and resets the wait.
  function scheduleClaim(run) {
    if (run.unclaimed.size) {
      run.nextClaim = clock.now() + Math.max(run.claimWait, run.retryAfter);
      run.claimWait = Math.min(run.claimWait * 2, CLAIM_RETRY_MAX);
    } else Object.assign(run, { nextClaim: Infinity, claimWait: CLAIM_RETRY });
    run.retryAfter = 0;
  }

  // Writes the run on one pin ("working"), then queues its "before" shot. The 60 s of the shot
  // count from the delegation: after a late claim the session may have changed the page. A 409
  // means that the pin closed or that another agent has it: it leaves the run. Any other failure
  // (429, 5xx, no answer) keeps the pin in the run as unclaimed, and reclaim() tries again.
  async function claim(run, id) {
    try {
      const { pin } = await api(`/api/pins/${id}/start`, { run: `triad:${run.id}`, model: run.model });
      run.pins.set(id, pin?.reopens);
      run.unclaimed.delete(id);
      shots?.add(id, run.since);
    } catch (error) {
      if (error.status === 409) {
        run.unclaimed.delete(id);
        run.pins.delete(id);
        log(`pin claim skipped pin=${id} http=409`);
      } else {
        // One line per pin, not one per try.
        if (!run.unclaimed.has(id)) log(`pin claim failed pin=${id} ${errorCode(error)}`);
        run.unclaimed.add(id);
        run.retryAfter = Math.max(run.retryAfter, error.retryAfter || 0);
      }
    }
  }

  // The session of the run works on a pin that is still "queued": it cannot post steps or ship.
  // Read the pin first: the answer of an earlier start may be lost, and a 409 would then drop a
  // pin that this run has.
  async function reclaim(run) {
    for (const id of [...run.unclaimed]) {
      try {
        const { pin } = await api(`/api/pins/${id}`);
        if (pin.run === `triad:${run.id}`) {
          run.pins.set(id, pin.reopens);
          run.unclaimed.delete(id);
          shots?.add(id, run.since);
        } else if (pin.status === "queued" && !pin.run && attempted.get(id) === generation(pin)) await claim(run, id);
        else {
          // The pin closed, another agent has it, or it changed since the delegation (he answered
          // a question of the session, or edited the note). It leaves the run. A changed pin in
          // the queue is a new order: ingest() lets it start its own run.
          run.unclaimed.delete(id);
          run.pins.delete(id);
          await ingest(pin);
        }
      } catch (error) {
        // A deleted pin leaves the run. Any other failure waits for the next try.
        if (error.status === 404) { run.unclaimed.delete(id); run.pins.delete(id); }
      }
    }
    scheduleClaim(run);
  }

  // After a failed delegation each pin gets a question. One that the Pins server did not take is
  // sent again every 30 s, so no pin waits without a word. A pin that changed since gets none.
  async function sendOwed() {
    if (!owed.size || clock.now() < owedAfter) return;
    for (const [id, question] of owed) {
      try {
        const { pin } = await api(`/api/pins/${id}`);
        if (pin.status === "queued" && attempted.get(id) === generation(pin)) await api(`/api/pins/${id}/ask`, { question });
        owed.delete(id);
      } catch (error) {
        if ([400, 404, 409].includes(error.status)) owed.delete(id);
        else {
          owedAfter = clock.now() + POLL;
          log(`pin ask failed pin=${id} ${errorCode(error)}`);
        }
      }
    }
  }

  // The state of the run's Triad task. A task that Triad does not know (HTTP 404) is not an ended
  // task: Triad forgets its tasks at a timeline reset and stops no session. Such a run counts as
  // running until Triad's own time limit is over, then as GONE.
  async function taskState(run) {
    try {
      const state = await triad.task(run.task);
      if (typeof state.status !== "string" || !state.status) throw new Error("Invalid task status");
      return state;
    } catch (error) {
      if (error.status !== 404) throw error;
      // One line per run, not one per watch.
      if (!run.unknown) log(`run unknown triad:${run.id}`);
      run.unknown = true;
      return clock.now() - run.since < RUN_LIMIT ? { status: "running" } : GONE;
    }
  }

  async function watch(run) {
    run.nextCheck = clock.now() + WATCH;
    try {
      if (!run.end) {
        const state = await taskState(run);
        if (state.status === "running") return;
        if (state.continuedAs) {
          // Triad moved the session to the other Claude account at a plan limit. The same session
          // goes on in a new task; a retry now would put a second session on the pins. The new
          // task has its own time limit.
          Object.assign(run, { task: state.continuedAs, since: clock.now(), adopted: false });
          log(`run continues triad:${run.id} task=${run.task}`);
          return;
        }
        Object.assign(run, { end: state, nextClaim: Infinity });
        log(`run ended triad:${run.id} status=${state.status.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)}`);
      }
      const { status, exitCode, lastLine } = run.end;
      const ended = `The run ended without a result (${status}, exit ${exitCode ?? "null"}): ${String(lastLine ?? "").slice(0, 300)}.`;
      for (const id of [...run.pins.keys()]) {
        try {
          await settle(run, id, ended);
          run.pins.delete(id);
        } catch (error) {
          // A failed ask (including a missing route) is retried on the next watch.
          log(`run cleanup failed triad:${run.id} pin=${id} ${errorCode(error)}`);
        }
      }
      if (!run.pins.size) {
        runs.delete(run.id);
        endedRuns.add(run.id);
        if (endedRuns.size > ENDED_MAX) endedRuns.delete(endedRuns.values().next().value);
      }
    } catch (error) { log(`run watch failed triad:${run.id} ${errorCode(error)}`); }
  }

  // What an ended run owes one pin. It throws when the Pins server fails; the next watch tries again.
  async function settle(run, id, ended) {
    let pin;
    try { ({ pin } = await api(`/api/pins/${id}`)); }
    catch (error) {
      if (error.status === 404) return;
      throw error;
    }
    const back = pin.status === "queued" && !pin.run;
    if (back && sentBack(pin, run.pins.get(id))) {
      // He sent the pin back (an answer, "Not right", Reopen) while this run still ran. That is a
      // new order: the pin leaves this run and starts its own.
      run.pins.delete(id);
      await ingest(pin);
      return;
    }
    // A closed or waiting pin needs nothing. A pin with another run belongs to another agent. A
    // pin that is back in the queue for any other reason (its claim never worked, or its own
    // session reopened it) gets the question: a new run for it could repeat without end.
    if (!back && !(pin.status === "working" && pin.run === `triad:${run.id}`)) return;
    try {
      if (run.end !== GONE && enabled && !options.disabled && pin.status === "working" && Number(runsOf(pin).attempts) < MAX_ATTEMPTS) {
        // One more run, one effort step higher. It starts at once. With auto-fix off nothing
        // would pick it up, so the pin goes to the Chairman instead.
        const next = inBulk(pin) ? chooseBulkModel([pin]) : chooseModel(runsOf(pin));
        await api(`/api/pins/${id}/replies`, { body: `${ended} Trying again at effort ${next.effort}.` });
        await api(`/api/pins/${id}/reopen`, {});
      } else await api(`/api/pins/${id}/ask`, { question: `${ended} Reply to retry, or dismiss it.` });
    } catch (error) { if (error.status !== 409) throw error; }
  }

  async function drive() {
    await sendOwed();
    for (const run of runs.values()) {
      if (stopping) return;
      if (run.nextClaim <= clock.now()) await reclaim(run);
      if (run.nextCheck <= clock.now()) await watch(run);
    }
    if (!bootstrapped || !enabled || options.disabled || stopping || clock.now() < startAfter) return;
    for (const entry of units()) {
      if (stopping) return;
      const reason = limit(entry.key);
      if (!reason) await (inBulk(entry.pin) ? launchBulk(entry) : launch(entry));
      else if (entry.limit !== reason) {
        entry.limit = reason;
        log(`limit reached ${reason} pin=${entry.pin.id}`);
      }
      if (!enabled || clock.now() < startAfter) break;
    }
  }

  // What can start, oldest pin first: one run per pin, or with bulk on one run per batch, which
  // its oldest queued pin stands for.
  function units() {
    const batches = new Set();
    return [...pending.values()].sort((a, b) => a.pin.id - b.pin.id).filter(({ pin }) => {
      if (!inBulk(pin)) return true;
      if (batches.has(pin.batch)) return false;
      batches.add(pin.batch);
      return true;
    });
  }

  function plan() {
    clock.clearTimeout(timers.get("wake"));
    timers.delete("wake");
    if (stopping) return;
    const deadlines = [...runs.values()].map((run) => Math.min(run.nextCheck, run.nextClaim));
    if (owed.size) deadlines.push(Math.max(clock.now() + 1, owedAfter));
    if (bootstrapped && enabled && !options.disabled) {
      for (const entry of units()) {
        const reason = limit(entry.key);
        if (!reason) deadlines.push(Math.max(clock.now() + 1, startAfter));
        else if (reason === "daily") deadlines.push(Date.parse(`${utcDay(clock.now())}T00:00:00Z`) + 86_400_000);
      }
    }
    if (deadlines.length) timer("wake", Math.min(...deadlines) - clock.now(), () => enqueue(async () => {}));
  }

  function poll() {
    timer("poll", POLL, () => {
      enqueue(() => sync()).finally(() => { if (!stopping) poll(); });
    });
  }

  function connect() {
    if (stopping) return;
    const controller = streamController = new AbortController();
    streamJob = (async () => {
      // The open has the time of any other request. The stream itself stays open.
      const opening = clock.setTimeout(() => controller.abort(), API_MS);
      try {
        let response;
        try {
          response = await fetch(`${base}/api/events`, {
            headers: { Accept: "text/event-stream" }, signal: controller.signal, redirect: "error",
          });
        } finally { clock.clearTimeout(opening); }
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw Object.assign(new Error("SSE unavailable"), { status: response.status });
        }
        retry = 3000;
        enqueue(() => sync());
        await readEvents(response.body, (type, data) => {
          enqueue(async () => {
            if (type === "settings") apply(data);
            else if ((type === "pin" || type === "reply") && data.pin) await ingest(data.pin, data.action === "deleted");
          });
        }, controller.signal);
      } catch (error) {
        if (!stopping) log(`events reconnect ${errorCode(error)}`);
      } finally {
        if (!stopping) {
          timer("reconnect", retry, connect);
          retry = Math.min(retry * 2, 30_000);
        }
      }
    })();
  }

  return {
    async start() {
      if (started) throw new Error("Runner already started");
      started = true;
      if (options.budget) {
        try { budget = await options.budget.load(); }
        catch {
          // A broken file must not stop the runner: the runs that already run still need their
          // end. With a daily limit the day counts as used (fail closed). The next run writes a
          // good file.
          budget = { day: utcDay(clock.now()), used: options.maxRunsPerDay };
          log("budget file unreadable; today counts as used");
        }
      }
      await enqueue(() => sync());
      if (!stopping) { poll(); connect(); }
    },
    async stop() {
      stopping = true;
      for (const timeout of timers.values()) clock.clearTimeout(timeout);
      timers.clear();
      shots?.stop();
      streamController?.abort();
      await queue;
      await streamJob;
    },
    idle: () => queue,
    /** The size of each state holder. All have a bound; the memory test checks them. */
    sizes: () => ({ pending: pending.size, runs: runs.size, attempted: attempted.size, owed: owed.size,
      shots: shots?.size ?? 0, counted: counted.ids.size, endedRuns: endedRuns.size }),
  };
}
