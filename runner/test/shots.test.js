import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { shotCommand, createShots } from "../src/shots.js";
import { FakeClock, flush } from "./helpers.js";

test("the before shot is one systemd-run call: an argument array with its limits, and only an integer pin id", () => {
  const [file, args] = shotCommand(12, { port: 4750, pinsCli: "/srv/pins/server/bin/pins.js", node: "/opt/node/bin/node", env: {} });
  assert.equal(file, "/usr/bin/systemd-run");
  assert.deepEqual(args, [
    "--quiet", "--wait", "--collect", "--slice=onspot.slice", "--property=MemoryMax=1G", "--property=RuntimeMaxSec=75",
    "--setenv=PINS_AGENT=claude", "--setenv=PINS_PORT=4750", `--setenv=HOME=${homedir()}`,
    "--setenv=PATH=/opt/studio/bin:/usr/local/bin:/usr/bin:/bin",
    "/opt/node/bin/node", "/srv/pins/server/bin/pins.js", "snap", "12", "before",
  ]);
  const custom = shotCommand(7, { port: 6000, pinsCli: "/p", node: "/n", env: { PINS_SHOT_PATH: "/usr/bin:/bin", PINS_FACTS_DIR: "/var/lib/facts" } })[1];
  assert.deepEqual(custom.slice(7), ["--setenv=PINS_PORT=6000", `--setenv=HOME=${homedir()}`, "--setenv=PATH=/usr/bin:/bin", "--setenv=PINS_FACTS_DIR=/var/lib/facts", "/n", "/p", "snap", "7", "before"]);
  for (const bad of ["12", "--url=https://evil.example", 0, -1, 1.5, NaN, null, undefined, { id: 1 }]) {
    assert.throws(() => shotCommand(bad, { port: 4750, pinsCli: "/p" }), /Invalid pin id/, String(bad));
  }
});

test("the shot queue runs 2 at a time, in order, and a failed shot or a throwing log stops nothing", async () => {
  const clock = new FakeClock(), started = [], finish = new Map(), logs = [];
  const shots = createShots({ clock, shoot: (id) => { started.push(id); return new Promise((resolve, reject) => finish.set(id, { resolve, reject })); },
    log: (line) => { logs.push(line); throw new Error("log failed"); } });
  for (const id of [1, 2, 3, 4]) shots.add(id);
  await flush();
  assert.deepEqual([started, shots.size], [[1, 2], 2]);
  finish.get(1).reject(new Error("chromium")); await flush();
  assert.deepEqual([started, logs], [[1, 2, 3], ["before shot failed pin=1"]]);
  finish.get(2).resolve(); await flush();
  assert.deepEqual([started, shots.size], [[1, 2, 3, 4], 0]);
  shots.add(5); shots.stop(); finish.get(3).resolve(); await flush();
  assert.deepEqual(started, [1, 2, 3, 4], "stop drops the pins that wait");
});

test("the 60 s of a shot count from the start of its session, not from the moment it joins the queue", async () => {
  const clock = new FakeClock(), started = [], logs = [];
  const shots = createShots({ clock, shoot: async (id) => { started.push(id); }, log: (line) => logs.push(line) });
  shots.add(1, clock.now() - 60_000); shots.add(2, clock.now() - 60_001); shots.add(3);
  await flush();
  assert.deepEqual([started, logs, shots.size], [[1, 3], ["before shot skipped pin=2"], 0]);
});
