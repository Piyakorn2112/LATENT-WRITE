import type { Novel, StoryGraph, WorldData } from "../types";
import { buildSpeakerPalette, getSpeakerColor } from "./palette";
import { classifyChapterPresence } from "./character-presence";

export interface TimelineCharacterTrack {
  name: string;
  count: number;
  color: string;
  chapterIds: ReadonlySet<string>;
  /** Chapters where a STORED EVENT names this character as its agent, with the
   *  event count — "drives the chapter". Read from the persisted graph's
   *  majorEvents; costs no NLP. */
  drivesByChapter?: ReadonlyMap<string, number>;
  /**
   * The TYPES of the events this character drives, per chapter, in story order
   * — "revelation", "confrontation", "climax"…
   *
   * ★ THE TYPE WAS ALREADY STORED AND WAS BEING THROWN AWAY. `majorEvents`
   *   carries `type` on every event and the cast ledger reduced it to a count,
   *   so the timeline could say a character drives three beats here but never
   *   WHICH three. That is the difference between "she is busy" and "she is the
   *   one making the revelations", and it costs nothing to carry.
   */
  driveTypesByChapter?: ReadonlyMap<string, readonly string[]>;
  /** Alias-aware mention counts per chapter. Only the async builder has the
   *  chapter text, so the snapshot builder leaves this unset and renderers
   *  fall back to uniform presence. */
  mentionsByChapter?: ReadonlyMap<string, number>;
  /**
   * Whether the character is ON THE PAGE in each chapter or only talked about.
   *
   * ★ THE ABSENCE IS THE INFORMATION. Dropping evoked chapters would make the
   *   ledger honest and less useful at the same time — "everyone keeps
   *   mentioning her while she is away" is exactly the shape a writer wants to
   *   see. Unset for graphs persisted before the classifier existed, and the
   *   renderer must then draw every chapter as plain presence.
   */
  presenceByChapter?: ReadonlyMap<string, "speaking" | "present" | "mentioned">;
  /** Chapters whose class the deterministic signals could not call. */
  uncertainChapters?: ReadonlySet<string>;
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

/** Everything the two builders gather that is keyed by lower-cased name. */
interface TrackExtras {
  drivesByName?: Map<string, Map<string, number>>;
  driveTypesByName?: Map<string, Map<string, string[]>>;
  mentionsByName?: Map<string, Map<string, number>>;
  presenceByName?: Map<string, Map<string, "speaking" | "present" | "mentioned">>;
  uncertainByName?: Map<string, Set<string>>;
}

function finalizeTracks(
  counts: Map<string, number>,
  chapterIdsByName: Map<string, Set<string>>,
  limit: number,
  extras: TrackExtras = {},
): TimelineCharacterTrack[] {
  const sortedNames = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Number.isFinite(limit) ? limit : undefined)
    .map(([name]) => name);

  const palette = buildSpeakerPalette(sortedNames);
  return sortedNames.map((name) => {
    const key = name.toLowerCase();
    return {
      name,
      count: counts.get(name) ?? 0,
      color: getSpeakerColor(palette, name).text,
      chapterIds: chapterIdsByName.get(name) ?? new Set<string>(),
      drivesByChapter: extras.drivesByName?.get(key),
      driveTypesByChapter: extras.driveTypesByName?.get(key),
      mentionsByChapter: extras.mentionsByName?.get(key),
      presenceByChapter: extras.presenceByName?.get(key),
      uncertainChapters: extras.uncertainByName?.get(key),
    };
  });
}

/** Collect the stored per-chapter presence classes, canonicalised through the
 *  alias map so "Holmes" and "Sherlock Holmes" land on one track. */
