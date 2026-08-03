/**
 * test-assist-reviews.ts — wave-2's PURE gates. No model, no Electron.
 *
 * The live harness (scripts/verify-assistant-tasks.cjs) measures what the model
 * answers. This measures what the code does with any answer, which is the half
 * that has to hold when the model is unavailable, slow, or wrong. For each of
 * the three tasks:
 *
 *   1. RANKING     the budget goes to the right candidate first, and only to
 *                  candidates that are genuinely questions.
 *   2. CAP         the per-chapter budget holds, whatever the prose does.
 *   3. OFFERED     a value outside the offered set is dropped, never coerced.
 *   4. FLOOR       an answer below the confidence floor changes nothing.
 *   5. ABSTENTION  "unsure" / "none" / "furniture" surface nothing and are
 *                  never turned into a fabricated answer.
 *   6. KEY         the cache key is stable for identical input and moves with
 *                  content, model id, and the offered set.
 *
 * ★ EVERY NAME IS FABRICATED. Nothing here is a real book, person or place: a
 *   gate that passed on a remembered world would be measuring the model's
 *   memory instead of this code.
 *
 *   /opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs scripts/test-assist-reviews.ts
 */
import {
  ATTRIBUTION_CAP,
  ATTRIBUTION_MIN_CONFIDENCE,
  ATTRIBUTION_TASK,
  UNSURE_HI,
  UNSURE_LO,
  ambiguityOf,
  attributionKeyFor,
  buildAttributionRequest,
  normalizeAttribution,
  offeredSpeakers,
  recentSpeakers,
  runAttributionReview,
  selectAttributionCandidates,
  type AttributionReviewInput,
  type AttributionSpan,
} from "../src/lib/attribution-review";
import {
  CHEKHOV_CAP,
  CHEKHOV_MIN_CONFIDENCE,
  CHEKHOV_TASK,
  buildChekhovRequest,
  chekhovKeyFor,
  isSurfacedChekhov,
  normalizeChekhov,
  runChekhovReview,
  selectChekhovCandidates,
  type ChekhovReviewCandidate,
} from "../src/lib/chekhov-review";
import {
  SCENE_CAP,
  SCENE_FLOOR,
  SCENE_MIN_CONFIDENCE,
  SCENE_NONE,
  SCENE_TASK,
  SCENE_TEXT_BUDGET,
  buildSceneRequest,
  floorShortfall,
  isNearMiss,
  normalizeSceneLabel,
  offeredLabels,
  runSceneReview,
  sceneExcerpt,
  sceneKeyFor,
  selectSceneCandidates,
  type SceneReviewCandidate,
} from "../src/lib/scene-review";
import type { AssistantJSONRequest, AssistantJSONRunner } from "../src/lib/assistant-client";

