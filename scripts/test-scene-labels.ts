/**
 * test-scene-labels.ts — is the chapter-part label actually SAYING anything?
 *
 * The label the reader sees above a scene ("| REFLECTION") sits next to a
 * colour that already encodes tension. So the only question that matters is:
 * once you know the colour, does the word still carry information?
 *
 * That is not a vibe, it is conditional entropy. This harness reports:
 *
 *   coverage      — % of scenes that get any label at all
 *   distinct      — how many different words the engine can actually produce
 *   top share     — the single most common label's share (a 60% label is wallpaper)
 *   H(label)      — entropy of the label distribution, bits
 *   H(label|tens) — entropy REMAINING once tension is known ← the real number
 *   redundancy    — I(label;tension)/H(label): 1.0 means the word is a synonym
 *                   for the colour and the label is pure decoration
 *   repeat        — consecutive scenes carrying the same label
 *
 * Books are split DEV / TEST. Tuning looks at DEV only; TEST is reported so a
 * gain that does not generalise is visible.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-scene-labels.ts
 *   ... --verbose      also dump the per-label table
 */

import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { loadBook, splitParagraphs } from "./print-chapter";

const VERBOSE = process.argv.includes("--verbose");

/** Tuning may read these. */
const DEV = ["pride", "sherlock", "anne", "dracula", "carol", "webnovel"];
/** Held out. Reported, never tuned against. */
const TEST = ["gatsby", "antonia", "treasure", "awakening", "expectations", "frankenstein", "worlds"];

/** Chapters per book — enough for a stable distribution, bounded for runtime. */
const MAX_CHAPTERS = 12;

interface SceneObs {
  label: string | undefined;
  tension: "calm" | "rising" | "high";
  book: string;
}

async function collect(books: string[]): Promise<SceneObs[]> {
  const out: SceneObs[] = [];
  for (const book of books) {
    const novel = await loadBook(book);
    for (const chapter of novel.chapters.slice(0, MAX_CHAPTERS)) {
      const paragraphs = splitParagraphs(chapter.content);
      if (paragraphs.length < 4) continue;
      const results = detectSpeechInChapter(paragraphs, []);
      for (const r of results) {
        if (!r.meta.sceneStart) continue;
        out.push({
          label: r.meta.sceneLabel,
          tension: r.meta.sceneTension ?? "calm",
          book,
        });
      }
    }
  }
  return out;
}

