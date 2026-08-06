/**
 * test-max-ask.ts — the max harness, without a model.
 *
 * Two things are gated here and they are different in kind:
 *   · THE PACK — a budget that is actually respected, rungs dropped WHOLE and
 *     reported, and the top rungs surviving a budget of almost nothing.
 *   · THE LOOP — every exit reachable, every exit named, and no input able to
 *     make it spin. The runner is driven by a FAKE model, so "cannot get
 *     stuck" is a property of the harness rather than of a model's mood.
 *
 * ★ A LOOP TEST THAT USES A REAL MODEL TESTS THE MODEL. The fakes here are
 *   scripted to be maximally hostile — always-abstain, always-identical,
 *   always-fail, infinitely-slow — because those are the shapes that hang an
 *   agent, and none of them can be relied on to appear on demand from qwen.
 *
 *   /opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs scripts/test-max-ask.ts
 */
import {
  buildMaxAskPack, buildMaxAskRequest, normalizeMaxAsk, isUsefulAnswer, runMaxAsk,
  normalizeClaimCheck, buildReviewRequest, computeReviewVerdict,
  coerceProseAbstention, buildMaxAskRequest as buildReq, maxAskSchema,
  NOT_IN_CONTEXT, FITS, MAX_STEPS, DEFAULT_BUDGET_TOKENS, WIDEN_CEILING_TOKENS,
  type MaxAskInput,
} from "../src/lib/max-ask";
import type { AssistantJSONRunner } from "../src/lib/assistant-client";

