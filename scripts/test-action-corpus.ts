/**
 * test-action-corpus.ts — action assignment at CORPUS scale, without hand
 * labelling a single span.
 *
 * The Lantern story (test-action-assign.ts) is the adversarial fixture: rich,
 * hand-graded, 18 spans. It cannot tell us whether a fix generalises. This
 * does, by the house masking method (see the speech benchmark): find spans
 * whose answer is already written in the text, then DELETE that evidence and
 * ask the engine to recover it.
 *
 *   PART A · EXPLICIT. An action sentence that opens with a known name is
 *     that character acting. Gold is free and near-perfect. This measures the
 *     easy half — the half where "longest name anywhere" used to lose to
 *     object names.
 *
 *   PART B · MASKED. The same sentences with the leading name replaced by a
 *     gender-agreeing pronoun. Gold stays the original name. This measures
 *     the CARRY, which is where every remaining failure lives.
 *
 *   CONTROL · OPPOSITE. Part B again with the WRONG-gender pronoun. If
 *     accuracy holds up here, the engine is ignoring gender and Part B's
 *     score is luck. It must collapse.
 *
 *   BASELINE · the naive "most recent name mentioned" resolver, so the lift
 *     from the carry + gender logic is visible rather than asserted.
 *
 * DEV/TEST split BY BOOK — chapters of one novel share cast and voice, so a
 * chapter split leaks. HOLDOUT=1 runs the held-out books.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-action-corpus.ts
 */

import { runChapterAnalysis, toParagraphs } from "../src/lib/chapter-analysis-runner";
import { findActionSentences, sentenceBounds, inferGender, isCommonWordName } from "../src/lib/action-detect";
import { resolveKnownNames } from "../src/lib/world-data";
import { loadBook } from "./print-chapter";

const DEV_BOOKS = ["webnovel", "treasure", "frankenstein", "hollow-iris", "sherlock", "worlds", "anne", "root-crown"];
const TEST_BOOKS = ["pride", "dracula", "carol", "expectations", "gatsby", "antonia", "awakening", "sample"];
const BOOKS = process.env.HOLDOUT === "1" ? TEST_BOOKS : DEV_BOOKS;
const CHAPTERS_PER_BOOK = Number(process.env.CHAPTERS ?? 8);
const STRIDE = 3; // mask every 3rd eligible sentence, so context stays intact

interface Trial {
  paragraphIndex: number;
  /** Offset of the sentence start in the (possibly masked) paragraph. */
  start: number;
  gold: string;
  /** The naive answer: most recent name mentioned before this sentence. */
  baseline: string | null;
}

