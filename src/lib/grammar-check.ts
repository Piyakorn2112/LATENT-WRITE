// Rule-based grammar checker.
//
// Detects common writing errors and emits ghost-text suggestions. NOT a full
// NLP system — just a pragmatic list of frequent confusables and patterns.
// The HighlightLayer renders each suggestion as small ghost text floating
// above the original word, no red squiggles or autocomplete.

export interface GrammarSuggestion {
  /** Absolute start offset in input text. */
  start: number;
  /** Absolute end offset (exclusive). */
  end: number;
  /** The original wrong text exactly as it appears. */
  original: string;
  /** The suggested replacement (will be displayed as ghost text). */
  suggestion: string;
  /** Short label classifying the type of issue. */
  kind: "confusable" | "spacing" | "double" | "punctuation" | "agreement";
}

interface Rule {
  pattern: RegExp;        // Must use the global flag.
  build: (m: RegExpExecArray) => { suggestion: string; kind: GrammarSuggestion["kind"] } | null;
}

// ─── Confusable pairs ───────────────────────────────────────────────────
// Context-aware where possible: only fire when surrounding tokens make the
// substitution likely correct (prevents false positives on legitimate uses).

const RULES: Rule[] = [
  // your → you're (before contractions or "welcome")
  { pattern: /\byour\s+(welcome|right|wrong|the\s+best|amazing|so|too|not|gonna|going\s+to)\b/gi,
    build: (m) => ({ suggestion: `you're ${m[1]}`, kind: "confusable" }) },

  // you're → your (before nouns)
  { pattern: /\byou're\s+(book|car|house|name|friend|family|hand|face|eyes|hair|mom|dad|brother|sister|son|daughter|own|fault)\b/gi,
    build: (m) => ({ suggestion: `your ${m[1]}`, kind: "confusable" }) },

  // their/there/they're confusion
  { pattern: /\btheir\s+(is|are|was|were|will\s+be|has\s+been)\b/gi,
    build: (m) => ({ suggestion: `there ${m[1]}`, kind: "confusable" }) },
  { pattern: /\bthere\s+(own|house|car|family|book|name)\b/gi,
    build: (m) => ({ suggestion: `their ${m[1]}`, kind: "confusable" }) },
  { pattern: /\bthey're\s+(house|car|book|own|family|name|friend)\b/gi,
    build: (m) => ({ suggestion: `their ${m[1]}`, kind: "confusable" }) },

  // its / it's
  { pattern: /\bits\s+(a|an|the|going|been|just|only|too|not|gonna|so)\b/gi,
    build: (m) => ({ suggestion: `it's ${m[1]}`, kind: "confusable" }) },
  { pattern: /\bit's\s+(own|way|effect|tail|head|own|color|colour|name|side)\b/gi,
    build: (m) => ({ suggestion: `its ${m[1]}`, kind: "confusable" }) },

  // affect / effect
  { pattern: /\b(the|an|a|that|this|side|major|minor|adverse|positive|negative)\s+affect\b/gi,
    build: (m) => ({ suggestion: `${m[1]} effect`, kind: "confusable" }) },
  { pattern: /\b(it|this|that|to)\s+effects\b/gi,
    build: (m) => ({ suggestion: `${m[1]} affects`, kind: "confusable" }) },

  // then / than
  { pattern: /\b(more|less|better|worse|other|rather|stronger|weaker|bigger|smaller|taller|shorter|faster|slower)\s+then\b/gi,
    build: (m) => ({ suggestion: `${m[1]} than`, kind: "confusable" }) },

  // loose / lose
  { pattern: /\bloose\s+(the|a|my|his|her|their|your|our|it|him|her|them|control|hope|track|sight|weight|time|money)\b/gi,
    build: (m) => ({ suggestion: `lose ${m[1]}`, kind: "confusable" }) },

  // could of / should of / would of / must of
  { pattern: /\b(could|should|would|must|might)\s+of\b/gi,
    build: (m) => ({ suggestion: `${m[1].toLowerCase()} have`, kind: "confusable" }) },

  // alot → a lot
  { pattern: /\balot\b/gi,
    build: () => ({ suggestion: "a lot", kind: "confusable" }) },

  // (Removed: "alright" → "all right". It's now widely accepted in modern
  //  English and editorial style guides; flagging it produced noise.)

  // definately / definitly → definitely
  { pattern: /\bdefin[ae]t(?:l|el)y\b/gi,
    build: () => ({ suggestion: "definitely", kind: "confusable" }) },

  // recieve → receive
  { pattern: /\brec[ie]{2}ve(d|s|r|rs|ing)?\b/gi,
    build: (m) => {
      const stem = "receiv";
      const suffix = m[1] ?? "e";
      const tail = suffix === "e" ? "e" : suffix;
      return { suggestion: stem + tail, kind: "confusable" };
    } },

  // seperate → separate
  { pattern: /\bsep[ae]rate(d|s|ly)?\b/gi,
    build: (m) => ({ suggestion: "separate" + (m[1] ?? ""), kind: "confusable" }) },

  // occured → occurred
  { pattern: /\boccured\b/gi,
    build: () => ({ suggestion: "occurred", kind: "confusable" }) },

  // truely → truly
  { pattern: /\btruely\b/gi,
    build: () => ({ suggestion: "truly", kind: "confusable" }) },

  // untill → until
  { pattern: /\buntill\b/gi,
    build: () => ({ suggestion: "until", kind: "confusable" }) },

  // begining → beginning
  { pattern: /\bbegining\b/gi,
    build: () => ({ suggestion: "beginning", kind: "confusable" }) },

  // ─── Spacing / typing artefacts ────────────────────────────────────
  // Doubled space inside a sentence
  { pattern: / {2,}(?=\S)/g,
    build: () => ({ suggestion: " ", kind: "spacing" }) },

  // Space before sentence punctuation
  { pattern: / +([.,;:!?])/g,
    build: (m) => ({ suggestion: m[1], kind: "punctuation" }) },

  // Missing space after sentence punctuation (lower → upper / letter)
  { pattern: /([.!?])([A-Z][a-z])/g,
    build: (m) => ({ suggestion: `${m[1]} ${m[2]}`, kind: "spacing" }) },

  // Doubled words — conservative list. We deliberately exclude "had", "is",
  // "that", "do", "did" because legitimate constructions exist (past perfect
  // "had had", relative clauses "the fact that that…", etc.). The list
  // below covers the typo-heavy cases without flagging valid grammar.
  { pattern: /\b(the|a|an|and|of|to|in|on|for|but|with|as|i|he|she|they|we|you|her|his|him|its|their|our|my|your|me|us|them|so|too|very|just|when|where|what|who|why|how|all|any|some|now|here|there)\s+\1\b/gi,
    build: (m) => ({ suggestion: m[1], kind: "double" }) },

  // ─── Subject-verb agreement (light) ────────────────────────────────
  // "he/she/it don't" → "doesn't"
  { pattern: /\b(he|she|it)\s+don't\b/gi,
    build: (m) => ({ suggestion: `${m[1]} doesn't`, kind: "agreement" }) },
  // "he/she/it have" → "has"
  { pattern: /\b(he|she|it)\s+have\b/gi,
    build: (m) => ({ suggestion: `${m[1]} has`, kind: "agreement" }) },

  // ─── Spelling: unambiguous single-word typos ────────────────────────
  // Each below has only ONE plausible correction and no legitimate use.
  // We deliberately do NOT flag informal contractions (gonna/wanna/tho/cuz
  // /thru) — those are intentional in fiction dialogue. We also do NOT
  // flag "everyday X" — "everyday" is a valid adjective ("everyday life"
  // is correct, "every day life" is wrong; the earlier rule had inverted
  // semantics and was firing on correct prose).
  { pattern: /\bwierd\b/gi,
    build: () => ({ suggestion: "weird", kind: "confusable" }) },
  { pattern: /\bteh\b/g,
    build: () => ({ suggestion: "the", kind: "confusable" }) },
  { pattern: /\bthier\b/gi,
    build: () => ({ suggestion: "their", kind: "confusable" }) },
  { pattern: /\bsupposably\b/gi,
    build: () => ({ suggestion: "supposedly", kind: "confusable" }) },
  { pattern: /\birregardless\b/gi,
    build: () => ({ suggestion: "regardless", kind: "confusable" }) },
  { pattern: /\bnoone\b/gi,
    build: () => ({ suggestion: "no one", kind: "confusable" }) },

  // ─── Punctuation/style ──────────────────────────────────────────────
  // Three+ exclamation marks → one. (Two is intentional emphasis;
  // we only flag three or more.)
  { pattern: /!{3,}/g,
    build: () => ({ suggestion: "!", kind: "punctuation" }) },
  // Three+ question marks → one.
  { pattern: /\?{3,}/g,
    build: () => ({ suggestion: "?", kind: "punctuation" }) },
  // Trailing space before paragraph break
  { pattern: / +(?=\n)/g,
    build: () => ({ suggestion: "", kind: "spacing" }) },
];

/** Run all rules over `text`, returning a sorted, non-overlapping list of
 *  suggestions. Earlier (lower-start) matches win on overlap. */
export function checkGrammar(text: string): GrammarSuggestion[] {
  if (!text) return [];

  const all: GrammarSuggestion[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text)) !== null) {
      const built = rule.build(m);
      if (!built) continue;
      const original = m[0];
      // Skip no-op suggestions (e.g., when casing already correct).
      if (built.suggestion === original) continue;
      all.push({
        start: m.index,
        end: m.index + original.length,
        original,
        suggestion: built.suggestion,
        kind: built.kind,
      });
    }
  }

  // Sort by start, drop overlaps (keep first).
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: GrammarSuggestion[] = [];
  let lastEnd = -1;
  for (const s of all) {
    if (s.start < lastEnd) continue;
    out.push(s);
    lastEnd = s.end;
  }
  return out;
}
