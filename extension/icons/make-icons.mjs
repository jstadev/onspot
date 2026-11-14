import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function chunk(type, data) {
  const name = Buffer.from(type);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  name.copy(result, 4);
  data.copy(result, 8);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

// Four cubic curves form a round head and a tapered tip. Coordinates are normalized.
const outline = [[0.5, 0.95]];
for (const [b, c, d] of [
  [[0.44, 0.87], [0.2, 0.6], [0.2, 0.38]],
  [[0.2, 0.205], [0.335, 0.07], [0.5, 0.07]],
  [[0.665, 0.07], [0.8, 0.205], [0.8, 0.38]],
  [[0.8, 0.6], [0.56, 0.87], [0.5, 0.95]],
]) {
  const a = outline.at(-1);
  for (let step = 1; step <= 24; step++) {
    const t = step / 24;
    const u = 1 - t;
    outline.push([0, 1].map((axis) =>
      u ** 3 * a[axis] + 3 * u ** 2 * t * b[axis] + 3 * u * t ** 2 * c[axis] + t ** 3 * d[axis]));
  }
}

function inside(x, y) {
  let result = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [ax, ay] = outline[i];
    const [bx, by] = outline[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) result = !result;
  }
  return result;
}

function png(size) {
  const samples = 8;
  const stride = 1 + size * 4;
  const rows = Buffer.alloc(stride * size); // Filter 0, RGBA, transparent outside the glyph.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let coverage = 0;
      let white = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = (x + (sx + 0.5) / samples) / size;
          const py = (y + (sy + 0.5) / samples) / size;
          if (!inside(px, py)) continue;
          coverage++;
          if ((px - 0.5) ** 2 + (py - 0.37) ** 2 <= 0.115 ** 2) white++;
        }
      }
      if (!coverage) continue;
      const offset = y * stride + 1 + x * 4;
      for (const [axis, blue] of [59, 130, 246].entries()) {
        rows[offset + axis] = Math.round(blue + (255 - blue) * white / coverage);
      }
      rows[offset + 3] = Math.round(255 * coverage / samples ** 2);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const data = png(size);
  writeFileSync(new URL(`icon-${size}.png`, import.meta.url), data);
  console.log(`icon-${size}.png: ${data.length} bytes`);
}
