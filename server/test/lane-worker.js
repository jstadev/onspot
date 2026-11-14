// One contender for a lane, run by ship.test.js in several processes at once. It takes the lane, checks that
// it is alone (a marker file made with wx), then leaves the lane in one of the given ways:
//   die     : the lock stays with the pid of a dead process, so the next holder must take a stale lock over
//   release : the release function
//   old     : the lock is made 31 minutes old while this process lives; the release runs one turn later
//   guard   : as "die", after a process died inside the takeover guard: its guard file stays
// Prints { holds, violations }.
// Usage: node lane-worker.js <dir> <dead pid> <ms> [modes, default "die"]
import { readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as turn, setTimeout as delay } from "node:timers/promises";
import { takeLane } from "../src/ship.js";

const [dir, deadPid, ms, modeList = "die"] = process.argv.slice(2);
const modes = modeList.split(",");
const file = join(dir, "gate-demo.lock");
const deadGuard = `${file}.takeover.${deadPid}`;
const marker = join(dir, "inside");
const end = Date.now() + Number(ms);
const ago = (age) => new Date(Date.now() - age);
let holds = 0;
let violations = 0;
while (Date.now() < end) {
  const body = JSON.stringify({ pid: process.pid, pin: 1, at: `${process.pid}-${holds}` });
  const release = await takeLane(file, body, { waitMs: Infinity, sleep: () => delay(1) });
  holds++;
  try { writeFileSync(marker, String(process.pid), { flag: "wx" }); }
  catch (error) { if (error.code === "EEXIST") violations++; else throw error; }
  for (let spin = 0; spin < 2000; spin++); // Stay in the lane for a moment.
  rmSync(marker, { force: true });
  const mode = modes[(process.pid + holds) % modes.length];
  if (mode === "release") release();
  else if (mode === "old") {
    try { utimesSync(file, ago(31 * 60000), ago(31 * 60000)); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await turn();
    release();
  } else {
    // A guard file has the pid of its process in the name, so this is never the guard of a live process.
    if (mode === "guard") writeFileSync(deadGuard, deadPid);
    // The dead holder's lock replaces this holder's lock in one step, and only while it is still there.
    let own = false;
    try { own = readFileSync(file, "utf8") === body; } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (own) {
      const temp = `${file}.${process.pid}.dead`;
      writeFileSync(temp, JSON.stringify({ pid: Number(deadPid), pin: 1, at: `dead-${process.pid}-${holds}` }));
      renameSync(temp, file);
    }
  }
  await turn();
}
console.log(JSON.stringify({ holds, violations }));
