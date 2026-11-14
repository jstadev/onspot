import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Reserve before POST /delegate. A crash or lost response must not refund a run.
export function openBudget(file) {
  return {
    async load() {
      let text;
      try { text = await readFile(file, "utf8"); }
      catch (error) { if (error.code === "ENOENT") return { day: null, used: 0 }; throw error; }
      const value = JSON.parse(text);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value.day) || !Number.isSafeInteger(value.used) || value.used < 0) {
        throw new Error("Invalid runner budget");
      }
      return { day: value.day, used: value.used };
    },
    async save(value) {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flush: true });
      await rename(temporary, file);
    },
  };
}
