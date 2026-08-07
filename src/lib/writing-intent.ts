/**
 * writing-intent.ts — rules-only edit-intent classifier for the writing tool.
 *
 * ★ THE INSTRUCTION'S CLASS DECIDES THE HARNESS, NOT THE MODEL. The
 *   writing-assistant literature (IteraTeR, CoEdIT) found a small model's
 *   editing quality is substantially a function of whether the harness knows
 *   WHICH edit it is performing — and our old refusals ("merge these two
 *   paragraphs" was inexpressible) were routing failures, not model
 *   failures. The class picks batching granularity, system prompt, gate
 *   profile and retry behavior in writing-tool.ts.
 *
 * ★ UNKNOWN IS THE CONTRACT, NOT A SHRUG. Rules here are deliberately
 *   high-precision: anything they do not confidently match falls to
 *   "unknown", which routes EXACTLY like today's custom path — so a
 *   misclassification cannot make any previously-working request worse.
 *   (An embedding layer under these rules is specced but deferred until
 *   rules-miss frequency is observed: plans/harness-upgrade-spec.md.)
 */

export type WritingIntent =
  | "merge"
  | "split"
  | "condense"
  | "expand"
  | "insert"
  | "tone"
  | "target"
  | "scrub"
  | "unknown";

/**
 * A SCRUB edit — the self-editing-checklist family (field research:
 * plans/writer-request-research.md, tier 1-2): a class of tokens must come
 * DOWN, and the class is countable by script. Which rewrites replace them
 * is the model's craft; the count moving is the gate.
 */
export type ScrubKind = "filter-words" | "ly-adverbs" | "passive" | "opening-run";

/**
 * A TERM-TARGETED edit — the family where the gate can COUNT the thing the
 * instruction names. Four modes:
 *  - rename:     "rename Mara to Naomi", "replace John with Marcus" — both
 *                sides are name-shaped; handled DETERMINISTICALLY, no model.
 *  - pronounize: "replace John with a pronoun" — later mentions become
 *                pronouns; which ones is the model's judgment (soft bound),
 *                but the COUNT must come down (hard gate).
 *  - substitute: "replace the sword with a dagger" — every mention becomes
 *                the replacement; term count → 0, replacement must appear.
 *  - reduce:     "use 'suddenly' less", "stop repeating just" — count must
 *                strictly decrease.
 */
export interface TargetSpec {
  /** The term as the instruction wrote it; the runner re-cases it against
   *  the actual prose before anything else uses it. */
  term: string;
  mode: "rename" | "pronounize" | "substitute" | "reduce";
  replacement?: string;
}

export interface IntentReading {
  intent: WritingIntent;
  /** Explicit paragraph target when the instruction states one ("into two
   *  paragraphs"); undefined means the intent's default applies. */
  targetParas?: number;
  /** The instruction also asks for shorter output (merge+condense combos
   *  like "merge these and make them shorter" widen the length gate down). */
  wantsShorter?: boolean;
  /** Set only when intent === "target". */
  target?: TargetSpec;
  /** Set only when intent === "scrub". */
  scrub?: { kind: ScrubKind };
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  single: 1, a: 1, an: 1,
};

/** "into one paragraph", "into 3 paragraphs", "in two" after a structural verb. */
function readParaTarget(instruction: string): number | undefined {
  const m = /\b(?:into|in|to|as)\s+(?:just\s+)?(\d+|one|two|three|four|five|six|a|an|single)\s*(?:paragraphs?|parts?|pieces?)?\b/i.exec(instruction);
  if (!m) return undefined;
  const word = m[1].toLowerCase();
  const n = /^\d+$/.test(word) ? parseInt(word, 10) : NUMBER_WORDS[word];
  return Number.isFinite(n) && n >= 1 && n <= 12 ? n : undefined;
}

// ── term-targeted extraction ──────────────────────────────────────────────

