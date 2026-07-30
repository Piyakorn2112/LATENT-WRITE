/**
 * probe-entity-funnel.ts — where do entity-subject candidates die?
 *
 * TEMPORARY. Entity subjects are the strongest major-event predictor measured
 * anywhere in this engine (+33.7pp, 50% hit rate against a 17% base) and the
 * detector produces only six of them across 205 candidates. The standing
 * hypothesis was that `isSpecified` was throttling them; removing that gate
 * entirely added ONE candidate, so the hypothesis is wrong and the loss is
 * upstream. This walks the funnel and counts the survivors at each stage.
 */

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { analyzeChapter } from "../src/lib/chapter-analysis";
import { detectNarrativeEvents, _funnel, _funnelSamples, _resetFunnel } from "../src/lib/narrative-events";
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { resolveKnownNames } from "../src/lib/world-data";
import { loadBook, splitParagraphs } from "./print-chapter";
import type { Novel } from "../src/types";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function main() {
  const gold = JSON.parse(
    await readFile(path.join(REPO_ROOT, "scripts", "fixtures", "event-gold.json"), "utf8"),
  ) as { chapters: Array<{ book: string; chapter: number }> };

  _resetFunnel();
  const cache = new Map<string, Novel>();
  for (const gc of gold.chapters) {
    let novel = cache.get(gc.book);
    if (!novel) { novel = await loadBook(gc.book); cache.set(gc.book, novel); }
    const chapter = novel.chapters.find((c) => c.number === gc.chapter);
    if (!chapter) continue;
    const paragraphs = splitParagraphs(chapter.content);
    const knownNames = resolveKnownNames(novel);
    const speech = detectSpeechInChapter(paragraphs, knownNames, { intelligenceLevel: "default" });
    analyzeChapter(paragraphs, speech, []);
    detectNarrativeEvents(paragraphs, speech, {
      knownNames,
      worldData: novel.worldData,
      tensionByParagraph: speech.map((r) =>
        r.meta.tension === "high" ? 1 : r.meta.tension === "rising" ? 0.5 : 0),
    });
  }

  const f = _funnel;
  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");
  console.log(`\nSentences reaching narrationCandidate       ${f.sentences}`);
  console.log(`  a NAMED or PRONOUN agent matched first     ${f.agentNamedOrPronoun}  (${pct(f.agentNamedOrPronoun, f.sentences)})`);
  console.log(`  → entity subject even TRIED                ${f.entityTried}  (${pct(f.entityTried, f.sentences)})`);
  console.log(`\nOf the ${f.entityTried} sentences where an entity subject was tried:`);
  console.log(`  findEntitySubject matched                  ${f.entityFound}  (${pct(f.entityFound, f.entityTried)})`);
  console.log(`\nOf the ${f.entityFound} entity subjects found, killed by:`);
  const kills: Array<[string, number]> = [
    ["no verb found after the subject", f.entityNoVerb],
    ["verb not in CHANGE_VERBS", f.entityVerbNotChange],
    ["type not state-change/action/arrival/departure", f.entityWrongType],
    ["arrival/departure without a place or person", f.entityArrivalDeparture],
    ["action with a weak/trivial object", f.entityActionWeakObject],
    ["ambient subject (weather, light, time)", f.entityAmbient],
  ];
  for (const [name, n] of kills) {
    console.log(`  ${name.padEnd(46)} ${String(n).padStart(4)}  (${pct(n, f.entityFound)})`);
  }
  console.log(`  ${"SURVIVED to a candidate".padEnd(46)} ${String(f.entitySurvived).padStart(4)}  (${pct(f.entitySurvived, f.entityFound)})`);
  console.log(`\n  (isSpecified now only tags, does not kill: ${f.entityUnspecified} tagged)`);


  const person = f.personNoVerb + f.personVerbNotChange + f.personSurvived;
  console.log(`\n── the NAMED / PRONOUN path, ${person} subjects found ──`);
  console.log(`  no verb found after the subject   ${String(f.personNoVerb).padStart(4)}  (${pct(f.personNoVerb, person)})`);
  console.log(`  verb not in CHANGE_VERBS          ${String(f.personVerbNotChange).padStart(4)}  (${pct(f.personVerbNotChange, person)})`);
  console.log(`  SURVIVED to a candidate           ${String(f.personSurvived).padStart(4)}  (${pct(f.personSurvived, person)})`);

  const pv = new Map<string, number>();
  const pex = new Map<string, string>();
  for (const s of _funnelSamples.personNotChange) {
    const [v, rest] = s.split("\t");
    pv.set(v, (pv.get(v) ?? 0) + 1);
    if (!pex.has(v)) pex.set(v, rest);
  }
  console.log(`\n── unrecognised verbs on the PERSON path, by frequency ──`);
  for (const [v, n] of [...pv].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`  ${String(n).padStart(3)}×  ${v.padEnd(14)} ${pex.get(v)?.slice(0, 84) ?? ""}`);
  }

  const N = Number(process.env.SAMPLES ?? 40);
  console.log(`\n── ${N} of the ${f.entityNoVerb} "no verb found" cases  [subject] ⟩⟩ remainder ──`);
  for (const s of _funnelSamples.noVerb.slice(0, N)) console.log(`  ${s}`);
  // The unrecognised verbs, by frequency. CHANGE_VERBS is a closed class on
  // purpose, so growing it is only defensible when the additions are common and
  // genuinely denote change — which needs the counts, not a sample.
  const verbs = new Map<string, number>();
  const example = new Map<string, string>();
  for (const s of _funnelSamples.notChange) {
    const [v, rest] = s.split("\t");
    verbs.set(v, (verbs.get(v) ?? 0) + 1);
    if (!example.has(v)) example.set(v, rest);
  }
  console.log(`\n── unrecognised verbs on the entity path, by frequency (${f.entityVerbNotChange} total) ──`);
  for (const [v, n] of [...verbs].sort((a, b) => b[1] - a[1]).slice(0, N)) {
    console.log(`  ${String(n).padStart(3)}×  ${v.padEnd(14)} ${example.get(v)?.slice(0, 88) ?? ""}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
