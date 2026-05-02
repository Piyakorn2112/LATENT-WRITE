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

// ── Contextual entity classifier ──────────────────────────────────────────

const PLACE_SUFFIX_RE = /\b(forest|wood|woods|mountain|mountains|peak|ridge|valley|plains|plain|desert|island|islands|lake|river|sea|ocean|bay|gulf|cove|creek|brook|stream|falls|harbor|harbour|port|city|town|village|hamlet|castle|keep|tower|gate|bridge|road|street|avenue|square|market|hall|inn|tavern|temple|shrine|palace|manor|estate|fortress|citadel|dungeon|ruins|cave|cavern|mine|district|quarter|ward|sector|region|territory|province|country|land|field|fields|garden|gardens|cliff|pass|hills|hill|marsh|swamp|bog|inlet|basin)\b/i;

const FACTION_SUFFIX_RE = /\b(order|guild|house|council|brotherhood|sisterhood|society|alliance|clan|legion|corps|division|union|academy|circle|court|agency|federation|confederation|republic|dynasty|tribe|cult|sect|guard|watch|militia|syndicate|collective|assembly|parliament|senate|commission|committee|board|ministry|institute|college|chapter|covenant)\b/i;

const CHAR_TITLE_RE = /\b(lord|lady|sir|captain|master|doctor|dr|father|mother|queen|king|prince|princess|elder|chief|general|colonel|major|sergeant|inspector|professor|saint)\s*$/i;

const PLACE_PREP_RE = /\b(in|at|from|to|near|through|outside|inside|across|toward|towards|beyond|into|within|upon|above|below|around|beside|along|between|past)\s*$/i;

const CHAR_VERB_RE = /^\s*(said|asked|replied|whispered|shouted|called|told|warned|answered|explained|nodded|shook|smiled|frowned|looked|stared|watched|turned|walked|ran|moved|stood|sat|fell|rose|felt|thought|knew|heard|saw|met|glanced|waved|reached|grabbed|held|spoke|cried|laughed|sighed|gasped|blinked|noticed|realized|remembered|decided|wondered|wanted|needed|found|returned|entered|left|opened|closed|pulled|pushed|drew|raised|pressed|touched|released|jumped|stepped|leaned|knelt|bowed|pointed|added|continued|interrupted)\b/i;

const CHAR_PRONOUN_RE = /\b(he|she|they|him|her)\s*$/i;

const FACTION_COLLECTIVE_RE = /^\s*(attacked|gathered|declared|sent|marched|controlled|ruled|ordered|commanded|demanded|allied|fought|held|occupied|protected|served|arrived|retreated|advanced|surrounded|captured|released|accepted|rejected|agreed|disbanded|recruited|deployed|imposed)\b/i;

export interface ScanResult {
  characters: string[];
  places:     string[];
  factions:   string[];
}

/**
 * Scans `text` for Title-Case proper-noun candidates not already in `existing`,
 * then classifies each into character / place / faction using name-internal
 * keywords and contextual signals from the surrounding prose.
 */
export function scanAndClassify(
  text: string,
  existing: WorldData | undefined,
  minFreq = 2,
): ScanResult {
  // Build exclusion set from already-registered names + aliases
  const excluded = new Set<string>();
  for (const e of [
    ...(existing?.characters ?? []),
    ...(existing?.places     ?? []),
    ...(existing?.factions   ?? []),
  ]) {
    excluded.add(e.name.toLowerCase());
    for (const a of e.aliases ?? []) excluded.add(a.toLowerCase());
  }

  // Extract 1–3 word Title-Case sequences with frequency count
  const freq = new Map<string, number>();
  const pat = /\b([A-Z][a-z]{1,}(?:\s[A-Z][a-z]{1,}){0,2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = pat.exec(text)) !== null) {
    const name = m[1];
    const first = name.split(" ")[0];
    if (STOPLIST.has(first) || name.length < 3) continue;
    if (excluded.has(name.toLowerCase())) continue;
    freq.set(name, (freq.get(name) ?? 0) + 1);
  }

  // Filter, sort longest-first (so longer names win de-overlap), then by freq
  const candidates = [...freq.entries()]
    .filter(([, n]) => n >= minFreq)
    .sort((a, b) => b[0].length - a[0].length || b[1] - a[1])
    .map(([name]) => name);

  // De-overlap: drop shorter names that are strict substrings of a kept name
  const kept: string[] = [];
  for (const name of candidates) {
    const lc = name.toLowerCase();
    if (!kept.some((k) => k.toLowerCase() !== lc && k.toLowerCase().includes(lc))) {
      kept.push(name);
    }
  }

  const result: ScanResult = { characters: [], places: [], factions: [] };

  for (const name of kept) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ctxRe = new RegExp(`([^\\n]{0,90})\\b${esc}\\b([^\\n]{0,90})`, "gi");

    let charScore = 0, placeScore = 0, factScore = 0;

    // Name-internal structural signals (highest weight — reliable in fiction)
    if (PLACE_SUFFIX_RE.test(name)) placeScore += 4;
    if (FACTION_SUFFIX_RE.test(name)) factScore += 4;

    let cx: RegExpExecArray | null;
    while ((cx = ctxRe.exec(text)) !== null) {
      const before = cx[1];
      const after  = cx[2];
      if (CHAR_TITLE_RE.test(before))   charScore  += 3;
      if (CHAR_PRONOUN_RE.test(before)) charScore  += 2;
      if (CHAR_VERB_RE.test(after))     charScore  += 1;
      if (PLACE_PREP_RE.test(before))   placeScore += 1;
      if (/\bthe\s*$/i.test(before) && FACTION_COLLECTIVE_RE.test(after)) factScore += 2;
    }

    const max = Math.max(charScore, placeScore, factScore);
    if (factScore  === max && factScore  > charScore) { result.factions.push(name); continue; }
    if (placeScore === max && placeScore > charScore) { result.places.push(name);   continue; }
    result.characters.push(name);
  }

  return result;
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
