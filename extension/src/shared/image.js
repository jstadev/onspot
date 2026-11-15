// Pure rules for an attached image. The background and the content script both use them.
import { IMAGE_ID_RE, IMAGES_MAX, SHOT_MAX, SHOT_TYPES } from "./protocol.js";

export const IMAGE_SIDE = 2560;
// One draw at the 2560 fit, then at most three scales of 0.75.
export const ENCODE_ATTEMPTS = 4;

// `apply` on 8 KiB parts: 13 ms for 2 MiB. The spread form on 32 KiB parts took 104 ms.
export function bytesToBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x2000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000));
  return btoa(text);
}

// Null when `data` is not base64, or when the decoded bytes are empty or over `max`.
export function base64ToBytes(data, max) {
  if (typeof data !== "string" || !data || data.length > Math.ceil(max / 3) * 4) return null;
  let binary;
  try { binary = atob(data); } catch { return null; }
  if (!binary.length || binary.length > max) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// The shot magic check (server `shotType`): the first bytes must match the type.
export function imageType(bytes) {
  if (!bytes || bytes.length < 3) return "";
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === "RIFF" && String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === "WEBP") return "image/webp";
  return "";
}

// Send the file unchanged when the browser already stored a shot type at a size we can post.
export function sendAsIs(type, size, width, height) {
  return SHOT_TYPES.includes(type) && size >= 1 && size <= SHOT_MAX && width >= 1 && height >= 1 && Math.max(width, height) <= IMAGE_SIDE;
}

// The canvas size for encode attempt `attempt` (0 is the first draw).
export function drawSize(width, height, attempt) {
  const longest = Math.max(width, height, 1);
  const fit = Math.min(1, IMAGE_SIDE / longest);
  let w = Math.max(1, Math.round(width * fit));
  let h = Math.max(1, Math.round(height * fit));
  for (let step = 0; step < attempt; step++) {
    w = Math.max(1, Math.round(w * 0.75));
    h = Math.max(1, Math.round(h * 0.75));
  }
  return [w, h];
}

// At most 6 ids, in order. A bad id or a duplicate is dropped.
export function cleanImageIds(value) {
  const ids = [];
  if (!Array.isArray(value)) return ids;
  for (const id of value) {
    if (typeof id === "string" && IMAGE_ID_RE.test(id) && !ids.includes(id)) ids.push(id);
    if (ids.length === IMAGES_MAX) break;
  }
  return ids;
}

// The draft keeps the cleaned list, or no key when nothing valid remains.
export function keepImages(body) {
  const images = cleanImageIds(body?.images);
  if (!body || typeof body !== "object") return images;
  if (images.length) body.images = images;
  else delete body.images;
  return images;
}
