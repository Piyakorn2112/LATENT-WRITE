// Cross-chapter continuity signals — compares the active chapter against
// the surrounding book to surface high-leverage editorial flags:
//
//   • Out-of-order character mention — character first canonically
//     appears in a later chapter (potential timeline slip / missing
//     flashback marker).
//   • Chekhov candidates — concrete, specific nouns introduced in this
//     chapter that never recur. The writer can decide whether they
//     should pay off, fade, or be cut.
//   • Setting / time hand-off — soft check that the chapter's opening
//     locale and time-of-day cohere with the prior chapter's ending.
//
// Like prose-profile, all signals are heuristic. Designed to surface
// candidates the writer reviews; never to autocorrect.

import type { Chapter, WorldData } from "../types";

// ─── Character first-appearance map ──────────────────────────────────────
//
// Walks the book in chapter order and records the first chapter index
// where each known character name (or alias) appears. We then check the
// active chapter's mentions against that map: if a character is first
// "officially" introduced in chapter 12 but they're being mentioned in
// chapter 4, that's worth flagging.

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasesFor(c: WorldData["characters"][number]): string[] {
  return [c.name, ...(c.aliases ?? [])].filter(Boolean);
}

export interface OutOfOrderHit {
  character: string;       // canonical name
  firstChapter: number;    // chapter number where they're "officially" introduced
  thisChapter: number;     // current chapter number
}

export function findOutOfOrderMentions(
  chapters: Chapter[],
  worldData: WorldData | undefined,
  thisIndex: number,
): OutOfOrderHit[] {
  if (!worldData?.characters?.length) return [];
  if (thisIndex < 0 || thisIndex >= chapters.length) return [];
  const cur = chapters[thisIndex];
  const text = cur.content;
  if (!text.trim()) return [];

  const out: OutOfOrderHit[] = [];
  for (const ch of worldData.characters) {
    const aliases = aliasesFor(ch);
    if (aliases.length === 0) continue;
    const re = new RegExp(`\\b(?:${aliases.map(escapeRe).join("|")})\\b`, "i");
    if (!re.test(text)) continue;
    // Find the FIRST chapter that mentions this character.
    let firstIdx = -1;
    for (let i = 0; i < chapters.length; i++) {
      if (re.test(chapters[i].content)) { firstIdx = i; break; }
    }
    if (firstIdx >= 0 && firstIdx > thisIndex) {
      out.push({
        character: ch.name,
        firstChapter: chapters[firstIdx].number,
        thisChapter: cur.number,
      });
    }
  }
  return out;
}

// ─── Chekhov: introduced-and-never-recurs concrete nouns ─────────────────
//
// Heuristic: collect bigrams where a definite-article phrase ("the rusted
// pistol", "her grandfather's watch") appears in this chapter and the
// noun head never reappears in any later chapter. We match the *noun
// head* (last word of the phrase) against later content to count
// recurrences.

const STOPWORDS = new Set([
  "the","a","an","this","that","these","those","my","your","his","her",
  "their","our","its","one","some","any","every","each","what","which",
]);

const COMMON_NOUNS = new Set([
  // Body parts, generic nouns that aren't "objects" worth tracking.
  "hand","hands","face","faces","eye","eyes","head","heart","mouth","arm",
  "arms","leg","legs","foot","feet","skin","hair","fingers","finger",
  "shoulder","shoulders","back","chest","mind","minds","voice","voices",
  "thing","things","man","woman","men","women","boy","girl","boys","girls",
  "person","people","kid","kids","child","children","day","days","night",
  "nights","hour","hours","minute","minutes","time","moment","moments",
  "way","ways","place","places","side","end","start","beginning","middle",
  "front","top","bottom","line","lines","word","words","name","names",
  "thought","thoughts","reason","reasons","question","questions","answer",
  "kind","kinds","sort","point","part","parts",
]);

export interface ChekhovCandidate {
  /** The noun phrase, e.g. "rusted pistol". */
  phrase: string;
  /** Number of mentions in *this* chapter. */
  mentions: number;
}

