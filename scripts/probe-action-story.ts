/**
 * probe-action-story.ts — run the FULL high-mode action pipeline over the
 * owner's stress story and print every span with its assigned actor, so the
 * weak points are read the way the writer reads them.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/probe-action-story.ts
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runChapterAnalysis } from "../src/lib/chapter-analysis-runner";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const content = readFileSync(path.join(ROOT, "scripts", "fixtures", "lantern-cove.txt"), "utf8");
const KNOWN = ["Mira", "Thomas", "Elena", "Adrian", "Frank", "Lio"];

const result = runChapterAnalysis({
  chapter: { id: "story", number: 1, title: "The Lantern at Half Moon Cove", content },
  knownNames: KNOWN,
  level: "high",
});

for (let pi = 0; pi < result.paragraphs.length; pi++) {
  const para = result.paragraphs[pi];
  const preds = result.actionPredictions[pi] ?? [];
  if (!preds.length) continue;
  console.log(`\n¶${pi + 1} ────────────────────────────────`);
  for (const p of preds) {
    const text = para.slice(p.start, p.end).replace(/\s+/g, " ").trim();
    const shown = text.length > 88 ? `${text.slice(0, 85)}...` : text;
    console.log(`  [${(p.actor ?? "—").padEnd(7)}] ${shown}`);
  }
}
