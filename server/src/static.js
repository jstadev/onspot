import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { HttpError } from "./http.js";

const DOWNLOADS = new Set(["onspot-chrome.zip", "onspot-firefox.zip"]);

// Inspect the raw target before any URL parser can normalize away dot segments.
export function decodePath(target) {
  const raw = target.split("?", 1)[0];
  let path;
  try { path = decodeURIComponent(raw); }
  catch { throw new HttpError(400, "invalid path"); }
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\0") || path.includes("\\") || path.split("/").includes("..")) {
    throw new HttpError(404, "not found");
  }
  return path;
}

// The only files are the two extension builds. The queue is the Pins tab in the Triad console.
export function createStatic({ downloadDir }) {
  async function find(path) {
    const name = path.startsWith("/download/") ? path.slice("/download/".length) : "";
    if (!downloadDir || !DOWNLOADS.has(name)) return null;
    const file = join(downloadDir, name);
    try {
      const info = await stat(file);
      return info.isFile() ? { file, info, name } : null;
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes(error.code)) return null;
      throw error;
    }
  }

  async function send(req, res, { file, info, name }) {
    const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
    const headers = {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-cache",
      "ETag": etag,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    };
    const tags = req.headers["if-none-match"]?.split(",").map((tag) => tag.trim().replace(/^W\//, ""));
    if (tags?.some((tag) => tag === "*" || tag === etag.slice(2))) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, "Content-Length": info.size });
    try { await pipeline(createReadStream(file), res); }
    catch (error) {
      if (res.destroyed && ["ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET"].includes(error.code)) return;
      throw error;
    }
  }

  return { find, send };
}