function entropy(counts: Map<string, number>): number {
  const n = [...counts.values()].reduce((a, b) => a + b, 0);
  if (n === 0) return 0;
  let h = 0;
  for (const c of counts.values()) {
    if (c === 0) continue;
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

interface Report {
  scenes: number;
  labelled: number;
  coverage: number;
  distinct: number;
  topLabel: string;
  topShare: number;
  hLabel: number;
  hLabelGivenTension: number;
  redundancy: number;
  repeatRate: number;
  table: Array<[string, number]>;
}

function analyse(obs: SceneObs[]): Report {
  const labelled = obs.filter((o) => o.label);
  const counts = new Map<string, number>();
  for (const o of labelled) counts.set(o.label!, (counts.get(o.label!) ?? 0) + 1);

  // H(label | tension) = Σ_t P(t) · H(label | tension = t)
  const byTension = new Map<string, SceneObs[]>();
  for (const o of labelled) {
    const arr = byTension.get(o.tension) ?? [];
    arr.push(o);
    byTension.set(o.tension, arr);
  }
  let hCond = 0;
  for (const [, group] of byTension) {
    const c = new Map<string, number>();
    for (const o of group) c.set(o.label!, (c.get(o.label!) ?? 0) + 1);
    hCond += (group.length / labelled.length) * entropy(c);
  }

  const hLabel = entropy(counts);
  const table = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  // Consecutive scenes (within the same book stream) sharing a label.
  let repeats = 0, pairs = 0;
  for (let i = 1; i < obs.length; i++) {
    if (obs[i].book !== obs[i - 1].book) continue;
    if (!obs[i].label || !obs[i - 1].label) continue;
    pairs++;
    if (obs[i].label === obs[i - 1].label) repeats++;
  }

  return {
    scenes: obs.length,
    labelled: labelled.length,
    coverage: labelled.length / Math.max(1, obs.length),
    distinct: counts.size,
    topLabel: table[0]?.[0] ?? "—",
    topShare: table.length ? table[0][1] / labelled.length : 0,
    hLabel,
    hLabelGivenTension: hCond,
    redundancy: hLabel > 0 ? (hLabel - hCond) / hLabel : 0,
    repeatRate: pairs ? repeats / pairs : 0,
    table,
  };
}

function print(name: string, r: Report) {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  console.log(`\n── ${name} ──`);
  console.log(`  scenes            ${r.scenes}`);
  console.log(`  coverage          ${pct(r.coverage)}  (${r.labelled} labelled)`);
  console.log(`  distinct labels   ${r.distinct}`);
  console.log(`  most common       "${r.topLabel}" at ${pct(r.topShare)}`);
  console.log(`  H(label)          ${r.hLabel.toFixed(3)} bits`);
  console.log(`  H(label|tension)  ${r.hLabelGivenTension.toFixed(3)} bits   ← what the word adds`);
  console.log(`  redundancy        ${pct(r.redundancy)}   ← 100% = the word IS the colour`);
  console.log(`  adjacent repeat   ${pct(r.repeatRate)}`);
  if (VERBOSE) {
    console.log(`  distribution:`);
    for (const [label, n] of r.table) {
      console.log(`    ${String(n).padStart(4)}  ${pct(n / r.labelled).padStart(6)}  ${label}`);
    }
  }
}

/**
 * Gates, set from the measured state of the rewrite with room to move.
 *
 * The baseline these replaced scored: redundancy 51%, top share 46%, adjacent
 * repeat 35%, 10 distinct labels of which 4 covered 89% of output. Every gate
 * below would have failed on it, which is the point — this file exists so that
 * a future change cannot quietly slide back toward a word that just restates
 * the tension colour.
 */
const GATES = {
  /** Information the label shares with the colour. The anti-gimmick number. */
  maxRedundancy: 0.2,
  /** No single word may become wallpaper. */
  maxTopShare: 0.3,
  /** Saying the same word twice running tells the reader nothing. */
  maxRepeat: 0.15,
  /** A vocabulary that collapses to a handful is a vocabulary in name only. */
  minDistinct: 10,
  /** Abstention is a feature, but an engine that never speaks is not one. */
  minCoverage: 0.2,
};

let failed = 0;
function gate(scope: string, name: string, actual: string, pass: boolean) {
  console.log(`  ${pass ? "✓" : "✗"} ${scope} ${name} — ${actual}`);
  if (!pass) failed++;
}

function check(scope: string, r: Report) {
  const p = (v: number) => `${(v * 100).toFixed(1)}%`;
  gate(scope, `redundancy ≤ ${p(GATES.maxRedundancy)}`, p(r.redundancy), r.redundancy <= GATES.maxRedundancy);
  gate(scope, `top share ≤ ${p(GATES.maxTopShare)}`, `${p(r.topShare)} ("${r.topLabel}")`, r.topShare <= GATES.maxTopShare);
  gate(scope, `adjacent repeat ≤ ${p(GATES.maxRepeat)}`, p(r.repeatRate), r.repeatRate <= GATES.maxRepeat);
  gate(scope, `distinct ≥ ${GATES.minDistinct}`, String(r.distinct), r.distinct >= GATES.minDistinct);
  gate(scope, `coverage ≥ ${p(GATES.minCoverage)}`, p(r.coverage), r.coverage >= GATES.minCoverage);
}

async function main() {
  console.log("═".repeat(66));
  console.log("scene-label quality");
  console.log("═".repeat(66));

  const dev = analyse(await collect(DEV));
  print(`DEV  (${DEV.join(", ")})`, dev);
  const test = analyse(await collect(TEST));
  print(`TEST (${TEST.join(", ")})`, test);

  console.log("\n── gates ──");
  check("DEV ", dev);
  check("TEST", test);

  console.log("\n" + "═".repeat(66));
  if (failed > 0) {
    console.log(`${failed} gate(s) failed.\n`);
    process.exit(1);
  }
  console.log("All gates passed.\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
