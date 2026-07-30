import type { Chapter, MajorEvent, WorldData } from "../types";
import type { ChapterGraphEntry, StoryGraph } from "../types";
import type { ChapterAnalysisResult } from "./use-analysis";
import { detectNarrativeEvents } from "./narrative-events";

const DEV = (import.meta as { env?: { DEV?: boolean } }).env?.DEV ?? false;

import { isDesktopApp, saveProjectState, loadProjectState } from "./project-manager";

const STORY_GRAPH_KEY = "glass-editor:story-graph-v1";

export function emptyStoryGraph(): StoryGraph {
  return { version: 1, entries: {} };
}

export function loadStoryGraph(): StoryGraph {
  if (isDesktopApp()) return emptyStoryGraph();
  try {
    const raw = localStorage.getItem(STORY_GRAPH_KEY);
    if (!raw) return emptyStoryGraph();
    const parsed = JSON.parse(raw) as StoryGraph;
    if (parsed.version !== 1 || typeof parsed.entries !== "object") return emptyStoryGraph();
    return parsed;
  } catch {
    return emptyStoryGraph();
  }
}

export async function loadStoryGraphFromProject(): Promise<StoryGraph | null> {
  const data = await loadProjectState<StoryGraph>("story-graph");
  if (!data || data.version !== 1 || typeof data.entries !== "object") return null;
  return data;
}

export function saveStoryGraph(g: StoryGraph): void {
  if (isDesktopApp()) { saveProjectState("story-graph", g); return; }
  try { localStorage.setItem(STORY_GRAPH_KEY, JSON.stringify(g)); }
  catch { /* quota — ignore */ }
}

const STRUCTURAL_EVENT_LABELS = new Set(["Scene transition", "Narrative pivot", "Chapter climax"]);

function paragraphIndexForEvent(tensionPosition: number, paragraphCount: number): number {
  if (paragraphCount <= 1) return 0;
  return Math.max(0, Math.min(paragraphCount - 1, Math.round(tensionPosition * (paragraphCount - 1))));
}

export function buildChapterEntry(
  chapter: Chapter,
  result: ChapterAnalysisResult,
  worldData?: WorldData,
): ChapterGraphEntry {
  const { analysis, speechPredictions, actionPredictions } = result;

  const charSet = new Set<string>();
  // From speech and action predictions (NLP speaker detection)
  for (const p of speechPredictions) {
    if (p.predictedLabel) charSet.add(p.predictedLabel);
  }
  for (const paraPreds of actionPredictions) {
    for (const p of paraPreds) {
      if (p.actor) charSet.add(p.actor);
    }
  }
  // Also: any named character in worldData who actually appears in this chapter's text.
  // This ensures Hollow Iris characters (Nora, Iris, Helia, Kaelen…) are always tracked
  // even when the speech-detection NLP doesn't attribute dialogue to them directly.
  if (worldData?.characters) {
    for (const c of worldData.characters) {
      if (c.name && c.name.length >= 2 && chapter.content.includes(c.name)) {
        charSet.add(c.name);
      }
    }
  }

  const full = analysis.tensionCurve;
  const tensionPeak = full.length ? Math.max(...full) : 0;
  const tensionCurve = downsample(full, 8);

  const words = chapter.content.trim() ? chapter.content.trim().split(/\s+/).length : 0;

  // Heavy event detection — runs per chapter, not per keystroke.
  //
  // narrative-events.ts replaced event-detect.ts here. The old engine scored
  // paragraphs against phrase dictionaries tuned on two specific manuscripts; on
  // the gold set it matched 4 of 22 events, typed every one of those 4 wrongly,
  // and its labels shared no content words with what a reader would say happened.
  // See scripts/test-event-detect.ts for the side-by-side.
  const knownNames = [
    ...(worldData?.characters ?? []).flatMap((c) => [c.name, ...(c.aliases ?? [])]),
    ...analysis.speakerCounts.map((s) => s.name),
  ].filter((n): n is string => Boolean(n) && n.length >= 2);

  const majorEvents: MajorEvent[] = chapter.content.trim().length > 100
    ? detectNarrativeEvents(result.paragraphs, result.speechResults, {
        knownNames,
        worldData,
        // One value per paragraph, no subsampling. The engine reads the
        // DERIVATIVE of this: a local rise is evidence that something happened,
        // where a high plateau only says the chapter is tense.
        tensionByParagraph: result.speechResults.map((r) =>
          r.meta.tension === "high" ? 1 : r.meta.tension === "rising" ? 0.5 : 0,
        ),
      }).map((e) => ({
        label: e.label,
        type: e.legacyType,
        tensionPosition: e.tensionPosition,
        confidence: e.confidence,
        sentence: e.sentence,
        paragraphIndex: e.paragraphIndex,
        offsetInParagraph: e.offsetInParagraph,
        narrativeType: e.type,
        salience: e.salience,
        agent: e.agent,
        channel: e.channel,
      }))
    : [];

  return {
    chapterId: chapter.id,
    chapterNumber: chapter.number,
    chapterTitle: chapter.title,
    role: analysis.chapterRole,
    tensionPeak,
    tensionCurve,
    charactersPresent: [...charSet].slice(0, 8),
    wordCount: words,
    proseRegister: analysis.register,
    majorEvents,
    lastUpdated: Date.now(),
    contentHash: `${chapter.content.length}|${chapter.content.slice(0, 60)}`,
  };
}

