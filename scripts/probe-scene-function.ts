/**
 * probe-scene-function.ts — the funnel and the validity check.
 *
 * Two questions the quality harness cannot answer:
 *
 *  1. WHERE does a label die? A candidate that fires 3 times in 766 scenes is
 *     either gated out (never considered) or out-scored (considered and lost).
 *     Those need opposite fixes, so count the funnel instead of guessing:
 *     gate-pass → win → survives-margin.
 *
 *  2. ★ IS THE VALUE SHIFT REAL? setback/upturn/reversal rest entirely on a
 *     valence delta from a hand-written lexicon, and a delta between two noisy
 *     estimates is itself noise-shaped — it would still produce a confident,
 *     plausible-looking distribution if it measured nothing at all.
 *     So: reverse each scene's token order and recompute. A genuine trajectory
 *     must flip sign. Noise will not care.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/probe-scene-function.ts
 */

import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { classifyScene, _internals } from "../src/lib/scene-function";
import { loadBook, splitParagraphs } from "./print-chapter";

const DEV = ["pride", "sherlock", "anne", "dracula", "carol", "webnovel"];
const MAX_CHAPTERS = 12;

interface Scene {
  paragraphs: string[];
  dialogueDensity: number[];
  tension: "calm" | "rising" | "high";
  prevTension?: "calm" | "rising" | "high";
}

async function collectScenes(books: string[]): Promise<Scene[]> {
  const out: Scene[] = [];
  for (const book of books) {
    const novel = await loadBook(book);
    for (const chapter of novel.chapters.slice(0, MAX_CHAPTERS)) {
      const paragraphs = splitParagraphs(chapter.content);
      if (paragraphs.length < 4) continue;
      const results = detectSpeechInChapter(paragraphs, []);
      const starts: number[] = [];
      results.forEach((r, i) => { if (r.meta.sceneStart) starts.push(i); });
      let prevTension: Scene["prevTension"];
      for (let s = 0; s < starts.length; s++) {
        const a = starts[s];
        const b = s + 1 < starts.length ? starts[s + 1] : results.length;
        const tension = results[a].meta.sceneTension ?? "calm";
        out.push({
          paragraphs: paragraphs.slice(a, b),
          dialogueDensity: results.slice(a, b).map((r) => r.meta.dialogueDensity),
          tension,
          prevTension,
        });
        prevTension = tension;
      }
    }
  }
  return out;
}

function pct(v: number) { return `${(v * 100).toFixed(1)}%`; }

function percentiles(xs: number[]): string {
  if (xs.length === 0) return "—";
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `p10 ${at(0.1).toFixed(2)}  p50 ${at(0.5).toFixed(2)}  p90 ${at(0.9).toFixed(2)}  max ${s[s.length - 1].toFixed(2)}`;
}

