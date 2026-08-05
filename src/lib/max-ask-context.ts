/**
 * max-ask-context.ts — MaxAskInput, assembled from what the app already knows.
 *
 * max-ask.ts is deliberately pure: it takes `present`, `chapterSummaries` and
 * the rest as INPUTS and never fetches anything. This module is the other
 * half — the renderer feed. It reads only state the app is already holding
 * (the novel, worldData, the per-chapter lmSummary the summary engine wrote)
 * and does NO model work and NO whole-book scans: it runs on a right-click,
 * so its budget is "instant".
 *
 * ★ WHAT IS DELIBERATELY NOT FED YET, so the gap is a decision rather than an
 *   accident:
 *   · openThreads — the chekhov results live in the analysis panel's review
 *     store keyed per chapter run; threading them here needs a store read that
 *     does not exist yet. The pack simply omits the rung.
 *   · related — needs embedding retrieval (narrativeLMEmbed), which is async
 *     and belongs in the caller per max-ask's own contract.
 *   Both rungs degrade to absence by design; the ladder never renders an
 *   empty heading.
 */
import type { Novel, StoryGraph, WorldData } from "../types";
import type { AskKind, MaxAskInput } from "./max-ask";

/** The engine's paragraph split — every non-empty line. Same expression as
 *  App.tsx / story-graph / event-detect; a mismatch here would hand the model
 *  a different paragraph than the one under the pointer. */
export function splitEngineParagraphs(content: string): string[] {
  return content.split(/\n{2,}|\n/).map((p) => p.trim()).filter(Boolean);
}

/**
 * Which ENGINE paragraph contains this character offset?
 *
 * The split drops blank lines, so raw-text offsets and paragraph indices
 * disagree exactly where a writer right-clicks after a hard-wrapped break.
 * Walk the same segments the split produces, keeping count only of the ones
 * that survive the filter; an offset inside a blank run belongs to the
 * PREVIOUS paragraph (the one the writer just finished).
 */
export function paragraphIndexAt(content: string, offset: number): number {
  const at = Math.max(0, Math.min(offset, content.length));
  let index = -1;
  let cursor = 0;
  for (const segment of content.split(/(\n+)/)) {
    const start = cursor;
    cursor += segment.length;
    if (segment.startsWith("\n")) continue;      // a newline run, not a paragraph
    if (segment.trim() === "") continue;         // whitespace-only line: filtered out
    index += 1;
    if (at >= start && at <= cursor) return index;
    if (at < start) return Math.max(0, index - 1);
  }
  return Math.max(0, index);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Underscore is a word character and imported prose wraps names in it. Same
 *  boundary as character-presence and alias-scan. */
const LB = "(?<![A-Za-z0-9])";
const RB = "(?![A-Za-z0-9])";

/**
 * Cast members named in the paragraph or its immediate neighbours, CANONICAL
 * names out. An alias hit counts for its owner — the dossier the pack prints
 * is keyed by the canonical entry, and "Kes is here" is useless to it if the
 * lookup then misses "Kestrel".
 */
export function presentAround(
  paragraphs: readonly string[],
  index: number,
  worldData: WorldData | null | undefined,
  radius = 1,
): string[] {
  const characters = worldData?.characters ?? [];
  if (characters.length === 0) return [];
  const windowText = paragraphs
    .slice(Math.max(0, index - radius), index + radius + 1)
    .join("\n");
  const out: Array<{ name: string; at: number }> = [];
  for (const c of characters) {
    const forms = [c.name, ...(c.aliases ?? [])].filter((f) => f.trim().length >= 2);
    let best = -1;
    for (const form of forms) {
      const m = new RegExp(`${LB}${esc(form)}${RB}`).exec(windowText);
      if (m && (best === -1 || m.index < best)) best = m.index;
    }
    if (best >= 0) out.push({ name: c.name, at: best });
  }
  // In order of appearance, which is scene order more often than cast order.
  return out.sort((a, b) => a.at - b.at).map((x) => x.name);
}

export interface AskContext {
  novel: Novel;
  chapterId: string;
  worldData?: WorldData | null;
  /** Where the per-chapter lmSummary actually lives — the story graph, keyed
   *  by chapterId, not the Chapter itself. */
  storyGraph?: StoryGraph | null;
}

/**
 * The renderer feed. Returns null only when the chapter cannot be found —
 * every other absence just thins the pack.
 */
export function buildAskInput(
  ctx: AskContext,
  paragraphIndex: number,
  kind: AskKind,
  question?: string,
): MaxAskInput | null {
  const chapter = ctx.novel.chapters.find((c) => c.id === ctx.chapterId);
  if (!chapter) return null;
  const paragraphs = splitEngineParagraphs(chapter.content);
  const index = Math.max(0, Math.min(paragraphIndex, paragraphs.length - 1));
  const paragraph = paragraphs[index];
  if (!paragraph) return null;

  // ★ THE SUMMARIES ARE THE ONES THE SUMMARY ENGINE ALREADY WROTE — the story
  //   graph's lmSummary entries — never freshly generated here. A right-click
  //   must not queue N chapter summaries behind one question; a chapter with
  //   no summary yet just thins the story-so-far rung.
  const chapterSummaries = Object.values(ctx.storyGraph?.entries ?? {})
    .filter((e) => e.chapterNumber < chapter.number && (e.lmSummary || e.lmThroughline))
    .sort((a, b) => a.chapterNumber - b.chapterNumber)
    .map((e) => ({
      chapterNumber: e.chapterNumber,
      summary: e.lmSummary || e.lmThroughline || "",
    }));

  return {
    paragraph,
    paragraphIndex: index,
    chapterNumber: chapter.number,
    chapterTitle: chapter.title || undefined,
    kind,
    question,
    chapterParagraphs: paragraphs,
    present: presentAround(paragraphs, index, ctx.worldData).slice(0, 6),
    worldData: ctx.worldData ?? null,
    chapterSummaries,
  };
}
