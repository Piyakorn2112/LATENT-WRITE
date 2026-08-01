import type { Novel, StoryGraph, WorldData } from "../types";
import { buildSpeakerPalette, getSpeakerColor } from "./palette";

export interface TimelineCharacterTrack {
  name: string;
  count: number;
  color: string;
  chapterIds: ReadonlySet<string>;
  /** Chapters where a STORED EVENT names this character as its agent, with the
   *  event count — "drives the chapter". Read from the persisted graph's
   *  majorEvents; costs no NLP. */
  drivesByChapter?: ReadonlyMap<string, number>;
  /** Alias-aware mention counts per chapter. Only the async builder has the
   *  chapter text, so the snapshot builder leaves this unset and renderers
   *  fall back to uniform presence. */
  mentionsByChapter?: ReadonlyMap<string, number>;
}

interface TimelineTrackBuildOptions {
  signal?: AbortSignal;
  yieldEvery?: number;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildCanonicalCharacterMap(worldData: WorldData | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const character of worldData?.characters ?? []) {
    const canonical = character.name.trim();
    if (!canonical) continue;
    map.set(canonical.toLowerCase(), canonical);
    for (const alias of character.aliases ?? []) {
      const trimmed = alias.trim();
      if (!trimmed) continue;
      map.set(trimmed.toLowerCase(), canonical);
    }
  }
  return map;
}

function buildWorldCharacterMatchers(worldData: WorldData | undefined): Array<{ name: string; pattern: RegExp | null }> {
  return (worldData?.characters ?? [])
    .map((character) => {
      const canonical = character.name.trim();
      const variants = [canonical, ...(character.aliases ?? [])]
        .map((value) => value.trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)
        .map(escapeRegex);
      const pattern = variants.length > 0
        ? new RegExp(`\\b(?:${variants.join("|")})\\b`, "i")
        : null;
      return { name: canonical, pattern };
    })
    .filter((item) => !!item.name);
}

function canonicalCharacterName(name: string, canonicalMap: Map<string, string>): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return canonicalMap.get(trimmed.toLowerCase()) ?? trimmed;
}

function recordPresence(
  chapterId: string,
  present: Set<string>,
  counts: Map<string, number>,
  chapterIdsByName: Map<string, Set<string>>,
) {
  for (const name of present) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
    const chapterIds = chapterIdsByName.get(name) ?? new Set<string>();
    chapterIds.add(chapterId);
    chapterIdsByName.set(name, chapterIds);
  }
}

function finalizeTracks(
  counts: Map<string, number>,
  chapterIdsByName: Map<string, Set<string>>,
  limit: number,
  drivesByName?: Map<string, Map<string, number>>,
  mentionsByName?: Map<string, Map<string, number>>,
): TimelineCharacterTrack[] {
  const sortedNames = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Number.isFinite(limit) ? limit : undefined)
    .map(([name]) => name);

  const palette = buildSpeakerPalette(sortedNames);
  return sortedNames.map((name) => ({
    name,
    count: counts.get(name) ?? 0,
    color: getSpeakerColor(palette, name).text,
    chapterIds: chapterIdsByName.get(name) ?? new Set<string>(),
    drivesByChapter: drivesByName?.get(name.toLowerCase()),
    mentionsByChapter: mentionsByName?.get(name.toLowerCase()),
  }));
}

/** chapterId -> event count per character (lowercased canonical name), read
 *  straight from the persisted graph's majorEvents agents. */
function buildDrivesByName(
  storyGraph: StoryGraph,
  canonicalMap: Map<string, string>,
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const [chapterId, entry] of Object.entries(storyGraph.entries)) {
    for (const evt of entry.majorEvents ?? []) {
      if (!evt.agent) continue;
      const canonical = canonicalCharacterName(evt.agent, canonicalMap).toLowerCase();
      if (!canonical) continue;
      const per = out.get(canonical) ?? new Map<string, number>();
      per.set(chapterId, (per.get(chapterId) ?? 0) + 1);
      out.set(canonical, per);
    }
  }
  return out;
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error("Timeline track sync aborted");
  error.name = "AbortError";
  throw error;
}

async function yieldToMainThread() {
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

export function buildSnapshotTimelineCharacterTracks(
  storyGraph: StoryGraph,
  worldData: WorldData | undefined,
  limit = Number.POSITIVE_INFINITY,
): TimelineCharacterTrack[] {
  const canonicalMap = buildCanonicalCharacterMap(worldData);
  const counts = new Map<string, number>();
  const chapterIdsByName = new Map<string, Set<string>>();

  for (const [chapterId, entry] of Object.entries(storyGraph.entries)) {
    const present = new Set<string>();
    for (const rawName of entry.charactersPresent ?? []) {
      const canonical = canonicalCharacterName(rawName, canonicalMap);
      if (canonical) present.add(canonical);
    }
    recordPresence(chapterId, present, counts, chapterIdsByName);
  }

  return finalizeTracks(counts, chapterIdsByName, limit, buildDrivesByName(storyGraph, canonicalMap));
}

export async function buildTimelineCharacterTracks(
  storyGraph: StoryGraph,
  chapters: Novel["chapters"],
  worldData: WorldData | undefined,
  limit = Number.POSITIVE_INFINITY,
  options?: TimelineTrackBuildOptions,
): Promise<TimelineCharacterTrack[]> {
  const canonicalMap = buildCanonicalCharacterMap(worldData);
  const worldMatchers = buildWorldCharacterMatchers(worldData);
  const counts = new Map<string, number>();
  const chapterIdsByName = new Map<string, Set<string>>();
  const mentionsByName = new Map<string, Map<string, number>>();
  const yieldEvery = Math.max(1, options?.yieldEvery ?? 4);
  // Global twins of the presence matchers, for COUNTING mentions rather than
  // just detecting one. The count is what lets the ledger show how much of a
  // chapter a character occupies instead of a flat dot.
  const countMatchers = worldMatchers.map((m) => ({
    name: m.name,
    pattern: m.pattern ? new RegExp(m.pattern.source, "gi") : null,
  }));

  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
    throwIfAborted(options?.signal);
    const chapter = chapters[chapterIndex];
    const present = new Set<string>();

    for (const rawName of storyGraph.entries[chapter.id]?.charactersPresent ?? []) {
      const canonical = canonicalCharacterName(rawName, canonicalMap);
      if (canonical) present.add(canonical);
    }

    for (const matcher of countMatchers) {
      if (!matcher.pattern) continue;
      matcher.pattern.lastIndex = 0;
      const mentions = chapter.content.match(matcher.pattern)?.length ?? 0;
      if (mentions === 0) continue;
      present.add(matcher.name);
      const per = mentionsByName.get(matcher.name.toLowerCase()) ?? new Map<string, number>();
      per.set(chapter.id, mentions);
      mentionsByName.set(matcher.name.toLowerCase(), per);
    }

    recordPresence(chapter.id, present, counts, chapterIdsByName);

    if (chapterIndex + 1 < chapters.length && (chapterIndex + 1) % yieldEvery === 0) {
      await yieldToMainThread();
    }
  }

  throwIfAborted(options?.signal);
  return finalizeTracks(
    counts, chapterIdsByName, limit,
    buildDrivesByName(storyGraph, canonicalMap), mentionsByName,
  );
}