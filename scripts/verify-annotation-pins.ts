/**
 * verify-annotation-pins.ts — a correction must stick to ITS SPAN, reach every
 * downstream consumer, and touch nothing else.
 *
 * The three properties that make pins safe, each asserted against the real
 * analysis pipeline rather than a mock:
 *
 *   STICKS   the corrected span carries the user's answer
 *   TRAVELS  the prediction traces carry it too, so the story graph, the
 *            timeline, the chips and every LLM prompt inherit it (the old
 *            override lived in HighlightLayer and reached none of them)
 *   INERT    every span the user did NOT correct is byte-identical to the
 *            unpinned baseline — this is what "cannot degrade the base
 *            engine" means operationally
 *
 * Plus the writing-app case the old index anchoring got wrong: inserting a
 * paragraph above a correction must not re-point it onto a different line.
 *
 * Run: ./node_modules/.bin/tsx scripts/verify-annotation-pins.ts
 */
import { runChapterAnalysis } from "../src/lib/chapter-analysis-runner";
import { applyPinsToAnalysis, applyResolvedPins, resolvePins } from "../src/lib/annotation-pins";
import type { AnnotationCorrection, Chapter } from "../src/types";

const results: Array<{ name: string; ok: boolean }> = [];
function gate(name: string, ok: boolean, detail = "") {
  results.push({ name, ok });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
}

const BODY = [
  `Mara set the lantern on the table. "We should go before the tide turns," she said.`,
  `"The boat will not hold three," Theo answered from the doorway.`,
  `"Then we walk." Mara pulled her coat from the hook.`,
  `Theo shook his head slowly.`,
  `"You have never walked that road at night," he said.`,
  `"I have done worse things than walk."`,
  `The lantern guttered and went out.`,
].join("\n\n");

const KNOWN = ["Mara", "Theo"];

function analyse(content: string) {
  const chapter: Chapter = { id: "ch1", number: 1, title: "Tide", content };
  return runChapterAnalysis({
    chapter, prevContext: null, siblingStats: [], knownNames: KNOWN,
    level: "default", collectPredictionDetails: true,
  });
}

function correction(over: Partial<AnnotationCorrection> & {
  paragraphIndex: number; spanIndex: number; spanText: string;
  contextBefore: string; contextAfter: string; correctedSpeaker: string | null;
}): AnnotationCorrection {
  return {
    id: `pin-${over.paragraphIndex}-${over.spanIndex}`,
    timestamp: 1,
    chapterId: "ch1",
    spanType: "speech",
    originalSpeaker: null,
    ...over,
  } as AnnotationCorrection;
}

/** Every (paragraph, span) → speaker, for whole-result comparison. */
function speakerMap(r: ReturnType<typeof analyse>) {
  const m = new Map<string, string | null>();
  r.speechResults.forEach((para, pi) => {
    para?.segments.forEach((s, si) => {
      if (s.type === "speech") m.set(`${pi}|${si}`, s.speaker ?? null);
    });
  });
  return m;
}

