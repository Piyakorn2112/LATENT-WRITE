import type { Novel, WorldData } from "../types";

// ── Types ──────────────────────────────────────────────────────────────────

export interface WorldEntity {
  name: string;
  type: "character" | "place" | "faction";
  role?: string;
  description?: string;
}

// ── Empty / construction helpers ───────────────────────────────────────────

export function emptyWorldData(): WorldData {
  return { characters: [], places: [], factions: [] };
}

export function ensureWorldData(novel: Novel): WorldData {
  const wd = novel.worldData;
  if (!wd) return emptyWorldData();
  return {
    characters: wd.characters ?? [],
    places: wd.places ?? [],
    factions: wd.factions ?? [],
  };
}

export function isWorldDataEmpty(wd: WorldData | undefined): boolean {
  if (!wd) return true;
  return (
    (wd.characters?.length ?? 0) === 0 &&
    (wd.places?.length ?? 0) === 0 &&
    (wd.factions?.length ?? 0) === 0
  );
}

// ── Stop list — words that start sentences but aren't proper nouns ─────────
const STOPLIST = new Set([
  "The", "This", "That", "These", "Those", "There", "Then", "Than", "What",
  "When", "Where", "Why", "How", "Who", "Which", "He", "She", "It", "They",
  "We", "His", "Her", "Its", "Their", "Our", "My", "Your", "Was", "Were",
  "Had", "Has", "Have", "Be", "Been", "Being", "Is", "Are", "Do", "Does",
  "Did", "Will", "Would", "Could", "Should", "May", "Might", "Must", "Can",
  "All", "Any", "Not", "No", "So", "As", "If", "But", "And", "Or", "For",
  "With", "From", "By", "At", "To", "In", "On", "Of", "Up", "Out",
  "About", "Into", "After", "Before", "Through", "Between", "Without",
  "Very", "Just", "More", "Most", "Also", "Still", "Even", "Now", "Back",
  "Each", "First", "Last", "Next", "Same", "Other", "New", "Old", "Such",
  "Only", "Both", "Over", "Down", "Here", "Again", "Much", "Many", "While",
  "During", "Once", "Every", "Never", "Always", "Already", "Something",
  "Someone", "Somewhere", "Nothing", "Nobody", "Nowhere", "Everything",
  "Everyone", "Everywhere", "Anything", "Anyone", "Somehow", "Whatever",
  "Whoever", "However", "Wherever", "Whenever", "Whichever", "Neither",
  "Either", "Few", "Several", "Another", "Above", "Against", "Along",
  "Among", "Around", "Across", "Behind", "Below", "Beside", "Beyond",
  "Despite", "Except", "Inside", "Instead", "Near", "Off", "Outside",
  "Past", "Since", "Throughout", "Toward", "Under", "Until", "Upon",
  "Within", "Perhaps", "Eventually", "Suddenly", "Quickly", "Slowly",
  "Carefully", "Finally", "Immediately", "Certainly", "Clearly", "Simply",
  "Naturally", "Probably", "Possibly", "Obviously", "Apparently", "Nearly",
  "Quietly", "Briefly", "Partly", "Mostly", "Barely", "Deeply",
  "Quite", "Rather", "Exactly", "Almost", "Enough", "Ahead", "Away",
  "Chapter",
]);

// ── World data → entity map ────────────────────────────────────────────────

/**
 * Converts world data into a lookup map (lowercase key → entity) and a flat
 * list of all display names + aliases for regex building. Returns empty
 * structures for an empty/missing worldData.
 */
export function buildEntityMap(worldData: WorldData | undefined): {
  map: Map<string, WorldEntity>;
  names: string[];
} {
  const map = new Map<string, WorldEntity>();
  const names: string[] = [];
  if (!worldData) return { map, names };

  const push = (
    type: WorldEntity["type"],
    name: string,
    role?: string,
    description?: string,
    aliases?: string[],
  ) => {
    if (!name) return;
    const entity: WorldEntity = { name, type, role, description };
    map.set(name.toLowerCase(), entity);
    names.push(name);
    for (const alias of aliases ?? []) {
      if (!alias) continue;
      map.set(alias.toLowerCase(), entity);
      names.push(alias);
    }
  };

  for (const c of worldData.characters ?? []) {
    push("character", c.name, c.role, c.description, c.aliases);
  }
  for (const p of worldData.places ?? []) {
    push("place", p.name, p.type, p.description, p.aliases);
  }
  for (const f of worldData.factions ?? []) {
    push("faction", f.name, f.type, f.description, f.aliases);
  }

  return { map, names };
}

// ── Auto-extraction heuristic ──────────────────────────────────────────────

/**
 * Scans all chapters for Title-Case words/phrases that appear `minFreq`+ times.
 * Used as a zero-config fallback when the user hasn't entered any world data.
 * Pure regex + frequency count — no external libraries.
 */
