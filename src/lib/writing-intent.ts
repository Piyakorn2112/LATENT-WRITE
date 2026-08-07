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
  | "unknown";

export interface IntentReading {
  intent: WritingIntent;
  /** Explicit paragraph target when the instruction states one ("into two
   *  paragraphs"); undefined means the intent's default applies. */
  targetParas?: number;
  /** The instruction also asks for shorter output (merge+condense combos
   *  like "merge these and make them shorter" widen the length gate down). */
  wantsShorter?: boolean;
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

  // CONDENSE / EXPAND: length-shaped, no structural verb.
  if (SHORTER.test(s) && !LONGER.test(s)) return { intent: "condense", targetParas: readParaTarget(s) };
  if (LONGER.test(s) && !SHORTER.test(s)) return { intent: "expand" };

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