function main() {
  const base = analyse(BODY);
  const paragraphs = base.paragraphs;

  // Pick a real speech span and pin it to the OTHER character, so the pin is
  // always a genuine change rather than an accidental agreement.
  let target: { pi: number; si: number; text: string; got: string | null } | null = null;
  base.speechResults.forEach((para, pi) => {
    para?.segments.forEach((s, si) => {
      if (target || s.type !== "speech" || !s.speaker) return;
      target = { pi, si, text: paragraphs[pi].slice(s.start, s.end), got: s.speaker ?? null };
    });
  });
  if (!target) { console.log("no speech span found — fixture broken"); process.exit(1); }
  const t = target as { pi: number; si: number; text: string; got: string | null };
  const wanted = t.got === "Mara" ? "Theo" : "Mara";
  console.log(`\nfixture: paragraph ${t.pi} span ${t.si} detected "${t.got}", pinning to "${wanted}"\n`);

  const seg = base.speechResults[t.pi].segments[t.si];
  const pin = correction({
    paragraphIndex: t.pi, spanIndex: t.si, spanText: t.text,
    contextBefore: paragraphs[t.pi].slice(0, seg.start),
    contextAfter: paragraphs[t.pi].slice(seg.end),
    correctedSpeaker: wanted, originalSpeaker: t.got,
  });

  // ── STICKS ────────────────────────────────────────────────────────────────
  console.log("1. the pin sticks to its span");
  const pinned = applyPinsToAnalysis(base, [pin]);
  gate("corrected span carries the user's answer",
    pinned.speechResults[t.pi].segments[t.si].speaker === wanted,
    `got=${pinned.speechResults[t.pi].segments[t.si].speaker}`);

  // ── INERT ─────────────────────────────────────────────────────────────────
  console.log("\n2. everything else is untouched");
  const before = speakerMap(base);
  const after = speakerMap(pinned);
  let changed = 0;
  for (const [k, v] of before) if (after.get(k) !== v) changed++;
  gate("exactly one span changed", changed === 1, `changed=${changed}`);
  gate("no spans added or lost", before.size === after.size);
  gate("no-corrections call returns the SAME object", applyPinsToAnalysis(base, []) === base);

  // ── TRAVELS ───────────────────────────────────────────────────────────────
  console.log("\n3. the answer reaches downstream consumers");
  const trace = pinned.speechPredictions.find(
    (p) => p.paragraphIndex === t.pi && p.spanIndex === t.si && p.task !== "action",
  );
  gate("a prediction trace exists for the span", !!trace);
  gate("trace carries the pinned label (story graph, chips, LLM)",
    !trace || trace.predictedLabel === wanted, `predictedLabel=${trace?.predictedLabel}`);

  // ── narrative / none ──────────────────────────────────────────────────────
  console.log("\n4. pinning to narrative removes the speaker");
  const nonePin = { ...pin, id: "pin-none", correctedSpeaker: null };
  const noned = applyPinsToAnalysis(base, [nonePin]);
  gate("speaker is absent, not the string 'null'",
    noned.speechResults[t.pi].segments[t.si].speaker === undefined,
    `got=${String(noned.speechResults[t.pi].segments[t.si].speaker)}`);

  // ── the writing-app case ──────────────────────────────────────────────────
  console.log("\n5. the pin survives an edit above it (index anchoring did not)");
  const shifted = analyse(`The tide was already turning.\n\n${BODY}`);
  const resolved = resolvePins([pin], shifted);
  gate("pin re-locates by content", resolved[0]?.via === "content",
    `via=${resolved[0]?.via} para=${resolved[0]?.paragraphIndex}`);
  gate("pin lands one paragraph lower, on the SAME sentence",
    resolved[0]?.paragraphIndex === t.pi + 1,
    `expected=${t.pi + 1} got=${resolved[0]?.paragraphIndex}`);
  const shiftedPinned = applyPinsToAnalysis(shifted, [pin]);
  const movedText = shifted.paragraphs[t.pi + 1]?.slice(
    shifted.speechResults[t.pi + 1]?.segments[resolved[0].spanIndex]?.start ?? 0,
    shifted.speechResults[t.pi + 1]?.segments[resolved[0].spanIndex]?.end ?? 0,
  );
  gate("the pinned text is the original sentence", movedText === t.text,
    `"${String(movedText).slice(0, 40)}"`);
  gate("and it carries the user's answer",
    shiftedPinned.speechResults[t.pi + 1]?.segments[resolved[0].spanIndex]?.speaker === wanted);
  // The old behaviour: blindly trusting the stored index would land here.
  const wrongSpan = shifted.paragraphs[t.pi]?.slice(
    shifted.speechResults[t.pi]?.segments[t.si]?.start ?? 0,
    shifted.speechResults[t.pi]?.segments[t.si]?.end ?? 0,
  );
  gate("index anchoring would have hit a DIFFERENT span", wrongSpan !== t.text,
    `index-${t.pi}/${t.si} now holds "${String(wrongSpan).slice(0, 40)}"`);

  // ── deleted text ──────────────────────────────────────────────────────────
  console.log("\n6. a pin whose sentence was deleted is dropped, not misapplied");
  const withoutTarget = BODY.split("\n\n").filter((_, i) => i !== t.pi).join("\n\n");
  const deleted = analyse(withoutTarget);
  const afterDelete = resolvePins([pin], deleted);
  gate("reported unresolved", afterDelete[0]?.via === "unresolved", `via=${afterDelete[0]?.via}`);
  const deletedPinned = applyPinsToAnalysis(deleted, [pin]);
  gate("nothing was overwritten",
    JSON.stringify(speakerMap(deletedPinned) instanceof Map ? [...speakerMap(deletedPinned)] : [])
      === JSON.stringify([...speakerMap(deleted)]));

  // ── the chapter-boundary guard ────────────────────────────────────────────
  console.log("\n7. a pin never crosses a chapter boundary");
  // Same sentence text, correction recorded in a DIFFERENT chapter. Short
  // dialogue repeats across a book, so text alone must not be enough.
  const foreign = { ...pin, id: "pin-foreign", chapterId: "ch9" };
  gate("foreign-chapter correction is ignored when the chapter is known",
    resolvePins([foreign], base, "ch1").length === 0);
  gate("and applying it changes nothing",
    applyResolvedPins(base, resolvePins([foreign], base, "ch1")) === base);
  gate("the matching chapter still resolves",
    resolvePins([pin], base, "ch1").length === 1);
  gate("segments arrive already sorted by start (the index convention)",
    base.speechResults.every((p) =>
      !p || p.segments.every((s, i) => i === 0 || p.segments[i - 1].start <= s.start)));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`}  (${results.length} gates)\n`);
  if (failed.length) process.exit(1);
}

main();
