/**
 * test-chip-picker.ts — the chip task's PURE gates. No model, no Electron.
 *
 * The live harness (scripts/verify-assistant-tasks.cjs) measures what the model
 * answers. This measures what the code does with any answer, and it is the half
 * that has to hold when the model is unavailable, slow, or wrong:
 *
 *   1. VALIDATION   normalizeChipPicks repairs per pick and fails whole-response
 *                   only; abstention survives as [] and never as null.
 *   2. KEY          chipKeyFor moves when the events move under a contentHash
 *                   that cannot see it — the reason the fingerprint exists.
 *   3. IDENTITY     with no picks, selectDisplayChips returns the SAME OBJECTS
 *                   selectTimelineChips returns, in the same order. That is the
 *                   regression bar for every display consumer.
 *   4. OVERRIDE     with picks it resolves rank → event, overrides the label for
 *                   display only, drops ranks that vanished, and never blanks a
 *                   chapter.
 *
 *   /opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs scripts/test-chip-picker.ts
 */
import {
  CHIP_LABEL_MAX,
  CHIP_PICK_CAP,
  buildChipRequest,
  chipKeyFor,
  eventFingerprint,
  normalizeChipPicks,
  type ChipCandidate,
} from "../src/lib/chip-picker";
import { selectDisplayChips, selectTimelineChips } from "../src/lib/narrative-events";
import type { ChapterGraphEntry, MajorEvent, TimelineChipPick } from "../src/types";

