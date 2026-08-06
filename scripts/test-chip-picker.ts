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
  CHIP_TARGET_MIN,
  startsWithPronoun,
  labelIsGrounded,
  preservesOutcome,
  draftIsTrueOfSentence,
  buildChipRequest,
  chipKeyFor,
  decodeRichChipWire,
  eventFingerprint,
  normalizeChipPicks,
  parsePartialChipPicks,
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
  gate(good?.[0]?.rank === 0 && good[0].label === "Ovin admits the shortfall",
    "a clean pick passes through (then backfills to the target)", JSON.stringify(good));

  const outOfRange = pick({ picks: [{ rank: 9, label: "Somewhere else entirely" }, { rank: 1, label: "Rell refuses" }] });
  gate(outOfRange?.[0]?.rank === 1 && !outOfRange.some((p) => p.rank === 9),
    "a rank that was not offered is dropped", JSON.stringify(outOfRange));

  const dupe = pick({ picks: [{ rank: 3, label: "first" }, { rank: 3, label: "second" }] });
  gate(dupe?.[0]?.label === "first" && dupe.filter((p) => p.rank === 3).length === 1,
    "a repeated rank is deduped, first wins", JSON.stringify(dupe));

  const fractional = pick({ picks: [{ rank: 1.5, label: "half a rank" }] });
  gate(fractional?.length === 0, "a non-integer rank is dropped", JSON.stringify(fractional));

  const missingRank = pick({ picks: [{ label: "no rank at all" }] });
  gate(missingRank?.length === 0, "a pick with no rank is dropped", JSON.stringify(missingRank));

  const heuristic = CANDIDATES.find((c) => c.rank === 0)!.label;
  const blank = pick({ picks: [{ rank: 0, label: "   " }] });
  gate(blank?.[0]?.label === heuristic,
    "a blank label falls back to the heuristic one", `"${blank?.[0]?.label}"`);

  const tooLong = pick({ picks: [{ rank: 0, label: "x".repeat(CHIP_LABEL_MAX + 1) }] });
  gate(tooLong?.[0]?.label === heuristic,
    `a label over ${CHIP_LABEL_MAX} chars falls back`, `"${tooLong?.[0]?.label}"`);

  const atCap = pick({ picks: [{ rank: 0, label: "y".repeat(CHIP_LABEL_MAX) }] });
  gate(atCap?.[0]?.label === "y".repeat(CHIP_LABEL_MAX),
    `exactly ${CHIP_LABEL_MAX} chars is accepted`, `length ${atCap?.[0]?.label.length}`);

  const multiline = pick({ picks: [{ rank: 0, label: "Ovin admits\nthe count is short" }] });
  gate(multiline?.[0]?.label === heuristic,
    "a multi-line label falls back", `"${multiline?.[0]?.label}"`);

  const overflow = pick({ picks: [0, 1, 2, 3].map((rank) => ({ rank, label: `label ${rank}` })) });
  gate(overflow?.length === CHIP_PICK_CAP, `capped at ${CHIP_PICK_CAP} picks`,
    `4 offered → ${overflow?.length}`);

  const junk = pick({ picks: [null, 7, { rank: 2, label: "Rell opens the sluice" }] });
  gate(junk?.[0]?.rank === 2, "junk items are skipped, not fatal",
    JSON.stringify(junk));

  // ★★ THE COUNT CANNOT COLLAPSE. v1 let the model answer a five-moment
  //    chapter with a single chip; one chip cannot remind a writer what a
  //    chapter was. A short answer is topped up from the engine's own ranking,
  //    and the model's own picks keep their places at the front.
  const skimped = pick({ picks: [{ rank: 1, label: "Rell refuses the writ" }] });
  gate(
    skimped?.length === CHIP_TARGET_MIN &&
      skimped[0].rank === 1 && skimped[0].label === "Rell refuses the writ" &&
      new Set(skimped.map((p) => p.rank)).size === skimped.length,
    `one pick is backfilled to ${CHIP_TARGET_MIN}`,
    JSON.stringify(skimped),
  );
  gate(
    (skimped?.slice(1) ?? []).every(
      (p) => CANDIDATES.find((c) => c.rank === p.rank)?.label === p.label,
    ),
    "backfilled chips carry the engine's own labels",
    (skimped?.slice(1) ?? []).map((p) => `${p.rank}:"${p.label}"`).join(" "),
  );
  // Abstention stays a real answer: an empty list is the model judging that
  // nothing here turns, and there is nothing to top up from.
  gate(pick({ picks: [] })?.length === 0,
    "an empty answer is left empty", "silence is not padded");

  // ── pronouns ────────────────────────────────────────────────────────────
  // A chip is read with no sentence beside it, so "He admits the count" names
  // nobody. The engine already resolved the agent, so the fix is substitution,
  // not rejection — throwing the chip away would discard a correct selection
  // and a correct compression over one word.
  const WITH_AGENT: typeof CANDIDATES = CANDIDATES.map((c) =>
    c.rank === 0 ? { ...c, agent: "Ovin Marr" } : c);
  const pickAgent = (raw: unknown) => normalizeChipPicks(raw, WITH_AGENT);

  const heRepaired = pickAgent({ picks: [{ rank: 0, label: "He admits the count" }] });
  gate(heRepaired?.[0]?.label === "Ovin admits the count",
    "a leading pronoun is replaced with the resolved name",
    `"${heRepaired?.[0]?.label}"`);

  const possessive = pickAgent({ picks: [{ rank: 0, label: "His ledger is seized" }] });
  gate(possessive?.[0]?.label === "Ovin's ledger is seized",
    "a possessive pronoun becomes a possessive name",
    `"${possessive?.[0]?.label}"`);

  // Without a resolved agent there is nothing to substitute, so the chip must
  // fall back rather than ship a pronoun.
  const noAgent = pick({ picks: [{ rank: 0, label: "She burns the writ" }] });
  gate(noAgent?.[0]?.label === CANDIDATES.find((c) => c.rank === 0)!.label,
    "with no resolved agent, a pronoun chip falls back to the engine label",
    `"${noAgent?.[0]?.label}"`);

  gate(!startsWithPronoun("Ovin admits the count") && startsWithPronoun("They leave at dawn"),
    "the pronoun test is neither blind nor trigger-happy",
    "names pass, pronouns caught");

  // ── prompt leakage ──────────────────────────────────────────────────────
  // ★★ The worked examples in the prompt do not stay in the prompt: chips came
  //    back carrying the EXAMPLE'S names into unrelated chapters. No wording
  //    makes that impossible on a small model, so it is caught mechanically.
  const CAST = ENTRY.charactersPresent;
  const leaked = normalizeChipPicks(
    { picks: [{ rank: 0, label: "Sefa admits the well is dry" }] }, CANDIDATES, CAST);
  gate(leaked?.[0]?.label === CANDIDATES.find((c) => c.rank === 0)!.label,
    "a chip carrying a name from the PROMPT's example is rejected",
    `"${leaked?.[0]?.label}"`);

  const ownName = normalizeChipPicks(
    { picks: [{ rank: 0, label: "Ovin admits the count" }] }, CANDIDATES, CAST);
  gate(ownName?.[0]?.label === "Ovin admits the count",
    "a name from the chapter's own sentence passes",
    `"${ownName?.[0]?.label}"`);

  const castName = normalizeChipPicks(
    { picks: [{ rank: 0, label: "Sella hears the count" }] }, CANDIDATES, CAST);
  gate(castName?.[0]?.label === "Sella hears the count",
    "a name from the chapter's CAST passes even if not in that sentence",
    `"${castName?.[0]?.label}"`);

  // A sentence-initial common word is the sentence's own word, not a name.
  gate(labelIsGrounded("Kettle is filled twice",
    { rank: 9, label: "x", sentence: "The kettle was filled twice before anyone drank." }),
    "a capitalised common word from the sentence is not treated as a foreign name",
    "case-insensitive match");

  // ── meaning ─────────────────────────────────────────────────────────────
  // ★★ The defect that started this: "put the office seal in the fire" came
  //    back as "Marda seals the office" — the object used as a verb, the act
  //    inverted. These two guards are what no wording of the prompt fixed.

  const FAILS = "Ivo fails to reach the pier";
  gate(!preservesOutcome("Ivo tries to reach the pier", FAILS),
    "a rewrite that softens a FAILURE into an attempt is rejected",
    '"fails" → "tries"');
  gate(preservesOutcome("Ivo fails to reach the pier before dark", FAILS),
    "a rewrite that keeps the failure passes", "outcome carried");
  gate(preservesOutcome("Ivo does not reach the pier", FAILS),
    "plain negation counts as carrying the outcome", '"does not reach"');
  gate(preservesOutcome("Marda opens the shutters", "Marda opens the shutters"),
    "a draft with no outcome verb constrains nothing", "no false positives");

  // A draft is a heuristic and is sometimes wrong; when it is, it must not be
  // shown, or the model copies the engine's error into a shipped chip.
  gate(!draftIsTrueOfSentence("Teva burns the ledger",
    "She carried the ledger down to the water and let it go, and did not watch it sink."),
    "a draft naming an action the sentence lacks is not shown",
    '"burns" is nowhere in the sentence');
  gate(draftIsTrueOfSentence("Ivo fails to reach the pier",
    "Ivo Trace tried to reach the pier before the tide turned, and did not manage it."),
    "an OUTCOME verb the engine inferred is exempt from grounding",
    '"fails" is the engine\'s inference, not the prose');
  gate(draftIsTrueOfSentence("Marda opens the shutters",
    "Marda Kelp opened the shutters on the yard side and left them open all morning."),
    "an ordinary true draft is shown", "stem match");

  const softened = normalizeChipPicks(
    { picks: [{ rank: 0, label: "Ovin tries the count" }] },
    [{ rank: 0, label: "Ovin fails the count", sentence: "Ovin tried the count and did not finish it." }],
  );
  gate(softened?.[0]?.label === "Ovin fails the count",
    "end to end: a softened outcome falls back to the engine's own label",
    `"${softened?.[0]?.label}"`);
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

