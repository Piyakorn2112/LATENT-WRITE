/**
 * verify-lane-keys.ts — the contract for the timeline lane's cache keys.
 *
 * The lane is the chip picker and the chapter summary. Both cache their answer
 * under a key, and the key decides how much inference the app does: a key that
 * moves when the prompt did not is a whole inference spent re-deriving an
 * answer the model already gave, and a key that stays when the prompt DID move
 * is a stale answer shown to the writer.
 *
 * So the key must be a function of exactly what can change the answer:
 *   · the bytes the model is shown (system prompt + user turn)
 *   · the material the VALIDATORS use that the prompt does not carry — a
 *     candidate's heuristic label (the fallback, and the outcome check) and
 *     the full cast (the grounding check)
 *   · the model, and the prompt version
 * and of nothing else. `${length}|${first 60 chars}` is neither.
 *
 * Every gate below is a property of that definition, tested in both
 * directions: what must move the key, and what must not.
 *
 *   ./node_modules/.bin/tsx scripts/verify-lane-keys.ts
 */
import { chipKeyFor, buildChipRequest } from "../src/lib/chip-picker";
import { summaryKeyFor, buildSummaryRequest } from "../src/lib/chapter-summary";
import type { ChapterGraphEntry, MajorEvent } from "../src/types";