/** Eligible = an action sentence whose subject is unambiguously a name. */
function eligibleSentences(para: string, names: string[], actionStarts: Set<number>, chapterText: string) {
  const out: Array<{ start: number; end: number; name: string }> = [];
  for (const [s, e] of sentenceBounds(para)) {
    if (!actionStarts.has(s)) continue;
    const text = para.slice(s, e);
    if (/["'“‘]/.test(text)) continue;           // dialogue: a different engine's job
    // LONGEST first: with "James" and "James McCarthy" both known, taking the
    // short one and masking it produced "He McCarthy was acquitted".
    const name = [...names].sort((a, b) => b.length - a.length).find((n) => text.startsWith(n));
    if (!name) continue;
    // ★ THE GOLD MUST BE A PERSON. "Let me say at once how I stand" and "God
    // forgive me" were scored as actions by characters called Let and God,
    // because the name pool carries sentence-initial common words. The
    // engine's own filter decides here too, or the test grades itself on
    // nonsense.
    if (isCommonWordName(name, chapterText)) continue;
    const after = text.slice(name.length);
    if (/^['’]s\b/.test(after)) continue;              // "Elizabeth's mother" — possessive
    if (/^\s+and\s+[A-Z]/.test(after)) continue;            // "Elizabeth and Jane" — two actors
    if (!/^[\s,]/.test(after)) continue;                    // "Elizabeths" — not the name
    if (/^\s+[A-Z][a-z]/.test(after)) continue;             // an unlisted surname follows
    // A NAME LIST is not one actor: "Squire Trelawney, Dr Livesey, and the
    // rest of these gentlemen having asked me to write down...".
    if (names.some((n) => n !== name && after.slice(0, 40).includes(n))) continue;
    out.push({ start: s, end: e, name });
  }
  return out;
}

/** Aliases are the same person: the engine may answer "Holmes" where the
 *  masked subject read "Sherlock Holmes", and scoring that as an error
 *  measures the alias table, not the attribution. */
function sameActor(answer: string | null | undefined, gold: string): boolean {
  if (!answer) return false;
  const a = answer.toLowerCase().trim();
  const g = gold.toLowerCase().trim();
  return a === g || a.includes(g) || g.includes(a);
}

async function main() {
  const modes = ["explicit", "masked", "opposite"] as const;
  const tally: Record<string, { n: number; hit: number; baseHit: number }> = {
    explicit: { n: 0, hit: 0, baseHit: 0 },
    masked: { n: 0, hit: 0, baseHit: 0 },
    opposite: { n: 0, hit: 0, baseHit: 0 },
  };
  const misses: string[] = [];

  for (const book of BOOKS) {
    let novel;
    try { novel = await loadBook(book); } catch { continue; }
    const knownNames = resolveKnownNames(novel);
    if (knownNames.length < 2) continue;
    const chapters = novel.chapters.slice(0, CHAPTERS_PER_BOOK);

    for (const chapter of chapters) {
      const paragraphs = toParagraphs(chapter.content);
      if (paragraphs.length < 4) continue;
      const joined = paragraphs.join("\n\n");
      const gender = inferGender(joined, knownNames);
      // ★ A MASK IS ONLY FAIR IF AN ANTECEDENT EXISTS. Deleting the FIRST
      // mention of a character in the chapter leaves nothing to recover them
      // from — the engine's honest answer is "nobody", and scoring that as an
      // error measures the test, not the engine. First run: 4 of the 10 worst
      // misses were exactly this.
      const firstMention = new Map<string, number>();
      for (const n of knownNames) {
        const at = joined.indexOf(n);
        if (at >= 0) firstMention.set(n, at);
      }
      const paraOffset: number[] = [];
      {
        let acc = 0;
        for (const para of paragraphs) { paraOffset.push(acc); acc += para.length + 2; }
      }

      for (const mode of modes) {
        const trials: Trial[] = [];
        const rebuilt: string[] = [];
        let seen = 0;
        let seenNames: string[] = [];

        for (let pi = 0; pi < paragraphs.length; pi++) {
          const para = paragraphs[pi];
          const actionStarts = new Set(findActionSentences(para).map((a) => a.start));
          const eligible = eligibleSentences(para, knownNames, actionStarts, joined);
          if (eligible.length === 0) {
            rebuilt.push(para);
            for (const n of knownNames) if (para.includes(n)) seenNames.push(n);
            continue;
          }
          let out = "";
          let cursor = 0;
          for (const { start, end, name } of eligible) {
            const absolute = paraOffset[pi] + start;
            const hasAntecedent = (firstMention.get(name) ?? Infinity) < absolute;
            const take = (seen++ % STRIDE) === 0 && (mode === "explicit" || hasAntecedent);
            out += para.slice(cursor, start);
            const newStart = out.length;
            const g = gender.get(name.toLowerCase());
            const maskable = mode !== "explicit" && !!g;
            if (take && (mode === "explicit" || maskable)) {
              const pronoun = mode === "explicit"
                ? name
                : mode === "masked"
                  ? (g === "female" ? "She" : "He")
                  : (g === "female" ? "He" : "She");   // control: wrong gender
              out += pronoun + para.slice(start + name.length, end);
              // The naive answer: the last name mentioned before this point.
              const before = [...seenNames, ...knownNames.filter((n) => para.slice(0, start).includes(n))];
              trials.push({
                paragraphIndex: pi, start: newStart, gold: name,
                baseline: before.length ? before[before.length - 1] : null,
              });
            } else {
              out += para.slice(start, end);
            }
            cursor = end;
          }
          out += para.slice(cursor);
          rebuilt.push(out);
          for (const n of knownNames) if (out.includes(n)) seenNames.push(n);
          if (seenNames.length > 40) seenNames = seenNames.slice(-40);
        }

        if (trials.length === 0) continue;
        const result = runChapterAnalysis({
          chapter: { ...chapter, content: rebuilt.join("\n\n") },
          knownNames,
          level: "high",
        });
        if (result.paragraphs.length !== rebuilt.length) continue; // re-split differently: skip

        for (const t of trials) {
          const preds = result.actionPredictions[t.paragraphIndex] ?? [];
          const hit = preds.find((p) => p.start >= t.start && p.start < t.start + 90);
          if (!hit) continue;
          tally[mode].n++;
          if (sameActor(hit.actor, t.gold)) tally[mode].hit++;
          else if (mode === "masked" && misses.length < 10) {
            const text = result.paragraphs[t.paragraphIndex].slice(hit.start, hit.start + 70).replace(/\s+/g, " ");
            misses.push(`${book}: "${text}..." → ${hit.actor ?? "—"} (gold ${t.gold})`);
          }
          if (sameActor(t.baseline, t.gold)) tally[mode].baseHit++;
        }
      }
    }
  }

  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
  console.log(`\naction assignment on the corpus — ${process.env.HOLDOUT === "1" ? "HELD-OUT" : "DEV"} books\n`);
  console.log(`  A · explicit subject      n=${String(tally.explicit.n).padStart(4)}   correct ${pct(tally.explicit.hit, tally.explicit.n)}`);
  console.log(`  B · masked to a pronoun   n=${String(tally.masked.n).padStart(4)}   correct ${pct(tally.masked.hit, tally.masked.n)}   (naive most-recent-name ${pct(tally.masked.baseHit, tally.masked.n)})`);
  console.log(`  C · control, WRONG gender n=${String(tally.opposite.n).padStart(4)}   correct ${pct(tally.opposite.hit, tally.opposite.n)}   ← must collapse vs B`);
  if (misses.length) {
    console.log(`\n  masked misses (first ${misses.length}):`);
    for (const m of misses) console.log(`   · ${m}`);
  }

  const explicitRate = tally.explicit.n ? tally.explicit.hit / tally.explicit.n : 0;
  const maskedRate = tally.masked.n ? tally.masked.hit / tally.masked.n : 0;
  const oppositeRate = tally.opposite.n ? tally.opposite.hit / tally.opposite.n : 1;
  const baseRate = tally.masked.n ? tally.masked.baseHit / tally.masked.n : 0;

  // ★ GATES SET JUST UNDER MEASURED, as tripwires rather than aspirations.
  // At the commit that introduced this file: explicit 100.0%, masked 38.2%
  // (naive baseline 25.0%), wrong-gender control 28.9%, over 93/76 trials on
  // DEV. Masked recovery started at 8.1% before the carry crossed paragraph
  // boundaries — the headroom that remains is two-character alternation,
  // which needs discourse modelling rather than another rule.
  const fails: string[] = [];
  if (tally.explicit.n < 60) fails.push(`too few explicit trials (${tally.explicit.n}) to mean anything`);
  if (explicitRate < 0.95) fails.push(`explicit subjects only ${pct(tally.explicit.hit, tally.explicit.n)} — the easy half is broken`);
  const maskedFloor = process.env.HOLDOUT === "1" ? 0.20 : 0.33;
  if (maskedRate < maskedFloor) fails.push(`masked recovery ${pct(tally.masked.hit, tally.masked.n)} — the carry regressed`);
  // ★ GATED ON DEV ONLY, AND SAID OUT LOUD RATHER THAN HIDDEN: on held-out
  // books the carry does NOT yet beat the naive baseline (23.1% vs 26.9% at
  // the commit that wrote this). Austen-style prose keeps several characters
  // live across long paragraphs and free indirect style, and recency alone
  // picks the wrong one. Failing CI on it would only tempt someone to tune
  // against held-out, which this repo does not do; leaving it silent would
  // be worse. It is printed as an OPEN PROBLEM every run.
  if (process.env.HOLDOUT !== "1" && maskedRate <= baseRate) {
    fails.push(`the engine does not beat the naive most-recent-name baseline`);
  }
  if (process.env.HOLDOUT === "1" && maskedRate <= baseRate) {
    console.log(`\n  ⚠ OPEN PROBLEM — on held-out books the carry (${pct(tally.masked.hit, tally.masked.n)}) does not yet`);
    console.log(`    beat naive most-recent-name (${pct(tally.masked.baseHit, tally.masked.n)}). Multi-character paragraphs need`);
    console.log(`    discourse modelling, not another recency rule.`);
  }
  if (oppositeRate >= maskedRate) fails.push(`wrong-gender control scores as well as the real one — gender is being ignored`);

  console.log("");
  if (!fails.length) {
    // The summary must not claim what this run did not show: on held-out the
    // carry is BELOW the baseline, and a blanket "beats the naive baseline"
    // line there would be the harness lying about its own result.
    console.log(maskedRate > baseRate
      ? "PASS — explicit subjects solid, carry beats the naive baseline, gender does real work."
      : "PASS — no regressions; the carry is still below the naive baseline here (see above).");
  }
  else for (const f of fails) console.log(`FAIL — ${f}`);
  process.exit(fails.length ? 1 : 0);
}
main();