console.log("\n── 5 · the max-mode rich detail ────────────────────────────────");
{
  // The small path is BYTE-IDENTICAL to what was measured: no rich flag, no
  // detail anywhere in prompt or schema.
  const plain = buildChipRequest(ENTRY);
  gate(!JSON.stringify(plain.schema).includes("detail") && !plain.systemPrompt.includes("detail"), "without `rich`, prompt and schema carry no trace of the detail field", "");
  const rich = buildChipRequest(ENTRY, { rich: true });
  gate(JSON.stringify(rich.schema).includes("prefixItems") && rich.systemPrompt.includes("detail") && rich.systemPrompt.includes("WIRE FORMAT"),
    "with `rich`, the schema is the tuple wire and the prompt teaches both detail and wire", "");

  // ★ THE WIRE IS DECODED BEFORE ANY JUDGEMENT. Tuples map back to canonical
  //   picks (2-tuple = no detail), and anything that is not the wire shape
  //   passes through untouched so normalize stays the single judge.
  const decoded = decodeRichChipWire({ p: [[0, "Ovin fails the count", "before the bell"], [2, "Rell opens the sluice"]] }) as {
    picks: Array<{ rank: number; label: string; detail?: string }>;
  };
  gate(decoded.picks.length === 2 && decoded.picks[0].rank === 0 && decoded.picks[0].detail === "before the bell",
    "tuple wire decodes to canonical picks", `got ${JSON.stringify(decoded)}`);
  gate(!("detail" in decoded.picks[1]), "a 2-tuple decodes with no detail key", "");
  const passthru = { picks: [{ rank: 0, label: "x" }] };
  gate(decodeRichChipWire(passthru) === passthru, "non-wire shapes pass through untouched", "");

  // ★ THE STREAM PARSER RETURNS ONLY COMPLETE PICKS. Mid-generation text ends
  //   inside a tuple; the finished ones surface, the torn one waits.
  const streamCands: ChipCandidate[] = [
    { rank: 0, label: "a", sentence: "s", agent: "Ovin" },
    { rank: 2, label: "b", sentence: "s", agent: "Rell" },
  ];
  const partialTuple = parsePartialChipPicks(
    '{ "p": [ [0, "Ovin fails the count", "before the bell"], [2, "She opens the slu',
    streamCands, true);
  gate(partialTuple.length === 1 && partialTuple[0].rank === 0 && partialTuple[0].detail === "before the bell",
    "tuple stream: complete picks surface, the torn one waits", `got ${JSON.stringify(partialTuple)}`);
  const partialKeyed = parsePartialChipPicks(
    '{\n "picks": [\n  {"rank": 2, "label": "She opens the sluice"},\n  {"rank": 0, "label": "Ovin fa',
    streamCands, false);
  gate(partialKeyed.length === 1 && partialKeyed[0].rank === 2 && partialKeyed[0].label.startsWith("Rell"),
    "keyed stream: complete pick surfaces with the pronoun repaired", `got ${JSON.stringify(partialKeyed)}`);

  const cands = rich.candidates;
  const r0 = cands[0].rank;
  // A deterministic candidate whose detail obeys every rule: grounded (three
  // shared content words), ends on a noun, differs from the label.
  const inline = [{ rank: 0, label: "Ovin fails the count",
    sentence: "Ovin tried the count and did not finish it before the bell.", agent: "Ovin" }];
  const words = "Ovin did not finish the count";
  const good = normalizeChipPicks(
    { picks: [{ rank: 0, label: "Ovin fails the count", detail: words }] }, inline, [], undefined);
  gate(good?.[0]?.detail === words, "a grounded detail (words from the sentence) rides the pick",
    `got ${JSON.stringify(good?.[0])}`);

  const drift = normalizeChipPicks(
    { picks: [{ rank: r0, label: cands[0].label, detail: "meanwhile aboard the orbital station everything changed forever" }] },
    cands, [], undefined);
  gate(!!drift && drift[0] && !("detail" in drift[0] && drift[0].detail), "★ an ungrounded detail is DROPPED — and the pick survives without it", "");

  // ★★ FRAGMENT SHAPES THE LABEL RULES USED TO KILL (probe-chip-max.cjs):
  //    a plural-noun fragment is not a dangling verb, and a tense shift is
  //    not an invention. Both were good details the 4B actually wrote.
  const inline2 = [{ rank: 0, label: "Ferren admits the count is short",
    sentence: "Ferren Ash told the room that the count had been short for eleven years, and that she had signed every page of it.", agent: "Ferren Ash" }];
  const plural = normalizeChipPicks(
    { picks: [{ rank: 0, label: "Ferren admits the count is short", detail: "eleven years" }] }, inline2, [], undefined);
  gate(plural?.[0]?.detail === "eleven years", "★ a plural-noun fragment survives (not read as a dangling verb)",
    `got ${JSON.stringify(plural?.[0])}`);
  const inline3 = [{ rank: 0, label: "Marda melts the office seal",
    sentence: "Marda put the office seal in the fire and the wax ran off the iron.", agent: "Marda" }];
  const tense = normalizeChipPicks(
    { picks: [{ rank: 0, label: "Marda melts the office seal", detail: "wax runs off iron" }] }, inline3, [], undefined);
  gate(tense?.[0]?.detail === "wax runs off iron", "★ one inflection-shifted word is allowed when the rest is grounded",
    `got ${JSON.stringify(tense?.[0])}`);
  const dangle = normalizeChipPicks(
    { picks: [{ rank: 0, label: "Marda melts the office seal", detail: "melted when the seal was" }] }, inline3, [], undefined);
  gate(!!dangle && !dangle[0]?.detail, "…but a genuinely dangling auxiliary still rejects the detail", "");

  const multi = normalizeChipPicks(
    { picks: [{ rank: r0, label: cands[0].label, detail: "line one\nline two" }] }, cands, [], undefined);
  gate(!!multi && !multi[0]?.detail, "a multi-line detail is dropped, pick kept", "");

  // display attach: selectDisplayChips carries the detail as lmDetail
  const shown = selectDisplayChips({ majorEvents: ENTRY.majorEvents,
    lmChips: [{ rank: r0, label: "Marda burns the seal", detail: words }] });
  gate((shown[0] as { lmDetail?: string }).lmDetail === words, "selectDisplayChips attaches the detail as lmDetail for the timeline", "");
  const shownPlain = selectDisplayChips({ majorEvents: ENTRY.majorEvents,
    lmChips: [{ rank: r0, label: "Marda burns the seal" }] });
  gate(!("lmDetail" in (shownPlain[0] as object)), "…and a pick without detail attaches nothing", "");
}

console.log("\n── the prompt one chapter actually sends ───────────────────────\n");
console.log(buildChipRequest(ENTRY).userText.split("\n").map((l) => `  ${l}`).join("\n"));

console.log(`\n${failures === 0 ? "✓ ALL GATES GREEN" : `✗ ${failures} GATE(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
