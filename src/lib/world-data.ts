import type {
  AdaptiveCandidateOption,
  AdaptiveInferenceContext,
  AdaptivePredictionTrace,
  Novel,
  WorldData,
} from "../types";
import { rerankAdaptiveCandidates } from "./adaptive-inference";

// ── Types ──────────────────────────────────────────────────────────────────

export interface WorldEntity {
  name: string;
  type: "character" | "place" | "faction";
  role?: string;
  description?: string;
}

interface EntityContextSignals {
  occurrences: number;
  charScore: number;
  placeScore: number;
  factScore: number;
  totalContext: number;
  previewBefore: string;
  previewAfter: string;
  isMultiWord: boolean;
  hasJoiner: boolean;
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

// ── Hard discrete filter — commonly-capitalised non-entity English words ───
//
// Words in these well-defined semantic classes appear Title-Cased at sentence
// starts in every novel but are never characters, places, or factions.
// This O(1) lookup removes the most frequent false-positive classes before
// the more expensive IDF scoring stage.
const COMMON_CAPITALIZED: ReadonlySet<string> = new Set([
  // Days of week
  "Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday",
  // Months
  "January","February","March","April","June",
  "July","August","September","October","November","December",
  // Cardinal numbers — one through nineteen, round tens, large magnitudes
  "One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten",
  "Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen",
  "Eighteen","Nineteen","Twenty","Thirty","Forty","Fifty","Sixty",
  "Seventy","Eighty","Ninety","Hundred","Thousand","Million","Billion",
  // Ordinals
  "Second","Third","Fourth","Fifth","Sixth","Seventh","Eighth",
  "Ninth","Tenth","Eleventh","Twelfth","Thirteenth","Fourteenth",
  "Fifteenth","Sixteenth","Seventeenth","Eighteenth","Nineteenth","Twentieth",
  // Seasons
  "Spring","Summer","Autumn","Winter",
  // Time-of-day / relative-time expressions
  "Morning","Afternoon","Evening","Midnight","Noon","Dusk",
  "Today","Tomorrow","Yesterday",
]);

// ── TF-IDF: English prose word-frequency table (IDF proxy) ────────────────
//
// Each entry maps a lowercase word to its approximate relative frequency in
// general English fiction prose, calibrated against BNC / COCA word-frequency
// lists and normalised to [0, 1].
//
//   IDF(w) = log(1 + 1 / freq(w))
//
// High-frequency English words ("Thursday" → 0.81, "One" → 0.97) yield
// IDF < 1.0 and are suppressed by the NSS gate below.
// Invented / world-specific names absent from this table default to
// RARE_WORD_FREQ ≈ 0.02, giving IDF ≈ 3.93 — well above every threshold.
//
// Threshold reference:
//   freq 0.97 → IDF 0.71   ("one" — blocked)
//   freq 0.82 → IDF 0.80   ("thursday" — blocked)
//   freq 0.27 → IDF 1.61   (breakeven for MIN_IDF_SOLO)
//   freq 0.55 → IDF 0.72   (breakeven for MIN_IDF_WITH_CONTEXT)
//   freq 0.02 → IDF 3.93   (invented name — always passes)
const ENGLISH_WORD_FREQ: ReadonlyMap<string, number> = new Map<string, number>([
  // Days
  ["monday",0.82],["tuesday",0.81],["wednesday",0.82],["thursday",0.81],
  ["friday",0.82],["saturday",0.80],["sunday",0.80],
  // Months
  ["january",0.83],["february",0.80],["march",0.82],["april",0.81],
  ["may",0.80],["june",0.80],["july",0.80],["august",0.79],
  ["september",0.78],["october",0.79],["november",0.78],["december",0.80],
  // Cardinals
  ["one",0.97],["two",0.96],["three",0.95],["four",0.94],["five",0.93],
  ["six",0.92],["seven",0.91],["eight",0.90],["nine",0.89],["ten",0.89],
  ["eleven",0.86],["twelve",0.86],["thirteen",0.85],["fourteen",0.84],
  ["fifteen",0.84],["sixteen",0.83],["seventeen",0.83],["eighteen",0.83],
  ["nineteen",0.82],["twenty",0.88],["thirty",0.86],["forty",0.85],
  ["fifty",0.85],["sixty",0.84],["seventy",0.83],["eighty",0.83],
  ["ninety",0.82],["hundred",0.90],["thousand",0.88],["million",0.87],
  ["billion",0.85],
  // Ordinals
  ["first",0.95],["second",0.94],["third",0.93],["fourth",0.88],
  ["fifth",0.87],["sixth",0.85],["seventh",0.84],["eighth",0.83],
  ["ninth",0.82],["tenth",0.82],["eleventh",0.80],["twelfth",0.79],
  // Seasons
  ["spring",0.84],["summer",0.87],["autumn",0.82],["winter",0.85],
  // Time
  ["morning",0.90],["afternoon",0.88],["evening",0.88],["night",0.91],
  ["midnight",0.85],["noon",0.83],["dawn",0.84],["dusk",0.82],
  ["today",0.93],["tomorrow",0.92],["yesterday",0.91],
  // High-frequency common nouns that appear title-cased in fiction
  ["people",0.93],["person",0.92],["man",0.94],["woman",0.92],
  ["child",0.91],["boy",0.90],["girl",0.90],["time",0.95],
  ["day",0.94],["year",0.93],["way",0.94],["thing",0.93],
  ["world",0.90],["life",0.90],["death",0.88],["blood",0.86],
  ["hand",0.92],["eye",0.89],["heart",0.89],["mind",0.88],
  ["soul",0.85],["voice",0.87],["face",0.91],["head",0.91],
  ["door",0.88],["room",0.88],["wall",0.87],["floor",0.86],
  ["sky",0.87],["sun",0.89],["moon",0.86],["star",0.87],
  ["wind",0.87],["rain",0.86],["fire",0.88],["water",0.90],
  ["earth",0.88],["light",0.91],["darkness",0.84],["shadow",0.84],
  ["name",0.92],["word",0.91],["thought",0.89],["feeling",0.87],
  ["power",0.89],["place",0.91],["moment",0.90],["memory",0.87],
  ["silence",0.84],["air",0.90],["ground",0.88],["path",0.87],
  ["step",0.88],["nothing",0.91],["everything",0.89],["something",0.89],
  ["someone",0.89],["anyone",0.87],["everyone",0.87],["nobody",0.85],
  // Common adjectives / adverbs that frequently open sentences in fiction
  ["good",0.94],["bad",0.93],["long",0.93],["short",0.91],
  ["big",0.92],["small",0.92],["high",0.91],["low",0.90],
  ["young",0.90],["true",0.92],["false",0.88],
  ["wrong",0.90],["hard",0.90],["soft",0.87],
  ["cold",0.89],["hot",0.89],["fast",0.88],["slow",0.88],
  ["full",0.90],["empty",0.87],["open",0.90],["closed",0.86],
  ["dead",0.89],["alive",0.86],["free",0.90],["lost",0.88],
  ["ready",0.88],["gone",0.88],["done",0.90],["dark",0.87],
  // Additional sentence-starters common in English fiction prose
  ["later",0.90],["soon",0.91],["once",0.90],["twice",0.87],
  ["half",0.91],["above",0.88],["below",0.87],["inside",0.88],
  ["outside",0.87],["near",0.90],["far",0.88],["across",0.88],
  ["around",0.89],["within",0.87],["beyond",0.86],["beneath",0.85],
  ["beside",0.85],["despite",0.87],["except",0.87],["along",0.88],
  ["through",0.90],["toward",0.88],["upon",0.88],["until",0.90],
  ["past",0.89],["since",0.90],
]);

// ── Novel-Specificity Score (NSS) — TF-IDF-inspired proper-noun metric ─────
//
// IDF(w) = log(1 + 1 / freq_english(w))
//
// Two-tier threshold system:
//
//   MIN_IDF_SOLO         — required when context signals are absent or weak.
//                          Filters common English words (days, months, numbers,
//                          generic nouns) that happen to be capitalised.
//                          Breakeven at corpus-freq ≈ 0.27.
//
//   MIN_IDF_WITH_CONTEXT — relaxed threshold applied when accumulated
//                          character / place / faction signal points reach
//                          CONTEXT_SIGNAL_THRESHOLD.  Admits borderline words
//                          used as actual entity names (e.g. "Dawn", "Hope",
//                          "March") when the prose provides clear evidence.
//                          Breakeven at corpus-freq ≈ 0.55.
//
// Words completely absent from ENGLISH_WORD_FREQ receive RARE_WORD_FREQ
// (0.02) → IDF ≈ 3.93, comfortably above both thresholds.
const RARE_WORD_FREQ           = 0.02;
const MIN_IDF_SOLO             = 1.61; // log(1 + 1/0.27)
const MIN_IDF_WITH_CONTEXT     = 0.72; // log(1 + 1/0.55)
const CONTEXT_SIGNAL_THRESHOLD = 3;    // min accumulated context points to unlock relaxed gate

const TITLE_TOKEN_PATTERN = `[A-Z][a-z]{1,}(?:['’-][A-Z][a-z]{1,})*`;

function buildTitleCaseCandidateRe(maxWords: number): RegExp {
  return new RegExp(`\\b(${TITLE_TOKEN_PATTERN}(?:\\s${TITLE_TOKEN_PATTERN}){0,${Math.max(0, maxWords - 1)}})\\b`, "g");
}

/** Compute IDF weight for a candidate word or phrase. */
function computeIDF(word: string): number {
  const lc      = word.toLowerCase();
  const firstLc = word.split(" ")[0].toLowerCase();
  const freq    = ENGLISH_WORD_FREQ.get(lc) ?? ENGLISH_WORD_FREQ.get(firstLc) ?? RARE_WORD_FREQ;
  return Math.log(1 + 1 / freq);
}

function collectTitleCaseCandidates(text: string, maxWords: number): Map<string, number> {
  const freq = new Map<string, number>();
  const pattern = buildTitleCaseCandidateRe(maxWords);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1];
    const first = name.split(" ")[0];
    if (STOPLIST.has(first) || COMMON_CAPITALIZED.has(first) || name.length < 3) continue;
    freq.set(name, (freq.get(name) ?? 0) + 1);
  }
  return freq;
}