export function autoExtractEntities(novel: Novel, minFreq = 3, max = 30): string[] {
  const allText = novel.chapters.map((c) => c.content).join("\n");
  if (!allText) return [];
  const freq = new Map<string, number>();

  // Match 1–2 word Title-Case sequences. Two-word names ("Iris Valen") count
  // as one token; we sort longest-first later so longer wins on tie.
  const pattern = /\b([A-Z][a-z]{1,}(?:\s[A-Z][a-z]{1,})?)\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(allText)) !== null) {
    const name = match[1];
    const first = name.split(" ")[0];
    if (!STOPLIST.has(first) && name.length >= 3) {
      freq.set(name, (freq.get(name) ?? 0) + 1);
    }
  }

  return [...freq.entries()]
    .filter(([, n]) => n >= minFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([name]) => name);
}

// ── Combined known-names resolver ─────────────────────────────────────────

/**
 * Returns the deduplicated list of entity names to feed into speech-detect
 * and the highlight layer. Prefers world data when present, falls back to
 * heuristic extraction otherwise. World data names always come first so they
 * win equal-length ties during longest-first sorting.
 */
export function resolveKnownNames(novel: Novel): string[] {
  const fromWorld = buildEntityMap(novel.worldData).names;
  if (fromWorld.length > 0) {
    // Deduplicate while preserving insertion order
    const seen = new Set<string>();
    const out: string[] = [];
    for (const n of fromWorld) {
      const k = n.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(n); }
    }
    return out;
  }
  return autoExtractEntities(novel);
}

// ── Regex pattern builder ──────────────────────────────────────────────────

/**
 * Returns the alternation pattern string for entity matching. Caller
 * constructs `new RegExp(pattern, 'gi')` fresh per use to avoid shared
 * lastIndex issues. Longer names listed first so "Iris Valen" beats "Iris".
 */
export function buildEntityPattern(names: string[]): string | null {
  if (names.length === 0) return null;
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `\\b(?:${escaped.join("|")})\\b`;
}

// ── Rename ─────────────────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replace `oldName` with `newName` in `text`. Word-bounded and case-sensitive
 * by default — protects against false positives like renaming "Mark" turning
 * "marker" into "Bobker". Returns { text, count } so callers can display
 * what was changed.
 */
export function renameInText(text: string, oldName: string, newName: string): {
  text: string;
  count: number;
} {
  if (!oldName || oldName === newName) return { text, count: 0 };
  let count = 0;
  // \b is unreliable around accented letters / Unicode; we anchor manually
  // with character-class checks for word boundaries instead.
  const re = new RegExp(`(^|[^A-Za-z0-9_'\\u00C0-\\u024F])(${escapeRe(oldName)})(?=$|[^A-Za-z0-9_'\\u00C0-\\u024F])`, "g");
  const next = text.replace(re, (_m, pre) => {
    count++;
    return pre + newName;
  });
  return { text: next, count };
}

/**
 * Rename across a single chapter's content. Returns the patched content
 * and the replacement count.
 */
export function renameInChapter(
  chapter: { content: string },
  oldName: string,
  newName: string,
): { content: string; count: number } {
  const { text, count } = renameInText(chapter.content, oldName, newName);
  return { content: text, count };
}

/**
 * Rename across every chapter in the novel. Returns the patched novel and
 * a per-chapter count summary.
 */
export function renameInBook(
  novel: Novel,
  oldName: string,
  newName: string,
): { novel: Novel; total: number } {
  let total = 0;
  const chapters = novel.chapters.map((c) => {
    const { text, count } = renameInText(c.content, oldName, newName);
    total += count;
    return count > 0 ? { ...c, content: text } : c;
  });
  return { novel: { ...novel, chapters }, total };
}

// ── Entity lookup / update helpers ─────────────────────────────────────────

/**
 * Find which world-data record (and which list) holds the given name or alias.
 * Returns a path token like `characters[2]` to address it from React state.
 */
export function findEntityIndex(
  worldData: WorldData | undefined,
  name: string,
): { kind: "characters" | "places" | "factions"; index: number } | null {
  if (!worldData || !name) return null;
  const lc = name.toLowerCase();
  const match = (
    list: { name: string; aliases?: string[] }[] | undefined,
  ): number => {
    if (!list) return -1;
    return list.findIndex(
      (e) =>
        e.name.toLowerCase() === lc ||
        (e.aliases ?? []).some((a) => a.toLowerCase() === lc),
    );
  };
  let i = match(worldData.characters);
  if (i >= 0) return { kind: "characters", index: i };
  i = match(worldData.places);
  if (i >= 0) return { kind: "places", index: i };
  i = match(worldData.factions);
  if (i >= 0) return { kind: "factions", index: i };
  return null;
}
