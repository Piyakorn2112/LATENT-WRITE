/**
 * test-assist-sweep.ts — the WIRING's pure gates. No model, no Electron.
 *
 * test-assist-reviews.ts gates the three task modules in isolation. This gates
 * what joins them to the app, which is where the defects that actually reach a
 * writer live:
 *
 *   1. ORDER & BUDGET   scene before Chekhov, caps held, and a cancellation
 *                       between items stops the rest.
 *   2. KEY AGREEMENT    the key the sweep checks `isAsked` against is the SAME
 *                       key the task module stamps on its result. If these ever
 *                       diverge, every answer is stored under a key nothing
 *                       looks up and every question is asked forever.
 *   3. ADAPTERS         scene numbering matches the engine's own grouping, the
 *                       prev-scene carry is threaded, and a scene the engine
 *                       labelled is never a question.
 *   4. STALENESS        an edit, a model swap, or a re-tuned engine shortlist
 *                       all stop a stored answer surfacing.
 *   5. SILENCE          a "furniture" verdict is stored and shows nothing.
 *
 * ★ ATTRIBUTION IS NOT HERE. It was wired, then measured out by
 *   scripts/probe-attribution-anchor.cjs; src/lib/attribution-review.ts keeps
 *   the module, its own gates, and the number that withdrew it.
 *
 * ★ EVERY NAME IS FABRICATED, for the same reason as the sibling harness: a
 *   gate that passed on a remembered world would measure the model's memory.
 *
 *   /opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs scripts/test-assist-sweep.ts
 */
import {
  chekhovCandidatesFrom,
  runAssistSweep,
  sceneCandidatesFrom,
  sceneStartParagraphs,
  type SweepAnswer,
  presenceCandidatesFrom,
} from "../src/lib/assist-sweep";
import { CHEKHOV_TASK, chekhovKeyFor } from "../src/lib/chekhov-review";
import { PRESENCE_TASK, presenceKeyFor } from "../src/lib/presence-review";
import { classifyChapterPresence } from "../src/lib/character-presence";
import { alreadyAsked, presenceOverrides } from "../src/lib/review-store";
import {
  concretenessOf, detectHandoff, findChekhovCandidates, findUnintroducedArrivals,
} from "../src/lib/continuity";
import type { Chapter, WorldData } from "../src/types";
import { SCENE_TASK, offeredLabels, sceneKeyFor } from "../src/lib/scene-review";
import {
  chapterReviews,
  confirmedPromises,
  emptyReviewStore,
  pruneReviewStore,
  recordReviewAnswer,
  sceneLabelOverlay,
} from "../src/lib/review-store";
import type { AssistantJSONRequest, AssistantJSONRunner } from "../src/lib/assistant-client";
import type { ChapterParaResult } from "../src/lib/speech-detect";
import type { SceneReviewCandidate } from "../src/lib/scene-review";

