/**
 * measure-fold-shear.mjs — the shear, measured off the real render.
 *
 * Every instrument so far reported dx = 0: the map's own symmetry, a vertical
 * grating in a synthetic page, and a vertical grating injected behind the real
 * toolbar. All three measure the same thing — a per-row horizontal shift of a
 * pattern that is invariant in y — and the artifact is a shear INSIDE the fold
 * bands, where the content has been mirrored first. A grating cannot see that:
 * it has no vertical structure to mirror.
 *
 * So this measures the pair of captures instead, over real prose:
 *
 *   for each row of the GLASS image
 *     find the row of the PLAIN image it came from  (that is the fold: dy)
 *     and the horizontal offset that best matches it (that is the shear: dx)
 *
 * by normalised cross-correlation over a (dy, dx) search. Because it searches
 * dy too, it follows the sampling INTO the fold and back out, and reports the
 * horizontal offset at every depth — which is exactly the quantity the diagram
 * describes and the one nothing else has been able to see.
 *
 *   node scripts/measure-fold-shear.mjs [glass.png] [plain.png]
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const DIR = path.join(process.cwd(), ".glass-shots", "bend");
const A = process.argv[2] ?? path.join(DIR, "glass.png");
const B = process.argv[3] ?? path.join(DIR, "plain.png");

/** Minimal PNG reader: 8-bit RGB/RGBA, non-interlaced — what capturePage writes. */
function readPng(file) {
  const buf = fs.readFileSync(file);
  let pos = 8, width = 0, height = 0, depth = 0, colour = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colour = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8 || (colour !== 6 && colour !== 2)) {
    throw new Error(`unsupported PNG (depth ${depth}, colour ${colour})`);
  }
  const ch = colour === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = new Uint8Array(width * height * ch);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    out.set(cur, y * stride);
    prev = cur;
  }
  return { width, height, ch, data: out };
}

const lum = (img, x, y) => {
  const i = (y * img.width + x) * img.ch;
  return (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
};

/** Normalised cross-correlation of glass row gy against plain row py, shifted dx. */
function ncc(g, p, gy, py, dx, x0, x1) {
  let sa = 0, sb = 0, n = 0;
  for (let x = x0; x < x1; x++) {
    const xb = x + dx;
    if (xb < 0 || xb >= p.width) return -2;
    sa += lum(g, x, gy); sb += lum(p, xb, py); n++;
  }
  if (!n) return -2;
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let x = x0; x < x1; x++) {
    const va = lum(g, x, gy) - ma, vb = lum(p, x + dx, py) - mb;
    num += va * vb; da += va * va; db += vb * vb;
  }
  return da > 1 && db > 1 ? num / Math.sqrt(da * db) : -2;
}

const g = readPng(A);
const p = readPng(B);
if (g.width !== p.width || g.height !== p.height) {
  console.error(`size mismatch: ${g.width}x${g.height} vs ${p.width}x${p.height}`);
  process.exit(2);
}

// ★ THE dy SEARCH MUST BE PHYSICALLY BOUNDED. The peak pull is under 8 CSS px,
//   so a match claiming dy = -59 has locked onto a DIFFERENT LINE of text, and
//   the dx it reports with it is meaningless. An unbounded search does not
//   measure the glass; it measures how repetitive the prose is. Bound it to
//   what the engine can actually produce, times the device scale, plus slack.
const MAX_DY = Number(process.env.MAX_DY ?? 24);
const MAX_DX = 12;
const x0 = Math.round(g.width * 0.10);
const x1 = Math.round(g.width * 0.90);

console.log(`glass ${A}`);
console.log(`plain ${B}`);
console.log(`${g.width}x${g.height}, correlating x ${x0}..${x1}, search dy ±${MAX_DY} dx ±${MAX_DX}\n`);
console.log(" row    dy      dx     score");

const rows = [];
for (let gy = 0; gy < g.height; gy++) {
  let best = { score: -2, dy: 0, dx: 0 };
  for (let dy = -MAX_DY; dy <= MAX_DY; dy++) {
    const py = gy + dy;
    if (py < 0 || py >= p.height) continue;
    for (let dx = -MAX_DX; dx <= MAX_DX; dx++) {
      const s = ncc(g, p, gy, py, dx, x0, x1);
      if (s > best.score) best = { score: s, dy, dx };
    }
  }
  rows.push({ gy, ...best });
}

// Only rows the correlation actually locked onto say anything.
const good = rows.filter((r) => r.score > 0.75);
for (const r of rows) {
  if (r.gy % 4) continue;
  const ok = r.score > 0.75;
  const bar = ok ? "█".repeat(Math.min(24, Math.abs(r.dx) * 3)) : "";
  console.log(
    `${String(r.gy).padStart(4)}  ${String(r.dy).padStart(4)}  ${(r.dx >= 0 ? "+" : "") + r.dx}`.padEnd(20) +
    `${r.score.toFixed(2)}  ${ok ? bar : "(no lock)"}`);
}

if (good.length < 8) {
  console.log(`\nonly ${good.length} rows locked — not enough signal to conclude.`);
  process.exit(1);
}

// The shear: dx as an ODD function about the surface's vertical centre.
const mid = (good[0].gy + good[good.length - 1].gy) / 2;
let top = [], bot = [];
for (const r of good) (r.gy < mid ? top : bot).push(r.dx);
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const mTop = mean(top), mBot = mean(bot);

console.log(`\nrows locked: ${good.length}/${rows.length}`);
console.log(`mean dx above centre: ${mTop >= 0 ? "+" : ""}${mTop.toFixed(2)} px  (${top.length} rows)`);
console.log(`mean dx below centre: ${mBot >= 0 ? "+" : ""}${mBot.toFixed(2)} px  (${bot.length} rows)`);
console.log(`★ SHEAR (top − bottom): ${(mTop - mBot >= 0 ? "+" : "") + (mTop - mBot).toFixed(2)} px`);
console.log(Math.abs(mTop - mBot) > 0.75
  ? "→ the two halves ARE displaced in opposite directions. That is the lean."
  : "→ the halves agree; no horizontal shear in the rendered output.");