/**
 * Async LM pass over a built entry: semantic dedup, and a detail tag.
 *
 * ★ WHAT THIS DELIBERATELY NO LONGER DOES: relabel.
 *
 * It used to hand each event's paragraph to `selectBestEventSentence` and take
 * the returned sentence as the label. That made sense when the label came from a
 * regex scavenging a paragraph. It does not now: narrative-events.ts builds the
 * label from the same clause that triggered detection, as agent + act + object,
 * inside the timeline's real 28-character budget. Letting the LM replace that
 * with a picked sentence would put the truncated sentences straight back.
 *
 * There was also a concrete reason not to trust that scorer as it stands. Its
 * total is `anchor*0.58 + centrality*0.18 + quality*0.45 + coverage*0.24`, and
 * `coverage` measures overlap with the label being corrected — so the surface
 * terms outweigh the semantic one and the pass is biased toward AGREEING with the
 * input it was meant to improve. Handed a paragraph whose event is a declaration
 * to a committee, it returned the scene-setting first sentence.
 *
 * The literature is on the LM's side about the SHAPE though, not against it:
 * modern sentence-embedding similarity is competitive with NLI zero-shot, and
 * the documented weaknesses of this pattern are a single hand-written anchor per
 * class and no calibration against a null anchor. Fixing those is the next step
 * for this file, and is why the seam is kept rather than deleted.
 *
 * Dedup, by contrast, is a task cosine similarity is genuinely good at, so that
 * is what runs here.
 */