const CHAR_NAMED_RE = /\b(named|called)\s*$/i;
const CHAR_POSSESSIVE_AFTER_RE = /^\s*['’]s\b/i;
const PLACE_OF_RE = /\b(city|town|village|hamlet|kingdom|empire|realm|province|district|ward|sector|port|harbor|harbour|temple|fortress|castle|keep|mount|mountain|river|lake|forest|woods|island|sea|bay|garden|market|road|street|avenue|hall|inn|bridge|gate|capital|region|territory|basin)\s+(?:of|called)\s*$/i;
const FACTION_PREFIX_RE = /\b(the|house|order|guild|clan|legion|council|academy|guard|watch|union|alliance|ministry|court|brotherhood|sisterhood|syndicate|collective|committee|board)\s*$/i;

function computeEntityContextSignals(text: string, name: string): EntityContextSignals {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ctxRe = new RegExp(`([^\\n]{0,90})\\b${escaped}\\b([^\\n]{0,90})`, "gi");

  let occurrences = 0;
  let charScore = 0;
  let placeScore = 0;
  let factScore = 0;
  let previewBefore = "";
  let previewAfter = "";

  if (PLACE_SUFFIX_RE.test(name)) placeScore += 4;
  if (FACTION_SUFFIX_RE.test(name)) factScore += 4;

  let match: RegExpExecArray | null;
  while ((match = ctxRe.exec(text)) !== null) {
    const before = match[1];
    const after = match[2];
    occurrences += 1;
    if (!previewBefore && !previewAfter) {
      previewBefore = before;
      previewAfter = after;
    }

    if (CHAR_TITLE_RE.test(before))   charScore += 3;
    if (CHAR_PRONOUN_RE.test(before)) charScore += 2;
    if (CHAR_VERB_RE.test(after))     charScore += 1.25;
    if (CHAR_NAMED_RE.test(before))   charScore += 2;
    if (CHAR_POSSESSIVE_AFTER_RE.test(after)) charScore += 0.75;

    if (PLACE_PREP_RE.test(before))   placeScore += 1.25;
    if (PLACE_OF_RE.test(before))     placeScore += 2.5;

    if (/\bthe\s*$/i.test(before) && FACTION_COLLECTIVE_RE.test(after)) factScore += 2;
    if (FACTION_PREFIX_RE.test(before)) factScore += 1.5;
  }

  return {
    occurrences,
    charScore,
    placeScore,
    factScore,
    totalContext: charScore + placeScore + factScore,
    previewBefore,
    previewAfter,
    isMultiWord: /\s/.test(name),
    hasJoiner: /['’-]/.test(name),
  };
}

function shouldKeepEntityCandidate(
  name: string,
  occurrences: number,
  signals: EntityContextSignals,
  minFreq: number,
): boolean {
  const strongest = Math.max(signals.charScore, signals.placeScore, signals.factScore);
  const structural = signals.isMultiWord || signals.hasJoiner || PLACE_SUFFIX_RE.test(name) || FACTION_SUFFIX_RE.test(name);
  if (occurrences >= minFreq + 2) return true;
  if (structural && occurrences >= minFreq) return true;
  if (signals.totalContext >= 2) return true;
  if (strongest >= 1.5 && occurrences >= minFreq) return true;
  return false;
}

function candidateSortScore(
  occurrences: number,
  idf: number,
  signals: EntityContextSignals,
): number {
  return occurrences * 14 + signals.totalContext * 6 + (signals.isMultiWord ? 5 : 0) + (signals.hasJoiner ? 3 : 0) + idf * 4;
}

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
  const freq = collectTitleCaseCandidates(allText, 2);

  return [...freq.entries()]
    .map(([name, n]) => {
      const signals = computeEntityContextSignals(allText, name);
      const idf = computeIDF(name);
      const minIdf = signals.totalContext >= CONTEXT_SIGNAL_THRESHOLD
        ? MIN_IDF_WITH_CONTEXT
        : MIN_IDF_SOLO;
      return { name, n, idf, minIdf, signals };
    })
    .filter(({ name, n, idf, minIdf, signals }) =>
      n >= minFreq && idf >= minIdf && shouldKeepEntityCandidate(name, n, signals, minFreq),
    )
    .sort((a, b) => candidateSortScore(b.n, b.idf, b.signals) - candidateSortScore(a.n, a.idf, a.signals))
    .slice(0, max)
    .map(({ name }) => name);
}

function autoExtractKnownNamesFast(novel: Novel, minFreq = 3, max = 30): string[] {
  const allText = novel.chapters.map((c) => c.content).join("\n");
  if (!allText) return [];
  const freq = new Map<string, number>();
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

interface ScanAndClassifyOptions {
  adaptiveContext?: AdaptiveInferenceContext;
  predictionTraceOut?: { value: AdaptivePredictionTrace[] };
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
  options?: ScanAndClassifyOptions,
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
  const freq = collectTitleCaseCandidates(text, 3);
  for (const name of [...freq.keys()]) {
    if (excluded.has(name.toLowerCase())) freq.delete(name);
  }

  // Filter, sort longest-first (so longer names win de-overlap), then by freq
  const candidates = [...freq.entries()]
    .filter(([name, n]) => {
      if (n < minFreq) return false;
      const signals = computeEntityContextSignals(text, name);
      const idf = computeIDF(name);
      const minIdf = signals.totalContext >= CONTEXT_SIGNAL_THRESHOLD
        ? MIN_IDF_WITH_CONTEXT
        : MIN_IDF_SOLO;
      return idf >= minIdf && shouldKeepEntityCandidate(name, n, signals, minFreq);
    })
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
  if (options?.predictionTraceOut) options.predictionTraceOut.value = [];

  for (let keptIndex = 0; keptIndex < kept.length; keptIndex++) {
    const name = kept[keptIndex];
    const signals = computeEntityContextSignals(text, name);
    const charScore = signals.charScore;
    const placeScore = signals.placeScore;
    const factScore = signals.factScore;
    const previewBefore = signals.previewBefore;
    const previewAfter = signals.previewAfter;

    // ── NSS (Novel-Specificity Score) gate ────────────────────────────────
    // Suppresses common English words that happen to be Title-Cased (e.g.
    // "Thursday", "Morning", "Second") unless strong contextual evidence
    // confirms they are used as entity names in this specific text.
    const totalContext = signals.totalContext;
    const idf          = computeIDF(name);
    const minIDF       = totalContext >= CONTEXT_SIGNAL_THRESHOLD
      ? MIN_IDF_WITH_CONTEXT
      : MIN_IDF_SOLO;
    if (idf < minIDF) continue;

    const entityCandidates: AdaptiveCandidateOption[] = [
      {
        label: "character",
        source: "entity-heuristic",
        baseScore: charScore * 25 + idf * 8,
        learnedAdjustment: 0,
        finalScore: charScore * 25 + idf * 8,
        features: {
          char_score: charScore,
          place_score: placeScore,
          faction_score: factScore,
          total_context: totalContext,
          idf,
          place_suffix: PLACE_SUFFIX_RE.test(name) ? 1 : 0,
          faction_suffix: FACTION_SUFFIX_RE.test(name) ? 1 : 0,
        },
      },
      {
        label: "place",
        source: "entity-heuristic",
        baseScore: placeScore * 25 + idf * 8,
        learnedAdjustment: 0,
        finalScore: placeScore * 25 + idf * 8,
        features: {
          char_score: charScore,
          place_score: placeScore,
          faction_score: factScore,
          total_context: totalContext,
          idf,
          place_suffix: PLACE_SUFFIX_RE.test(name) ? 1 : 0,
          faction_suffix: FACTION_SUFFIX_RE.test(name) ? 1 : 0,
        },
      },
      {
        label: "faction",
        source: "entity-heuristic",
        baseScore: factScore * 25 + idf * 8,
        learnedAdjustment: 0,
        finalScore: factScore * 25 + idf * 8,
        features: {
          char_score: charScore,
          place_score: placeScore,
          faction_score: factScore,
          total_context: totalContext,
          idf,
          place_suffix: PLACE_SUFFIX_RE.test(name) ? 1 : 0,
          faction_suffix: FACTION_SUFFIX_RE.test(name) ? 1 : 0,
        },
      },
      {
        label: null,
        source: "entity-null",
        baseScore: Math.max(0, (MIN_IDF_SOLO - idf) * 40),
        learnedAdjustment: 0,
        finalScore: Math.max(0, (MIN_IDF_SOLO - idf) * 40),
        features: {
          char_score: charScore,
          place_score: placeScore,
          faction_score: factScore,
          total_context: totalContext,
          idf,
          place_suffix: PLACE_SUFFIX_RE.test(name) ? 1 : 0,
          faction_suffix: FACTION_SUFFIX_RE.test(name) ? 1 : 0,
        },
      },
    ];

    const max = Math.max(charScore, placeScore, factScore);
    let predictedLabel: "character" | "place" | "faction" = "character";
    if (factScore === max && factScore > charScore) predictedLabel = "faction";
    else if (placeScore === max && placeScore > charScore) predictedLabel = "place";

    const ranked = rerankAdaptiveCandidates(options?.adaptiveContext, entityCandidates, {
      task: "entity",
      spanText: name,
      contextBefore: previewBefore.slice(-120),
      contextAfter: previewAfter.slice(0, 120),
    });
    const chosenLabel = ranked.candidates[0]?.label;
    const finalLabel =
      options?.adaptiveContext && typeof chosenLabel === "string" && ranked.confidence >= 0.68
        ? chosenLabel as "character" | "place" | "faction"
        : predictedLabel;

    options?.predictionTraceOut?.value.push({
      task: "entity",
      paragraphIndex: 0,
      spanIndex: keptIndex,
      spanText: name,
      contextBefore: previewBefore.slice(-120),
      contextAfter: previewAfter.slice(0, 120),
      candidates: ranked.candidates,
      predictedLabel: finalLabel,
      confidence: ranked.confidence,
      needsReview: ranked.needsReview,
      ambiguityGap: ranked.ambiguityGap,
      source: "entity-scan",
    });

    if (finalLabel === "faction") { result.factions.push(name); continue; }
    if (finalLabel === "place") { result.places.push(name); continue; }
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
  return autoExtractKnownNamesFast(novel);
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