async function main() {
  const scenes = await collectScenes(DEV);
  console.log(`\n${"═".repeat(70)}\nscene-function funnel — ${scenes.length} DEV scenes\n${"═".repeat(70)}`);

  const feats = scenes.map((s) =>
    _internals.extract({ ...s, prevLabel: undefined }));

  // ── Feature distributions ───────────────────────────────────────────────
  console.log("\n── feature distributions (rates per 100 words) ──");
  const keys = ["interior", "deliberate", "agency", "motion", "oppose", "violence",
    "fear", "silence", "reveal", "milieu", "bargain", "retro", "question"] as const;
  for (const k of keys) {
    console.log(`  ${k.padEnd(12)} ${percentiles(feats.map((f) => f[k] as number))}`);
  }
  console.log(`  ${"dialogue".padEnd(12)} ${percentiles(feats.map((f) => f.dialogue))}`);
  console.log(`  ${"shift".padEnd(12)} ${percentiles(feats.map((f) => Math.abs(f.shift)))}  (abs)`);
  console.log(`  ${"words".padEnd(12)} ${percentiles(feats.map((f) => f.words))}`);

  // ── Per-candidate funnel ────────────────────────────────────────────────
  console.log("\n── funnel: gate-pass → top-scorer → shipped ──");
  const gatePass = new Map<string, number>();
  const topScorer = new Map<string, number>();
  const shipped = new Map<string, number>();

  for (let i = 0; i < scenes.length; i++) {
    const f = feats[i];
    if (f.words < 45) continue;
    const scored = _internals.CANDIDATES
      .filter((c) => c.gate(f))
      .map((c) => ({ c, s: 1 + c.score(f) }))
      .sort((a, b) => b.s - a.s);
    for (const { c } of scored) gatePass.set(c.label, (gatePass.get(c.label) ?? 0) + 1);
    if (scored.length) topScorer.set(scored[0].c.label, (topScorer.get(scored[0].c.label) ?? 0) + 1);
    const out = classifyScene({ ...scenes[i], prevLabel: undefined });
    if (out) shipped.set(out.label, (shipped.get(out.label) ?? 0) + 1);
  }

  const rows = _internals.CANDIDATES.map((c) => ({
    label: c.label,
    gate: gatePass.get(c.label) ?? 0,
    top: topScorer.get(c.label) ?? 0,
    ship: shipped.get(c.label) ?? 0,
  })).sort((a, b) => a.ship - b.ship);

  console.log(`  ${"label".padEnd(17)} ${"gated-in".padStart(9)} ${"was-top".padStart(8)} ${"shipped".padStart(8)}   diagnosis`);
  for (const r of rows) {
    let dx = "";
    if (r.gate < 20) dx = "★ GATE too tight — rarely even considered";
    else if (r.top < 5) dx = "★ SCORE too low — considered, always loses";
    else if (r.ship < r.top * 0.4) dx = "margin/floor eats it";
    console.log(`  ${r.label.padEnd(17)} ${String(r.gate).padStart(9)} ${String(r.top).padStart(8)} ${String(r.ship).padStart(8)}   ${dx}`);
  }

  // ── ★ Validity: is the value shift measuring a trajectory? ──────────────
  //
  // The FIRST version of this check reversed the scene's token order and
  // asserted the shift flipped sign. It reported a perfect 100%. It was
  // worthless: `chargeOf` is a bag count, so reversing the tokens swaps head
  // and tail exactly and negates the delta BY CONSTRUCTION. The test could not
  // have failed, which means it was not a test.
  //
  // The real null is a PERMUTATION: shuffle the tokens across the whole scene
  // so every trajectory is destroyed while length, vocabulary and charge
  // totals are held identical, then read off the |shift| the estimator invents
  // from chance alone. A threshold is only meaningful above that floor.
  console.log("\n── validity: permutation test on the value shift ──");
  console.log("  Null = same tokens, shuffled. Any |shift| it still reports is noise.\n");

  // Seeded so the floor is reproducible run to run.
  let seed = 0x2f6e2b1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  // ★ STRATIFIED BY LENGTH. A third of a 116-word scene is 39 words and holds
  //   perhaps three charge words — far too few to estimate a charge, let alone
  //   a difference of two. If a trajectory is recoverable at all it will only
  //   appear in long scenes, so a single pooled number would hide both the
  //   failure at the short end and any success at the long end.
  const PERMS = 3;
  const BUCKETS: Array<[string, number, number]> = [
    ["150–299 w", 150, 300],
    ["300–599 w", 300, 600],
    ["600+ w", 600, Infinity],
  ];

  const q = (xs: number[], p: number) => {
    if (!xs.length) return 0;
    const s2 = [...xs].sort((a, b) => a - b);
    return s2[Math.min(s2.length - 1, Math.floor(p * s2.length))];
  };

  console.log(`  ${"bucket".padEnd(11)} ${"n".padStart(5)} ${"real p90".padStart(9)} ${"null p90".padStart(9)} ${"null p95".padStart(9)} ${"enrich".padStart(7)}`);
  let bestFloor = 0, bestLift = 0, bestBucket = "";

  for (const [name, lo, hi] of BUCKETS) {
    const real: number[] = [];
    const null_: number[] = [];
    for (const s of scenes) {
      const f = _internals.extract({ ...s, prevLabel: undefined });
      if (f.words < lo || f.words >= hi) continue;
      real.push(Math.abs(f.shift));

      const words = s.paragraphs.join("\n").split(/\s+/);
      for (let p = 0; p < PERMS; p++) {
        const shuffled = [...words];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const fn = _internals.extract({
          paragraphs: [shuffled.join(" ")],
          dialogueDensity: s.dialogueDensity,
          tension: s.tension,
          prevTension: s.prevTension,
        });
        null_.push(Math.abs(fn.shift));
      }
    }
    if (real.length < 20) { console.log(`  ${name.padEnd(11)} ${String(real.length).padStart(5)}   (too few)`); continue; }

    const floor95 = q(null_, 0.95);
    const rAbove = real.filter((v) => v > floor95).length / real.length;
    const nAbove = null_.filter((v) => v > floor95).length / Math.max(1, null_.length);
    // ★ A DEGENERATE FLOOR IS NOT A PASS. When the null p95 is 0 the estimator
    //   is silent almost everywhere, and "> 0" then compares two handfuls of
    //   outliers — which reported a triumphant 3.00× for a bucket whose real
    //   p90 was flat zero. An enrichment ratio means nothing without a floor
    //   that actually separates.
    const lift = floor95 <= 0 ? 0 : rAbove / Math.max(1e-9, nAbove);
    console.log(
      `  ${name.padEnd(11)} ${String(real.length).padStart(5)} ${q(real, 0.9).toFixed(3).padStart(9)} ` +
      `${q(null_, 0.9).toFixed(3).padStart(9)} ${floor95.toFixed(3).padStart(9)} ${(lift.toFixed(2) + "×").padStart(7)}`);
    if (lift > bestLift) { bestLift = lift; bestFloor = floor95; bestBucket = name; }
  }

  console.log(
    bestLift >= 1.5
      ? `\n  ✓ REAL in ${bestBucket} — order carries signal the shuffle cannot fake (${bestLift.toFixed(2)}×).\n    Gate the shift family to that length and set SHIFT_MIN ≥ ${bestFloor.toFixed(2)}.`
      : `\n  ✗ NOT A TRAJECTORY at any length (best ${bestLift.toFixed(2)}×). A valence delta\n    over a hand-written lexicon does not recover a Story Grid value shift from\n    scenes this short. setback/upturn/reversal would be naming chance —\n    DROP THEM rather than shipping a confident word for a coin flip.`);

  console.log(`\n${"═".repeat(70)}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