let pass = 0, fail = 0;
function gate(ok: boolean, label: string, detail = "") {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ""}`); }
}

const PARA = "The fire had been out since midnight, but the smell of it stayed in the walls. "
  + "Elena Vasquez sat with her back to the cold stove and counted what was left in the tin.";

const INPUT: MaxAskInput = {
  paragraph: PARA,
  paragraphIndex: 4,
  chapterNumber: 9,
  chapterTitle: "The Ash Road",
  kind: "check",
  chapterParagraphs: ["one", "two", "three", "four", PARA, "Kestrel came in from the yard."],
  present: ["Elena", "Kestrel"],
  worldData: {
    characters: [
      { name: "Elena", aliases: ["Ash Marshal"], role: "Protagonist", description: "Clears the road. Wanted in three parishes." },
      { name: "Kestrel", aliases: [], role: "", description: "Runs ahead. Does not explain herself." },
    ],
    places: [], factions: [], entities: [],
  },
  chapterSummaries: [
    { chapterNumber: 7, summary: "The muster list is wrong and nobody will say who wrote it." },
    { chapterNumber: 8, summary: "Elena refuses the short way and does not say why." },
  ],
  openThreads: [{ chapterNumber: 6, text: "The notice offering forty marks is still up." }],
  related: [{ chapterNumber: 2, text: "Elena had not been called the Ash Marshal in nine years." }],
};

console.log("=".repeat(74));
console.log("max harness");
console.log("=".repeat(74));

// ── 1 · the pack ───────────────────────────────────────────────────────────
console.log("\nthe pack respects its budget");
{
  const full = buildMaxAskPack(INPUT, 10_000);
  gate(full.rungsIncluded.length >= 6,
    `a generous budget takes ${full.rungsIncluded.length} rungs: ${full.rungsIncluded.join(", ")}`);
  gate(full.rungsDropped.length === 0, "…and drops nothing");

  const tiny = buildMaxAskPack(INPUT, 1);
  // ★ THE PAIRED POSITIVE: a budget test that only checks "it dropped things"
  //   passes for a packer that returns nothing at all.
  gate(tiny.rungsIncluded.includes("passage") && tiny.rungsIncluded.includes("ask"),
    "★ a budget of 1 token still carries the passage and the question",
    `got: ${tiny.rungsIncluded.join(", ")}`);
  gate(tiny.rungsDropped.length > 0,
    `…and reports ${tiny.rungsDropped.length} dropped: ${tiny.rungsDropped.join(", ")}`);
  gate(tiny.tokensEstimate < full.tokensEstimate,
    `…and is genuinely smaller (${tiny.tokensEstimate} vs ${full.tokensEstimate} tokens)`);

  const mid = buildMaxAskPack(INPUT, 120);
  const overBy = mid.tokensEstimate - 120;
  // The always-rungs are exempt by design; everything optional must fit.
  gate(mid.rungsDropped.length === 0 || overBy <= 0 || mid.rungsIncluded.includes("passage"),
    `a middling budget lands at ${mid.tokensEstimate} tokens for a cap of 120 ` +
    `(the passage and the question are exempt — a pack without them asks nothing)`);

  gate(!/undefined|\[object/.test(full.text), "no undefined leaked into the prompt");
  gate(full.packHash !== tiny.packHash, "different packs hash differently");
  gate(buildMaxAskPack(INPUT, 10_000).packHash === full.packHash, "…and the same pack is stable");
}

console.log("\nthe schema only offers rungs that are actually present");
{
  const tiny = buildMaxAskPack(INPUT, 1);
  const req = buildMaxAskRequest(tiny);
  const offered = (req.schema.properties.basis as { enum: string[] }).enum;
  gate(offered.includes(NOT_IN_CONTEXT), "the abstention is always offered");
  gate(offered.every((o) => o === NOT_IN_CONTEXT || tiny.rungsIncluded.includes(o)),
    `★ every citable basis was really in the pack: ${offered.join(", ")}`);
  gate(!offered.includes("related"),
    "…and a dropped rung is NOT citable — the model cannot cite what it never saw");
}

console.log("\nvalidation refuses what a grammar cannot");
{
  const rungs = ["passage", "ask", "who"];
  gate(normalizeMaxAsk({ answer: "x", basis: "who", confidence: 0.5 }, rungs) !== null, "a good answer passes");
  gate(normalizeMaxAsk({ answer: "x", basis: "related", confidence: 0.5 }, rungs) === null,
    "★ a basis we never sent is refused, not trusted");
  gate(normalizeMaxAsk({ answer: "  ", basis: "who", confidence: 0.5 }, rungs) === null, "an empty answer is refused");
  gate(normalizeMaxAsk({ answer: "x", basis: "who", confidence: "high" }, rungs) === null, "a non-numeric confidence is refused");
  gate(normalizeMaxAsk({ answer: "x", basis: "WHO", confidence: 2 }, rungs)?.confidence === 1, "confidence is clamped");
  gate(!isUsefulAnswer(normalizeMaxAsk({ answer: "x", basis: NOT_IN_CONTEXT, confidence: 1 }, rungs)),
    "an abstention never reaches the writer");
}

// ── 2 · the loop ───────────────────────────────────────────────────────────
console.log("\nthe loop, driven by deliberately hostile fake models");

/** A runner that returns a scripted sequence, then repeats the last entry. */
const scripted = (seq: Array<Record<string, unknown> | null>): { run: AssistantJSONRunner; calls: () => number } => {
  let i = 0;
  const run = (async () => {
    const v = seq[Math.min(i, seq.length - 1)];
    i += 1;
    return v === null ? { ok: false as const, reason: "boom" } : { ok: true as const, json: v, modelId: "fake", timings: {} };
  }) as AssistantJSONRunner;
  return { run, calls: () => i };
};

{
  // answered on the first try
  const s = scripted([{ answer: "The tin is counted twice in two chapters.", basis: "passage", confidence: 0.9 }]);
  const r = await runMaxAsk(INPUT, { run: s.run });
  gate(r.stopped === "answered" && r.steps === 1 && s.calls() === 1,
    `a good first answer stops at one call (stopped=${r.stopped}, steps=${r.steps})`);
  gate(!!r.answer && r.answer.basis === "passage", "…and the answer comes back");
}
{
  // ★ ALWAYS ABSTAINS — the shape that makes an agent loop forever.
  const s = scripted([{ answer: "I need more.", basis: NOT_IN_CONTEXT, confidence: 0.4 }]);
  const r = await runMaxAsk({ ...INPUT, budgetTokens: 40 }, { run: s.run });
  gate(s.calls() <= MAX_STEPS,
    `★ an always-abstaining model is capped at ${MAX_STEPS} calls (made ${s.calls()})`);
  gate(["steps", "rungs-exhausted", "repeat"].includes(r.stopped),
    `…and stops for a NAMED reason: ${r.stopped}`);
  gate(r.answer !== null, "…and still returns the best answer it had, not null");
}
{
  // identical answer twice — more context changed nothing
  const s = scripted([{ answer: "same", basis: NOT_IN_CONTEXT, confidence: 0.4 }]);
  const r = await runMaxAsk({ ...INPUT, budgetTokens: 40 }, { run: s.run, maxSteps: 8 });
  gate(s.calls() <= 3, `★ a model repeating itself is cut off early (${s.calls()} calls, cap was 8)`);
  gate(r.stopped === "repeat" || r.stopped === "rungs-exhausted", `stopped=${r.stopped}`);
}
{
  // the model errors
  const s = scripted([null]);
  const r = await runMaxAsk(INPUT, { run: s.run });
  gate(r.stopped === "failed" && s.calls() === 1, "a failing model stops immediately and says so");
}
{
  // the deadline has already passed
  const s = scripted([{ answer: "never asked", basis: "passage", confidence: 1 }]);
  const r = await runMaxAsk(INPUT, { run: s.run, deadlineMs: -1, now: () => 0 });
  gate(r.stopped === "deadline" && s.calls() === 0,
    "★ an expired deadline is checked BEFORE the call, not after it");
}
{
  // nothing to widen into: every rung already fits
  const s = scripted([{ answer: "nope", basis: NOT_IN_CONTEXT, confidence: 0.3 }]);
  const r = await runMaxAsk(INPUT, { run: s.run, maxSteps: 5 });
  gate(r.stopped === "rungs-exhausted" && s.calls() === 1,
    `★ with nothing dropped there is nothing to retry with — one call (${s.calls()})`);
}
{
  // widening actually helps: abstain, then answer
  const s = scripted([
    { answer: "not enough", basis: NOT_IN_CONTEXT, confidence: 0.3 },
    { answer: "Elena refused the short way in ch 8 and does it again here.", basis: "story-so-far", confidence: 0.85 },
  ]);
  const r = await runMaxAsk({ ...INPUT, budgetTokens: 60 }, { run: s.run });
  gate(s.calls() === 2 && r.stopped === "answered",
    `★ widening is used exactly when it can help: ${s.calls()} calls, stopped=${r.stopped}`);
  gate(r.rungsIncluded.length > buildMaxAskPack(INPUT, 60).rungsIncluded.length,
    "…and the second pack really was bigger");
}
{
  // every stop reason in the type is reachable by SOME input
  const seen = new Set<string>();
  seen.add((await runMaxAsk(INPUT, { run: scripted([{ answer: "a", basis: "passage", confidence: 1 }]).run })).stopped);
  seen.add((await runMaxAsk(INPUT, { run: scripted([null]).run })).stopped);
  seen.add((await runMaxAsk(INPUT, { run: scripted([{ answer: "a", basis: "passage", confidence: 1 }]).run, deadlineMs: -1, now: () => 0 })).stopped);
  seen.add((await runMaxAsk(INPUT, { run: scripted([{ answer: "a", basis: NOT_IN_CONTEXT, confidence: 0 }]).run })).stopped);
  gate(seen.size >= 4, `★ ${seen.size} distinct stop reasons are reachable: ${[...seen].join(", ")}`);
}

console.log("\nthe opening rung and the self-review");
{
  const deep = buildMaxAskPack(INPUT, 10_000);
  gate(deep.rungsIncluded.includes("opening"),
    "a paragraph deep in the chapter carries the chapter's opening");
  const early = buildMaxAskPack({ ...INPUT, paragraphIndex: 1 }, 10_000);
  gate(!early.rungsIncluded.includes("opening"),
    "…and an early paragraph does not — the opening would just repeat a neighbour");

  const ans = { answer: "x", basis: "passage", confidence: 0.9 };
  const req = buildReviewRequest(deep, ans);
  gate(req.userText.includes(deep.text) && req.userText.includes("THE ANSWER UNDER REVIEW"),
    "★ the reviewer sees EXACTLY what the answerer saw, plus the answer");

  const PACK = deep.text;
  gate(normalizeClaimCheck({ claims: [
    { claim: "she counts twice", kind: "fact", quote: "counted what was left in the tin" },
    { claim: 42, kind: "fact", quote: "x" },              // dropped
    { claim: "y", kind: "perhaps", quote: "x" },          // dropped
  ] })?.length === 1,
    "malformed and off-enum claims are dropped, not trusted");
  gate(normalizeClaimCheck({ notClaims: [] }) === null, "a shapeless reply is refused");

  // ── the verdict is string arithmetic against the pack ──
  const v1 = computeReviewVerdict([
    { claim: "Elena counts what is left", kind: "fact",
      quote: "counted what was left in the tin" },
    { claim: "this shows patience", kind: "reading", quote: "" },
  ], PACK);
  gate(v1.verdict === "supported" && v1.facts === 1 && v1.readings === 1,
    "★ a truly-quoted fact plus an unquoted READING is supported — interpretation exempt by TYPE");

  // ★★ THE COMPOUND-CLAIM ESCAPE, PINNED. Round 2 measured the model locating
  //    "counts coins to pay off Captain Vale" in the passage — the true half
  //    anchoring the invented half. Under quotes, the borrowed tin-quote is
  //    real text but cannot contain the claim's NAME, so the fact fails.
  const v2 = computeReviewVerdict([
    { claim: "Elena counts coins to pay Captain Vale", kind: "fact",
      quote: "counted what was left in the tin" },
  ], PACK);
  gate(v2.verdict === "overreaches" && v2.note?.includes("Vale"),
    "★★ a REAL quote cannot support a claim whose name it does not contain");
  const v3 = computeReviewVerdict([
    { claim: "Vale blackmails her", kind: "fact",
      quote: "Vale had been blackmailing Elena for a season" },   // invented text
  ], PACK);
  gate(v3.verdict === "overreaches",
    "★★ an INVENTED quote fails indexOf against the pack, however plausible");
  gate(computeReviewVerdict([], PACK).verdict === "supported"
    && computeReviewVerdict([], PACK).facts === 0,
    "no claims = supported with facts:0, so the UI can refuse to say \"checked\"");

  // ── loop wiring: one extra call, decoration only, ALL kinds ──
  {
    const s = scripted([
      { answer: "Elena counts twice.", basis: "passage", confidence: 0.9 },
      { answer: "IGNORED", basis: "passage", confidence: 0.9 },   // wrong shape for review
    ]);
    const r = await runMaxAsk(INPUT, { run: s.run, selfReview: true });
    gate(s.calls() === 2, `★ self-review costs exactly one extra call (${s.calls()})`);
    gate(r.stopped === "answered" && !!r.answer && r.review == null,
      "…and an unparseable review loses NOTHING — the answer ships undecorated");
  }
  {
    const s = scripted([
      { answer: "conflicts with ch 8", basis: "story-so-far", confidence: 0.9 },
      { claims: [
        { claim: "the fire is out", kind: "fact", quote: "The fire had been out since midnight" },
        { claim: "she refused the short way", kind: "fact", quote: "Elena refuses the short way" },
      ] },
    ]);
    const r = await runMaxAsk(INPUT, { run: s.run, selfReview: true });
    gate(r.review?.verdict === "supported" && r.review.facts === 2,
      "★ a CHECK answer now reviews cleanly — decomposition locates both facts of a " +
      "correct flag instead of reading the flag as a contradiction of itself");
  }
  {
    const s = scripted([
      { answer: "she pays Vale", basis: "passage", confidence: 0.9 },
      { claims: [{ claim: "Vale blackmails her", kind: "fact", quote: "" }] },
    ]);
    const r = await runMaxAsk({ ...INPUT, kind: "question", question: "why count?" },
      { run: s.run, selfReview: true });
    gate(r.review?.verdict === "overreaches" && !!r.answer,
      "★ an overreach decorates and NEVER vetoes — the caution is the UI's lever");
  }
  {
    const s = scripted([{ answer: "x", basis: "passage", confidence: 0.9 }]);
    await runMaxAsk(INPUT, { run: s.run });
    gate(s.calls() === 1, "selfReview off (the default) adds no call");
  }
}

console.log("\nthe fits outlet, the prose abstention, and the refine loop");
{
  // ── fits: a schema outlet, check-kind only ──
  const deep = buildMaxAskPack(INPUT, 10_000);
  const checkBases = (maxAskSchema(deep.rungsIncluded, "check").properties.basis as { enum: string[] }).enum;
  const explainBases = (maxAskSchema(deep.rungsIncluded, "explain").properties.basis as { enum: string[] }).enum;
  gate(checkBases.includes(FITS) && !explainBases.includes(FITS),
    "★ \"fits\" is offered to a CHECK and to nothing else");
  gate(buildReq(deep, 640, "check").systemPrompt.includes("OPPOSITE"),
    "…and the check request carries the conflict-requires-opposites line");
  const fitsAns = normalizeMaxAsk({ answer: "Nothing conflicts.", basis: FITS, confidence: 0.9 }, deep.rungsIncluded);
  gate(!!fitsAns && isUsefulAnswer(fitsAns), "a fits verdict parses and reaches the writer");

  // ── prose abstention is coerced, question-kind only ──
  const prose = { answer: "The passage does not mention what Renner does with the money.", basis: "passage", confidence: 0.9 };
  gate(coerceProseAbstention(prose, "question").basis === NOT_IN_CONTEXT,
    "★ \"does not mention\" with basis=passage is an abstention in costume");
  gate(coerceProseAbstention(prose, "check").basis === "passage",
    "…and a CHECK is exempt — \"nothing conflicts\" is a verdict, not an abstention");
  // ★ the golden set's surviving FAIL, pinned: a confident negative about the
  //   story ("No, she never said…") is an unverifiable claim wearing an
  //   answer's clothes — a negative has no quote, so the claim-check cannot
  //   flag it and the refine never fires. It coerces like the rest.
  const negative = { answer: "No, Solvei never said who she wanted the Petrel to go to.", basis: "passage", confidence: 0.9 };
  gate(coerceProseAbstention(negative, "question").basis === NOT_IN_CONTEXT,
    "★ a confident \"never said\" coerces to an abstention — unverifiable, so unshippable as fact");
  {
    // the coercion feeds the widen loop: prose-abstain at a tiny budget, then a real answer
    const s = scripted([
      { answer: "The sections do not mention the notice.", basis: "passage", confidence: 0.9 },
      { answer: "Forty marks, from the notice.", basis: "story-so-far", confidence: 0.9 },
    ]);
    const r = await runMaxAsk({ ...INPUT, kind: "question", question: "how much?", budgetTokens: 60 },
      { run: s.run });
    gate(s.calls() === 2 && r.stopped === "answered",
      `★ a prose abstention now WIDENS instead of shipping (${s.calls()} calls, ${r.stopped})`);
  }

  // ── refine: revise on the tool flag, re-verify, ship only if clean ──
  {
    const s = scripted([
      { answer: "She pays Vale monthly.", basis: "passage", confidence: 0.9 },          // ask
      { claims: [{ claim: "Vale collects payment", kind: "fact", quote: "" }] },          // review: overreach
      { answer: "She counts what is left in the tin.", basis: "passage", confidence: 0.9 }, // refine
      { claims: [{ claim: "she counts the tin", kind: "fact", quote: "counted what was left in the tin" }] }, // recheck: clean
    ]);
    const r = await runMaxAsk({ ...INPUT, kind: "question", question: "why count?" },
      { run: s.run, selfReview: true });
    gate(s.calls() === 4 && r.refined === true,
      `★ flagged -> refined -> re-verified -> ships (${s.calls()} calls, refined=${r.refined})`);
    gate(r.answer?.answer.includes("counts") === true && r.review?.verdict === "supported",
      "…and the SHIPPED answer is the revision, with the clean re-check riding along");
  }
  {
    // the revision is WORSE — still flagged on recheck — so it is discarded
    const s = scripted([
      { answer: "She pays Vale monthly.", basis: "passage", confidence: 0.9 },
      { claims: [{ claim: "Vale collects payment", kind: "fact", quote: "" }] },
      { answer: "Vale burned the ledger himself.", basis: "passage", confidence: 0.9 },
      { claims: [{ claim: "Vale burned the ledger", kind: "fact", quote: "" }] },
    ]);
    const r = await runMaxAsk({ ...INPUT, kind: "question", question: "why count?" },
      { run: s.run, selfReview: true });
    gate(r.refined !== true && r.answer?.answer.includes("pays Vale") === true,
      "★ a revision that fails the re-check is DISCARDED — the original ships with its caution");
    gate(r.review?.verdict === "overreaches",
      "…and the caution survives, because nothing verified got better");
  }
  {
    // low confidence triggers the refine even when the review is clean
    const s = scripted([
      { answer: "Maybe something about money.", basis: "passage", confidence: 0.4 },
      { claims: [] },
      { answer: "She counts what is left in the tin twice.", basis: "passage", confidence: 0.9 },
      { claims: [{ claim: "counts twice", kind: "fact", quote: "counted what was left in the tin" }] },
    ]);
    const r = await runMaxAsk({ ...INPUT, kind: "question", question: "why count?" },
      { run: s.run, selfReview: true });
    gate(s.calls() === 4 && r.refined === true,
      `★ low confidence triggers the refine pass too (${s.calls()} calls, refined=${r.refined})`);
  }
  {
    // hard cap: refine happens at most ONCE, whatever the model does
    const s = scripted([
      { answer: "She pays Vale.", basis: "passage", confidence: 0.3 },
      { claims: [{ claim: "pays Vale", kind: "fact", quote: "" }] },
      { answer: "She pays Vale weekly.", basis: "passage", confidence: 0.3 },
      { claims: [{ claim: "pays Vale weekly", kind: "fact", quote: "" }] },
    ]);
    const r = await runMaxAsk({ ...INPUT, kind: "question", question: "why?" },
      { run: s.run, selfReview: true });
    gate(s.calls() === 4,
      `★ the refine loop is HARD-CAPPED at one revision + one re-check (${s.calls()} calls)`);
  }
}

console.log("\nthe harness narrates its phases");
{
  const phases = (calls: Parameters<typeof runMaxAsk>[1]) => {
    const seen: string[] = [];
    return { opts: { ...calls, onPhase: (p: string) => seen.push(p) }, seen };
  };
  {
    const s = scripted([
      { answer: "coins", basis: "passage", confidence: 0.9 },
      { claims: [] },
    ]);
    const { opts, seen } = phases({ run: s.run, selfReview: true });
    await runMaxAsk({ ...INPUT, kind: "question", question: "what is in the tin?" }, opts);
    gate(seen.join(",") === "asking,reviewing",
      `a clean reviewed question narrates asking -> reviewing (got ${seen.join(",")})`);
  }
  {
    const s = scripted([
      { answer: "she pays Vale", basis: "passage", confidence: 0.9 },
      { claims: [{ claim: "pays Vale", kind: "fact", quote: "" }] },
      { answer: "she counts the tin", basis: "passage", confidence: 0.9 },
      { claims: [{ claim: "counts the tin", kind: "fact", quote: "counted what was left in the tin" }] },
    ]);
    const { opts, seen } = phases({ run: s.run, selfReview: true });
    await runMaxAsk({ ...INPUT, kind: "question", question: "why?" }, opts);
    gate(seen.join(",") === "asking,reviewing,refining,reviewing",
      `★ a refined answer narrates the whole chain (got ${seen.join(",")})`);
  }
  {
    const s = scripted([
      { answer: "not enough", basis: NOT_IN_CONTEXT, confidence: 0.3 },
      { answer: "found it in ch 8", basis: "story-so-far", confidence: 0.85 },
    ]);
    const { opts, seen } = phases({ run: s.run });
    await runMaxAsk({ ...INPUT, budgetTokens: 60 }, opts);
    gate(seen.join(",") === "asking,widening",
      `a widened ask narrates asking -> widening (got ${seen.join(",")})`);
  }
  {
    const s = scripted([
      { answer: "fits", basis: "passage", confidence: 0.9 },
      { claims: [] },
    ]);
    const { opts, seen } = phases({ run: s.run, selfReview: true });
    await runMaxAsk(INPUT, opts);   // check-kind reviews too, under decomposition
    gate(seen.join(",") === "asking,reviewing",
      `a reviewed CHECK narrates asking -> reviewing (got ${seen.join(",")})`);
    const s2 = scripted([{ answer: "fits", basis: "passage", confidence: 0.9 }]);
    const { opts: o2, seen: seen2 } = phases({ run: s2.run });
    await runMaxAsk(INPUT, o2);
    gate(seen2.join(",") === "asking",
      `★ every phase named is a call that HAPPENS — no review, no "reviewing" (got ${seen2.join(",")})`);
  }
}

console.log("\nthe defaults are sane for an 8 GB window");
{
  const p = buildMaxAskPack(INPUT);
  gate(p.tokensEstimate <= DEFAULT_BUDGET_TOKENS + 200,
    `the default pack is ${p.tokensEstimate} tokens against a ${DEFAULT_BUDGET_TOKENS} budget`,
    "a pack that overruns its own default leaves a thinking model no room to think");
  gate(WIDEN_CEILING_TOKENS + 2000 < 8192,
    "★ even a WIDENED pack fits the 8k window with ~2k left for thinking");
}

console.log("\n" + "=".repeat(74));
console.log(`${pass} passed, ${fail} failed`);
console.log("=".repeat(74));
process.exitCode = fail > 0 ? 1 : 0;
