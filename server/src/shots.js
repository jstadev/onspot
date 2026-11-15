// Shot limits shared by the store, the HTTP layer and the CLI (which must not load node:sqlite).
export const SHOT_MAX = 2 * 1024 * 1024;
export const SHOT_KINDS = ["before", "after"];
export const SHOT_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** The image type that the first bytes name, or null. */
export function shotType(bytes) {
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// Images he attaches to a pin or a reply use the shot types and SHOT_MAX. An id is 16 random bytes as base64url.
export const IMAGE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