const Q = `["'‘’“”]`; // any quote the writer might wrap a term in
const TERM = `([A-Za-z][\\w'’-]*)`;
// Article/qualifier before the term: "the word X", "the name X", or a bare
// article ("replace the sword…"). Ordered longest-first so "the word" never
// leaves "word" as the term.
const LEAD = `(?:every\\s+|all\\s+)?(?:the\\s+(?:word|name)\\s+|the\\s+|a\\s+|an\\s+)?`;
const REPLACE_RE = new RegExp(`\\b(?:replace|swap)\\s+${LEAD}${Q}?${TERM}${Q}?\\s+with\\s+(?:a\\s+|an\\s+|the\\s+)?${Q}?${TERM}${Q}?`, "i");
const CHANGE_RE = new RegExp(`\\b(?:change|turn)\\s+${LEAD}${Q}?${TERM}${Q}?\\s+(?:to|into)\\s+(?:a\\s+|an\\s+|the\\s+)?${Q}?${TERM}${Q}?`, "i");
const RENAME_RE = new RegExp(`\\brename\\s+${Q}?${TERM}${Q}?\\s+(?:to|as)\\s+${Q}?${TERM}${Q}?`, "i");
const INSTEAD_RE = new RegExp(`\\buse\\s+${Q}?${TERM}${Q}?\\s+instead\\s+of\\s+${Q}?${TERM}${Q}?`, "i");
const REDUCE_RE = new RegExp(
  `\\buse\\s+(?:the\\s+word\\s+)?${Q}?${TERM}${Q}?\\s+less\\b` +
  `|\\bstop\\s+(?:using|repeating|saying)\\s+(?:the\\s+word\\s+)?${Q}?${TERM}${Q}?` +
  `|\\b(?:remove|cut|drop)\\s+(?:some\\s+of\\s+)?the\\s+word\\s+${Q}?${TERM}${Q}?` +
  `|\\bfewer\\s+${Q}${TERM}${Q}`, "i");

const PRONOUN_WORDS = new Set(["pronoun", "pronouns", "he", "she", "they", "him", "her", "them", "it"]);
/** Meta words that name an ASPECT of the prose, not a term in it — "change
 *  the tone to formal" is a tone ask, "turn this into two paragraphs" is not
 *  a replacement of the word "this". */
const META_TERMS = new Set([
  "this", "it", "that", "them", "those", "these", "everything",
  "tone", "voice", "tense", "pov", "mood", "style", "pacing", "ending",
  "paragraph", "paragraphs", "sentence", "sentences", "passage", "text",
  "adverbs", "adjectives", "words", "repetition", "dialogue",
]);

/**
 * Continuity patch: "she's holding a knife, not a gun" means the text says
 * gun and should say knife — a substitution with the pair REVERSED. The
 * article is load-bearing: "make it shorter, not longer" has no article and
 * must never read as a substitution.
 */
