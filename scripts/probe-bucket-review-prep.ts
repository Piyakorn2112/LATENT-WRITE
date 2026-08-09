/// <reference types="node" />

/**
 * probe-bucket-review-prep.ts — the scan and the review selection, exactly as
 * the app performs them, emitted as JSON for the Electron side to answer.
 *
 * Every step here is the shipped one. Nothing decides anything that
 * WorldDataView does not decide the same way.
 */

import { readFile } from "fs/promises";
import { scanAndClassify } from "../src/lib/world-data";
import {
  selectReviewable,
  usageSnippets,
  usageSignals,
  buildEntityReviewRequest,
  type EntityReviewEntry,
  type EntityType,
} from "../src/lib/entity-review";
import type { AdaptivePredictionTrace } from "../src/types";

const BOOK = "/Users/piyakorn/Desktop/Testwriting/novel-reader/public/novels/root-crown.txt";

export function splitBookChapters(raw: string): string[] {
  return raw.split(/^===CHAPTER [^=]*===$/m).slice(1).map((p) => p.trim()).filter(Boolean);
}

async function main() {
  const raw = await readFile(BOOK, "utf8");
  const chapters = splitBookChapters(raw);
  const text = chapters.join("\n");

  const traceOut: { value: AdaptivePredictionTrace[] } = { value: [] };
  const scan = await scanAndClassify(chapters, undefined, 2, { predictionTraceOut: traceOut });

  // The app's own shape: reviewEntriesFromTraces, inlined because it is four
  // lines and not exported.
  const entries: EntityReviewEntry[] = traceOut.value.map((t) => ({
    name: t.spanText,
    currentType: t.predictedLabel as EntityType,
    needsReview: t.needsReview,
    ambiguityGap: t.ambiguityGap,
  }));

  const selected = selectReviewable(entries, { text });
  const asks = selected
    .map((entry) => {
      const snippets = usageSnippets(text, entry.name);
      if (snippets.length === 0) return null;
      const req = buildEntityReviewRequest(entry, snippets, 128, usageSignals(text, entry.name));
      return {
        name: entry.name,
        currentType: entry.currentType,
        systemPrompt: req.systemPrompt,
        userText: req.userText,
        schema: req.schema,
        maxTokens: req.maxTokens,
      };
    })
    .filter(Boolean);

  console.log(JSON.stringify({ scan, entries, asks }));
}

main().catch((err) => { console.error(err); process.exit(1); });