let pass = 0, fail = 0;
const gate = (ok: boolean, label: string, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ""}`); }
};

const MODEL = "qwen3-1.7b-q4_k_m";

const EVENTS: MajorEvent[] = [
  {
    rank: 1, label: "Ferren admits the count is short", type: "action", channel: "action",
    agent: "Ferren Ash", tensionPosition: 0.1,
    sentence: "Ferren Ash told the room that the count had been short for eleven years, and that she had signed every page of it.",
  },
  {
    rank: 2, label: "Marda burns the seal", type: "action", channel: "action",
    agent: "Marda Kelp", tensionPosition: 0.5,
    sentence: "Marda Kelp put the office seal in the fire and held it there until the wax ran off the iron.",
  },
  {
    rank: 3, label: "Wick resigns his post", type: "action", channel: "action",
    agent: "Wick Odlum", tensionPosition: 0.9,
    sentence: "Wick Odlum resigned his post before the second bell, in writing, and gave no reason for it.",
  },
] as unknown as MajorEvent[];

const BASE: ChapterGraphEntry = {
  chapterId: "ch-7", chapterNumber: 7, chapterTitle: "The Long Count",
  contentHash: "4820|The office had been quiet since the second bell, and the",
  tensionPeak: 0.82,
  charactersPresent: ["Ferren Ash", "Wick Odlum", "Marda Kelp"],
  majorEvents: EVENTS,
} as unknown as ChapterGraphEntry;

/** A fresh object every time: the key must not depend on object identity. */
const clone = (patch: Partial<ChapterGraphEntry> = {}): ChapterGraphEntry =>
  ({ ...BASE, majorEvents: BASE.majorEvents.map((e) => ({ ...e })), ...patch }) as ChapterGraphEntry;

const withEvent = (index: number, patch: Partial<MajorEvent>): ChapterGraphEntry => {
  const events = BASE.majorEvents.map((e) => ({ ...e }));
  events[index] = { ...events[index], ...patch } as MajorEvent;
  return clone({ majorEvents: events });
};

const chip = (e: ChapterGraphEntry, rich = false) => chipKeyFor(e, MODEL, { rich });
const summ = (e: ChapterGraphEntry) => summaryKeyFor(e, MODEL);

console.log("\ntimeline lane — cache key contract\n");

// ── 1. stable ─────────────────────────────────────────────────────────────
gate(chip(clone()) === chip(clone()), "chip key is stable across equal entries");
gate(summ(clone()) === summ(clone()), "summary key is stable across equal entries");
gate(chip(clone()) !== summ(clone()), "the two tasks never share a key");

// ── 2. THE WIN: content that the prompt does not carry must not move it ───
//
// Every one of these is a real writing action that today forces two full
// inferences whose prompts are byte-identical to the ones already answered.
const bytesUnchanged: Array<[string, ChapterGraphEntry]> = [
  ["a word added elsewhere in the chapter (length changed)",
    clone({ contentHash: "4827|The office had been quiet since the second bell, and the" })],
  ["the opening line reworded (first 60 chars changed)",
    clone({ contentHash: "4820|The office was quiet after the second bell, and the light" })],
  ["a trailing space",
    clone({ contentHash: "4821|The office had been quiet since the second bell, and the" })],
];
for (const [what, entry] of bytesUnchanged) {
  const c = buildChipRequest(entry);
  const b = buildChipRequest(clone());
  gate(c.userText === b.userText && c.systemPrompt === b.systemPrompt,
    `precondition: ${what} leaves the chip prompt byte-identical`);
  gate(chip(entry) === chip(clone()), `chip key survives: ${what}`);
  gate(summ(entry) === summ(clone()), `summary key survives: ${what}`);
}

// ── 3. anything the model or the validators can see MUST move it ──────────
const mustMoveChip: Array<[string, ChapterGraphEntry]> = [
  ["an event's sentence rewritten", withEvent(1, { sentence: "Marda Kelp carried the office seal down to the water and let it go." })],
  ["an event's rank changed", withEvent(2, { rank: 9 })],
  ["an event's resolved agent changed", withEvent(0, { agent: "Ferren Ashe" })],
  ["an event's heuristic draft changed", withEvent(1, { label: "Marda destroys the seal" })],
  ["an event's narrative type changed", withEvent(0, { narrativeType: "revelation" } as Partial<MajorEvent>)],
  ["an event's position in the chapter changed", withEvent(0, { tensionPosition: 0.44 })],
  ["an event dropped", clone({ majorEvents: BASE.majorEvents.slice(0, 2) })],
  ["the chapter title changed", clone({ chapterTitle: "The Short Count" })],
  ["the chapter number changed", clone({ chapterNumber: 8 })],
  ["the tension peak changed", clone({ tensionPeak: 0.4 })],
  ["the cast changed", clone({ charactersPresent: ["Ferren Ash", "Wick Odlum"] })],
];
for (const [what, entry] of mustMoveChip) {
  gate(chip(entry) !== chip(clone()), `chip key moves: ${what}`);
}
// ★ THE HOLE IN THE OLD KEY. `${length}|${first 60}` plus a fingerprint of
//   (rank, sentence) cannot see a changed agent or a changed draft — and both
//   change the answer: the agent is printed as "who" and substituted for a
//   leading pronoun, the draft is printed as "draft" and is the fallback label.
gate(chip(withEvent(0, { agent: "Ferren Ashe" })) !== chip(clone())
  && chip(withEvent(1, { label: "Marda destroys the seal" })) !== chip(clone()),
  "chip key closes the agent/draft hole the content hash could not see");

const mustMoveSummary: Array<[string, ChapterGraphEntry]> = [
  ["an event's sentence rewritten", withEvent(1, { sentence: "Marda Kelp carried the office seal down to the water and let it go." })],
  ["a re-rank that reorders the moments", withEvent(2, { rank: 0 })],
  ["the chapter title changed", clone({ chapterTitle: "The Short Count" })],
  ["the tension peak changed", clone({ tensionPeak: 0.4 })],
  ["the cast changed", clone({ charactersPresent: ["Ferren Ash"] })],
  ["an event dropped", clone({ majorEvents: BASE.majorEvents.slice(0, 2) })],
];
for (const [what, entry] of mustMoveSummary) {
  gate(summ(entry) !== summ(clone()), `summary key moves: ${what}`);
}
// ★ AND THE MIRROR CASE, which is a win rather than an oversight: the summary
//   prompt lists the moments in rank ORDER and never prints a rank, so a
//   re-rank that leaves the order alone cannot change the answer. The CHIP
//   prompt does print ranks (the model answers with them), so the same edit
//   must move the chip key. One engine change, two correct verdicts.
gate(summ(withEvent(2, { rank: 9 })) === summ(clone()),
  "summary key ignores a re-rank that does not reorder (the chip key does not)");
gate(chip(withEvent(2, { rank: 9 })) !== chip(clone()),
  "chip key moves on the same re-rank, because it prints the rank");

// ── 4. tier and mode ──────────────────────────────────────────────────────
gate(chip(clone(), true) !== chip(clone(), false),
  "chip key separates max mode's richer prompt from the small one");
gate(chipKeyFor(clone(), "qwen3-4b-thinking-2507-q4_k_m") !== chip(clone()),
  "chip key separates models");
gate(summaryKeyFor(clone(), "qwen3-4b-thinking-2507-q4_k_m") !== summ(clone()),
  "summary key separates models");

// ── 5. the key IS the prompt: equal prompts, equal keys ───────────────────
//
// Stated as a property rather than a case list, so a future prompt edit that
// starts reading a new field cannot silently fall outside the key.
{
  const a = clone({ contentHash: "1|x" });
  const b = clone({ contentHash: "999999|completely different opening sixty characters here ok" });
  const ra = buildChipRequest(a), rb = buildChipRequest(b);
  const sa = buildSummaryRequest(a), sb = buildSummaryRequest(b);
  gate(ra.systemPrompt + ra.userText === rb.systemPrompt + rb.userText
    && chip(a) === chip(b), "equal chip prompts ⇒ equal chip keys");
  gate(sa.systemPrompt + sa.userText === sb.systemPrompt + sb.userText
    && summ(a) === summ(b), "equal summary prompts ⇒ equal summary keys");
}

// ── 6. cost: the key is computed on every tick over every chapter ─────────
{
  const entries = Array.from({ length: 200 }, (_, i) =>
    clone({ chapterId: `ch-${i}`, chapterNumber: i + 1 }));
  const t0 = performance.now();
  for (let round = 0; round < 5; round++) for (const e of entries) { chip(e); summ(e); }
  const ms = performance.now() - t0;
  gate(ms < 250, `1000 key computations over 200 chapters cost ${ms.toFixed(0)}ms (memoised on entry identity)`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
