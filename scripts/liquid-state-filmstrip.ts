/* liquid-state-filmstrip — render the indicator's every loop and every transition to a
 * contact sheet, headless, so the motion can be LOOKED AT rather than reasoned about.
 *
 * The gate in test-liquid-state.ts proves the motion is continuous, contained, and that
 * the neck is real. None of that is a statement about whether it looks any good, and
 * the numbers were talked into agreeing with three different geometries before anyone
 * saw a frame. This writes PNGs.
 *
 *   scripts/liquid-state-filmstrip.ts            → both sheets in the scratch dir
 *
 * Two sheets, because they answer different questions:
 *   big    96px cells — is the CHOREOGRAPHY right? where is the neck, does the splat
 *          read, does the droplet fly
 *   true   the real 18px at 2×, blown up 4× with no smoothing — is it legible at the
 *          size it actually ships at? A shape that reads at 96px and turns to mush at
 *          18px is the whole reason this file renders both
 *
 * No dependencies: PNG is IHDR + one deflated IDAT + IEND, and node has zlib.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import {
  DURATION, GEOMETRY, fieldOf, kindFor, loopPose, poseAt,
  type LiquidStateName, type Motion, type Pose,
} from "../src/components/liquid-state/choreography";
import { rasterise } from "../src/components/liquid-state/field";

/* ── PNG ────────────────────────────────────────────────────────────────────────── */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function png(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; /* filter: none */
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; /* 8-bit RGB */
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ── the sheet ──────────────────────────────────────────────────────────────────── */
const INK: [number, number, number] = [59, 130, 246];
const INK_A = 0.88;
const BG: [number, number, number] = [244, 244, 243];
const GRID: [number, number, number] = [220, 220, 218];

interface Row { label: string; frames: Pose[] }

function motionOf(from: LiquidStateName, to: LiquidStateName, atClock = 0): Motion {
  return { from, to, kind: kindFor(from, to), fromPose: loopPose(from, atClock), elapsed: 0 };
}
const period = (s: LiquidStateName) =>
  s === "thinking" ? GEOMETRY.P_THINK : s === "writing" ? GEOMETRY.P_WRITE : GEOMETRY.P_READ;

const COLS = 14;
function loopRow(s: LiquidStateName): Row {
  const p = period(s);
  return { label: `${s} loop (${p}ms)`, frames: Array.from({ length: COLS }, (_, i) => loopPose(s, (i / COLS) * p)) };
}
function transitionRow(from: LiquidStateName, to: LiquidStateName, atClock = 0): Row {
  const m = motionOf(from, to, atClock);
  const dur = DURATION[m.kind];
  /* Sample the transition plus a beat of the loop it hands over to — the handover is
   * the frame most likely to be wrong and the least likely to be looked at. */
  const span = dur * 1.25;
  return {
    label: `${from} → ${to} (${m.kind}, ${dur}ms)`,
    frames: Array.from({ length: COLS }, (_, i) => {
      const t = (i / (COLS - 1)) * span;
      return t < dur ? poseAt(to, 0, { ...m, elapsed: t }) : loopPose(to, t - dur);
    }),
  };
}
function enterRow(to: LiquidStateName): Row {
  const m: Motion = { from: null, to, kind: "enter", fromPose: loopPose(to, 0), elapsed: 0 };
  const span = DURATION.enter * 1.25;
  return {
    label: `entrance → ${to} (${DURATION.enter}ms)`,
    frames: Array.from({ length: COLS }, (_, i) => {
      const t = (i / (COLS - 1)) * span;
      return t < DURATION.enter ? poseAt(to, 0, { ...m, elapsed: t }) : loopPose(to, t - DURATION.enter);
    }),
  };
}

const ROWS: Row[] = [
  loopRow("thinking"),
  loopRow("writing"),
  loopRow("reading"),
  enterRow("thinking"),
  transitionRow("reading", "thinking"),
  transitionRow("thinking", "writing", GEOMETRY.P_THINK * 0.33),
  transitionRow("writing", "thinking"),
  transitionRow("reading", "writing"),
];

/** Draw one pose into a cell of `cell` device px, scaled up by `zoom` with no smoothing. */
function drawCell(out: Uint8Array, sheetW: number, ox: number, oy: number, pose: Pose, cell: number, zoom: number) {
  const rgba = new Uint8ClampedArray(cell * cell * 4);
  rasterise(rgba, cell, fieldOf(pose), INK, INK_A * pose.alpha);
  for (let y = 0; y < cell * zoom; y++) {
    for (let x = 0; x < cell * zoom; x++) {
      const src = (Math.floor(y / zoom) * cell + Math.floor(x / zoom)) * 4;
      const a = rgba[src + 3] / 255;
      const o = ((oy + y) * sheetW + ox + x) * 3;
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(BG[c] * (1 - a) + rgba[src + c] * a);
    }
  }
}

function sheet(file: string, cell: number, zoom: number) {
  const side = cell * zoom;
  const pad = 6;
  const labelH = 14;
  const w = COLS * (side + pad) + pad;
  const h = ROWS.length * (side + pad + labelH) + pad;
  const out = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { out[i * 3] = 255; out[i * 3 + 1] = 255; out[i * 3 + 2] = 255; }

  ROWS.forEach((row, r) => {
    const oy = pad + r * (side + pad + labelH) + labelH;
    /* A rule under each strip, so the ground line is visible and rows do not blur into
     * one another when the sheet is read at a glance. */
    for (let x = pad; x < w - pad; x++) {
      const o = ((oy - 4) * w + x) * 3;
      for (let c = 0; c < 3; c++) out[o + c] = GRID[c];
    }
    row.frames.forEach((pose, i) => {
      drawCell(out, w, pad + i * (side + pad), oy, pose, cell, zoom);
    });
  });
  writeFileSync(file, png(w, h, out));
  console.log(`${file}  ${w}×${h}  ${ROWS.length} rows × ${COLS} frames  (cell ${cell}px ×${zoom})`);
  ROWS.forEach((row, i) => console.log(`  row ${i + 1}  ${row.label}`));
}

const dir = process.argv[2] ?? ".";
sheet(`${dir}/liquid-state-big.png`, 96, 1);
/* The size it actually ships at: 18 CSS px on a 2× screen. */
sheet(`${dir}/liquid-state-true.png`, 36, 4);