const CONTINUITY_RE = /\b(?:holding|carrying|wearing|wields?|has|had|is|was|it's|are|were)\s+(?:a|an|the)\s+([A-Za-z][\w'’-]*),\s+not\s+(?:a|an|the)\s+([A-Za-z][\w'’-]*)/i;

function readScrub(s: string): { kind: ScrubKind } | null {
  const wantsLess = /\b(remove|cut|kill|drop|delete|fewer|less|no|without|de-?filter|fix|vary|stop|reduce|purge|clean)\b/i.test(s);
  if (/\bfilter\s*words?\b|\bde-?filter\b/i.test(s)) return { kind: "filter-words" };
  if (wantsLess && /\badverbs?\b|\b-?ly words?\b/i.test(s)) return { kind: "ly-adverbs" };
  if (/\bactive voice\b/i.test(s) || (wantsLess && /\bpassive( voice)?\b/i.test(s))) return { kind: "passive" };
  if (/\b(sentence\s+)?(openings?|starts?|beginnings?)\b/i.test(s) &&
      /\b(vary|different|same|every|all|too many|repetitive)\b/i.test(s)) return { kind: "opening-run" };
  if (/\b(every|too many|all( of the)?)\s+sentences?\s+(start|begin)s?\b/i.test(s)) return { kind: "opening-run" };
  return null;
}

function readTarget(s: string): TargetSpec | null {
  const cont = CONTINUITY_RE.exec(s);
  if (cont && !META_TERMS.has(cont[2].toLowerCase()) && !META_TERMS.has(cont[1].toLowerCase())) {
    return { term: cont[2], mode: "substitute", replacement: cont[1] };
  }
  const reduce = REDUCE_RE.exec(s);
  if (reduce) {
    const term = reduce.slice(1).find(Boolean);
    if (term && !META_TERMS.has(term.toLowerCase())) return { term, mode: "reduce" };
    return null;
  }
  let term: string | undefined, replacement: string | undefined;
  const instead = INSTEAD_RE.exec(s);
  if (instead) { replacement = instead[1]; term = instead[2]; }
  else {
    const m = REPLACE_RE.exec(s) ?? CHANGE_RE.exec(s) ?? RENAME_RE.exec(s);
    if (m) { term = m[1]; replacement = m[2]; }
  }
  if (!term || !replacement || META_TERMS.has(term.toLowerCase()) || META_TERMS.has(replacement.toLowerCase())) return null;
  if (PRONOUN_WORDS.has(replacement.toLowerCase())) return { term, mode: "pronounize", replacement };
  // Both sides name-shaped (capitalized): a rename, deterministic downstream.
  if (/^[A-Z]/.test(term) && /^[A-Z]/.test(replacement)) return { term, mode: "rename", replacement };
  return { term, mode: "substitute", replacement };
}

const SHORTER = /\b(short(er|en)?|tight(er|en)?|condense|trim|compress|concise|cut(\s+(it|this|them|down))?|fewer words|less wordy|half(\s+(the|its))?\s*(length)?)\b/i;
// "longer", never bare "long": "make it half as long" is a CONDENSE ask and
// the bare word made it read as both directions at once (→ unknown).
const LONGER = /\b(longer|expand|extend|lengthen|flesh out|elaborate|deepen|develop|double)\b|\badd (more|some|extra)\b|\bmore (detail|description|depth|texture)\b/i;

/**
 * Classify one custom instruction. Order matters: structural verbs beat
 * length words (a merge that also says "shorter" is still a merge, and the
 * length ask survives as `wantsShorter`), and INSERT is checked before
 * EXPAND because "add a scene" contains "add".
 */
export function classifyInstruction(instruction: string): IntentReading {
  const s = instruction.trim();
  if (!s) return { intent: "unknown" };

  // SCRUB before TARGET: "cut the -ly adverbs" must not read as a term edit
  // (its object is a CLASS of words, not a word). Both before the
  // structural rules — they are the most specific shapes.
  const scrub = readScrub(s);
  if (scrub) return { intent: "scrub", scrub };
  const target = readTarget(s);
  if (target) return { intent: "target", target };

  // MERGE: a joining verb near paragraph-shaped nouns, or "into one".
  if (
    /\b(merge|combine|join|fuse|unify)\b/i.test(s) &&
    (/\b(paragraphs?|parts?|sections?|passages?|these|them|both|the two)\b/i.test(s) || /\binto (one|a single|1)\b/i.test(s))
  ) {
    return { intent: "merge", targetParas: readParaTarget(s) ?? 1, wantsShorter: SHORTER.test(s) || undefined };
  }

  // SPLIT: a dividing verb aimed at this text.
  if (/\b(split|divide|break)\b[^.]*\b(up|apart|into|in two|in half|paragraphs?|parts?|pieces?)\b/i.test(s)) {
    return { intent: "split", targetParas: readParaTarget(s), wantsShorter: SHORTER.test(s) || undefined };
  }

  // INSERT: adding a NEW narrative unit, not more of the same texture.
  // Checked before expand — "add an action scene" must not read as length.
  if (/\b(add|insert|write|include|work in|put in)\b[^.]*\b(a|an|another|new)\s+(\w+\s+){0,3}?(scene|beat|moment|exchange|paragraph|passage|flashback|interlude)\b/i.test(s)) {
    return { intent: "insert" };
  }

  // CONDENSE / EXPAND: length-shaped, no structural verb. Negated clauses
  // are stripped first — "make it shorter, not longer" names BOTH
  // directions and only the unnegated one is the ask.
  const dir = s.replace(/\bnot\s+[\w'’-]+/gi, "");
  if (SHORTER.test(dir) && !LONGER.test(dir)) return { intent: "condense", targetParas: readParaTarget(s) };
  if (LONGER.test(dir) && !SHORTER.test(dir)) return { intent: "expand" };

  // TONE: register/mood/voice words with no structural or length ask.
  if (/\b(tone|voice|mood|funn(y|ier)|playful|witt(y|ier)|tenser?|tension|darker|lighter|warmer|colder|formal|casual|poetic|lyrical|punchy|dramatic|humorous|serious|scar(y|ier)|creep(y|ier)|romantic|melanchol\w+|somber|cheerful)\b/i.test(s)) {
    return { intent: "tone" };
  }

  return { intent: "unknown" };
}

/** Character names the instruction itself mentions — provisioning input:
 *  "add more detail about Mira's action" must send Mira's info even when
 *  the batch paragraph never names her. Word-boundary match, case kept
 *  (names are proper nouns; "rose" the flower must not match "Rose"). */
export function namesInInstruction(instruction: string, names: readonly string[]): string[] {
  return names.filter((name) => {
    if (!name) return false;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}])${esc}([^\\p{L}]|$)`, "u").test(instruction);
  });
}