let failures = 0;
const gate = (ok: boolean, label: string, detail: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label} — ${detail}`);
  if (!ok) failures++;
};

// ── fixture ───────────────────────────────────────────────────────────────
// Fabricated throughout, same discipline as the live fixtures.

const event = (over: Partial<MajorEvent> & { label: string; rank: number; tensionPosition: number }): MajorEvent => ({
  type: "transition",
  confidence: 0.5,
  sentence: `${over.label}, verbatim.`,
  narrativeType: "action",
  salience: "major",
  channel: "narration",
  ...over,
});

const EVENTS: MajorEvent[] = [
  event({ label: "Rell opens the sluice", rank: 2, tensionPosition: 0.10, paragraphIndex: 1 }),
  event({ label: "Ovin admits the count is short", rank: 0, tensionPosition: 0.45, paragraphIndex: 7 }),
  event({ label: "Rell refuses the second writ", rank: 1, tensionPosition: 0.72, paragraphIndex: 12 }),
  event({ label: "The bell is answered", rank: 3, tensionPosition: 0.90, paragraphIndex: 18 }),
];

const entryOf = (events: MajorEvent[], over: Partial<ChapterGraphEntry> = {}): ChapterGraphEntry => ({
  chapterId: "ch-4",
  chapterNumber: 4,
  chapterTitle: "The Weight of Water",
  role: "rising",
  tensionPeak: 0.81,
  tensionCurve: [0.1, 0.2, 0.3, 0.5, 0.6, 0.8, 0.7, 0.5],
  charactersPresent: ["Rell", "Ovin", "Sella"],
  wordCount: 2400,
  proseRegister: "measured",
  majorEvents: events,
  lastUpdated: 0,
  contentHash: "2400|The lock-keeper's house stood where the two cuts met, and",
  ...over,
});

const ENTRY = entryOf(EVENTS);
const CANDIDATES: ChipCandidate[] = buildChipRequest(ENTRY).candidates;

console.log("\n── 1. normalizeChipPicks ───────────────────────────────────────");
{
  const pick = (raw: unknown) => normalizeChipPicks(raw, CANDIDATES);

  gate(pick(null) === null, "null response", "→ null (caller keeps heuristics)");
  gate(pick("picks: 0") === null, "non-object response", "→ null");
  gate(pick({}) === null, "no picks key", "→ null");
  gate(pick({ picks: "0,1" }) === null, "picks is not an array", "→ null");

  const empty = pick({ picks: [] });
  gate(Array.isArray(empty) && empty.length === 0, "abstention",
    `{"picks":[]} → ${JSON.stringify(empty)} (an answer, never null)`);

  const good = pick({ picks: [{ rank: 0, label: "Ovin admits the shortfall" }] });
  gate(good?.length === 1 && good[0].label === "Ovin admits the shortfall",
    "a clean pick passes through", JSON.stringify(good));

  const outOfRange = pick({ picks: [{ rank: 9, label: "Somewhere else entirely" }, { rank: 1, label: "Rell refuses" }] });
  gate(outOfRange?.length === 1 && outOfRange[0].rank === 1,
    "a rank that was not offered is dropped", JSON.stringify(outOfRange));

  const dupe = pick({ picks: [{ rank: 1, label: "first" }, { rank: 1, label: "second" }] });
  gate(dupe?.length === 1 && dupe[0].label === "first",
    "a repeated rank is deduped, first wins", JSON.stringify(dupe));

  const fractional = pick({ picks: [{ rank: 1.5, label: "half a rank" }] });
  gate(fractional?.length === 0, "a non-integer rank is dropped", JSON.stringify(fractional));

  const missingRank = pick({ picks: [{ label: "no rank at all" }] });
  gate(missingRank?.length === 0, "a pick with no rank is dropped", JSON.stringify(missingRank));

  const heuristic = CANDIDATES.find((c) => c.rank === 0)!.label;
  const blank = pick({ picks: [{ rank: 0, label: "   " }] });
  gate(blank?.length === 1 && blank[0].label === heuristic,
    "a blank label falls back to the heuristic one", `"${blank?.[0]?.label}"`);

  const tooLong = pick({ picks: [{ rank: 0, label: "x".repeat(CHIP_LABEL_MAX + 1) }] });
  gate(tooLong?.length === 1 && tooLong[0].label === heuristic,
    `a label over ${CHIP_LABEL_MAX} chars falls back`, `"${tooLong?.[0]?.label}"`);

  const atCap = pick({ picks: [{ rank: 0, label: "y".repeat(CHIP_LABEL_MAX) }] });
  gate(atCap?.length === 1 && atCap[0].label === "y".repeat(CHIP_LABEL_MAX),
    `exactly ${CHIP_LABEL_MAX} chars is accepted`, `length ${atCap?.[0]?.label.length}`);

  const multiline = pick({ picks: [{ rank: 0, label: "Ovin admits\nthe count is short" }] });
  gate(multiline?.length === 1 && multiline[0].label === heuristic,
    "a multi-line label falls back", `"${multiline?.[0]?.label}"`);

  const overflow = pick({ picks: [0, 1, 2, 3].map((rank) => ({ rank, label: `label ${rank}` })) });
  gate(overflow?.length === CHIP_PICK_CAP, `capped at ${CHIP_PICK_CAP} picks`,
    `4 offered → ${overflow?.length}`);

  const junk = pick({ picks: [null, 7, { rank: 2, label: "Rell opens the sluice" }] });
  gate(junk?.length === 1 && junk[0].rank === 2, "junk items are skipped, not fatal",
    JSON.stringify(junk));
}

console.log("\n── 2. buildChipRequest ─────────────────────────────────────────");
{
  const req = buildChipRequest(ENTRY);
  gate(req.candidates.map((c) => c.rank).join(",") === "0,1,2,3",
    "candidates are offered in rank order", req.candidates.map((c) => c.rank).join(","));
  gate(req.candidates.every((c) => req.userText.includes(`[${c.rank}] `)),
    "each candidate is numbered by its RANK in the prompt",
    req.userText.split("\n").filter((l) => l.startsWith("[")).join(" / "));

  // An event with no sentence has nothing for the label to be grounded in.
  const sentenceless = entryOf([
    event({ label: "Rell opens the sluice", rank: 0, tensionPosition: 0.1 }),
    { ...event({ label: "Legacy record", rank: 1, tensionPosition: 0.5 }), sentence: undefined },
  ]);
  const partial = buildChipRequest(sentenceless);
  gate(partial.candidates.length === 1 && partial.candidates[0].rank === 0,
    "events with no sentence are not offered", `${partial.candidates.length} candidate(s)`);

  const capped = buildChipRequest(
    entryOf(Array.from({ length: 20 }, (_, i) =>
      event({ label: `Beat ${i}`, rank: i, tensionPosition: i / 20 }))),
  );
  gate(capped.candidates.length === 8, "candidate list is capped at 8",
    `20 events → ${capped.candidates.length}`);

  const none = buildChipRequest(entryOf([]));
  gate(none.candidates.length === 0, "an empty chapter offers nothing",
    "runChipPick returns null before spending an inference");
}

console.log("\n── 3. chipKeyFor ───────────────────────────────────────────────");
{
  const key = chipKeyFor(ENTRY, "qwen3-1.7b-q4_k_m");
  gate(key === chipKeyFor(entryOf([...EVENTS]), "qwen3-1.7b-q4_k_m"),
    "stable across identical entries", key);
  gate(key !== chipKeyFor(ENTRY, "some-other-model"),
    "moves with the model id", `${key} vs ${chipKeyFor(ENTRY, "some-other-model")}`);
  gate(key !== chipKeyFor(entryOf(EVENTS, { contentHash: "2401|different prose" }), "qwen3-1.7b-q4_k_m"),
    "moves with the content hash", "different chapter text → different key");

  // ★ THE POINT OF THE FINGERPRINT. contentHash is `length|first 60 chars`, so
  //   a re-ranking engine leaves it byte-identical while every stored pick now
  //   names a different event.
  const reranked = EVENTS.map((e) => ({ ...e, rank: (e.rank! + 1) % EVENTS.length }));
  gate(key !== chipKeyFor(entryOf(reranked), "qwen3-1.7b-q4_k_m"),
    "moves when the events are RE-RANKED under an unchanged contentHash",
    "engine drift invalidates the picks");

  const resentenced = EVENTS.map((e, i) => (i === 1 ? { ...e, sentence: "A different clause entirely." } : e));
  gate(key !== chipKeyFor(entryOf(resentenced), "qwen3-1.7b-q4_k_m"),
    "moves when a candidate's sentence changes", "the offered evidence changed");

  // Reading order is not evidence: the fingerprint is taken rank-ordered, so a
  // reshuffled array with the same rank→sentence pairs is the same question.
  const shuffled = [EVENTS[3], EVENTS[0], EVENTS[2], EVENTS[1]];
  gate(eventFingerprint(EVENTS) === eventFingerprint(shuffled),
    "array order alone does not move the fingerprint", eventFingerprint(EVENTS));
}

console.log("\n── 4. selectDisplayChips: fallback identity ────────────────────");
{
  const sameObjects = (a: readonly unknown[], b: readonly unknown[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);

  const base = selectTimelineChips(EVENTS);
  gate(sameObjects(selectDisplayChips(ENTRY), base),
    "no lmChips → object-for-object identical to selectTimelineChips",
    base.map((e) => e.label).join(" | "));

  gate(sameObjects(selectDisplayChips({ ...ENTRY, lmChips: [] }), base),
    "empty lmChips → identical (abstention never blanks the timeline)",
    "heuristic chips stand");

  gate(selectDisplayChips(undefined).length === 0 && selectDisplayChips(null).length === 0,
    "an unanalysed chapter selects nothing", "[] for null/undefined");

  // Pre-rank stored entries: array order IS the rank, on both paths.
  const preRank = EVENTS.map((e) => ({ ...e, rank: undefined }));
  gate(sameObjects(selectDisplayChips(entryOf(preRank)), selectTimelineChips(preRank)),
    "pre-rank entries fall back to array order identically",
    selectTimelineChips(preRank).map((e) => e.label).join(" | "));

  const budgeted = selectDisplayChips(ENTRY, 2);
  gate(sameObjects(budgeted, selectTimelineChips(EVENTS, 2)), "budget is honoured on the fallback path",
    budgeted.map((e) => e.label).join(" | "));
}

console.log("\n── 5. selectDisplayChips: the lm path ──────────────────────────");
{
  const picks: TimelineChipPick[] = [
    { rank: 3, label: "Sella answers the night bell" },
    { rank: 0, label: "Ovin admits the shortfall" },
  ];
  const shown = selectDisplayChips({ ...ENTRY, lmChips: picks });
  gate(shown.map((e) => e.label).join(" | ") === "Ovin admits the shortfall | Sella answers the night bell",
    "picks are drawn in READING order, not answer order",
    shown.map((e) => `${e.tensionPosition} ${e.label}`).join(" | "));

  const promoted = shown.find((e) => e.label === "Sella answers the night bell")!;
  const original = EVENTS.find((e) => e.rank === 3)!;
  gate(promoted.paragraphIndex === original.paragraphIndex && promoted.sentence === original.sentence,
    "the label overrides for DISPLAY only — every other field survives",
    `¶${promoted.paragraphIndex}, sentence intact`);
  gate(original.label === "The bell is answered",
    "the stored event is never mutated", `"${original.label}"`);

  const partial = selectDisplayChips({ ...ENTRY, lmChips: [{ rank: 99, label: "gone" }, { rank: 1, label: "Rell tears up the writ" }] });
  gate(partial.length === 1 && partial[0].label === "Rell tears up the writ",
    "a rank that no longer resolves is dropped", JSON.stringify(partial.map((e) => e.label)));

  const stale = selectDisplayChips({ ...ENTRY, lmChips: [{ rank: 40, label: "a" }, { rank: 41, label: "b" }] });
  gate(stale.map((e) => e.label).join(" | ") === selectTimelineChips(EVENTS).map((e) => e.label).join(" | "),
    "picks that ALL fail to resolve fall back rather than blank the chapter",
    stale.map((e) => e.label).join(" | "));

  const over = selectDisplayChips({ ...ENTRY, lmChips: [{ rank: 0, label: "a" }, { rank: 1, label: "b" }, { rank: 2, label: "c" }] }, 2);
  gate(over.length === 2, "budget caps the lm path too", `3 picks, budget 2 → ${over.length}`);

  const blankLabel = selectDisplayChips({ ...ENTRY, lmChips: [{ rank: 0, label: "" }] });
  gate(blankLabel.length === 1 && blankLabel[0] === EVENTS.find((e) => e.rank === 0),
    "an empty label keeps the heuristic one AND the original object",
    `"${blankLabel[0]?.label}"`);
}

console.log("\n── the prompt one chapter actually sends ───────────────────────\n");
console.log(buildChipRequest(ENTRY).userText.split("\n").map((l) => `  ${l}`).join("\n"));

console.log(`\n${failures === 0 ? "✓ ALL GATES GREEN" : `✗ ${failures} GATE(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
