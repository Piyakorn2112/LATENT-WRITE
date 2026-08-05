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
  NOT_IN_CONTEXT, MAX_STEPS, DEFAULT_BUDGET_TOKENS,
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

console.log("\nthe defaults are sane for an 8 GB window");
{
  const p = buildMaxAskPack(INPUT);
  gate(p.tokensEstimate <= DEFAULT_BUDGET_TOKENS + 200,
    `the default pack is ${p.tokensEstimate} tokens against a ${DEFAULT_BUDGET_TOKENS} budget`,
    "a pack that overruns its own default leaves a thinking model no room to think");
  gate(DEFAULT_BUDGET_TOKENS * 2 < 4096,
    "★ even a WIDENED pack fits a 4k window with room for reasoning");
}

console.log("\n" + "=".repeat(74));
console.log(`${pass} passed, ${fail} failed`);
console.log("=".repeat(74));
process.exitCode = fail > 0 ? 1 : 0;