export async function enrichChapterEntryWithLM(
  entry: ChapterGraphEntry,
  chapterContent: string,
): Promise<ChapterGraphEntry> {
  const paras = chapterContent
    .split(/\n{2,}|\n/)
    .map(p => p.trim())
    .filter(Boolean);
  if (paras.length === 0 || entry.majorEvents.length === 0) return entry;

  try {
    const { classifyEventDetail, semanticSimilarity, hasEmbedder, eventSalienceBatch, chapterCentrality } =
      await import("./narrative-lm");
    const { refineEventSalience } = await import("./narrative-events");

    // Say so out loud. A bare `catch {}` around this whole function meant that
    // for months every offline suite reported "the LM changed 0% of labels" and
    // that zero described a failed import of `sharp`, not a working model.
    if (!hasEmbedder()) {
      if (DEV) console.warn(`[StoryGraph] Ch.${entry.chapterNumber}: no embedding backend — dedup and detail tags skipped.`);
      return entry;
    }

    // ── LM salience re-rank, FIRST, because it prunes.
    //
    // The sync engine cannot tell a consequential act from stage business: both
    // are an agent plus a change verb, and its false positives score as high as
    // its true ones, so no threshold helps. A contrastive embedding score does
    // separate them, and it is the one judgement this model measured STRONG at.
    // Measured on the 45-event gold set: precision 32.8% -> 43.2% with major-event
    // recall held. See scripts/test-event-detect.ts (SALIENCE=-0.05).
    let events = entry.majorEvents;
    if (events.some((e) => e.sentence)) {
      const refined = await refineEventSalience(
        events.map((e) => ({
          ...e,
          sentence: e.sentence ?? "",
          type: (e.narrativeType ?? "unclassified") as never,
          legacyType: e.type as never,
          paragraphIndex: e.paragraphIndex ?? 0,
          sentenceIndex: 0,
          offsetInParagraph: e.offsetInParagraph ?? 0,
          salience: e.salience ?? "minor",
          channel: e.channel ?? "narration",
          why: [],
        })),
        {
          scorer: eventSalienceBatch,
          // The PRUNE. This is where the LM's value actually is, and the cut is a
          // cliff rather than a slope: -0.2 prunes 3 events, -0.05 prunes 65, 0.1
          // prunes 174 of 204 and destroys the output. Do not nudge it casually.
          minSalience: -0.05,
          // ★ THE SALIENCE BLEND IS OFF, AND THAT IS A MEASURED DECISION.
          //
          // `weight` multiplies the contrastive event-vs-description score into
          // confidence. The prune above uses the RAW score, so these are
          // independent: turning the blend off keeps the pruning.
          //
          // Measured on the eight-book set, all with the prune on:
          //     blend cent 0.45 + sal 0.5   precision@3 49.1%   major shown 16.9%
          //     blend off entirely          precision@3 49.1%   major shown 18.6%
          //     centrality only             precision@3 50.9%   major shown 18.6%
          //
          // So the salience term was COSTING 1.8 points of precision and 1.7 of
          // major coverage. It was not inert either: a probe with pruning disabled
          // showed it reshuffling the top three in 78.9% of chapters and landing
          // on precision@3 43.9% — bit-identical to not blending at all. Constant
          // churn, zero accuracy. MiniLM's event-vs-description judgement is good
          // enough to PRUNE with and not good enough to RANK with, on this corpus.
          weight: 0,
          // Chapter centrality: how close each clause sits to what the chapter is
          // about. Sign and weight both MEASURED, not assumed, because every
          // intuition-set weight in this engine has been wrong. Re-swept after the
          // salience term came out, reading precision@3 / major shown:
          //     0.2 -> 49.1/16.9   0.35 -> 49.1/16.9   0.45 -> 50.9/18.6
          //     0.6 -> 50.9/22.0   0.8 -> 49.1/20.3
          // Still a plateau rather than a lucky point, and 0.6 is the best corner
          // of it. An earlier sweep including negative weights fell away hard,
          // which is what confirmed the direction.
          centrality: (clauses) => chapterCentrality(clauses, paras),
          centralityWeight: 0.6,
        },
      );
      const keep = new Set(refined.map((r) => `${r.paragraphIndex}|${r.label}`));
      events = events
        .filter((e) => keep.has(`${e.paragraphIndex ?? 0}|${e.label}`))
        .map((e) => {
          const r = refined.find((x) => x.paragraphIndex === (e.paragraphIndex ?? 0) && x.label === e.label);
          return r ? { ...e, confidence: r.confidence } : e;
        });
      if (DEV && events.length !== entry.majorEvents.length) {
        console.log(`[StoryGraph] Ch.${entry.chapterNumber} LM salience: ${entry.majorEvents.length} -> ${events.length} events`);
      }
    }

    // A detail tag, from the clause the engine actually detected. Persisting
    // `sentence` is what makes this possible without re-deriving the paragraph.
    const tagged = await Promise.all(events.map(async (event) => {
      if (STRUCTURAL_EVENT_LABELS.has(event.label)) return event;
      const source = event.sentence
        ?? paras[event.paragraphIndex ?? paragraphIndexForEvent(event.tensionPosition, paras.length)];
      if (!source || source.length < 20) return event;
      const detail = await classifyEventDetail(source, event.type);
      // The type is NOT overwritten. It came from the clause's verb, which is
      // stronger evidence than a cosine against one hand-written anchor.
      return detail
        ? { ...event, detailType: detail.detailType, detailLabel: detail.detailLabel, detailConfidence: detail.confidence }
        : event;
    }));

    if (tagged.length <= 1) return { ...entry, majorEvents: tagged };

    const keep = new Array(tagged.length).fill(true);
    for (let i = 0; i < tagged.length; i++) {
      if (!keep[i]) continue;
      for (let j = i + 1; j < tagged.length; j++) {
        if (!keep[j]) continue;
        const sim = await semanticSimilarity(tagged[i].label, tagged[j].label);
        if (sim > 0.72) {
          const dropIdx = tagged[i].confidence >= tagged[j].confidence ? j : i;
          keep[dropIdx] = false;
          if (DEV) console.log(`[StoryGraph] Ch.${entry.chapterNumber} dedup: "${tagged[i].label}" ~ "${tagged[j].label}" (sim ${sim.toFixed(2)}) → drop "${tagged[dropIdx].label}"`);
        }
      }
    }
    return { ...entry, majorEvents: tagged.filter((_, i) => keep[i]) };
  } catch (err) {
    if (DEV) console.warn(`[StoryGraph] Ch.${entry.chapterNumber}: LM pass failed —`, err);
    return entry;
  }
}

function downsample(arr: number[], n: number): number[] {
  if (!arr.length) return Array(n).fill(0);
  if (arr.length <= n) {
    const out = [...arr];
    while (out.length < n) out.push(arr[arr.length - 1]);
    return out;
  }
  return Array.from({ length: n }, (_, i) => arr[Math.floor((i / (n - 1)) * (arr.length - 1))]);
}
