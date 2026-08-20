import { writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const SIZE = 256;
const SCALE = 3;
const canvas = new Uint8Array(SIZE * SIZE * 4);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function inRoundedSquare(x, y) {
  const inset = 10;
  const radius = 48;
  const cx = Math.min(Math.max(x, inset + radius), SIZE - inset - radius);
  const cy = Math.min(Math.max(y, inset + radius), SIZE - inset - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
}

function inTriangle(x, y, a, b, c) {
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const p = [x, y];
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function inStar(x, y) {
  const points = [];
  for (let index = 0; index < 10; index += 1) {
    const radius = index % 2 === 0 ? 31 : 13;
    const angle = -Math.PI / 2 + index * Math.PI / 5;
    points.push([128 + Math.cos(angle) * radius, 112 + Math.sin(angle) * radius]);
  }
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

for (let py = 0; py < SIZE; py += 1) {
  for (let px = 0; px < SIZE; px += 1) {
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 0;
    for (let sy = 0; sy < SCALE; sy += 1) {
      for (let sx = 0; sx < SCALE; sx += 1) {
        const x = px + (sx + 0.5) / SCALE;
        const y = py + (sy + 0.5) / SCALE;
        if (!inRoundedSquare(x, y)) continue;
        const blend = (x + y) / (SIZE * 2);
        let sample = [Math.round(79 - 55 * blend), Math.round(70 + 112 * blend), Math.round(229 + 1 * blend), 255];
        const distance = Math.hypot(x - 128, y - 112);
        const ring = distance >= 61 && distance <= 78;
        const tail = inTriangle(x, y, [77, 165], [61, 216], [112, 184]);
        if (ring || tail || inStar(x, y)) sample = [255, 255, 255, 255];
        red += sample[0];
        green += sample[1];
        blue += sample[2];
        alpha += sample[3];
      }
    }
    const samples = SCALE * SCALE;
    const offset = (py * SIZE + px) * 4;
    canvas[offset] = Math.round(red / samples);
    canvas[offset + 1] = Math.round(green / samples);
    canvas[offset + 2] = Math.round(blue / samples);
    canvas[offset + 3] = Math.round(alpha / samples);
  }
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let row = 0; row < SIZE; row += 1) {
  const target = row * (SIZE * 4 + 1);
  raw[target] = 0;
  Buffer.from(canvas.subarray(row * SIZE * 4, (row + 1) * SIZE * 4)).copy(raw, target + 1);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
await writeFile(new URL('../media/yuanmeng-ai.png', import.meta.url), png);
process.stdout.write(`generated media/yuanmeng-ai.png (${SIZE}x${SIZE})\n`);
