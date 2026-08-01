/**
 * probe-lm-differential.ts — WHERE do the sync engine and the LM re-rank
 * disagree, and who is right there?
 *
 * Aggregates over DEV chapters:
 *   - chips the LM PRUNED from the top 3 (present without LM, absent with),
 *     split by whether they matched gold (bad prune) or not (good prune);
 *   - chips the LM PROMOTED into the top 3, same split;
 *   - majors the prune removed from the RAIL entirely (the recall cost);
 *   - the `why` signals over-represented in each class, which is the map for
 *     making the SYNC engine learn what the LM knows.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/probe-lm-differential.ts
 */

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import {
  detectNarrativeEvents, refineEventSalience, selectTimelineChips,
  type NarrativeEvent,
} from "../src/lib/narrative-events";
import { eventSalienceBatch } from "../src/lib/narrative-lm";
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { resolveKnownNames } from "../src/lib/world-data";
import { loadBook, splitParagraphs } from "./print-chapter";
import { installNodeEmbedder } from "./lm-node-backend";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
// Mirrors DEV_BOOKS in test-event-detect.ts — importing it would run the whole
// suite (the module executes main() at load). Keep in sync by hand.
const DEV_BOOKS = [
  "webnovel", "treasure", "frankenstein", "hollow-iris", "sherlock",
  "worlds", "anne", "root-crown",
];

interface GoldEvent { paragraph: number; salience: string; summary: string }
interface GoldChapter { book: string; chapter: number; events: GoldEvent[] }

const near = (a: number, b: number) => Math.abs(a - b) <= 1;

async function main() {
  await installNodeEmbedder();
  const gold: { chapters: GoldChapter[] } = JSON.parse(
    await readFile(path.join(REPO_ROOT, "scripts", "fixtures", "event-gold.json"), "utf8"),
  );

  const pruned: { good: NarrativeEvent[]; bad: NarrativeEvent[] } = { good: [], bad: [] };
  const promoted: { good: NarrativeEvent[]; bad: NarrativeEvent[] } = { good: [], bad: [] };
  let railMajorsLost = 0;
  let railMajorsLostSamples: string[] = [];

  for (const book of DEV_BOOKS) {
    const novel = await loadBook(book);
    const chaptersGold = gold.chapters.filter((c) => c.book === book);
    for (const gc of chaptersGold) {
      const chapter = novel.chapters[gc.chapter - 1];
      if (!chapter) continue;
      const paragraphs = splitParagraphs(chapter.content);
      const knownNames = resolveKnownNames(novel);
      const speech = detectSpeechInChapter(paragraphs, knownNames, { intelligenceLevel: "default" });
      const base = detectNarrativeEvents(paragraphs, speech, { knownNames, worldData: novel.worldData });

      // The SHIPPED config (story-graph.ts): keepFloor 0.8, no centrality.
      const refined = await refineEventSalience(base, {
        scorer: eventSalienceBatch,
        minSalience: -0.05,
        keepFloor: 0.8,
        weight: 0,
      });

      const goldAt = (e: NarrativeEvent) =>
        gc.events.find((g) => near(g.paragraph, (e.paragraphIndex ?? 0) + 1));
      const isHit = (e: NarrativeEvent) => !!goldAt(e);

      const key = (e: NarrativeEvent) => `${e.paragraphIndex}|${e.label}`;
      const topSync = selectTimelineChips(base);
      const topLm = selectTimelineChips(refined);
      const lmKeys = new Set(topLm.map(key));
      const syncKeys = new Set(topSync.map(key));

      for (const e of topSync) {
        if (lmKeys.has(key(e))) continue;
        (isHit(e) ? pruned.bad : pruned.good).push(e);
      }
      for (const e of topLm) {
        if (syncKeys.has(key(e))) continue;
        (isHit(e) ? promoted.good : promoted.bad).push(e);
      }

      // Rail cost: majors matched by SOME base event but matched by no refined event.
      const refinedKeys = new Set(refined.map(key));
      for (const e of base) {
        if (refinedKeys.has(key(e))) continue;
        const g = goldAt(e);
        if (g?.salience === "major") {
          railMajorsLost++;
          if (railMajorsLostSamples.length < 12) {
            railMajorsLostSamples.push(
              `${book} ch${gc.chapter} ¶${(e.paragraphIndex ?? 0) + 1} "${e.label}" [${e.why.find((w) => w.startsWith("lm-salience")) ?? "?"}] — gold: ${g.summary.slice(0, 60)}`,
            );
          }
        }
      }
    }
  }

  const whyProfile = (evs: NarrativeEvent[]) => {
    const counts = new Map<string, number>();
    for (const e of evs) {
      for (const w of new Set(e.why.map((x) => x.split(":")[0]))) {
        counts.set(w, (counts.get(w) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([w, n]) => `${w} ${(100 * n / Math.max(1, evs.length)).toFixed(0)}%`)
      .join(", ");
  };

  console.log("\n═══ LM vs sync, top-3 differential (DEV) ═══");
  console.log(`\nLM PRUNED from the chips:`);
  console.log(`  good prunes (was wrong):  ${pruned.good.length}   why: ${whyProfile(pruned.good)}`);
  console.log(`  BAD prunes (was right):   ${pruned.bad.length}   why: ${whyProfile(pruned.bad)}`);
  console.log(`\nLM PROMOTED into the chips:`);
  console.log(`  good promotes (is right): ${promoted.good.length}   why: ${whyProfile(promoted.good)}`);
  console.log(`  bad promotes (is wrong):  ${promoted.bad.length}   why: ${whyProfile(promoted.bad)}`);
  console.log(`\nRAIL: majors deleted entirely by the -0.05 prune: ${railMajorsLost}`);
  for (const s of railMajorsLostSamples) console.log(`   · ${s}`);
  console.log(`\nnet chip effect: +${promoted.good.length - pruned.bad.length} right, ${promoted.bad.length - pruned.good.length} wrong`);
}
main();