let failures = 0;
const gate = (ok: boolean, label: string, detail: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label} — ${detail}`);
  if (!ok) failures++;
};

const MODEL = "qwen3-1.7b-q4_k_m";
const HASH = "3100|The yard office kept two ledgers and had done for as lon";
const CHAPTER_ID = "ch-7";

/** Answers each task with a usable body, and records every request in order. */
function taskRunner(seen: AssistantJSONRequest[]): AssistantJSONRunner {
  return (async (req: AssistantJSONRequest) => {
    seen.push(req);
    if (req.task === SCENE_TASK) {
      return {
        ok: true, modelId: MODEL, timings: null,
        json: { reason: "she weighs what the letter cost her", label: "reckoning", confidence: 0.83 },
      };
    }
    return {
      ok: true, modelId: MODEL, timings: null,
      json: { reason: "it only puts the bowl in the room", verdict: "furniture", confidence: 0.9 },
    };
  }) as AssistantJSONRunner;
}

// ── fixtures ──────────────────────────────────────────────────────────────

const PARAGRAPHS = [
  "The yard office kept two ledgers and had done for as long as anyone there could remember.",
  "Marda Kelp set the lamp on the desk and did not sit down.",
  "“You signed for the second load,” she said.",
  "Ferren Ash turned a page without looking up from it.",
  "“I signed for what came off the barge.”",
  "“That is not the same thing and you know it.”",
];

const meta = (over: Partial<ChapterParaResult["meta"]> = {}): ChapterParaResult["meta"] => ({
  tension: "calm", dialogueDensity: 0, ...over,
});
const para = (over: Partial<ChapterParaResult["meta"]> = {}): ChapterParaResult => ({
  segments: [], meta: meta(over),
});

async function main() {
  console.log("\n[assist-sweep] adapters\n");

  // Real-length prose, reused by the ungrouped gate below and the exclusion
  // gate further down — both are vacuous under the 45-word floor.
  const SCENE_PROSE_EARLY = [
    "She went along the row of crates with the lamp held low, reading the chalk marks one after another, and none of them matched what the manifest in her other hand said they should.",
    "The yard was quiet enough that she could hear the river working at the pilings, and she counted to the end of the row before she let herself believe it.",
    "He was waiting by the office door when she came back, and he did not pretend to be doing anything else, which she supposed was a kind of honesty.",
  ];

  // ── scene numbering ─────────────────────────────────────────────────────
  const grouped: ChapterParaResult[] = [
    para({ sceneStart: true, sceneTension: "calm" }),
    para(),
    para({ sceneStart: true, sceneTension: "high", sceneLabel: "confrontation" }),
    para(),
    para({ sceneStart: true, sceneTension: "rising" }),
  ];
  gate(JSON.stringify(sceneStartParagraphs(grouped)) === "[0,2,4]",
    "scene numbering follows the engine's own grouping", sceneStartParagraphs(grouped).join(","));
  gate(sceneStartParagraphs([]).length === 0,
    "…an empty chapter is no scenes", "[]");

  // ★★ THE FAST PATH MARKS NOTHING, AND THAT MUST MEAN NOTHING TO REVIEW.
  //    detectSpeechInChapter skips groupIntoScenes at level 'fast'
  //    (useGroupScenes = level !== 'fast'), so no paragraph carries sceneStart.
  //    This returned [0] once — inventing ONE scene spanning the whole chapter,
  //    which burned an inference per fast-analysed chapter on a question about
  //    a whole chapter, and stored an answer HighlightLayer can never draw
  //    (it renders a label only where meta.sceneStart is set).
  const ungrouped: ChapterParaResult[] = [para(), para(), para()];
  gate(sceneStartParagraphs(ungrouped).length === 0,
    "★★ a chapter the engine did not group has NO scenes, not one big one",
    `${sceneStartParagraphs(ungrouped).length} starts from ungrouped input`);
  gate(sceneCandidatesFrom(SCENE_PROSE_EARLY, ungrouped).length === 0,
    "…so nothing is asked about it", "no marked start → no question, no wasted call");

  // ★ The engine-labelled scene must not be a question even though its raw
  //   scores can look like a margin loss (the prevLabel step-down).
  //
  //   ★ THE PROSE HAS TO BE REAL LENGTH OR THIS GATE PROVES NOTHING.
  //     `sceneCandidateScores` returns [] below 45 words, so a fixture of
  //     two-word paragraphs makes EVERY scene absent and the gate passes
  //     without testing the exclusion at all. It read green that way first.
  const SCENE_PROSE = [
    "She went along the row of crates with the lamp held low, reading the chalk marks one after another, and none of them matched what the manifest in her other hand said they should.",
    "The yard was quiet enough that she could hear the river working at the pilings, and she counted to the end of the row before she let herself believe it.",
    "He was waiting by the office door when she came back, and he did not pretend to be doing anything else, which she supposed was a kind of honesty.",
    "They looked at each other for a while without either of them saying the thing, and the lamp burned down between them on the step.",
    "Afterwards she sat on the wall above the slipway and watched the water go by underneath, thinking about nothing much, letting the cold get into her hands until they hurt.",
  ];
  const built = sceneCandidatesFrom(SCENE_PROSE, grouped);
  gate(built.length > 0,
    "the scene fixture is long enough to be scored at all",
    `${built.length} scene(s) considered — below 45 words every gate here is vacuous`);
  gate(built.length > 0 && built.every((c) => c.sceneIndex !== 1),
    "★ a scene the engine already labelled is never asked about",
    `asked about scene(s) [${built.map((c) => c.sceneIndex).join(",") || "none"}], engine labelled scene 1`);

  // ── what the generator hands the sweep ──────────────────────────────────
  //
  // ★★ AN UNANSWERABLE QUESTION IS WORSE THAN A HARD ONE. The Chekhov regex
  //    matches `article + up to two words + word + word`, so a clause like
  //    "…the register rather than…" yields the phrase "rather than". The real
  //    app produced exactly that, and the model confirmed it as a PROMISE at
  //    0.7 — found by reading verify-review-sweep-e2e.mjs's output, invisible
  //    to every gate. It is unanswerable-but-plausible: the model is grounded
  //    in the SENTENCE, which always sounds meaningful, so it confirms rather
  //    than declines. And junk recurs, so mentions-first ranking sorted it
  //    ABOVE every real object and spent the budget on it.
  const junkChapters = [
    { id: "c1", number: 1, title: "One", content:
      "He set the rusted pistol on the shelf rather than in the case, and did not look at it again." },
    { id: "c2", number: 2, title: "Two", content: "Nothing here recurs from the chapter before it." },
  ] as Parameters<typeof findChekhovCandidates>[0];
  const generated = findChekhovCandidates(junkChapters, 0);
  // ★ THE POSITIVE HALF IS WHAT KEEPS THE NEGATIVE HALF HONEST. "no closed-class
  //   phrase" is satisfied perfectly by generating NOTHING, and this gate read
  //   green that way once — the same vacuous-fixture trap as the scene one.
  gate(generated.some((c) => c.phrase === "rusted pistol"),
    "the generator still finds the real noun phrase",
    `got [${generated.map((c) => c.phrase).join(", ") || "none"}]`);
  gate(!generated.some((c) => /\b(rather|than|because|which|while|of|with|on|the)\b/.test(c.phrase)),
    "★★ …and never hands the sweep a closed-class phrase",
    `got [${generated.map((c) => c.phrase).join(", ") || "none"}]`);
  gate(generated.every((c) => c.sentence.trim() !== ""),
    "…and every candidate carries the sentence that introduces it",
    "a phrase with no sentence is an invitation to invent");

  // ── the engine signals the sweep is built on ────────────────────────────
  console.log("\n[continuity] engine signals\n");

  // ★★ THE SIGNAL THAT COULD NEVER FIRE. findOutOfOrderMentions asked whether a
  //    character's FIRST mention was in a LATER chapter than one that mentions
  //    them — computing "first" over every chapter including this one, so it
  //    was always ≤ this one. Measured 0.00 hits per chapter over 61 DEV
  //    chapters while shipping as one of three continuity signals.
  const ch = (n: number, content: string): Chapter =>
    ({ id: `c${n}`, number: n, title: `Ch ${n}`, content } as Chapter);
  const CAST = { characters: [
    { name: "Teva", aliases: [], role: "", description: "" },
    { name: "Rucastle", aliases: [], role: "", description: "" },
  ], places: [], factions: [], entities: [] } as unknown as WorldData;
  const BOOK = [
    ch(1, "Teva opened the yard at six as she always did, and the river was loud under it."),
    ch(2, "Teva counted the crates again and the number did not change by even one."),
    ch(3, "Teva went down to the gate. “You are late,” said Rucastle, who had been waiting."),
    ch(4, "Teva did not sleep that night and the register stayed shut on the desk."),
    ch(5, "Teva walked the length of the quay until it got dark and the tide turned over."),
  ];
  const arrivals = (i: number) => findUnintroducedArrivals(BOOK, CAST, i).map((h) => h.character);
  gate(arrivals(2).join(",") === "Rucastle",
    "★★ a character who SPEAKS with no earlier mention is found",
    `ch3 → [${arrivals(2).join(", ") || "none"}]`);
  gate(arrivals(0).length === 0,
    "…the opening of a book reports nobody", "every character arrives in chapter one");
  gate(arrivals(3).length === 0 && arrivals(4).length === 0,
    "…and a character already set up is never reported again",
    "Teva was named in chapter one");
  gate(findUnintroducedArrivals(BOOK, undefined, 2).length === 0,
    "…and no cast means no claim", "it reads worldData, which can be empty");

  // ★ CONCRETENESS RANKS, IT NEVER DELETES. Only 16% of emitted phrases are
  //   ever handled by anybody (1174 phrases, six DEV books), so a hard filter
  //   would empty the widget.
  const PROP = "She put the sealed letter under the ledger and said nothing about it to anyone.";
  const ABSTRACT = "He spoke with extreme plainness about the whole business.";
  gate(concretenessOf("sealed letter", PROP, PROP.indexOf("sealed letter")) >
       concretenessOf("extreme plainness", ABSTRACT, ABSTRACT.indexOf("extreme plainness")),
    "a handled object outranks an abstraction",
    "concreteness orders the list the writer reads");

  // ★★ AND HERE IS WHAT THE PROXY CANNOT DO, RECORDED RATHER THAN HIDDEN.
  //    "hearty assent" scores as high as a real prop: "assent" ends in -ent,
  //    which the abstract-suffix list does not cover (adding it would catch
  //    "agent", "parent", "student"), and "gave" counts as handling because
  //    giving assent borrows a handling verb. A bigram regex cannot tell an
  //    abstraction from an object without a lexicon, which is exactly why the
  //    model now has a `not-a-thing` verdict and why concreteness only RANKS.
  //    If this gate ever starts passing, the proxy got better and the note
  //    should be re-measured, not deleted.
  const ASSENT = "She gave her hearty assent to the plan and it was settled.";
  gate(concretenessOf("hearty assent", ASSENT, ASSENT.indexOf("hearty assent")) >= 0.9,
    "★★ …and the proxy still scores 'hearty assent' as a thing (known gap)",
    "the model's not-a-thing verdict is what covers this");
  gate(concretenessOf("wit flowed", "The wit flowed freely at that table.", 4) <
       concretenessOf("brass key", PROP, 0),
    "…and a verb-headed phrase ranks below a noun-headed one", "\"wit flowed\" is not a thing");

  // ★★ THE HAND-OFF NEEDED A TIME WORD ON BOTH SIDES, so it fired 0.04 times
  //    per chapter over 55 DEV boundaries — the third of three signals that was
  //    effectively dead. The common real case is a chapter that ends without
  //    naming a time and opens with one.
  const HANDOFF_BOOK = [
    ch(1, "They worked until the counting was done and nobody said anything more about it."),
    ch(2, "The next morning Teva was at the gate before the foreman, and she had not slept."),
  ];
  gate(detectHandoff(HANDOFF_BOOK, 1, undefined)?.drift === "time",
    "★★ a chapter that OPENS with elapsed time is a hand-off on its own",
    "the previous chapter naming no time is the common case, not an exemption");
  gate(detectHandoff(
    [ch(1, "They worked until it was done."), ch(2, "Teva was at the gate before the foreman.")],
    1, undefined) === null,
    "…and a boundary that announces nothing still reports nothing", "silence is the default");

  // ── the sweep ───────────────────────────────────────────────────────────
  console.log("\n[assist-sweep] order, budget, cancellation\n");

  const SCENES: SceneReviewCandidate[] = [
    {
      sceneIndex: 0, tension: "calm",
      paragraphs: ["She read the letter twice and then set it face down on the table."],
      nearMisses: [{ label: "reckoning", score: 1.18 }, { label: "milieu", score: 1.02 }],
    },
    {
      sceneIndex: 2, tension: "rising",
      paragraphs: ["He counted the crates again, slower, and the number did not change."],
      nearMisses: [{ label: "pursuit", score: 1.31 }, { label: "reckoning", score: 1.27 }],
    },
  ];
  const CHEKHOV = chekhovCandidatesFrom(
    [
      { phrase: "chipped bowl", mentions: 2, sentence: "A chipped bowl sat on the sill where the light got it." },
      { phrase: "sealed letter", mentions: 1, sentence: "She put the sealed letter under the ledger and told no one." },
    ],
    7, 3,
  );
  gate(CHEKHOV.length === 2 && CHEKHOV[0].chaptersSince === 3,
    "chekhov candidates carry the length of the silence", `${CHEKHOV[0].chaptersSince} chapters`);

  const seen: AssistantJSONRequest[] = [];
  const answers: Array<{ key: string; answer: SweepAnswer | null }> = [];
  const stats = await runAssistSweep(
    { chapterId: CHAPTER_ID, chapterContentHash: HASH, scenes: SCENES, chekhov: CHEKHOV },
    {
      run: taskRunner(seen), modelId: MODEL,
      isAsked: () => false,
      onAnswer: (key, answer) => answers.push({ key, answer }),
    },
  );

  const order = seen.map((r) => r.task);
  const lastScene = order.lastIndexOf(SCENE_TASK);
  const firstChekhov = order.indexOf(CHEKHOV_TASK);
  gate(lastScene >= 0 && firstChekhov > lastScene,
    "★ the order is the priority: scene → Chekhov",
    order.map((t) => t.replace("-review", "")).join(" → "));
  gate(stats.asked === 4 && stats.answered === 4,
    "every question inside the budget was asked and answered", JSON.stringify(stats));

  // ★ KEY AGREEMENT. The sweep's key must equal the module's own.
  gate(answers.some((a) => a.key === sceneKeyFor(HASH, 0, MODEL, offeredLabels(SCENES[0]))),
    "★ the key the sweep checks is the key the module stamps",
    "diverge and every answer is stored where nothing looks it up");
  gate(answers.some((a) => a.key === chekhovKeyFor(HASH, "chipped bowl", MODEL)),
    "…and for a Chekhov verdict", "phrase folded in");

  // Caps.
  const many: SceneReviewCandidate[] = Array.from({ length: 9 }, (_, i) => ({
    sceneIndex: i, tension: "calm" as const,
    paragraphs: [`Scene ${i}: she checked the seal again and put it back.`],
    nearMisses: [{ label: "reckoning", score: 1.15 }, { label: "milieu", score: 1.1 }],
  }));
  const capSeen: AssistantJSONRequest[] = [];
  await runAssistSweep(
    { chapterId: CHAPTER_ID, chapterContentHash: HASH, scenes: many, chekhov: CHEKHOV },
    { run: taskRunner(capSeen), modelId: MODEL, isAsked: () => false, onAnswer: () => {} },
  );
  gate(capSeen.filter((r) => r.task === SCENE_TASK).length === 3,
    "★ the cap holds whatever the prose does", "9 near-miss scenes → 3 questions");

  // Already-asked.
  const askedKeys = new Set(answers.map((a) => a.key));
  const repeatSeen: AssistantJSONRequest[] = [];
  const repeat = await runAssistSweep(
    { chapterId: CHAPTER_ID, chapterContentHash: HASH, scenes: SCENES, chekhov: CHEKHOV },
    {
      run: taskRunner(repeatSeen), modelId: MODEL,
      isAsked: (key) => askedKeys.has(key),
      onAnswer: () => {},
    },
  );
  gate(repeatSeen.length === 0 && repeat.skipped === 4,
    "★ a settled chapter asks nothing at all", `${repeat.skipped} skipped, 0 sent`);

  // Cancellation.
  let calls = 0;
  const cancelSeen: AssistantJSONRequest[] = [];
  const cancelled = await runAssistSweep(
    { chapterId: CHAPTER_ID, chapterContentHash: HASH, scenes: SCENES, chekhov: CHEKHOV },
    {
      run: taskRunner(cancelSeen), modelId: MODEL,
      isAsked: () => false, onAnswer: () => { calls++; },
      isCancelled: () => calls >= 1,
    },
  );
  gate(cancelled.cancelled && cancelSeen.length === 1,
    "★ cancellation stops the sweep between items, mid-budget",
    `${cancelSeen.length} sent before the edit landed`);

  // ── the store ───────────────────────────────────────────────────────────
  console.log("\n[assist-sweep] store & selectors\n");

  let store = emptyReviewStore();
  for (const { key, answer } of answers) {
    store = recordReviewAnswer(store, CHAPTER_ID, HASH, MODEL, key, answer, 1000);
  }
  const entry = chapterReviews(store, CHAPTER_ID, HASH, MODEL);
  gate(entry.asked.length === 4, "every question asked is recorded, answered or not",
    `${entry.asked.length} asked · ${Object.keys(entry.scenes).length} scene · ${Object.keys(entry.chekhov).length} chekhov`);

  const staleModel = chapterReviews(store, CHAPTER_ID, HASH, "some-other-model");
  gate(staleModel.asked.length === 0,
    "★ a model swap invalidates the chapter whole", "stale reads as empty, never as partial");
  const staleText = chapterReviews(store, CHAPTER_ID, "4000|different opening", MODEL);
  gate(staleText.asked.length === 0, "…and so does an edit that moves the hash", "pending work is dropped");

  const overlay = sceneLabelOverlay(entry, [0, 2, 4], (i) => offeredLabels(SCENES.find((s) => s.sceneIndex === i)!));
  gate(overlay.get(0)?.label === "reckoning",
    "a model scene label lands on the paragraph its scene starts at", `¶0 → ${overlay.get(0)?.label}`);
  const movedShortlist = sceneLabelOverlay(entry, [0, 2, 4], () => ["pursuit"]);
  gate(movedShortlist.size === 0,
    "★ a re-tuned engine re-points the shortlist, and the old answer stops showing",
    "the question it answered is no longer the question");

  const promises = confirmedPromises(entry);
  gate(promises.size === 0,
    "★ a 'furniture' verdict is stored and renders nothing",
    "the honest majority answer must not delete the writer's list");

  let promiseStore = recordReviewAnswer(
    emptyReviewStore(), CHAPTER_ID, HASH, MODEL, "k1",
    { kind: "chekhov", value: { phrase: "sealed letter", verdict: "promise", confidence: 0.86, reason: "she hides it and tells no one" } },
    1000,
  );
  promiseStore = recordReviewAnswer(
    promiseStore, CHAPTER_ID, HASH, MODEL, "k2",
    { kind: "chekhov", value: { phrase: "loose board", verdict: "promise", confidence: 0.55, reason: "it is only mentioned" } },
    1000,
  );
  const confirmed = confirmedPromises(chapterReviews(promiseStore, CHAPTER_ID, HASH, MODEL));
  gate(confirmed.has("sealed letter") && !confirmed.has("loose board"),
    "only a CONFIDENT promise is marked", `${[...confirmed].join(", ") || "none"}`);

  // ── presence: only the marks the engine DEFERRED become questions ────────
  {
    const text =
      `The hall was cold and the fire had gone out hours before anyone noticed. ` +
      `“We should have sent for Corwin days ago,” said Alder, and nobody answered him. ` +
      `She caught Bramble by the sleeve before he could reach the door. ` +
      `Alder wrote to Corwin twice that winter and burned both of the letters.`;
    const cast = ["Alder", "Bramble", "Corwin"].map((name) => ({ name, variants: [] as string[] }));
    const classified = classifyChapterPresence(text, cast);
    const candidates = presenceCandidatesFrom(classified, text, 4);
    const askedNames = candidates.map((c) => c.name).sort();

    gate(candidates.length > 0, "the sweep has presence questions to ask", `${candidates.length}`);
    // ★ THE PAIRED POSITIVE AND NEGATIVE. "ask about nobody" satisfies any
    //   filter gate perfectly; "ask about everybody" satisfies any coverage
    //   gate. Both directions, on the same fixture.
    gate(candidates.length < classified.filter((p) => p.klass !== "absent").length,
      "…but not about every character in the chapter", `asked ${askedNames.join(", ")}`);
    const decided = classified.filter((p) => p.klass !== "absent" && !p.uncertain).map((p) => p.name);
    gate(decided.every((n) => !askedNames.includes(n)),
      "★ a mark the engine DECIDED is never sent to the model",
      `decided [${decided.join(", ")}] vs asked [${askedNames.join(", ")}]`);
    gate(candidates.every((c) => c.snippets.length > 0 && c.snippets.every((s) => s.trim() !== "")),
      "every question carries verbatim evidence — no snippet, no question");
    gate(candidates.every((c) => !c.snippets.join(" ").includes("PASSAGES")),
      "the snippets are prose, not the prompt scaffolding");
  }

  // ── presence: the store only overrides what it was told to ───────────────
  {
    let s2 = recordReviewAnswer(
      emptyReviewStore(), CHAPTER_ID, HASH, MODEL, presenceKeyFor(HASH, "Corwin", MODEL),
      { kind: "presence", value: { name: "Corwin", verdict: "talked-about", confidence: 0.9,
        reason: "the letters are written to him", applied: "mentioned" } },
      1000,
    );
    s2 = recordReviewAnswer(
      s2, CHAPTER_ID, HASH, MODEL, presenceKeyFor(HASH, "Bramble", MODEL),
      { kind: "presence", value: { name: "Bramble", verdict: "in-the-scene", confidence: 0.5,
        reason: "she catches him by the sleeve", applied: null } },
      1000,
    );
    const entry = chapterReviews(s2, CHAPTER_ID, HASH, MODEL);
    const over = presenceOverrides(entry);
    gate(over.get("corwin") === "mentioned", "a confident answer overrides the mark", `${over.get("corwin")}`);
    gate(!over.has("bramble"),
      "★ a BELOW-FLOOR answer is stored but changes nothing — the engine keeps its call",
      `${over.get("bramble")}`);
    gate(alreadyAsked(entry, presenceKeyFor(HASH, "Bramble", MODEL)),
      "…and is still recorded as asked, so it is not asked again every mount");
  }

  const pruned = pruneReviewStore(store, ["ch-1"]);
  gate(Object.keys(pruned.chapters).length === 0,
    "a deleted chapter stops being answered about", "pruned");
  gate(pruneReviewStore(store, [CHAPTER_ID]) === store,
    "…and pruning nothing returns the same object", "no needless re-render");

  console.log(`\n${failures === 0 ? "✓ ALL GATES GREEN" : `✗ ${failures} GATE(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
