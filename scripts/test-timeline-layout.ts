/**
 * test-timeline-layout.ts — the fullscreen timeline's chip layout, MEASURED.
 *
 * Runs the REAL layoutBoxes over realistic mixed-height data (max-mode
 * two-line chips, dense high-tension chapters — the shapes the owner sees)
 * and counts what the eye complains about:
 *   · box–box overlaps (any visible pair intersection > 1px²)
 *   · box–node intrusions (a chip sitting on a chapter node)
 *   · strays (a chip pushed further than a column-width from its chapter)
 *
 * The bar is ZERO overlaps and intrusions across every scenario. Strays are
 * reported (a jammed column legitimately steps sideways) but bounded.
 *
 * Run: ./node_modules/.bin/tsx scripts/test-timeline-layout.ts
 */
import { layoutBoxes, TIMELINE_GEOM } from "../src/components/TimelineGraphFull";
import type { MajorEvent } from "../src/types";

let failures = 0;
const gate = (ok: boolean, label: string, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const { PAD_X, CHAPTER_W, SPINE_BASE, TERRAIN_AMP } = TIMELINE_GEOM;
const spineY = (t: number) => SPINE_BASE - TERRAIN_AMP * t;

const LABELS = [
  "Ferren admits the count is short", "Wick crosses the yard twice",
  "Marda melts the office seal", "Clerk refuses to carry the ledger",
  "The bell is answered at last", "Rell opens the sluice gate",
  "Sella reads the second writ", "The tally board breaks",
];
const DETAILS = [
  "the count ran short for eleven years", "kettle boiled on the stove",
  "wax ran off the iron", "refused twice before the second bell",
  null, "the water took the lower field", null, "in front of the assembly",
];

function mkEvents(n: number, tallEvery: number, seed: number): MajorEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    label: LABELS[(seed + i) % LABELS.length],
    sentence: "x",
    type: "action",
    tensionPosition: i / Math.max(1, n - 1),
    ...(tallEvery > 0 && i % tallEvery === 0
      ? { lmDetail: DETAILS[(seed + i) % DETAILS.length] ?? "a detail line under the label" }
      : {}),
  } as unknown as MajorEvent));
}

interface Scenario { name: string; chapters: Array<{ tension: number; events: MajorEvent[] }> }
const SCENARIOS: Scenario[] = [
  {
    name: "max mode, all tall, mixed tension",
    chapters: Array.from({ length: 12 }, (_, i) => ({
      tension: [0.9, 0.4, 1, 0.7, 0.2, 0.95, 0.6, 0.85, 0.3, 1, 0.5, 0.75][i],
      events: mkEvents(4, 1, i),
    })),
  },
  {
    name: "max mode, every other chip tall",
    chapters: Array.from({ length: 10 }, (_, i) => ({
      tension: (i % 3) / 2, events: mkEvents(4, 2, i),
    })),
  },
  {
    name: "adjacent high-tension chapters, dense",
    chapters: Array.from({ length: 6 }, (_, i) => ({
      tension: 0.9 + (i % 2) * 0.1, events: mkEvents(4, 1, i),
    })),
  },
  {
    name: "small tier, single-line only",
    chapters: Array.from({ length: 12 }, (_, i) => ({
      tension: (i % 5) / 4, events: mkEvents(3, 0, i),
    })),
  },
];

for (const sc of SCENARIOS) {
  const chData = sc.chapters.map((c, i) => ({
    ch: { id: `ch${i}` },
    x: PAD_X + i * CHAPTER_W,
    y: spineY(c.tension),
    nr: 6 + 4 * c.tension,
    events: c.events,
    color: "#345",
  }));
  const boxes = layoutBoxes(chData);

  let overlaps = 0, intrusions = 0, strays = 0;
  const pairNotes: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 1 && oy > 1) {
        overlaps++;
        if (pairNotes.length < 4) pairNotes.push(`"${a.label.slice(0, 18)}"×"${b.label.slice(0, 18)}" ${Math.round(ox)}x${Math.round(oy)}px`);
      }
    }
    for (const n of chData) {
      // circle-rect intersection
      const cx = Math.max(a.x, Math.min(n.x, a.x + a.w));
      const cy = Math.max(a.y, Math.min(n.y, a.y + a.h));
      if ((cx - n.x) ** 2 + (cy - n.y) ** 2 < n.nr ** 2) intrusions++;
    }
    const homeX = chData.find((c) => a.key.startsWith(c.ch.id + "-"))?.x ?? 0;
    if (Math.abs((a.x + a.w / 2) - homeX) > CHAPTER_W) strays++;
  }
  const aboveTop = boxes.filter((b) => b.y < 0).length;
  console.log(`\n── ${sc.name}: ${boxes.length} boxes`);
  gate(overlaps === 0, "zero box–box overlaps", `${overlaps} (${pairNotes.join(" · ")})`);
  gate(intrusions === 0, "zero box–node intrusions", `${intrusions}`);
  gate(aboveTop === 0, "nothing above the canvas", `${aboveTop}`);
  gate(strays <= Math.ceil(boxes.length * 0.1), "strays bounded (≤10%)", `${strays}/${boxes.length}`);
}

console.log(`\n${failures === 0 ? "✓ ALL GATES GREEN" : `✗ ${failures} GATE(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
