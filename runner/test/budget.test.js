import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBudget } from "../src/budget.js";

test("budget persists in a private file, survives reopening, and rejects corruption", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pins-budget-")), file = join(root, "state", "budget.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  const budget = openBudget(file);
  assert.deepEqual(await budget.load(), { day: null, used: 0 });
  await budget.save({ day: "2026-10-17", used: 40 });
  assert.deepEqual(await openBudget(file).load(), { day: "2026-10-17", used: 40 });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await writeFile(file, '{"day":"2026-10-17","used":-1}');
  await assert.rejects(budget.load(), /Invalid runner budget/);
});
