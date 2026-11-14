import { readdir, readFile, stat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";

const scans = new Map();
const TTL = 60_000;

async function optionalFile(file) {
  try { return await readFile(file, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function scan(root) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const folder = join(root, entry.name);
    const [json, memory, state] = await Promise.all([
      optionalFile(join(folder, "project.json")), optionalFile(join(folder, "MEMORY.md")),
      optionalFile(join(folder, "state.md")),
    ]);
    let meta = {};
    try { meta = JSON.parse(json) || {}; } catch { /* Legacy memory still participates. */ }
    const urls = [];
    for (const raw of Array.isArray(meta.urls) ? meta.urls : []) {
      try {
        const url = new URL(raw);
        if (["https:", "http:"].includes(url.protocol)) urls.push(url);
      } catch { /* Ignore malformed metadata URLs. */ }
    }
    return {
      name: typeof meta.name === "string" && meta.name ? meta.name : entry.name,
      active: meta.status === "active", urls,
      dirs: Array.isArray(meta.dirs) ? meta.dirs.filter((dir) => typeof dir === "string" && isAbsolute(dir)) : [],
      text: `${memory}\n${state}`.toLowerCase(),
    };
  }));
}

// A path prefix ends at a path segment: /pins also matches /pins/, never /pinstripe.
function prefixLength(prefix, path) {
  const base = prefix.replace(/\/+$/, "") || "/";
  return base === "/" || path === base || path.startsWith(`${base}/`) ? base.length : -1;
}

/** Finds the project of a page. root holds one folder per project (PINS_PROJECTS_DIR), each with
 *  project.json ({ name, status, urls, dirs }), MEMORY.md and state.md. Returns the project name,
 *  its first folder that exists, and every project that matched. */
export async function resolveProject(host, path, { root }) {
  let cached = scans.get(root);
  if (!cached || Date.now() - cached.at >= TTL) {
    cached = { at: Date.now(), promise: scan(root) };
    scans.set(root, cached);
    cached.promise.catch(() => { if (scans.get(root) === cached) scans.delete(root); });
  }
  const projects = await cached.promise;
  const target = String(host).toLowerCase();
  const pathname = path || "/";
  let matches = projects.map((project) => ({
    project,
    prefix: Math.max(-1, ...project.urls.filter((url) => url.host === target).map((url) => prefixLength(url.pathname, pathname))),
  })).filter((match) => match.prefix >= 0);
  if (!matches.length) {
    // A host mention must be whole, not a suffix of another host or part of an email.
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mention = new RegExp(`(^|[^a-z0-9.@-])${escaped}(?![a-z0-9-]|\\.[a-z0-9]|:\\d)`, "i");
    matches = projects.filter((project) => mention.test(project.text)).map((project) => ({ project, prefix: 0 }));
  }
  matches.sort((a, b) => b.prefix - a.prefix || Number(b.project.active) - Number(a.project.active) || a.project.name.localeCompare(b.project.name));
  const project = matches[0]?.project;
  let dir = null;
  for (const candidate of project?.dirs || []) {
    try {
      if ((await stat(candidate)).isDirectory()) { dir = candidate; break; }
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  return { name: project?.name ?? null, dir, candidates: [...new Set(matches.map((match) => match.project.name))] };
}
