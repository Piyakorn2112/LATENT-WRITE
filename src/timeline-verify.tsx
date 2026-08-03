/**
 * Dev-only harness: the REAL <TimelineGraphFull/> with a synthetic novel,
 * for verifying the cast ledger (and any future timeline work) against the
 * shipping component instead of a hand-built imitation of it.
 *
 * Driven by scripts/verify-timeline-cast.cjs. Not imported by the app.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { TimelineGraphFull } from "./components/TimelineGraphFull";
import type { StoryGraph, MajorEvent } from "./types";
import type { TimelineCharacterTrack } from "./lib/story-graph-display";

const N = 14;
const chapters = Array.from({ length: N }, (_, i) => ({
  id: `ch${i + 1}`,
  number: i + 1,
  title: ["A Truth Acknowledged", "The Assembly", "First Impressions", "Netherfield",
    "The Visit", "A Proposal Refused", "The Letter", "Pemberley", "News from Home",
    "Flight", "The Return", "Lady Catherine Calls", "A Second Proposal", "Consent"][i],
}));

const evt = (label: string, agent: string, pos: number, rank: number): MajorEvent => ({
  label,
  type: "revelation",
  tensionPosition: pos,
  confidence: 0.8 - rank * 0.05,
  rank,
  agent,
  salience: "major",
  narrativeType: "revelation",
  sentence: `${label}, as the chapter has it.`,
  paragraphIndex: Math.round(pos * 30),
});

const entries: StoryGraph["entries"] = {};
for (let i = 0; i < N; i++) {
  const id = chapters[i].id;
  entries[id] = {
    chapterId: id,
    chapterNumber: i + 1,
    chapterTitle: chapters[i].title,
    role: i === 9 ? "climax" : "standard",
    tensionPeak: [0.2, 0.3, 0.35, 0.4, 0.35, 0.6, 0.55, 0.45, 0.6, 0.9, 0.5, 0.65, 0.75, 0.4][i],
    tensionCurve: [0.2, 0.3, 0.4, 0.5, 0.6, 0.5, 0.4, 0.3],
    charactersPresent: [],
    wordCount: 2600,
    proseRegister: "narration",
    majorEvents: [
      evt(`Elizabeth learns of ch ${i + 1}`, "Elizabeth", 0.55, 0),
      ...(i === 5 || i === 12 ? [evt("Darcy proposes", "Darcy", 0.8, 1)] : []),
    ],
    lastUpdated: 0,
    contentHash: `h${i}`,
  };
}

const track = (
  name: string,
  color: string,
  present: number[],           // chapter numbers
  mentions: Record<number, number>,
  drives: Record<number, number>,
  /** The TYPE of each driven event, so the agency squares carry their colour.
   *  Omitted on one track on purpose — an older persisted graph has counts and
   *  no types, and the row must still draw the right NUMBER of squares. */
  driveTypes?: Record<number, string[]>,
): TimelineCharacterTrack => ({
  name,
  color,
  count: present.length,
  chapterIds: new Set(present.map((n) => `ch${n}`)),
  mentionsByChapter: new Map(Object.entries(mentions).map(([n, m]) => [`ch${n}`, m])),
  drivesByChapter: new Map(Object.entries(drives).map(([n, d]) => [`ch${n}`, d])),
  driveTypesByChapter: driveTypes
    ? new Map(Object.entries(driveTypes).map(([n, t]) => [`ch${n}`, t]))
    : undefined,
});

const tracks: TimelineCharacterTrack[] = [
  track("Elizabeth", "#e05d7a",
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    { 1: 12, 2: 30, 3: 22, 4: 18, 5: 9, 6: 44, 7: 38, 8: 26, 9: 14, 10: 20, 11: 16, 12: 34, 13: 46, 14: 28 },
    { 6: 2, 13: 1 }, { 6: ["revelation", "confrontation"], 13: ["climax"] }),
  track("Darcy", "#5b7cfa",
    [2, 3, 4, 6, 7, 8, 12, 13, 14],
    { 2: 14, 3: 20, 4: 16, 6: 30, 7: 26, 8: 22, 12: 10, 13: 32, 14: 18 },
    { 6: 1, 13: 1 }, { 6: ["confrontation"], 13: ["revelation"] }),
  track("Jane", "#3aa981",
    [1, 2, 3, 4, 5, 9, 10, 11, 14],
    { 1: 8, 2: 16, 3: 10, 4: 20, 5: 12, 9: 9, 10: 6, 11: 10, 14: 12 },
    {}),
  track("Lady Catherine de Bourgh", "#b08a3e",
    [7, 12],
    { 7: 6, 12: 24 },
    { 12: 1 }, { 12: ["confrontation"] }),
  track("Wickham", "#8a63c9",
    [3, 4, 9, 10],
    { 3: 10, 4: 8, 9: 18, 10: 22 },
    { 10: 1 }),
];

document.body.style.margin = "0";

createRoot(document.getElementById("stage")!).render(
  <StrictMode>
    <TimelineGraphFull
      storyGraph={{ version: 1, entries }}
      chapters={chapters}
      characterTracks={tracks}
      insights={[]}
      currentChapterId="ch1"
      onSelectChapter={() => {}}
      onClose={() => {}}
    />
  </StrictMode>,
);

interface W extends Window { __probe?: () => Record<string, unknown> }
(window as W).__probe = () => {
  // The overlay's header renders icon svgs first — the chart is the svg that
  // actually contains the ledger header text.
  const svg = [...document.querySelectorAll("svg")].find((s) =>
    [...s.querySelectorAll("text")].some((t) => t.textContent === "CAST"),
  );
  if (!svg) return { error: "no svg containing the CAST ledger" };
  const texts = [...svg.querySelectorAll("text")].map((t) => t.textContent ?? "");
  // ★ SELECT ON MEANING, NOT ON PIXELS. These queries were written as
  //   rect[rx='1'] and width<5, so the first time the marks were RESIZED four
  //   gates went red while the component was perfectly correct. A visual gate
  //   keyed to a size cannot survive visual work, which is the only work it
  //   exists to check.
  const bars = [...svg.querySelectorAll("[data-cast-mark='presence']")];
  const heights = bars.map((b) => Number(b.getAttribute("height")));
  // Agency squares sit BELOW the baseline; the old diamonds floated above the
  // bars and moved with their height.
  const drives = [...svg.querySelectorAll("[data-cast-mark='drive']")];
  const driveColors = new Set(drives.map((r) => r.getAttribute("fill")));
  const rings = [...svg.querySelectorAll("[data-cast-mark='peak']")];
  const dashed = [...svg.querySelectorAll("line[stroke-dasharray='2,5']")];
  return {
    castHeader: texts.includes("CAST"),
    names: texts.filter((t) => ["Elizabeth", "Darcy", "Jane", "Wickham"].includes(t)),
    ellipsised: texts.find((t) => t.endsWith("…")) ?? null,
    barCount: bars.length,
    distinctHeights: new Set(heights.map((h) => h.toFixed(1))).size,
    driveCount: drives.length,
    driveColorCount: driveColors.size,
    peakRingCount: rings.length,
    legendTypes: texts.filter((t) =>
      ["climax", "confrontation", "revelation", "introduction"].includes(t)),
    diamondCount: [...svg.querySelectorAll("path")]
      .filter((el) => /l 3\.4,3\.4/.test(el.getAttribute("d") ?? "")).length,
    bridgeCount: dashed.length,
    statLines: texts.filter((t) => /ch ·|· drives |· away |· enters /.test(t)),
  };
};
