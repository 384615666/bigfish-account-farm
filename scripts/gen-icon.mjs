// 生成应用图标 build/icon.png（512x512）。纯 Node 实现，无第三方依赖。
// 设计：深紫渐变圆角方块 + 三根白色额度条（月/周/5小时），表达"多账号额度看板"。
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 512;
const px = new Uint8Array(SIZE * SIZE * 4);

function setPx(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

function insideRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function roundedRect(x0, y0, x1, y1, r, fn) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (insideRoundRect(x, y, x0, y0, x1, y1, r)) fn(x, y);
    }
  }
}

// 背景：圆角方块 + 纵向渐变
const CORNER = 96;
roundedRect(4, 4, SIZE - 5, SIZE - 5, CORNER, (x, y) => {
  const t = y / SIZE;
  const r = Math.round(79 + (124 - 79) * t);   // #4F46E5 -> #7C3AED
  const g = Math.round(70 + (58 - 70) * t);
  const b = Math.round(229 + (237 - 229) * t);
  setPx(x, y, r, g, b, 255);
});

// 三根额度条（白色，圆角），长度递减代表 月 > 周 > 5小时
const bars = [
  { x0: 84, x1: 428, y0: 118, y1: 178, r: 26, a: 240 },
  { x0: 84, x1: 322, y0: 226, y1: 286, r: 26, a: 225 },
  { x0: 84, x1: 216, y0: 334, y1: 394, r: 26, a: 210 },
];
for (const b of bars) {
  roundedRect(b.x0, b.y0, b.x1, b.y1, b.r, (x, y) => setPx(x, y, 255, 255, 255, b.a));
}

// ---- 最小 PNG 编码器（RGBA 8bit，filter 0） ----
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter none
  raw.set(px.subarray(y * SIZE * 4, (y + 1) * SIZE * 4), y * (SIZE * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const outDir = path.join(ROOT, "build");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "icon.png");
// build/icon.png 现在是手绘素材，本脚本的占位图只允许在"确实是本脚本生成的"情况下覆盖。
const prev = existsSync(outFile) ? readFileSync(outFile) : null;
if (prev && !prev.equals(png) && !process.argv.includes("--force")) {
  console.error(
    [
      "拒绝覆盖 build/icon.png：现有文件和本脚本生成的不一致，说明它是手工素材。",
      "本脚本只负责生成占位图标，不要用它盖掉手绘图标。",
      "确实要覆盖请显式执行：npm run icon -- --force",
    ].join("\n")
  );
  process.exit(1);
}
if (prev && prev.equals(png)) {
  console.log("icon unchanged:", outFile, png.length, "bytes");
} else {
  writeFileSync(outFile, png);
  console.log("icon written:", outFile, png.length, "bytes");
}
