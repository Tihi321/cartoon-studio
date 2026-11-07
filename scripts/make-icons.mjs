// Generates the app icon (build/icon.png, build/icon.ico) from a 16x16 pixel sprite (a flat cutout face on blue), zlib only.
// Run: yarn icons   (the outputs are committed; build/icon.png also ships as resources/icon.png for the window and tray)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// Each sprite pixel is a flat square, so every size stays crisp (integer multiples of 16 only; 48 and 192 would also be exact).
const COLORS = {
  K: [0x22, 0x22, 0x22], // outline
  B: [0x0d, 0x3b, 0x66], // background blue
  Y: [0xf4, 0xd3, 0x5e], // face yellow
  O: [0xee, 0x96, 0x4b], // cheeks
};
const SPRITE = [
  "BBBBBBBBBBBBBBBB",
  "BBBBBKKKKKKBBBBB",
  "BBBKKYYYYYYKKBBB",
  "BBKYYYYYYYYYYKBB",
  "BKYYYKKYYKKYYYKB",
  "BKYYYKKYYKKYYYKB",
  "BKYYYYYYYYYYYYKB",
  "BKYOOYYYYYYOOYKB",
  "BKYYYYYYYYYYYYKB",
  "BKYYKYYYYYYKYYKB",
  "BBKYYKKKKKKYYKBB",
  "BBKYYYKKKKYYYKBB",
  "BBBKYYYYYYYYKBBB",
  "BBBBKKYYYYKKBBBB",
  "BBBBBBKKKKBBBBBB",
  "BBBBBBBBBBBBBBBB",
];
function shade(x, y) {
  const n = SPRITE.length;
  const color = COLORS[SPRITE[Math.min(n - 1, Math.floor(y * n))][Math.min(n - 1, Math.floor(x * n))]];
  return color ? [...color, 255] : null;
}
function render(size) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = shade((x + 0.5) / size, (y + 0.5) / size);
    if (px) out.set(px, (y * size + x) * 4);
  }
  return out;
}

fs.mkdirSync(path.join(root, "build"), { recursive: true });
fs.writeFileSync(path.join(root, "build", "icon.png"), png(256, render(256)));

const sizes = [16, 32, 48, 64, 128, 256];
const images = sizes.map((s) => png(s, render(s)));
const dir = Buffer.alloc(6 + 16 * sizes.length);
dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(sizes.length, 4);
let offset = dir.length;
sizes.forEach((s, i) => {
  const e = 6 + i * 16;
  dir[e] = s === 256 ? 0 : s; dir[e + 1] = s === 256 ? 0 : s; dir[e + 2] = 0; dir[e + 3] = 0;
  dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6); dir.writeUInt32LE(images[i].length, e + 8); dir.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
fs.writeFileSync(path.join(root, "build", "icon.ico"), Buffer.concat([dir, ...images]));
console.log("icons written: build/icon.png, build/icon.ico");