let failures = 0;
const gate = (ok: boolean, label: string, detail: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label} — ${detail}`);
  if (!ok) failures++;
};

const MODEL = "qwen3-1.7b-q4_k_m";
const HASH = "3100|The yard office kept two ledgers and had done for as lon";

/** A runner that answers with one fixed JSON body and records what it was sent. */
function stubRunner(
  json: unknown,
  seen: AssistantJSONRequest[] = [],
  ok = true,
): AssistantJSONRunner {
  return (async (req: AssistantJSONRequest) => {
    seen.push(req);
    return ok
      ? { ok: true, json, modelId: MODEL, timings: null }
      : { ok: false, reason: "run-failed" };
  }) as AssistantJSONRunner;
}

// ══ 1 · attribution ═══════════════════════════════════════════════════════
//
// A fabricated chapter of dialogue. Every span the engine settled sits outside
// the unsure band; the four inside it are deliberately spread so that ambiguity
// and material weight disagree, and only the ranking can pick between them.

const LONG_PARA =
  "The tally book had been open on the sill since the middle of the afternoon and nobody had " +
  "written a line in it, which was the first thing anyone noticed and the last thing anyone " +
  "was willing to mention out loud in that room. The lamp had been trimmed twice. The kettle " +
  "had gone cold on the stove and been carried back to the water butt and filled again, and " +
  "the whole business had taken long enough that the light off the yard had changed colour. " +
  "Marda Kelp put the tally book down where the others could see it.";

const PARAGRAPHS = [
  "Ilm Vance came up the stair with the satchel still buckled and did not put it down.",
  "The office had been quiet since the first bell and stayed quiet after he came in.",
  "Marda Kelp read the top page twice and said nothing anyone could hear.",
  "Outside, the yard filled and emptied and filled again with the ordinary traffic of a Tuesday.",
  "Ferren Ash came in from the weighing floor with her sleeves still rolled.",
  LONG_PARA,
  "Nobody moved for a moment after that.",
  "The answer came flat and without any particular weight behind it.",
  "The clock on the landing ran a minute fast and always had.",
  "Wick Odlum stopped in the doorway with his hat in both hands.",
  "The lamp guttered and somebody put a hand up to shield it.",
  "The tally book was still open on the sill and still nobody had written in it.",
  "The yard bell went for the second time.",
  "Whatever had been agreed a moment earlier was plainly not agreed any longer.",
];

const span = (over: AttributionSpan): AttributionSpan => over;

const SPANS: AttributionSpan[] = [
  // Opens the chapter with nothing before it and no engine candidates, so the
  // offered set never reaches two names. Not a tie-break: there is nothing to
  // choose between, and confirming the engine's own guess writes nothing.
  span({
    paragraphIndex: 0, spanIndex: 0, speaker: "Ilm Vance", confidence: 0.5,
    quote: "“The count is short and it has been short since the thaw, whatever the book says.”",
  }),
  // Attested — above ATTESTED_FLOOR, so never asked about.
  span({
    paragraphIndex: 2, spanIndex: 0, speaker: "Marda Kelp", confidence: 0.92,
    quote: "“Read me the third column and read it slowly.”",
  }),
  span({
    paragraphIndex: 4, spanIndex: 0, speaker: "Ferren Ash", confidence: 0.88,
    quote: "“I have been on the floor since six and I have not eaten.”",
  }),
  // ★ THE ONE THE BUDGET SHOULD BUY: dead centre of the unsure band, a long
  //   line, and a speaker who holds a third of the chapter's dialogue.
  span({
    paragraphIndex: 6, spanIndex: 0, speaker: "Marda Kelp", confidence: 0.51,
    candidates: ["Ferren Ash"],
    quote:
      "“Somebody carried that book down to the weighing floor and back again this morning, " +
      "and I would like to know who thought that was worth doing.”",
  }),
  // Same material, but the engine is nearly certain it is unattributed — the
  // edge of the band is closer to an answer than the middle of it.
  span({
    paragraphIndex: 7, spanIndex: 0, speaker: "Ferren Ash", confidence: 0.3,
    candidates: ["Marda Kelp"],
    quote:
      "“It was down there when I came up and I did not carry it, and I am not going to " +
      "stand here and be asked about it twice.”",
  }),
  // Ambiguous, but three words in the mouth of a speaker with one line.
  span({
    paragraphIndex: 9, spanIndex: 0, speaker: "Wick Odlum", confidence: 0.5,
    candidates: ["Marda Kelp"],
    quote: "“Not before dawn.”",
  }),
  span({
    paragraphIndex: 11, spanIndex: 0, speaker: "Marda Kelp", confidence: 0.55,
    candidates: ["Wick Odlum"],
    quote: "“Then it will keep until dawn, and so will the rest of it.”",
  }),
  // Below PRONOUN_MIN_POSTERIOR — the engine has no real candidate here.
  span({
    paragraphIndex: 13, spanIndex: 0, speaker: "Ferren Ash", confidence: 0.1,
    candidates: ["Marda Kelp"],
    quote: "“Nothing was agreed.”",
  }),
];

const CHAPTER: AttributionReviewInput = {
  chapterId: "ch-7",
  chapterContentHash: HASH,
  paragraphs: PARAGRAPHS,
  spans: SPANS,
};

console.log("\n── 1. attribution: ranking & cap ───────────────────────────────");
{
  const picked = selectAttributionCandidates(CHAPTER);
  const at = (p: number) => picked.some((s) => s.paragraphIndex === p);

  gate(picked[0]?.paragraphIndex === 6,
    "the most ambiguous, most material span runs first",
    `¶${picked[0]?.paragraphIndex} conf ${picked[0]?.confidence}`);
  gate(picked.map((s) => s.paragraphIndex).join(",") === "6,11,9",
    "ambiguity × material orders the rest",
    picked.map((s) => `¶${s.paragraphIndex}:${s.confidence}`).join(" "));
  gate(picked.length === ATTRIBUTION_CAP, `capped at ${ATTRIBUTION_CAP} per chapter`,
    `${SPANS.length} spans → ${picked.length}`);
  gate(selectAttributionCandidates(CHAPTER, 1).length === 1,
    "an explicit cap overrides the default", "cap 1 → 1");
  gate(selectAttributionCandidates(CHAPTER, 0).length === 0,
    "a zero cap spends nothing", "a chapter can cost nothing");

  gate(!at(2) && !at(4), "an ATTESTED span is not a tie-break",
    `≥ ${UNSURE_HI} is settled`);
  gate(!at(13), "a span below the posterior floor is not a tie-break",
    `≤ ${UNSURE_LO} has no candidate to choose between`);
  gate(!at(0), "a span with fewer than two offered names is not asked about",
    "nothing to choose between → no inference spent");

  gate(ambiguityOf(0.515) > ambiguityOf(0.3) && ambiguityOf(0.515) > ambiguityOf(0.77),
    "the MIDDLE of the band is the ambiguous place, not the bottom",
    `mid ${ambiguityOf(0.515).toFixed(2)} · 0.30 ${ambiguityOf(0.3).toFixed(2)} · 0.77 ${ambiguityOf(0.77).toFixed(2)}`);

  gate(selectAttributionCandidates({ ...CHAPTER, spans: [] }).length === 0,
    "a chapter with no dialogue spends nothing", "[]");
}

console.log("\n── 2. attribution: the request ─────────────────────────────────");
{
  const candidate = SPANS.find((s) => s.paragraphIndex === 6)!;
  const req = buildAttributionRequest(candidate, CHAPTER);

  gate(req.offered.join(" | ") === "Marda Kelp | Ferren Ash",
    "the engine's own answer leads the offered set, then its candidates",
    req.offered.join(" | "));
  gate(req.userText.includes("Somebody carried that book down"),
    "the quoted line is the evidence", "verbatim");
  gate(req.userText.includes("Ferren Ash came in from the weighing floor"),
    "two preceding paragraphs are shown", "¶4 and ¶5");
  gate(!req.userText.includes("Outside, the yard filled and emptied"),
    "a third paragraph back is not", "the window is two");

  const long = req.userText.split("\n").find((l) => l.trim().startsWith("¶5"))!;
  gate(long.length < 460 && long.includes("Marda Kelp put the tally book down"),
    "a long paragraph is cut to ~400 chars, keeping the TAIL",
    `${long.length} chars, ends on the attribution`);
  gate(long.includes("…"), "the cut is marked", "leading ellipsis");

  gate(req.userText.includes("one line back: Ferren Ash") &&
       req.userText.includes("two lines back: Marda Kelp"),
    "the last two attributed speakers ride along", "dialogue alternates");
  gate(req.systemPrompt.includes("DIALOGUE ALTERNATES"),
    "and the prompt says why they matter", "the alternation rule is stated");
  gate(req.userText.trimEnd().endsWith("Who speaks the line?"),
    "the question is asked last", "after all the evidence");
  gate(req.userText.includes("- unsure"),
    "abstention is offered explicitly and last", "cheap to give");
  gate(req.systemPrompt.indexOf('"reason"') < req.systemPrompt.indexOf('"speaker"'),
    "the prompt asks for the reason FIRST", "grammar order = declaration order");

  gate(recentSpeakers(SPANS[0], CHAPTER).length === 0,
    "the first line of a chapter has no alternation evidence", "[]");
  const lone = span({ paragraphIndex: 0, spanIndex: 0, speaker: "Ilm Vance", confidence: 0.5, quote: "“No.”" });
  gate(offeredSpeakers(lone, { ...CHAPTER, spans: [lone] }).length === 1,
    "with no candidates and no history there is one option, so no question",
    "selection filters it out");
  gate(offeredSpeakers(SPANS[6], CHAPTER).includes("Wick Odlum"),
    "an engine candidate is always offered", "its ranking is the option set");
}

console.log("\n── 3. attribution: validation ──────────────────────────────────");
{
  const offered = ["Marda Kelp", "Ferren Ash"];
  const answer = (over: Record<string, unknown>) =>
    normalizeAttribution({ reason: "the reply answers her question directly", confidence: 0.9, ...over }, offered);

  gate(normalizeAttribution(null, offered) === null, "null response", "→ null");
  gate(normalizeAttribution("Ferren Ash", offered) === null, "non-object response", "→ null");
  gate(answer({ speaker: 7 }) === null, "a non-string speaker", "→ null");

  gate(answer({ speaker: "Wick Odlum" }) === null,
    "a speaker OUTSIDE the offered set is dropped",
    "the model may not name someone new");
  gate(answer({ speaker: "unsure" }) === null,
    "abstention returns null, never a fabricated name",
    '"unsure" → the engine\'s own answer stands');
  gate(answer({ speaker: "  UNSURE " }) === null,
    "abstention survives casing and whitespace", "collapsed before matching");

  gate(answer({ speaker: "ferren ash" })?.speaker === "Ferren Ash",
    "an offered name matches case-insensitively and returns the offered casing",
    "no new spellings enter the store");
  gate(answer({ speaker: "Ferren" })?.speaker === "Ferren Ash",
    "a shortened name resolves to the one offered name it can only mean",
    "shortening is not inventing");
  gate(normalizeAttribution(
    { reason: "she is named in the line before", speaker: "Marda", confidence: 0.9 },
    ["Marda Kelp", "Marda Roan"]) === null,
    "an AMBIGUOUS shortening resolves to nothing rather than to a guess",
    "two offered names share the word");

  gate(answer({ speaker: "Ferren Ash", confidence: ATTRIBUTION_MIN_CONFIDENCE - 0.01 }) === null,
    `confidence below ${ATTRIBUTION_MIN_CONFIDENCE} is discarded`,
    "a wrong confident answer teaches the ranker the wrong thing");
  gate(answer({ speaker: "Ferren Ash", confidence: ATTRIBUTION_MIN_CONFIDENCE })?.confidence === ATTRIBUTION_MIN_CONFIDENCE,
    "exactly at the floor is accepted", `${ATTRIBUTION_MIN_CONFIDENCE}`);
  gate(answer({ speaker: "Ferren Ash", confidence: 4 })?.confidence === 1,
    "an out-of-range confidence is clamped, not rejected", "4 → 1");
  gate(answer({ speaker: "Ferren Ash", confidence: Number.NaN }) === null,
    "a NaN confidence", "→ null");
  gate(answer({ speaker: "Ferren Ash", reason: "   " }) === null,
    "a silent answer is an unexplainable correction", "blank reason → null");

  const long = answer({ speaker: "Ferren Ash", reason: "x".repeat(400) });
  gate((long?.reason.length ?? 0) <= 121,
    "a runaway reason is tidied, not shipped whole", `${long?.reason.length} chars`);
}

console.log("\n── 4. attribution: cache key ───────────────────────────────────");
{
  const offered = ["Marda Kelp", "Ferren Ash"];
  const key = attributionKeyFor(HASH, 6, 0, MODEL, offered);
  gate(key === attributionKeyFor(HASH, 6, 0, MODEL, [...offered]),
    "stable across identical input", key);
  gate(key !== attributionKeyFor("3101|different prose entirely", 6, 0, MODEL, offered),
    "moves with the chapter content hash", "new prose → new question");
  gate(key !== attributionKeyFor(HASH, 6, 0, "some-other-model", offered),
    "moves with the model id", "a different model is a different answer");
  gate(key !== attributionKeyFor(HASH, 6, 0, MODEL, ["Marda Kelp", "Wick Odlum"]),
    "moves when the OFFERED SET changes under an unchanged hash",
    "world-data or engine drift re-points the question");
  gate(key !== attributionKeyFor(HASH, 7, 0, MODEL, offered) &&
       key !== attributionKeyFor(HASH, 6, 1, MODEL, offered),
    "moves with the span it names", "¶ and span index both count");
  gate(attributionKeyFor(HASH, 6, 0, MODEL) === attributionKeyFor(HASH, 6, 0, MODEL),
    "the four-argument form is stable too", attributionKeyFor(HASH, 6, 0, MODEL));
}

// ══ 2 · Chekhov ═══════════════════════════════════════════════════════════

const chekhov = (over: ChekhovReviewCandidate): ChekhovReviewCandidate => over;

const CHEKHOV_CANDIDATES: ChekhovReviewCandidate[] = [
  chekhov({
    phrase: "sealed tin box", mentions: 3, chapterNumber: 2, chaptersSince: 5,
    sentence: "She put the sealed tin box at the back of the press and turned the key on it before she went down.",
  }),
  chekhov({
    phrase: "loaded flare pistol", mentions: 3, chapterNumber: 1, chaptersSince: 6,
    sentence: "The loaded flare pistol lay in the drawer under the charts, and Ilm Vance had been told twice not to touch it.",
  }),
  chekhov({
    phrase: "folded oilcloth coat", mentions: 1, chapterNumber: 1, chaptersSince: 6,
    sentence: "A folded oilcloth coat hung on the back of the door and dripped onto the boards all evening.",
  }),
  // No introducing sentence: nothing to ground an answer in, so it is never
  // asked about rather than guessed at.
  chekhov({ phrase: "cracked lamp shade", mentions: 4, chapterNumber: 1, chaptersSince: 6, sentence: "" }),
];

console.log("\n── 5. chekhov: ranking & cap ───────────────────────────────────");
{
  const picked = selectChekhovCandidates(CHEKHOV_CANDIDATES);
  gate(picked[0]?.phrase === "loaded flare pistol",
    "mentions first, then the EARLIEST introduction",
    picked.map((c) => `${c.phrase}(${c.mentions}/ch${c.chapterNumber})`).join(" · "));
  gate(picked.length === CHEKHOV_CAP, `capped at ${CHEKHOV_CAP} per chapter`,
    `${CHEKHOV_CANDIDATES.length} candidates → ${picked.length}`);
  gate(selectChekhovCandidates(CHEKHOV_CANDIDATES, 1).length === 1,
    "an explicit cap overrides the default", "cap 1 → 1");
  gate(!picked.some((c) => c.phrase === "cracked lamp shade") &&
       selectChekhovCandidates(CHEKHOV_CANDIDATES, 9).every((c) => c.sentence !== ""),
    "a phrase with no introducing sentence is never offered",
    "the whole answer is grounded in that sentence");
  gate(selectChekhovCandidates([]).length === 0, "a chapter with no candidates spends nothing", "[]");
}

console.log("\n── 6. chekhov: the request ─────────────────────────────────────");
{
  const req = buildChekhovRequest(CHEKHOV_CANDIDATES[1]);
  gate(req.userText.includes("loaded flare pistol") &&
       req.userText.includes("told twice not to touch it"),
    "the phrase and its introducing sentence are the evidence", "verbatim");
  gate(req.userText.includes("chapter 1") && req.userText.includes("CHAPTERS SINCE: 6"),
    "the chapter it appeared in and how long ago", "both shown");
  gate(req.userText.includes("3 times"), "and how often the chapter mentioned it", "3 times");
  gate(/furniture is the answer you should expect/i.test(req.systemPrompt),
    "the prompt makes FURNITURE the easy, expected answer",
    "most definite-article noun phrases are scenery");
  gate(req.systemPrompt.indexOf('"reason"') < req.systemPrompt.indexOf('"verdict"'),
    "the prompt asks for the reason FIRST", "grammar order = declaration order");
  const enumOrder = (req.schema.properties.verdict.enum as readonly string[]).join(",");
  gate(enumOrder === "promise,furniture,unsure",
    "the abstention is LAST in the enum", enumOrder);

  const older = buildChekhovRequest({ ...CHEKHOV_CANDIDATES[1], chaptersSince: 2 });
  gate(older.userText !== req.userText,
    "chapters-since is real evidence and changes the prompt", "2 vs 6");
  gate(chekhovKeyFor(HASH, "loaded flare pistol", MODEL) === chekhovKeyFor(HASH, "loaded flare pistol", MODEL),
    "…but it is NOT in the key: whether a sentence promised something does not",
    "otherwise every chapter opened re-asks the whole book");
}

console.log("\n── 7. chekhov: validation & surfacing ──────────────────────────");
{
  const answer = (over: Record<string, unknown>) =>
    normalizeChekhov({ reason: "it is locked away and someone is warned off it", confidence: 0.9, ...over });

  gate(normalizeChekhov(null) === null, "null response", "→ null");
  gate(normalizeChekhov({ verdict: "promise" }) === null, "no confidence", "→ null");
  gate(answer({ verdict: "scenery" }) === null,
    "a verdict OUTSIDE the enum is dropped", '"scenery" → null');
  gate(answer({ verdict: "promise", reason: "  " }) === null,
    "a silent verdict is unexplainable", "blank reason → null");
  gate(answer({ verdict: "PROMISE" })?.verdict === "promise",
    "casing is normalised, not rejected", "PROMISE → promise");

  gate(isSurfacedChekhov(answer({ verdict: "promise", confidence: 0.9 })),
    "a confident promise is the one thing that surfaces", "0.9 ≥ floor");
  gate(!isSurfacedChekhov(answer({ verdict: "promise", confidence: CHEKHOV_MIN_CONFIDENCE - 0.01 })),
    `a promise below ${CHEKHOV_MIN_CONFIDENCE} surfaces nothing`,
    "the floor is re-checked at the surface");
  gate(isSurfacedChekhov(answer({ verdict: "promise", confidence: CHEKHOV_MIN_CONFIDENCE })),
    "exactly at the floor surfaces", `${CHEKHOV_MIN_CONFIDENCE}`);
  gate(!isSurfacedChekhov(answer({ verdict: "unsure", confidence: 0.95 })),
    "abstention surfaces nothing however confident it is", "unsure → silence");
  gate(!isSurfacedChekhov(answer({ verdict: "furniture", confidence: 0.95 })),
    "the majority answer surfaces nothing", "furniture → the list stands as it is");
  gate(!isSurfacedChekhov(null) && !isSurfacedChekhov(undefined),
    "a failed run surfaces nothing", "null/undefined → false");

  // ★ AND IT IS STILL AN ANSWER. A "furniture" verdict comes back intact so the
  //   caller can cache it: the question is asked once per phrase, not once per
  //   render. Discarding it would be indistinguishable from a failed run.
  gate(answer({ verdict: "furniture", confidence: 0.95 })?.verdict === "furniture",
    "…but it is returned, not discarded", "cacheable: never asked twice");
}

console.log("\n── 8. chekhov: cache key ───────────────────────────────────────");
{
  const key = chekhovKeyFor(HASH, "loaded flare pistol", MODEL);
  gate(key === chekhovKeyFor(HASH, "Loaded  flare pistol ", MODEL),
    "stable across identical input, whitespace and casing", key);
  gate(key !== chekhovKeyFor("3101|different prose entirely", "loaded flare pistol", MODEL),
    "moves with the chapter content hash", "new prose → new question");
  gate(key !== chekhovKeyFor(HASH, "sealed tin box", MODEL),
    "moves with the phrase", "the phrase IS the question here");
  gate(key !== chekhovKeyFor(HASH, "loaded flare pistol", "some-other-model"),
    "moves with the model id", "a different model is a different answer");
}

// ══ 3 · scene function ════════════════════════════════════════════════════

const scene = (over: SceneReviewCandidate): SceneReviewCandidate => over;

const SCENE_PARAS = [
  "Wick Odlum put the second ledger on the desk and did not let go of it.",
  "“You will sign for it or you will carry it back up yourself,” he said.",
  "Ferren Ash looked at the page for long enough that the lamp needed trimming again.",
  "“I signed for the first one and the first one was wrong.”",
  "Neither of them moved and neither of them said anything else for a while.",
];

const SCENES: SceneReviewCandidate[] = [
  // Cleared the floor, lost the photo-finish. Zero shortfall → asked first.
  scene({
    sceneIndex: 0, tension: "rising", paragraphs: SCENE_PARAS,
    nearMisses: [{ label: "confrontation", score: 1.35 }, { label: "friction", score: 1.3 }],
  }),
  // Short of the floor by a hair.
  scene({
    sceneIndex: 1, tension: "calm", paragraphs: SCENE_PARAS,
    nearMisses: [{ label: "reflection", score: 1.14 }, { label: "reckoning", score: 0.9 }],
  }),
  // Short of the floor by more.
  scene({
    sceneIndex: 2, tension: "calm", paragraphs: SCENE_PARAS,
    nearMisses: [{ label: "arrival", score: 1.05 }],
  }),
  // Cleared BOTH tests — the engine already labelled it, so it is not a question.
  scene({
    sceneIndex: 3, tension: "high", paragraphs: SCENE_PARAS,
    nearMisses: [{ label: "discovery", score: 1.6 }, { label: "stillness", score: 1.1 }],
  }),
  // Gated nothing in: silence on purpose, never asked about.
  scene({ sceneIndex: 4, tension: "calm", paragraphs: SCENE_PARAS, nearMisses: [] }),
];

console.log("\n── 9. scene: ranking & cap ─────────────────────────────────────");
{
  const picked = selectSceneCandidates(SCENES);
  gate(picked[0]?.sceneIndex === 0,
    "the smallest shortfall to the floor runs first",
    `scene ${picked[0]?.sceneIndex}, shortfall ${floorShortfall(SCENES[0]).toFixed(2)}`);
  gate(picked.map((s) => s.sceneIndex).join(",") === "0,1,2",
    "then by how far short they fell",
    picked.map((s) => `${s.sceneIndex}:${floorShortfall(s).toFixed(2)}`).join(" "));
  gate(picked.length === SCENE_CAP, `capped at ${SCENE_CAP} per chapter`,
    `${SCENES.length} scenes → ${picked.length}`);
  gate(selectSceneCandidates(SCENES, 2).length === 2,
    "an explicit cap overrides the default", "cap 2 → 2");

  gate(!picked.some((s) => s.sceneIndex === 3) && !isNearMiss(SCENES[3]),
    "a scene that cleared FLOOR and MARGIN is not a near miss",
    `the engine labelled it (floor ${SCENE_FLOOR})`);
  gate(!picked.some((s) => s.sceneIndex === 4) && !isNearMiss(SCENES[4]),
    "a scene that gated nothing in is silence on purpose",
    "64% of scenes abstain by design — they are not a defect queue");
  gate(selectSceneCandidates([{ ...SCENES[0], paragraphs: [] }]).length === 0,
    "a scene with no prose is not asked about", "no evidence, no question");
}

console.log("\n── 10. scene: the request & the excerpt ────────────────────────");
{
  const req = buildSceneRequest(SCENES[0]);
  gate(req.offered.join(" | ") === "confrontation | friction",
    "the shortlist is the offered set, in the engine's order", req.offered.join(" | "));
  gate(req.userText.includes("(score 1.35)") && req.userText.includes("(score 1.30)"),
    "with the scores that could not separate them", "both shown");
  gate(req.userText.includes(`- ${SCENE_NONE}`) &&
       req.userText.lastIndexOf(SCENE_NONE) > req.userText.indexOf("friction"),
    "and abstention is offered LAST", '"none" costs nothing');
  gate(req.userText.includes("tension reads rising"),
    "the tension band rides along", "so the model does not re-derive it");
  gate(req.userText.includes("You will sign for it or you will carry it back up"),
    "the scene's own prose is the evidence", "verbatim");
  gate(req.systemPrompt.indexOf('"reason"') < req.systemPrompt.indexOf('"label"'),
    "the prompt asks for the reason FIRST", "grammar order = declaration order");

  const short = sceneExcerpt(SCENE_PARAS);
  gate(short.join("\n") === SCENE_PARAS.join("\n"),
    "a scene inside the budget is passed through whole", `${short.length} paragraphs`);

  const filler = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => `${tag} paragraph ${i}: ` + "the yard was quiet and the light was going. ".repeat(6));
  const huge = ["OPENING: Wick Odlum came in from the yard.", ...filler(20, "middle"), "CLOSING: Ferren Ash signed it and went out."];
  const cut = sceneExcerpt(huge);
  const joined = cut.join("\n");
  gate(joined.length <= SCENE_TEXT_BUDGET + 40,
    `a long scene is cut to ~${SCENE_TEXT_BUDGET} chars`, `${joined.length} chars`);
  gate(joined.includes("OPENING:") && joined.includes("CLOSING:"),
    "HEAD AND TAIL both survive — a decision beat lands late by definition",
    "the end of a scene is what separates two of the readings");
  gate(cut.includes("…"), "and the gap is marked", "not read as continuous prose");
  gate(sceneExcerpt([]).length === 0, "an empty scene excerpts to nothing", "[]");
}

console.log("\n── 11. scene: validation ───────────────────────────────────────");
{
  const offered = offeredLabels(SCENES[0]);
  const answer = (over: Record<string, unknown>) =>
    normalizeSceneLabel({ reason: "one demands, the other refuses, over the same page", confidence: 0.9, ...over }, offered);

  gate(normalizeSceneLabel(null, offered) === null, "null response", "→ null");
  gate(answer({ label: 3 }) === null, "a non-string label", "→ null");
  gate(answer({ label: SCENE_NONE }) === null,
    "abstention returns null rather than a fabricated label",
    '"none" → the scene keeps no label, which is what it has now');
  gate(answer({ label: "None" }) === null, "abstention survives casing", "None → null");
  gate(answer({ label: "pursuit" }) === null,
    "a label OUTSIDE the shortlist is dropped",
    "the model may not invent a reading the engine never gated in");
  gate(answer({ label: "Confrontation" })?.label === "confrontation",
    "an offered label matches case-insensitively and keeps the engine's casing",
    "no new vocabulary enters the store");
  gate(answer({ label: "confrontation", confidence: SCENE_MIN_CONFIDENCE - 0.01 }) === null,
    `confidence below ${SCENE_MIN_CONFIDENCE} is discarded`,
    "a decorative word costs the writer trust");
  gate(answer({ label: "confrontation", confidence: SCENE_MIN_CONFIDENCE })?.confidence === SCENE_MIN_CONFIDENCE,
    "exactly at the floor is accepted", `${SCENE_MIN_CONFIDENCE}`);
  gate(answer({ label: "confrontation", confidence: 2 })?.confidence === 1,
    "an out-of-range confidence is clamped", "2 → 1");
  gate(answer({ label: "confrontation", reason: "" }) === null,
    "a silent label is unexplainable", "blank reason → null");
}

console.log("\n── 12. scene: cache key ────────────────────────────────────────");
{
  const offered = ["confrontation", "friction"];
  const key = sceneKeyFor(HASH, 0, MODEL, offered);
  gate(key === sceneKeyFor(HASH, 0, MODEL, [...offered]),
    "stable across identical input", key);
  gate(key !== sceneKeyFor("3101|different prose entirely", 0, MODEL, offered),
    "moves with the chapter content hash", "new prose → new question");
  gate(key !== sceneKeyFor(HASH, 1, MODEL, offered),
    "moves with the scene index", "a different scene is a different question");
  gate(key !== sceneKeyFor(HASH, 0, "some-other-model", offered),
    "moves with the model id", "a different model is a different answer");
  gate(key !== sceneKeyFor(HASH, 0, MODEL, ["confrontation", "negotiation"]),
    "moves when the SHORTLIST changes under an unchanged hash",
    "a tuned gate re-points the question the stored answer belongs to");
}

// ══ 4 · the injected runner ═══════════════════════════════════════════════
//
// Every module takes its runner as an argument: no IPC, no window, nothing that
// needs Electron to be exercised. These three drive the whole path.

console.log("\n── 13. injected runner: end to end, no model ───────────────────");
{
  void (async () => {
    const seen: AssistantJSONRequest[] = [];
    const candidate = SPANS.find((s) => s.paragraphIndex === 6)!;

    const good = await runAttributionReview(candidate, CHAPTER, {
      run: stubRunner({ reason: "she answers the question Ferren asked", speaker: "Ferren Ash", confidence: 0.86 }, seen),
      modelId: MODEL,
    });
    gate(good?.speaker === "Ferren Ash" && good?.previousSpeaker === "Marda Kelp",
      "attribution: an offered overturn comes back with what it replaced",
      `${good?.previousSpeaker} → ${good?.speaker} @${good?.confidence}`);
    gate(seen[0]?.task === ATTRIBUTION_TASK && seen[0]?.tag === "ch-7:6:0",
      "…tagged so a chapter's pending work can be cancelled as a unit", `${seen[0]?.tag}`);
    gate(good?.key === attributionKeyFor(HASH, 6, 0, MODEL, ["Marda Kelp", "Ferren Ash"]),
      "…and keyed on the offered set it was actually asked with", good?.key ?? "—");

    const abstained = await runAttributionReview(candidate, CHAPTER, {
      run: stubRunner({ reason: "either of them could be speaking here", speaker: "unsure", confidence: 0.9 }),
      modelId: MODEL,
    });
    gate(abstained === null, "attribution: abstention writes nothing", "→ null");

    const failed = await runAttributionReview(candidate, CHAPTER, {
      run: stubRunner(null, [], false),
      modelId: MODEL,
    });
    gate(failed === null, "attribution: a failed run is not a failed chapter", "→ null");

    const chekhovSeen: AssistantJSONRequest[] = [];
    const furniture = await runChekhovReview(CHEKHOV_CANDIDATES[2], {
      run: stubRunner({ reason: "it hangs on a door and nothing is asked of it", verdict: "furniture", confidence: 0.93 }, chekhovSeen),
      modelId: MODEL,
      chapterContentHash: HASH,
      chapterId: "ch-7",
    });
    gate(furniture?.verdict === "furniture" && furniture?.surfaced === false,
      "chekhov: the majority answer is stored and surfaces nothing",
      `${furniture?.verdict} · surfaced ${furniture?.surfaced}`);
    gate(chekhovSeen[0]?.task === CHEKHOV_TASK, "…on the chekhov task", chekhovSeen[0]?.task ?? "—");

    const promise = await runChekhovReview(CHEKHOV_CANDIDATES[1], {
      run: stubRunner({ reason: "it is loaded and someone is warned off it twice", verdict: "promise", confidence: 0.88 }),
      modelId: MODEL,
      chapterContentHash: HASH,
    });
    gate(promise?.surfaced === true && promise?.key === chekhovKeyFor(HASH, "loaded flare pistol", MODEL),
      "chekhov: a confident promise surfaces, keyed on the phrase", promise?.key ?? "—");

    const sceneSeen: AssistantJSONRequest[] = [];
    const labelled = await runSceneReview(SCENES[0], {
      run: stubRunner({ reason: "one demands the signature, the other refuses it", label: "confrontation", confidence: 0.81 }, sceneSeen),
      modelId: MODEL,
      chapterContentHash: HASH,
      chapterId: "ch-7",
    });
    gate(labelled?.label === "confrontation" && labelled?.modelSourced === true,
      "scene: an applied label is marked MODEL-SOURCED",
      "test-scene-labels.ts must keep measuring the engine alone");
    gate(sceneSeen[0]?.task === SCENE_TASK && sceneSeen[0]?.tag === "ch-7:scene-0",
      "…tagged per scene", sceneSeen[0]?.tag ?? "—");

    const none = await runSceneReview(SCENES[0], {
      run: stubRunner({ reason: "it is doing two things at once", label: "none", confidence: 0.95 }),
      modelId: MODEL,
      chapterContentHash: HASH,
    });
    gate(none === null, "scene: abstention leaves the scene unlabelled", "→ null");

    const notAsked = await runSceneReview(SCENES[3], {
      run: stubRunner({ reason: "should never be asked", label: "discovery", confidence: 0.99 }),
      modelId: MODEL,
      chapterContentHash: HASH,
    });
    gate(notAsked === null, "scene: a scene that is not a near miss is refused at the door",
      "the guard does not depend on the caller having selected properly");

    console.log("\n── the prompt one span actually sends ──────────────────────────\n");
    console.log(buildAttributionRequest(candidate, CHAPTER).userText.split("\n").map((l) => `  ${l}`).join("\n"));

    console.log(`\n${failures === 0 ? "✓ ALL GATES GREEN" : `✗ ${failures} GATE(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  })();
}