export function findChekhovCandidates(
  chapters: Chapter[],
  thisIndex: number,
  limit = 6,
): ChekhovCandidate[] {
  if (thisIndex < 0 || thisIndex >= chapters.length - 1) {
    // No "later chapters" exists for the final chapter — nothing to check.
    return [];
  }
  const text = chapters[thisIndex].content;
  if (!text.trim()) return [];
  const later = chapters.slice(thisIndex + 1).map((c) => c.content.toLowerCase()).join("\n");

  // Match: definite-article + 0/1 adjective + concrete noun.
  // Only fires when the noun is *capitalised in source* OR the phrase
  // is preceded by a definite article — both signal "specificity".
  const re = /\b(?:the|a|an|his|her|their|its|my|your)\s+(?:[a-z]+\s+){0,2}([a-z]+ed|[a-z]+ing|[a-z]+)\s+([a-z]+)\b/g;

  const counts = new Map<string, { phrase: string; mentions: number }>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const adj = m[1] ?? "";
    const head = m[2] ?? "";
    if (!head || head.length < 4) continue;
    if (STOPWORDS.has(head) || COMMON_NOUNS.has(head)) continue;
    if (STOPWORDS.has(adj) || COMMON_NOUNS.has(adj)) continue;
    const phrase = `${adj} ${head}`.trim();
    const key = head;
    const ex = counts.get(key);
    if (ex) ex.mentions++;
    else counts.set(key, { phrase, mentions: 1 });
  }

  const out: ChekhovCandidate[] = [];
  for (const [head, { phrase, mentions }] of counts) {
    // Skip noun heads that recur in later chapters at all — they're
    // already paying off (or the writer is referencing them).
    if (later.includes(` ${head} `) || later.includes(` ${head}.`) || later.includes(` ${head},`)) {
      continue;
    }
    // Only flag if there's enough specificity: the head appears as a
    // noun in a definite-article phrase 1+ time and doesn't recur.
    out.push({ phrase, mentions });
  }
  out.sort((a, b) => b.mentions - a.mentions);
  return out.slice(0, limit);
}

// ─── Setting / time hand-off ─────────────────────────────────────────────
//
// Crude time/place tokens at the end of the previous chapter vs the
// start of this chapter. We don't try to model an absolute timeline;
// just flag when one chapter ends "in the dungeon, at midnight" and
// the next opens in "the city plaza, at noon" with no transition prose.

const TIME_TOKENS_RE = /\b(dawn|morning|noon|afternoon|dusk|evening|twilight|night|midnight|sunrise|sunset|daybreak|nightfall)\b/gi;

export interface HandoffHint {
  prevTime?: string;
  thisTime?: string;
  prevPlace?: string;     // best-effort (worldData place mentioned in prev chapter's ending)
  thisPlace?: string;
  drift: "time" | "place" | "both" | null;
}

export function detectHandoff(
  chapters: Chapter[],
  thisIndex: number,
  worldData: WorldData | undefined,
): HandoffHint | null {
  if (thisIndex <= 0) return null;
  const cur = chapters[thisIndex];
  const prev = chapters[thisIndex - 1];
  if (!cur.content.trim() || !prev.content.trim()) return null;

  // Look at the last ~600 chars of prev chapter and first ~600 of this.
  const prevTail = prev.content.slice(-600);
  const thisHead = cur.content.slice(0, 600);

  const lastTime = (prevTail.match(TIME_TOKENS_RE) ?? []).pop()?.toLowerCase();
  const firstTime = (thisHead.match(TIME_TOKENS_RE) ?? [])[0]?.toLowerCase();

  // Place hand-off: dominant place mentioned in each window.
  const places = worldData?.places ?? [];
  const placesAndAliases = places.flatMap((p) => [p.name, ...(p.aliases ?? [])]).filter(Boolean);
  const findPlace = (window: string): string | undefined => {
    let best: { name: string; count: number } | null = null;
    for (const p of placesAndAliases) {
      if (!p) continue;
      const re = new RegExp(`\\b${escapeRe(p)}\\b`, "gi");
      const c = (window.match(re) ?? []).length;
      if (c > 0 && (!best || c > best.count)) best = { name: p, count: c };
    }
    return best?.name;
  };

  const prevPlace = findPlace(prevTail);
  const thisPlace = findPlace(thisHead);

  let drift: "time" | "place" | "both" | null = null;
  const timeShift = lastTime && firstTime && lastTime !== firstTime;
  const placeShift = prevPlace && thisPlace && prevPlace !== thisPlace;
  if (timeShift && placeShift) drift = "both";
  else if (timeShift) drift = "time";
  else if (placeShift) drift = "place";

  if (!drift) return null;
  return {
    prevTime: lastTime,
    thisTime: firstTime,
    prevPlace,
    thisPlace,
    drift,
  };
}

// Aggregate all signals — convenience for the widget.
export interface ContinuitySummary {
  outOfOrder: OutOfOrderHit[];
  chekhov: ChekhovCandidate[];
  handoff: HandoffHint | null;
  hasAnything: boolean;
}

export function summarizeContinuity(
  chapters: Chapter[],
  worldData: WorldData | undefined,
  thisIndex: number,
): ContinuitySummary {
  const outOfOrder = findOutOfOrderMentions(chapters, worldData, thisIndex);
  const chekhov = findChekhovCandidates(chapters, thisIndex);
  const handoff = detectHandoff(chapters, thisIndex, worldData);
  return {
    outOfOrder,
    chekhov,
    handoff,
    hasAnything: outOfOrder.length > 0 || chekhov.length > 0 || handoff !== null,
  };
}