function readStoredPresence(
  storyGraph: StoryGraph,
  canonicalMap: Map<string, string>,
  overrides?: PresenceOverrides,
): { presence: Map<string, Map<string, "speaking" | "present" | "mentioned">>; uncertain: Map<string, Set<string>> } {
  const presence = new Map<string, Map<string, "speaking" | "present" | "mentioned">>();
  const uncertain = new Map<string, Set<string>>();
  for (const [chapterId, entry] of Object.entries(storyGraph.entries)) {
    for (const record of entry.presence ?? []) {
      const canonical = canonicalCharacterName(record.name, canonicalMap).toLowerCase();
      if (!canonical) continue;
      const per = presence.get(canonical) ?? new Map<string, "speaking" | "present" | "mentioned">();
      // ★ A CANONICAL NAME CAN COLLECT TWO RECORDS in one chapter once aliases
      //   merge two surface forms. Keep the STRONGER reading: someone who
      //   speaks as "Holmes" and is merely named as "Sherlock Holmes" is
      //   speaking, and taking whichever record happened to be stored last
      //   would make the class depend on iteration order.
      const rank = { mentioned: 0, present: 1, speaking: 2 } as const;
      const prior = per.get(chapterId);
      if (!prior || rank[record.klass] > rank[prior]) per.set(chapterId, record.klass);
      presence.set(canonical, per);
      if (record.uncertain) {
        const set = uncertain.get(canonical) ?? new Set<string>();
        set.add(chapterId);
        uncertain.set(canonical, set);
      }
    }
  }
  // ★ THE MODEL'S ANSWER LANDS LAST AND ONLY WHERE THE ENGINE DEFERRED. It can
  //   only exist for a mark assist-sweep asked about, and it only asks about
  //   `uncertain` ones — so this cannot overturn a confident engine call even
  //   if a stale override survived a re-analysis. Applying it also CLEARS the
  //   uncertain flag: the question has been answered, and leaving the mark
  //   dashed would ask the writer to distrust a call that was just settled.
  for (const [chapterId, byName] of overrides ?? []) {
    for (const [nameLower, klass] of byName) {
      const canonical = canonicalCharacterName(nameLower, canonicalMap).toLowerCase();
      const per = presence.get(canonical);
      if (!per?.has(chapterId)) continue;
      if (!uncertain.get(canonical)?.has(chapterId)) continue;
      per.set(chapterId, klass);
      uncertain.get(canonical)?.delete(chapterId);
    }
  }
  return { presence, uncertain };
}

/** chapterId -> event count per character (lowercased canonical name), read
 *  straight from the persisted graph's majorEvents agents. */
