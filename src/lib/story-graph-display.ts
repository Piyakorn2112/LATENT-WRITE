import type { Novel, StoryGraph, WorldData } from "../types";
import { buildSpeakerPalette, getSpeakerColor } from "./palette";

export interface TimelineCharacterTrack {
  name: string;
  count: number;
  color: string;
  chapterIds: ReadonlySet<string>;
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
  }));
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

  return finalizeTracks(counts, chapterIdsByName, limit);
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
  const yieldEvery = Math.max(1, options?.yieldEvery ?? 4);

  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
    throwIfAborted(options?.signal);
    const chapter = chapters[chapterIndex];
    const present = new Set<string>();

    for (const rawName of storyGraph.entries[chapter.id]?.charactersPresent ?? []) {
      const canonical = canonicalCharacterName(rawName, canonicalMap);
      if (canonical) present.add(canonical);
    }

    for (const matcher of worldMatchers) {
      if (matcher.pattern?.test(chapter.content)) present.add(matcher.name);
    }

    recordPresence(chapter.id, present, counts, chapterIdsByName);

    if (chapterIndex + 1 < chapters.length && (chapterIndex + 1) % yieldEvery === 0) {
      await yieldToMainThread();
    }
  }

  throwIfAborted(options?.signal);
  return finalizeTracks(counts, chapterIdsByName, limit);
}