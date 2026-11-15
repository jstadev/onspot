import test from "node:test";
import assert from "node:assert/strict";
import { ENCODE_ATTEMPTS, IMAGE_SIDE, base64ToBytes, bytesToBase64, cleanImageIds, drawSize, imageType, keepImages, sendAsIs } from "../src/shared/image.js";
import { IMAGE_ID_RE, IMAGES_MAX, SHOT_MAX } from "../src/shared/protocol.js";

const ID = "Abcd1234_-Abcd1234_-Ab";
const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0);
const webp = Uint8Array.of(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);

test("image ids on a draft: at most 6, in order, bad entries and duplicates dropped", () => {
  assert.equal(ID.length, 22);
  assert.equal(IMAGE_ID_RE.test(ID), true);
  assert.equal(IMAGES_MAX, 6);
  const ids = [ID, ` ${ID}`, ID.slice(0, 21), `${ID}x`, ID, "bad id", 7, null, ID.replace("A", "B"), "!!!!!!!!!!!+++++++++++"];
  const six = Array.from({ length: 8 }, (_, index) => ID.replace("A", String.fromCharCode(66 + index)));
  assert.deepEqual(cleanImageIds(undefined), []);
  assert.deepEqual(cleanImageIds("nope"), []);
  assert.deepEqual(cleanImageIds(ids), [ID, ID.replace("A", "B")]);
  assert.deepEqual(cleanImageIds(six), six.slice(0, 6));
  const body = { note: "x", images: [...ids, ...six] };
  const kept = [ID, ...six.slice(0, 5)];
  assert.deepEqual(keepImages(body), kept);
  assert.deepEqual(body.images, kept);
  const empty = { images: ["nope", ID.slice(0, 21), ID, ID] };
  assert.deepEqual(keepImages(empty), [ID]);
  assert.deepEqual(keepImages({ images: "nope" }), []);
  const gone = { note: "x", images: [] };
  assert.deepEqual(keepImages(gone), []);
  assert.equal("images" in gone, false);
});

test("a file is sent unchanged only for a shot type within 2 MiB and 2560 px", () => {
  assert.equal(sendAsIs("image/png", 1, 1, 1), true);
  assert.equal(sendAsIs("image/jpeg", SHOT_MAX, IMAGE_SIDE, 10), true);
  assert.equal(sendAsIs("image/webp", 10, 10, IMAGE_SIDE), true);
  assert.equal(sendAsIs("image/gif", 10, 10, 10), false);
  assert.equal(sendAsIs("image/png", 0, 10, 10), false);
  assert.equal(sendAsIs("image/png", SHOT_MAX + 1, 10, 10), false);
  assert.equal(sendAsIs("image/png", 10, IMAGE_SIDE + 1, 10), false);
  assert.equal(sendAsIs("image/png", 10, 0, 10), false);
});

test("encode draws at the 2560 fit, then scales by 0.75 at most three times", () => {
  assert.equal(ENCODE_ATTEMPTS, 4);
  assert.deepEqual(drawSize(4000, 2000, 0), [2560, 1280]);
  assert.deepEqual(drawSize(4000, 2000, 1), [1920, 960]);
  assert.deepEqual(drawSize(4000, 2000, 2), [1440, 720]);
  assert.deepEqual(drawSize(4000, 2000, 3), [1080, 540]);
  assert.deepEqual(drawSize(100, 50, 0), [100, 50]);
  assert.deepEqual(drawSize(100, 50, 1), [75, 38]);
});

test("magic bytes name png, jpeg and webp, and base64 stops at 2 MiB", () => {
  assert.equal(imageType(png), "image/png");
  assert.equal(imageType(jpeg), "image/jpeg");
  assert.equal(imageType(webp), "image/webp");
  assert.equal(imageType(Uint8Array.of(0x89, 0x50, 0x4e)), "");
  assert.equal(imageType(Uint8Array.of(0xff, 0xd8, 0x00)), "");
  assert.equal(imageType(new Uint8Array(12)), "");
  const bytes = Uint8Array.from({ length: 9000 }, (_, index) => index % 251);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes), SHOT_MAX), bytes);
  assert.equal(base64ToBytes("", SHOT_MAX), null);
  assert.equal(base64ToBytes("!!!!", SHOT_MAX), null);
  assert.equal(base64ToBytes("QQ==", SHOT_MAX)?.length, 1);
  assert.equal(base64ToBytes("A".repeat(Math.ceil(SHOT_MAX / 3) * 4 + 1), SHOT_MAX), null);
});