function buildDrivesByName(
  storyGraph: StoryGraph,
  canonicalMap: Map<string, string>,
): {
  counts: Map<string, Map<string, number>>;
  types: Map<string, Map<string, string[]>>;
} {
  const counts = new Map<string, Map<string, number>>();
  const types = new Map<string, Map<string, string[]>>();
  for (const [chapterId, entry] of Object.entries(storyGraph.entries)) {
    for (const evt of entry.majorEvents ?? []) {
      if (!evt.agent) continue;
      const canonical = canonicalCharacterName(evt.agent, canonicalMap).toLowerCase();
      if (!canonical) continue;
      const per = counts.get(canonical) ?? new Map<string, number>();
      per.set(chapterId, (per.get(chapterId) ?? 0) + 1);
      counts.set(canonical, per);
      // ★ COUNT AND TYPES ARE BUILT IN ONE WALK. Two passes over majorEvents
      //   could disagree about which events have a resolvable agent, and the
      //   ledger would then draw a different number of marks than it counts.
      const perType = types.get(canonical) ?? new Map<string, string[]>();
      const list = perType.get(chapterId) ?? [];
      list.push(evt.type);
      perType.set(chapterId, list);
      types.set(canonical, perType);
    }
  }
  return { counts, types };
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

/** chapterId -> lower-cased character name -> the class the model settled on. */
export type PresenceOverrides =
  ReadonlyMap<string, ReadonlyMap<string, "present" | "mentioned">>;

export function buildSnapshotTimelineCharacterTracks(
  storyGraph: StoryGraph,
  worldData: WorldData | undefined,
  limit = Number.POSITIVE_INFINITY,
  overrides?: PresenceOverrides,
): TimelineCharacterTrack[] {
  const canonicalMap = buildCanonicalCharacterMap(worldData);
  const counts = new Map<string, number>();
  const chapterIdsByName = new Map<string, Set<string>>();

  const stored = readStoredPresence(storyGraph, canonicalMap, overrides);

  for (const [chapterId, entry] of Object.entries(storyGraph.entries)) {
    const present = new Set<string>();
    for (const rawName of entry.charactersPresent ?? []) {
      const canonical = canonicalCharacterName(rawName, canonicalMap);
      if (canonical) present.add(canonical);
    }
    // Evoked characters get a track too — being talked about while away is a
    // shape the ledger should show, not hide.
    for (const record of entry.presence ?? []) {
      const canonical = canonicalCharacterName(record.name, canonicalMap);
      if (canonical) present.add(canonical);
    }
    recordPresence(chapterId, present, counts, chapterIdsByName);
  }

  const drives = buildDrivesByName(storyGraph, canonicalMap);
  return finalizeTracks(counts, chapterIdsByName, limit, {
    drivesByName: drives.counts,
    driveTypesByName: drives.types,
    presenceByName: stored.presence,
    uncertainByName: stored.uncertain,
  });
}

export async function buildTimelineCharacterTracks(
  storyGraph: StoryGraph,
  chapters: Novel["chapters"],
  worldData: WorldData | undefined,
  limit = Number.POSITIVE_INFINITY,
  options?: TimelineTrackBuildOptions,
  overrides?: PresenceOverrides,
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

  // ★ THE STORED CLASSIFICATION IS PREFERRED AND THE RECOMPUTE IS THE FALLBACK,
  //   not the other way round. buildChapterEntry already ran the classifier
  //   with the chapter's own worldData; redoing it here for every chapter of a
  //   long book would compile a few regexes per character per chapter on the
  //   path that draws the panel. Graphs persisted before `presence` existed
  //   have nothing stored, and those recompute.
  const stored = readStoredPresence(storyGraph, canonicalMap, overrides);
  const presenceByName = stored.presence;
  const uncertainByName = stored.uncertain;
  const castForPresence = (worldData?.characters ?? [])
    .filter((c) => c.name && c.name.trim().length >= 2)
    .map((c) => ({ name: c.name.trim(), variants: c.aliases ?? [] }));

  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
    throwIfAborted(options?.signal);
    const chapter = chapters[chapterIndex];
    const present = new Set<string>();
    const entry = storyGraph.entries[chapter.id];

    for (const rawName of entry?.charactersPresent ?? []) {
      const canonical = canonicalCharacterName(rawName, canonicalMap);
      if (canonical) present.add(canonical);
    }

    if (!entry?.presence?.length && castForPresence.length > 0) {
      for (const record of classifyChapterPresence(chapter.content, castForPresence)) {
        if (record.klass === "absent") continue;
        const canonical = canonicalCharacterName(record.name, canonicalMap);
        if (!canonical) continue;
        const key = canonical.toLowerCase();
        const per = presenceByName.get(key) ?? new Map<string, "speaking" | "present" | "mentioned">();
        per.set(chapter.id, record.klass);
        presenceByName.set(key, per);
        if (record.uncertain) {
          const set = uncertainByName.get(key) ?? new Set<string>();
          set.add(chapter.id);
          uncertainByName.set(key, set);
        }
      }
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
  const driveData = buildDrivesByName(storyGraph, canonicalMap);
  return finalizeTracks(counts, chapterIdsByName, limit, {
    drivesByName: driveData.counts,
    driveTypesByName: driveData.types,
    mentionsByName,
    presenceByName,
    uncertainByName,
  });
}