/**
 * test-chapter-brief.ts — the "This chapter" card, accuracy-tested.
 *
 * The brief is the panel's entry point, and until now nothing measured it: a
 * malformed headline, an out-of-range anchor or a fabricated setting would
 * ship silently. This runs the REAL analysis pipeline over the gold chapters
 * of two DEV books and checks:
 *
 *   1. FORM — no Infinity/NaN/undefined leaks, no empty headline, no
 *      0-based paragraph leaking into display text.
 *   2. ANCHORS — every supporting line's paragraph exists.
 *   3. GOLD — headline beats are the rank-selected events, and their hit
 *      rate against gold events clears a floor (the same beats the timeline
 *      gates at ~50%; the floor here is conservative for the small sample).
 *   4. SETTING — the place named must actually occur >= 2 times in the
 *      prose, and the cast named must be real speakers.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-chapter-brief.ts
 */

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { runChapterAnalysis } from "../src/lib/chapter-analysis-runner";
import { buildChapterBrief } from "../src/lib/chapter-observation";
import { resolveKnownNames } from "../src/lib/world-data";
import { loadBook } from "./print-chapter";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
// DEV books only — the brief rides the same engine the timeline gates on TEST.
const BOOKS = ["anne", "sherlock"];

interface GoldEvent { paragraph: number; salience: string }
interface GoldChapter { book: string; chapter: number; events: GoldEvent[] }

let failed = 0;
const ok = (label: string, cond: boolean, detail?: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failed++;
};

async function main() {
  const gold: { chapters: GoldChapter[] } = JSON.parse(
    await readFile(path.join(REPO_ROOT, "scripts", "fixtures", "event-gold.json"), "utf8"),
  );

  let beatsCited = 0;
  let beatsHit = 0;
  let briefs = 0;

  for (const book of BOOKS) {
    const novel = await loadBook(book);
    const knownNames = resolveKnownNames(novel);
    for (const gc of gold.chapters.filter((c) => c.book === book)) {
      const chapter = novel.chapters[gc.chapter - 1];
      if (!chapter) continue;
      const result = runChapterAnalysis({
        chapter,
        knownNames,
        level: "default",
        worldData: book === "anne"
          ? { characters: [], factions: [], places: [{ name: "Green Gables" }, { name: "Avonlea" }] }
          : novel.worldData,
      });
      const brief = buildChapterBrief(result, null, book === "anne"
        ? { characters: [], factions: [], places: [{ name: "Green Gables" }, { name: "Avonlea" }] }
        : novel.worldData);
      if (!brief) continue;
      briefs++;
      const tag = `${book} ch${gc.chapter}`;
      const paraCount = result.paragraphs.length;

      // 1 · Form.
      ok(`${tag}: headline is clean prose`,
        brief.headline.length > 10 &&
        !/Infinity|NaN|undefined|¶0\b|  /.test(brief.headline),
        brief.headline.slice(0, 90));
      if (brief.setting) {
        ok(`${tag}: setting is clean`, !/Infinity|NaN|undefined/.test(brief.setting), brief.setting);
      }

      // 2 · Anchors.
      for (const line of brief.lines) {
        if (line.paragraphIndex === undefined) continue;
        ok(`${tag}: line anchor ¶${line.paragraphIndex + 1} exists`,
          line.paragraphIndex >= 0 && line.paragraphIndex < paraCount,
          `${line.paragraphIndex} of ${paraCount}`);
      }

      // 3 · Gold hit rate for the beats the headline narrates.
      if (!brief.eventless) {
        const majors = brief.events.filter((e) => e.salience === "major");
        const lead = (majors.length ? majors : brief.events).slice(0, 3);
        for (const e of lead) {
          beatsCited++;
          if (gc.events.some((g) => Math.abs(g.paragraph - (e.paragraphIndex + 1)) <= 1)) beatsHit++;
        }
      }

      // 4 · Setting truthfulness.
      if (brief.setting) {
        const placeMatch = brief.setting.match(/at ([A-Z][\w' ]+)\.$/);
        if (placeMatch) {
          const count = (chapter.content.match(new RegExp(`\\b${placeMatch[1]}\\b`, "gi")) ?? []).length;
          ok(`${tag}: setting place "${placeMatch[1]}" occurs >= 2 times`, count >= 2, `${count}`);
        }
        const speakerSet = new Set(result.analysis.speakerCounts.map((s) => s.name));
        const namesInSetting = brief.setting.replace(/,? mostly at .*$/, "").replace(/\.$/, "")
          .split(" and ").map((n) => n.trim()).filter((n) => /^[A-Z]/.test(n));
        for (const n of namesInSetting) {
          ok(`${tag}: setting cast "${n}" is a real speaker`, speakerSet.has(n));
          // ★ Both of these SHIPPED before this test existed: "Holmes and
          // Some." (a mis-detected speaker) and "Holmes and Sherlock Holmes"
          // (an alias pair read as two people).
          ok(`${tag}: setting cast "${n}" is not a junk word`,
            !/^(?:Some|One|All|Then|But|And|Now|Well|Yes|No|There|That|This|They)$/.test(n));
        }
        for (let i = 0; i < namesInSetting.length; i++) {
          for (let j = 0; j < namesInSetting.length; j++) {
            if (i === j) continue;
            ok(`${tag}: "${namesInSetting[i]}" and "${namesInSetting[j]}" are different people`,
              !namesInSetting[i].toLowerCase().includes(namesInSetting[j].toLowerCase()));
          }
        }
      }
    }
  }

  const rate = beatsCited ? beatsHit / beatsCited : 0;
  console.log(`\nheadline beats vs gold: ${beatsHit}/${beatsCited} (${(rate * 100).toFixed(0)}%) across ${briefs} briefs`);
  ok("headline beat hit-rate clears the floor", rate >= 0.35, `${(rate * 100).toFixed(0)}% < 35%`);

  console.log(failed ? `\nFAILED ${failed}` : "\nPASS — the brief tells the truth about form, anchors, gold and setting");
  process.exit(failed ? 1 : 0);
}
main();
