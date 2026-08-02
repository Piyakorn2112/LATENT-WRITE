/**
 * test-chapter-summary.ts — GATED, model-free harness for chapter summaries.
 *
 * The summary is the visible half of the timeline's enhanced mode, so what is
 * gated here is the part that must hold whatever the model says: the request
 * carries only derived material, the validator rejects a non-summary, and the
 * cache key moves when and only when the chapter's moments do.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-chapter-summary.ts
 */
import {
  buildSummaryRequest,
  normalizeSummary,
  summaryKeyFor,
  SUMMARY_EVENT_CAP,
  SUMMARY_MAX_CHARS,
} from "../src/lib/chapter-summary";
import type { ChapterGraphEntry, MajorEvent } from "../src/types";

let failures = 0;
const gate = (ok: boolean, label: string, detail: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label} — ${detail}`);
  if (!ok) failures++;
};

const event = (rank: number, sentence: string, agent?: string): MajorEvent => ({
  label: sentence.slice(0, 30), type: "confrontation",
  tensionPosition: 0.4 + rank * 0.08, confidence: 0.8,
  sentence, rank, agent, paragraphIndex: rank,
});

const entry = (over: Partial<ChapterGraphEntry> = {}): ChapterGraphEntry => ({
  chapterId: "c7", chapterNumber: 7, chapterTitle: "The Long Count",
  role: "pivot", tensionPeak: 0.72, tensionCurve: [0.2, 0.4, 0.72, 0.5],
  charactersPresent: ["Ferren Ash", "Wick Odlum", "Marda Kelp"],
  wordCount: 2400, proseRegister: "plain", lastUpdated: 0,
  contentHash: "2400|The count came up short",
  majorEvents: [
    event(0, "Ferren Ash admitted the count had been short for a month."),
    event(1, "Wick Odlum resigned his post before the meeting ended."),
    event(2, "The clerk refused to carry the ledger to the hall."),
  ],
  ...over,
});

console.log("═".repeat(70));
console.log("chapter summary — request, validation, and staleness");
console.log("═".repeat(70));

// ── 1. The request carries derived material only ─────────────────────────
{
  const req = buildSummaryRequest(entry());
  gate(
    req.userText.includes("Ferren Ash admitted the count") &&
    req.userText.includes("PRESENT: Ferren Ash") &&
    req.userText.includes("CHAPTER 7"),
    "the request carries moments, cast and chapter",
    `${req.offered.length} moments offered`,
  );
  const many = entry({
    majorEvents: Array.from({ length: 12 }, (_, i) => event(i, `Moment number ${i} happened.`)),
  });
  gate(
    buildSummaryRequest(many).offered.length === SUMMARY_EVENT_CAP,
    "moments are capped",
    `${buildSummaryRequest(many).offered.length} of 12, cap ${SUMMARY_EVENT_CAP}`,
  );
  // ★ Offered in RANK order, not array order — the same rule the chips follow.
  const shuffled = entry({
    majorEvents: [event(2, "Third by rank."), event(0, "First by rank."), event(1, "Second by rank.")],
  });
  gate(
    buildSummaryRequest(shuffled).offered[0]?.sentence === "First by rank.",
    "moments are offered strongest first",
    buildSummaryRequest(shuffled).offered.map((e) => e.rank).join(","),
  );
}

// ── 2. The validator rejects a non-summary ───────────────────────────────
{
  gate(normalizeSummary(null) === null, "null is rejected", "null in, null out");
  gate(normalizeSummary({}) === null, "a missing summary is rejected", "no summary field");
  gate(normalizeSummary({ summary: "   " }) === null, "whitespace is rejected", "blank");
  gate(normalizeSummary({ summary: "Too short" }) === null, "a fragment is rejected", '"Too short"');

  const blurb = normalizeSummary({ summary: "In this chapter, Ferren admits the count was short." });
  gate(
    !!blurb && !/^in this chapter/i.test(blurb.summary) && blurb.summary.startsWith("Ferren"),
    "the blurb opener is stripped, not kept",
    blurb?.summary ?? "(rejected)",
  );

  const newlines = normalizeSummary({ summary: "Ferren admitted the shortfall.\n\nWick resigned." });
  gate(
    !!newlines && !newlines.summary.includes("\n"),
    "newlines are collapsed",
    newlines?.summary ?? "(rejected)",
  );

  const long = normalizeSummary({ summary: `Ferren admitted the shortfall. ${"and it went on ".repeat(60)}` });
  gate(
    !!long && long.summary.length <= SUMMARY_MAX_CHARS,
    "an over-long summary is trimmed, not dropped",
    `${long?.summary.length ?? 0} chars, cap ${SUMMARY_MAX_CHARS}`,
  );

  const overThrough = normalizeSummary({
    summary: "Ferren admitted the shortfall and Wick resigned.",
    throughline: "x".repeat(200),
  });
  gate(
    !!overThrough && overThrough.throughline === undefined,
    "an over-long throughline is dropped, the summary survives",
    "throughline omitted",
  );
  const noThrough = normalizeSummary({ summary: "Ferren admitted the shortfall and Wick resigned." });
  gate(!!noThrough && noThrough.throughline === undefined, "a missing throughline is fine", "optional");
}

// ── 3. Staleness moves with the moments, not with anything else ──────────
{
  const base = entry();
  const key = summaryKeyFor(base, "m1");
  gate(key === summaryKeyFor(entry(), "m1"), "same entry, same key", key);
  gate(key !== summaryKeyFor(base, "m2"), "a different model invalidates", "model id is in the key");
  gate(
    key !== summaryKeyFor(entry({ contentHash: "2401|The count came up short" }), "m1"),
    "edited text invalidates",
    "content hash is in the key",
  );
  gate(
    key !== summaryKeyFor(entry({
      majorEvents: [event(0, "Ferren Ash denied everything."), event(1, "Wick Odlum resigned his post before the meeting ended.")],
    }), "m1"),
    "changed moments invalidate",
    "event fingerprint is in the key",
  );
  // ★ The summary describes the moments, so it must not outlive a re-rank even
  //   when the text is untouched — this is the case a content hash alone misses.
  const reranked = entry({
    majorEvents: [
      event(0, "Wick Odlum resigned his post before the meeting ended."),
      event(1, "Ferren Ash admitted the count had been short for a month."),
      event(2, "The clerk refused to carry the ledger to the hall."),
    ],
  });
  gate(
    key !== summaryKeyFor(reranked, "m1"),
    "a RE-RANK with identical text invalidates",
    "same contentHash, different fingerprint",
  );
}

console.log(`\n${failures === 0 ? "✓ ALL GATES GREEN" : `✗ ${failures} GATE(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
