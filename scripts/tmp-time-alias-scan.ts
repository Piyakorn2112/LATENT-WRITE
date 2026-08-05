import { readFile } from "fs/promises";
import path from "path";
import { parseNovel } from "../src/lib/parser";
import { scanAliases } from "../src/lib/alias-scan";
import { autoExtractEntities } from "../src/lib/world-data";
import { proposeAliases } from "../src/lib/alias-propose";

async function main() {
  const novel = parseNovel(await readFile(path.resolve("scripts/fixtures/corpus/pride.txt"), "utf8"));
  const cast = autoExtractEntities(novel, 5, 12).map((name) => ({ name, aliases: [] as string[] }));
  const text = novel.chapters.map((c) => c.content).join("\n\n");
  console.log(`text ${Math.round(text.length / 1024)}KB, cast ${cast.length}`);

  let t = performance.now();
  const extra = autoExtractEntities(novel, 3, 60);
  console.log(`  autoExtractEntities(3,60) -> ${extra.length} forms   ${Math.round(performance.now() - t)}ms`);

  t = performance.now();
  const p = proposeAliases(cast, extra, text);
  console.log(`  proposeAliases over those  -> ${p.proposals.length}   ${Math.round(performance.now() - t)}ms`);

  t = performance.now();
  const r = scanAliases({ characters: cast, chapters: novel.chapters, extraCandidates: extra });
  console.log(`  FULL scanAliases (app path)-> ${r.candidates.length} found  ${Math.round(performance.now() - t)}ms`);
}
main();
