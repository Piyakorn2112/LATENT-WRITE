/**
 * writing-tool.ts — the local writing helper: proofread / rewrite / custom
 * instruction over any selection, on the max tier.
 *
 * ★ THE MODEL WRITES PROSE; EVERYTHING ELSE IS DETERMINISTIC. Where the new
 *   text goes (the selection offsets), how a long selection is split
 *   (paragraph-boundary batches), what context each batch sees (the tail of
 *   what precedes it + the already-revised tail for continuity), and how the
 *   result is reassembled (the ORIGINAL separators between batches) are all
 *   script arithmetic. The model never chooses a location and never calls a
 *   tool — it returns replacement text for exactly one batch.
 *
 * ★ THE GRAMMAR CHECKER IS THE HARNESS. Every revised batch is gated by
 *   `checkGrammar`: a revision that carries MORE hard errors than the text it
 *   replaces is refused and that batch keeps its original text. The model
 *   must beat the deterministic checker to ship, which is what makes an
 *   unattended replace safe.
 *
 * ★ REPLACEMENT RIDES THE NORMAL EDIT PATH (`onContentChange`), so it lands
 *   in the same history as typing and is reversible like any user edit.
 */
import { checkGrammar } from "./grammar-check";
import { classifyInstruction, namesInInstruction, type IntentReading } from "./writing-intent";
import type { AssistantJSONRunner } from "./assistant-client";

export const WRITING_TASK = "writing-tool";
export const WRITING_PROMPT_VERSION = 1;

export type WritingOp = "proofread" | "rewrite" | "custom";

/** Batch sizing: ~350 tokens of prose per call keeps the 4B fast (~2-4s each)
 *  and leaves the whole context window for instructions + context. */
export const BATCH_MAX_CHARS = 1400;
/** How much preceding ORIGINAL text a batch sees, for tone and referents. */
export const CONTEXT_BEFORE_CHARS = 480;
/** How much of the previous batch's REVISED text a batch sees, so joins read
 *  as one pass (tense/pronoun continuity across the batch seam). */
export const REVISED_TAIL_CHARS = 320;

// ── batching ──────────────────────────────────────────────────────────────

export interface WritingBatch {
  index: number;
  /** The batch's own text (whole paragraphs where possible). */
  text: string;
  /** The verbatim separator FOLLOWING this batch (kept through reassembly). */
  sep: string;
}

/** Split one overlong paragraph on sentence ends, keeping every character. */
function splitLongParagraph(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];
  const parts: string[] = [];
  let rest = paragraph;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const cutAt = Math.max(
      window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "),
      window.lastIndexOf(".” "), window.lastIndexOf("?” "), window.lastIndexOf("!” "),
    );
    const cut = cutAt > maxChars * 0.3 ? cutAt + 2 : maxChars;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Paragraph-boundary batches that reassemble to EXACTLY the input:
 * `batches.map(b => b.text + b.sep).join("") === selected`.
 *
 * ★ `pack` MERGES ADJACENT PARAGRAPHS INTO ONE BATCH — right for proofread
 *   (mechanical, never restructures) and WRONG for rewrite/custom: given two
 *   paragraphs in one prompt the 4B merges or re-splits them, the paragraph
 *   gate refuses, and big selections "mostly break". Unpacked, each batch IS
 *   one paragraph, so structure survives by construction and every paragraph
 *   gets the model's full attention.
 */
export function planWritingBatches(
  selected: string,
  maxChars = BATCH_MAX_CHARS,
  pack = true,
): WritingBatch[] {
  // Tokenise into (paragraph, separator) pairs, separators kept verbatim.
  const pieces: Array<{ text: string; sep: string }> = [];
  const re = /\n[ \t]*\n[\s]*/g;
  let last = 0;
  for (const m of selected.matchAll(re)) {
    const para = selected.slice(last, m.index);
    for (const part of splitLongParagraph(para, maxChars)) pieces.push({ text: part, sep: "" });
    if (pieces.length > 0) pieces[pieces.length - 1].sep = m[0];
    else pieces.push({ text: "", sep: m[0] });
    last = (m.index ?? 0) + m[0].length;
  }
  const tail = selected.slice(last);
  for (const part of splitLongParagraph(tail, maxChars)) pieces.push({ text: part, sep: "" });

  // Greedy packing: adjacent pieces merge while the combined text fits.
  const batches: WritingBatch[] = [];
  for (const piece of pieces) {
    const prev = batches[batches.length - 1];
    if (
      pack &&
      prev &&
      prev.text.length + prev.sep.length + piece.text.length <= maxChars &&
      piece.text !== ""
    ) {
      prev.text = prev.text + prev.sep + piece.text;
      prev.sep = piece.sep;
    } else if (prev && piece.text === "") {
      prev.sep += piece.sep;
    } else {
      batches.push({ index: batches.length, text: piece.text, sep: piece.sep });
    }
  }
  return batches.filter((b) => b.text !== "" || b.sep !== "").map((b, i) => ({ ...b, index: i }));
}

// ── prompts ───────────────────────────────────────────────────────────────

const SHARED_RULES = `You are a writing tool inside a novelist's editor. You are given one passage
from their manuscript and you return the revised passage — nothing else. Hard
rules, all of them:
- Return the WHOLE passage, revised. Never a commentary, list, or summary.
- Keep the paragraph breaks exactly where they are: same number of
  paragraphs, in the same order.
- Preserve the point of view, the tense, every name, and every fact. Nothing
  happens in your version that does not happen in theirs.
- Preserve the writer's register. Dialogue keeps its voice — a character's
  grammar is characterisation, not an error.
- If some CONTEXT lines are shown, they are for continuity only — never
  revise or repeat them; revise only the PASSAGE.
- The \` character is the editor's placeholder for a quotation mark. Keep
  every \` exactly where it stands — never remove one, move one, or turn it
  into any other character.`;

export const PROOFREAD_SYSTEM = `${SHARED_RULES}

Your job here is PROOFREADING ONLY: fix spelling, punctuation, agreement,
doubled words, capitalisation and obvious typos. Do not rephrase, do not
"improve", do not touch a single word choice that is not an outright error.
If the passage has no errors, return it unchanged — that is a good answer.

Answer as JSON: {"text": the corrected passage}.`;

export const REWRITE_SYSTEM = `${SHARED_RULES}

Your job here is a LIGHT REWRITE for clarity and flow: smooth clumsy
phrasing, cut accidental repetition, untangle sentences that trip. Keep the
writer's meaning, structure and length (within about a fifth either way) —
you are polishing their sentences, not writing your own.

Answer as JSON: {"text": the revised passage}.`;

// ★ MEASURED TWICE (probe-writing-tool.cjs). Round 1: "follow it within the
//   hard rules; where it conflicts, the rule wins" made the 4B return the
//   passage UNCHANGED — the caution swallowed the instruction. The explicit
//   split below fixed it ("make it more tense" delivered). Round 2: ADDING a
//   length paragraph + worked example to this prompt regressed BOTH custom
//   cases back to verbatim copies — more rule text is less compliance, the
//   same lesson the chip prompt sweep taught. This prompt is therefore
//   FROZEN at the working wording; the length license rides the USER turn,
//   and only when the instruction is actually about length (see
//   buildWritingRequest).
export const CUSTOM_SYSTEM = `${SHARED_RULES}

The writer gives one INSTRUCTION for how this passage should read. REVISING
IS THE JOB: rework the wording, rhythm, sentence shapes and emphasis as far
as the instruction asks — returning the passage unchanged is a wrong answer
unless it already fully does what the instruction says. Only facts, names,
point of view, tense and the paragraph breaks are off-limits.

Answer as JSON: {"text": the revised passage}.`;

/**
 * ★ LENGTH IS ITS OWN PROMPT, NOT A CLAUSE ON CUSTOM. Measured ladder
 *   (probe-writing-tool.cjs): the shared rule "nothing happens in your
 *   version that does not happen in theirs" reads, to the 4B, as a ban on
 *   adding ANY prose — "make it longer" came back verbatim through three
 *   wordings, and bolting a length paragraph onto CUSTOM_SYSTEM regressed
 *   the non-length cases too. So a length-shaped instruction routes to this
 *   prompt instead, whose hard rules legitimize deepening from the first
 *   line and whose worked example shows the move.
 */
export const LENGTH_SYSTEM = `You are a writing tool inside a novelist's editor. The writer asks you to
change this passage's LENGTH. You return the revised passage — nothing else.
Hard rules, all of them:
- Return the WHOLE passage, revised to the asked length. Returning it
  unchanged is a wrong answer.
- Keep the paragraph breaks: same number of paragraphs, in the same order.
- Keep the point of view, the tense, every name and every event. To make it
  LONGER, deepen what is already there — sensation, image, a beat drawn
  out, a pause inhabited — never a new event, arrival or decision. To make
  it SHORTER, cut words; never summarise an event away.
- Keep the writer's register. Dialogue keeps its voice.
- If some CONTEXT lines are shown, they are for continuity only — never
  revise or repeat them; revise only the PASSAGE.
- The \` character is the editor's placeholder for a quotation mark. Keep
  every \` exactly where it stands.

Worked example for "make it longer" — a different story, never reuse its
words:
  passage: The kettle boiled and she poured the tea.
  revised: The kettle rattled its way to the boil, and she stood over it a
  moment longer than she needed to, letting the steam settle, before she
  poured the tea and watched the leaves turn slowly in the water.

Answer as JSON: {"text": the revised passage}.`;

/**
 * ★ STRUCTURE IS ITS OWN PROMPT. CUSTOM_SYSTEM hard-rules "keep the
 *   paragraph breaks exactly where they are" — which made merge/split/
 *   condense-into-N ops inexpressible: the model obeyed the rule, the gate
 *   enforced it, and the writer's ask was refused twice over. A structural
 *   instruction routes here instead, where reshaping IS the job. Kept lean
 *   on the measured lesson that more rule text is less compliance.
 */
export const STRUCTURE_SYSTEM = `You are a writing tool inside a novelist's editor. The writer gives one
INSTRUCTION about this passage's SHAPE — merging, splitting or condensing
paragraphs. RESHAPING IS THE JOB: change the paragraph breaks and rework the
wording as far as the instruction asks — returning the passage unchanged is
a wrong answer. Hard rules, all of them:
- Return the WHOLE passage, reshaped. Never a commentary, list, or summary.
- A paragraph break is a blank line between parts. To merge, remove the
  blank lines. To split, put a blank line at the most natural turn. To
  condense, cut words and clauses — the result must be clearly shorter.
- Preserve the point of view, the tense, every name, and every event.
  Nothing happens in your version that does not happen in theirs.
- Preserve the writer's register. Dialogue keeps its voice.
- If some CONTEXT lines are shown, they are for continuity only — never
  revise or repeat them; revise only the PASSAGE.
- The \` character is the editor's placeholder for a quotation mark. Keep
  every \` exactly where it stands — never remove one, move one, or turn it
  into any other character.

Worked example for "split this into two paragraphs" — a different story,
never reuse its words:
  passage: The kettle boiled and she poured the tea. The cat watched her
  from the sill and did not move.
  reshaped: The kettle boiled and she poured the tea.

The cat watched her from the sill and did not move.

Answer as JSON: {"text": the reshaped passage}.`;

/**
 * ★ INSERT LICENSES NEW EVENTS. Both CUSTOM_SYSTEM ("nothing happens in
 *   your version that does not happen in theirs") and LENGTH_SYSTEM ("never
 *   a new event") deliberately forbid invention — right for revision, fatal
 *   for "add an action scene". This prompt is the one place new material is
 *   the job, still fenced by continuity.
 */
export const INSERT_SYSTEM = `You are a writing tool inside a novelist's editor. The writer asks you to
ADD something NEW to this passage — a scene, a beat, a moment — described in
their INSTRUCTION. Adding is the job: keep the writer's own sentences doing
what they already do, and write the new material into the place where it
belongs. Hard rules, all of them:
- Return the WHOLE passage — the writer's text with your new material woven
  in. Returning it without new material is a wrong answer.
- The new material must fit what is established: same point of view, same
  tense, characters behaving as the story has them behave. Invent action and
  detail, never a contradiction.
- Keep the writer's paragraphs; put the new material in its own paragraph or
  paragraphs unless the instruction says otherwise.
- Keep the writer's register. Dialogue keeps its voice.
- If some CONTEXT lines are shown, they are for continuity only — never
  revise or repeat them.
- The \` character is the editor's placeholder for a quotation mark. Keep
  every \` exactly where it stands.

Answer as JSON: {"text": the passage with the new material}.`;

/**
 * A length/expansion-shaped instruction gets the LENGTH_SYSTEM routing.
 * "Add more detail about the storm" and "expand this with the sea" are
 * expansion-with-focus — exactly what that prompt's deepening rules do —
 * while "make it more playful" is a STYLE ask and must stay on CUSTOM
 * (the bare word "more" is not enough; the phrases are).
 */
export function isLengthInstruction(instruction: string): boolean {
  return /\b(long(er)?|short(er|en)?|expand|extend|lengthen|trim|cut|condense|double|half|flesh out|elaborate|deepen|develop)\b|\badd (more|some|extra|a )|\bmore (detail|description|depth|texture)/i.test(instruction);
}

export const WRITING_SCHEMA_BASE = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
} as const;

// ── the quote wire ────────────────────────────────────────────────────────
//
// ★★ DIALOGUE QUOTES END THE JSON STRING — AND A QUOTE-SHAPED SENTINEL DIES
//    THE SAME DEATH. Measured twice (probe-writing-tool.cjs): with straight
//    quotes the 4B truncated the passage at the first close-quote; swapped to
//    U+FF02 (a quote-shaped glyph) it STILL dropped the glyph and closed the
//    JSON at the same position, emitting complete well-formed JSON of one
//    fragment — the raw output proved the grammar blocked nothing, the
//    model's own quote-boundary instinct did it. The sentinel must not look
//    like a quote at all: straight double quotes travel as backticks (ASCII,
//    JSON-safe, absent from fiction prose), taught as an editor placeholder
//    in the shared rules, and are restored on the way back. Apostrophes and
//    curly quotes are JSON-safe and travel untouched.

const WIRE_QUOTE = "`";

export function toWire(text: string): string {
  return text.replaceAll('"', WIRE_QUOTE);
}

export function fromWire(text: string): string {
  return text.replaceAll(WIRE_QUOTE, '"');
}

/**
 * ★ MATCH THE WRITER'S QUOTE STYLE. The 4B drifts toward typographic quotes
 *   ("aunt's" came back "aunt’s") — a silent formatting change. If the
 *   original selection uses no curly quotes, the revision's are folded back
 *   to straight; a manuscript already in curly style is left alone.
 */
export function matchQuoteStyle(original: string, revised: string): string {
  let out = revised;
  if (!/[‘’]/.test(original)) out = out.replace(/[‘’]/g, "'");
  if (!/[“”]/.test(original)) out = out.replace(/[“”]/g, '"');
  return out;
}

export interface WritingRequest {
  systemPrompt: string;
  userText: string;
  schema: object;
  maxTokens: number;
}

/** A cast member appearing in the selection, with NON-BLANK info only —
 *  the caller must not send empty roles/descriptions (see App). */
export interface WritingCharacter { name: string; info: string }

export function buildWritingRequest(
  op: WritingOp,
  batch: WritingBatch,
  context: {
    before: string;
    revisedTail: string;
    instruction?: string;
    characters?: WritingCharacter[];
    /** Classified intent; computed here when the caller has none (probes). */
    reading?: IntentReading;
    /** A gate diagnosis from the previous attempt — the ONE line of external
     *  feedback a retry carries (system prompts stay frozen; the user turn
     *  is the measured-safe channel, the LENGTH_SYSTEM lesson). */
    retryNote?: string;
  },
): WritingRequest {
  const reading =
    op === "custom" ? context.reading ?? classifyInstruction(context.instruction ?? "") : undefined;
  const intent = reading?.intent ?? "unknown";
  const systemPrompt =
    op === "proofread" ? PROOFREAD_SYSTEM
    : op === "rewrite" ? REWRITE_SYSTEM
    // ★ ALL condense routes to STRUCTURE, not LENGTH: measured on the 4B
    //   (probe-writing-intents), "make it half as long" through LENGTH came
    //   back verbatim three attempts running — its worked example teaches
    //   only the LONGER direction. The structure prompt names cutting as
    //   the job and the condense gate enforces the window.
    : intent === "merge" || intent === "split" || intent === "condense" ? STRUCTURE_SYSTEM
    : intent === "insert" ? INSERT_SYSTEM
    : intent === "expand" ? LENGTH_SYSTEM
    : context.instruction && isLengthInstruction(context.instruction) ? LENGTH_SYSTEM
    : CUSTOM_SYSTEM;
  const lines: string[] = [];
  if (context.before) {
    lines.push("CONTEXT — the manuscript just before this passage (do not revise):");
    lines.push(toWire(context.before), "");
  }
  if (context.revisedTail) {
    lines.push("CONTEXT — your own revision continues from here (do not repeat it):");
    lines.push(toWire(context.revisedTail), "");
  }
  if (context.characters && context.characters.length > 0) {
    lines.push("CHARACTERS in this passage — reference only, never contradict:");
    for (const c of context.characters) lines.push(`- ${c.name}: ${c.info}`);
    lines.push("");
  }
  if (op === "custom" && context.instruction) {
    lines.push(`INSTRUCTION: ${context.instruction}`, "");
  }
  if (context.retryNote) {
    lines.push(`YOUR PREVIOUS ATTEMPT WAS REJECTED BY THE EDITOR'S CHECK: ${context.retryNote}. Revise again and fix exactly that.`, "");
  }
  lines.push("PASSAGE:", toWire(batch.text));
  return {
    systemPrompt,
    userText: lines.join("\n"),
    // ★★ NO maxLength ON THE REVISION STRING. A schema maxLength compiles to
    //   a bounded GBNF repetition `(char){0,N}`, and llama.cpp's parser
    //   rejects N past a "sane defaults" ceiling that SCALES WITH THE CHAR
    //   RULE'S COMPLEXITY (measured: {0,1999} parses, {0,2000} throws, with a
    //   2-alternative char rule — scripts/probe-grammar-repetition.cjs). The
    //   old batch-scaled bound (3x+400 for custom) crossed it on ordinary
    //   paragraphs, so every host-path batch died at grammar parse before the
    //   model ran. Length is already enforced where it belongs: maxTokens caps
    //   generation, and revisionAcceptable's per-op window refuses overruns.
    //   Bonus: one shared schema means one cached grammar for every batch —
    //   the per-batch maxLength made each request a grammar-cache miss.
    schema: WRITING_SCHEMA_BASE,
    // ~chars/3.2 tokens for English prose, slack + scaffold; custom gets
    // expansion headroom because the instruction may legitimately EXPAND
    // ("make it longer"). Structural ops cap near their gate ceiling (a
    // merge output is ≤1.15x source — the 2.8x custom budget would let a
    // 2.8k-char selection run to 2.5k tokens for nothing), and insert gets
    // an absolute allowance for the NEW material instead of a multiple.
    maxTokens:
      intent === "merge" || intent === "split" || intent === "condense"
        ? Math.ceil((batch.text.length / 3.2) * 1.6) + 200
      : intent === "insert"
        ? Math.ceil((batch.text.length / 3.2) * 1.5) + 900
      : op === "custom"
        ? Math.ceil((batch.text.length / 3.2) * 2.8) + 128
        : Math.ceil((batch.text.length / 3.2) * 1.5) + 96,
  };
}

// ── the grammar gate ──────────────────────────────────────────────────────

/** Hard errors only — style counts are the writer's business, not the gate's. */
export function hardErrorCount(text: string): number {
  return checkGrammar(text).filter((s) => s.severity === "error").length;
}

/**
 * ★ THE CUSTOM GATE COUNTS ONLY MECHANICAL ERRORS. "Make it funny" writes
 *   informal grammar ON PURPOSE — "ain't", comma splices, agreement bends
 *   are the voice the instruction asked for, and the full error count was
 *   refusing them wholesale. Typos are never the voice: spelling, doubled
 *   words and spacing still gate.
 */
const MECHANICAL_KINDS = new Set(["spelling", "double", "spacing"]);
export function mechanicalErrorCount(text: string): number {
  return checkGrammar(text).filter((s) => s.severity === "error" && MECHANICAL_KINDS.has(s.kind)).length;
}

/**
 * A revision ships only if it does not LOSE to the deterministic checker:
 * fewer-or-equal hard errors than the original, and non-trivially shaped
 * (non-empty, same paragraph count, length within the op's honest range).
 *
 * ★ THE LENGTH WINDOW IS PER OP. Proofread/rewrite promise roughly-the-same
 *   text, so a wild length change means the model wandered. A CUSTOM
 *   instruction is often ABOUT length ("make it longer", "cut this down") —
 *   the tight window silently vetoed exactly what the writer asked for, and
 *   the popover then reported "nothing needed changing". Custom keeps only
 *   the never-sane bounds.
 */
export type ParaRule =
  | { kind: "exact"; count: number }   // merge into 1, split into 3
  | { kind: "drift"; max: number }     // stay within ±max of the source
  | { kind: "atMost" }                 // condensing must not add paragraphs
  | { kind: "moreThan" };              // split/insert must end with more

export interface GateProfile {
  paras: ParaRule;
  /** Length window as ratios of the source, with absolute slack on the max
   *  (ratios alone are twitchy on short selections). */
  lenMin: number;
  lenMax: number;
  lenSlack: number;
  grammar: "hard" | "mechanical";
}

export interface RevisionFailure {
  code: "empty" | "para-count" | "len-low" | "len-high" | "grammar" | "unchanged";
  /** Plain-numbers sentence, written for BOTH consumers: the retry prompt
   *  quotes it to the model, the popover quotes it to the writer. */
  detail: string;
}

export type RevisionVerdict = { ok: true } | { ok: false; failure: RevisionFailure };

// The two legacy profiles are today's gate expressed as data — byte-for-byte
// the same decisions, which keeps every measured baseline intact.
const LEGACY_STRICT: GateProfile = { paras: { kind: "drift", max: 0 }, lenMin: 0.5, lenMax: 1.8, lenSlack: 0, grammar: "hard" };
const LEGACY_CUSTOM: GateProfile = { paras: { kind: "drift", max: 2 }, lenMin: 0.3, lenMax: 3.2, lenSlack: 240, grammar: "mechanical" };

/**
 * ★ THE GATE PROFILE IS CHOSEN FOR THE DECLARED INTENT (the report's
 *   guards-provision-not-block lesson): a merge is no longer a paragraph-
 *   count violation, it is a paragraph-count SPECIFICATION. Unknown intent
 *   gets today's custom gates unchanged.
 */
export function gateProfileFor(op: WritingOp, reading?: IntentReading): GateProfile {
  if (op !== "custom") return LEGACY_STRICT;
  switch (reading?.intent) {
    case "merge":
      return {
        paras: { kind: "exact", count: reading.targetParas ?? 1 },
        // ★ wantsShorter is a SPECIFICATION, not a footnote: with the 1.15x
        //   ceiling, "merge and make them shorter" shipped a pure
        //   concatenation (measured, probe-writing-intents). 0.95x sits just
        //   under a concat, so the gate demands actual cutting and its
        //   diagnosis tells the model by how much.
        lenMin: reading.wantsShorter ? 0.3 : 0.35,
        lenMax: reading.wantsShorter ? 0.95 : 1.15,
        lenSlack: reading.wantsShorter ? 0 : 60, grammar: "mechanical",
      };
    case "split":
      return {
        paras: reading.targetParas ? { kind: "exact", count: reading.targetParas } : { kind: "moreThan" },
        lenMin: 0.8, lenMax: 1.4, lenSlack: 60, grammar: "mechanical",
      };
    case "condense":
      return {
        paras: reading.targetParas ? { kind: "exact", count: reading.targetParas } : { kind: "atMost" },
        lenMin: 0.3, lenMax: 0.85, lenSlack: 0, grammar: "mechanical",
      };
    // lenMin 1.0, not higher: the old gate shipped even a SHORTENED text on
    // "make it longer" (0.3x floor); refusing only actual shrinkage is
    // strictly more aligned while never stricter than an honest expansion.
    case "expand":
      return { paras: { kind: "drift", max: 2 }, lenMin: 1.0, lenMax: 4.0, lenSlack: 240, grammar: "mechanical" };
    case "insert":
      return { paras: { kind: "moreThan" }, lenMin: 1.15, lenMax: 8, lenSlack: 600, grammar: "mechanical" };
    case "tone":
      return { paras: { kind: "drift", max: 2 }, lenMin: 0.6, lenMax: 1.6, lenSlack: 120, grammar: "mechanical" };
    default:
      return LEGACY_CUSTOM;
  }
}

const paraCount = (t: string) => t.split(/\n[ \t]*\n/).length;
const plural = (n: number) => (n === 1 ? "" : "s");

/**
 * The gate, with a DIAGNOSIS instead of a bare bit. Check order matches the
 * old boolean gate exactly (empty, paragraphs, length, grammar) so the legacy
 * profiles reproduce its decisions.
 *
 * ★ RETRIES ARE JUSTIFIED ONLY BECAUSE THIS FEEDBACK IS EXTERNAL AND
 *   RELIABLE (Kamoi TACL 2024; RefineBench 2025: self-critique degrades
 *   small models, verifier feedback helps). The failure detail is the entire
 *   retry prompt's new information — never a "try harder".
 */
export function judgeRevision(original: string, revised: string, profile: GateProfile): RevisionVerdict {
  const r = revised.trim();
  if (!r) return { ok: false, failure: { code: "empty", detail: "the revision came back empty" } };

  const src = paraCount(original);
  const got = paraCount(r);
  const p = profile.paras;
  let paraDetail: string | null = null;
  if (p.kind === "exact" && got !== p.count) {
    paraDetail = `it came back as ${got} paragraph${plural(got)} but must be exactly ${p.count} paragraph${plural(p.count)}`;
  } else if (p.kind === "drift" && Math.abs(src - got) > p.max) {
    paraDetail = p.max === 0
      ? `it came back as ${got} paragraph${plural(got)} but must keep the original ${src}`
      : `it moved from ${src} to ${got} paragraphs; at most ${p.max} apart is allowed`;
  } else if (p.kind === "atMost" && got > src) {
    paraDetail = `it grew from ${src} to ${got} paragraphs; condensing must not add paragraphs`;
  } else if (p.kind === "moreThan" && got <= src) {
    paraDetail = `it came back as ${got} paragraph${plural(got)}; it must end with more paragraphs than the original ${src}`;
  }
  if (paraDetail) return { ok: false, failure: { code: "para-count", detail: paraDetail } };

  const min = original.length * profile.lenMin;
  const max = original.length * profile.lenMax + profile.lenSlack;
  const ratio = (r.length / Math.max(1, original.length)).toFixed(2);
  if (r.length < min) {
    return { ok: false, failure: { code: "len-low", detail: `it came back at ${ratio}x the original length; it must be at least ${profile.lenMin}x` } };
  }
  if (r.length > max) {
    return { ok: false, failure: { code: "len-high", detail: `it came back at ${ratio}x the original length; it must stay under ${profile.lenMax}x` } };
  }

  const count = profile.grammar === "mechanical" ? mechanicalErrorCount : hardErrorCount;
  if (count(r) > count(original)) {
    return { ok: false, failure: { code: "grammar", detail: "it introduced writing errors the original does not have" } };
  }
  return { ok: true };
}

export function revisionAcceptable(original: string, revised: string, op: WritingOp = "rewrite"): boolean {
  return judgeRevision(original, revised, op === "custom" ? LEGACY_CUSTOM : LEGACY_STRICT).ok;
}

// ── the run ───────────────────────────────────────────────────────────────

export interface WritingProgress {
  batchIndex: number;
  batchCount: number;
  /** The full revision so far (accepted batches + originals for the rest). */
  preview: string;
}

export interface WritingToolOptions {
  run: AssistantJSONRunner;
  op: WritingOp;
  instruction?: string;
  /** Manuscript text BEFORE the selection (context source). */
  before: string;
  /** Cast present in the selection, non-blank info only. */
  characters?: WritingCharacter[];
  onProgress?: (p: WritingProgress) => void;
  timeoutMs?: number;
}

export interface WritingToolOutcome {
  revised: string;
  /** Per batch: "revised", "unchanged" (model returned the same text or
   *  proofread found nothing), "kept-original" (gate refused the revision),
   *  or "failed" (run failed; original kept). */
  batchOutcomes: Array<"revised" | "unchanged" | "kept-original" | "failed">;
  /** Runner reasons for every "failed" batch, in order — so the popover can
   *  say "not enough memory" instead of pretending nothing needed changing. */
  failReasons: string[];
  /** The first gate diagnosis that survived every retry — shown to the
   *  writer verbatim, so a refusal names its reason instead of shrugging. */
  diagnosis?: string;
  cancelled: boolean;
}

export function assembleRevision(batches: readonly WritingBatch[], texts: readonly string[]): string {
  return batches.map((b, i) => (texts[i] ?? b.text) + b.sep).join("");
}

/** Pure splice: the revised selection back into the chapter. */
export function applyRevision(fullText: string, selStart: number, selEnd: number, revised: string): string {
  return fullText.slice(0, selStart) + revised + fullText.slice(selEnd);
}

/** Structural ops (merge/split/insert/condense-into-N) run the WHOLE
 *  selection as one batch — a merge across two batches is inexpressible.
 *  Above this, the tool fails honestly instead of mis-batching. */
export const STRUCTURAL_MAX_CHARS = 2800;
/** Attempt cap per batch: attempt 0, one diagnosed retry, and (custom only)
 *  one sampled retry. Self-Refine's own curves put most of the gain in the
 *  first feedback round; past that, escalate or stop. */
const MAX_ATTEMPTS_CUSTOM = 3;
const MAX_ATTEMPTS_DEFAULT = 2;

/** One batch holding the whole selection, whitespace fringes preserved so
 *  `assembleRevision` still reproduces the selection byte-for-byte. */
function structuralBatches(selected: string): WritingBatch[] {
  const lead = /^\s*/.exec(selected)![0];
  const rest = selected.slice(lead.length);
  const trailAt = /\s*$/.exec(rest)!.index;
  const batches: WritingBatch[] = [];
  if (lead) batches.push({ index: 0, text: "", sep: lead });
  batches.push({ index: batches.length, text: rest.slice(0, trailAt), sep: rest.slice(trailAt) });
  return batches;
}

/** Long structural batches legitimately decode past the 60s patience —
 *  scale the cap with the token budget instead of failing the honest path. */
function timeoutFor(maxTokens: number): number {
  return Math.max(60_000, Math.min(150_000, 20_000 + maxTokens * 55));
}

/**
 * The retry line for a verbatim answer. Tone gets a LICENSE, not just a
 * verdict — measured (probe-writing-intents): "make it funny" came back as a
 * copy three attempts running under the bare note; the model needs to hear
 * that reworking wording is allowed before it will touch a dry paragraph.
 */
export function unchangedRetryNote(reading?: IntentReading): string {
  const base = "the passage came back unchanged; the instruction requires an actual revision";
  return reading?.intent === "tone"
    ? `${base}. Rework the wording and rhythm freely toward the asked tone; keep the events, names and facts`
    : base;
}

export async function runWritingTool(
  selected: string,
  opts: WritingToolOptions,
): Promise<WritingToolOutcome> {
  const reading: IntentReading =
    opts.op === "custom" ? classifyInstruction(opts.instruction ?? "") : { intent: "unknown" };
  const structural =
    opts.op === "custom" &&
    (reading.intent === "merge" || reading.intent === "split" || reading.intent === "insert" ||
      (reading.intent === "condense" && reading.targetParas !== undefined));

  if (structural && selected.length > STRUCTURAL_MAX_CHARS) {
    return {
      revised: selected,
      batchOutcomes: ["failed"],
      failReasons: ["selection-too-long"],
      diagnosis: `reshaping works on selections up to ${STRUCTURAL_MAX_CHARS.toLocaleString()} characters and this one is ${selected.length.toLocaleString()}`,
      cancelled: false,
    };
  }

  // Proofread packs paragraphs per batch (mechanical, structure-safe);
  // rewrite/custom take one paragraph per batch; structural intents take the
  // selection whole — see planWritingBatches / structuralBatches.
  const batches = structural
    ? structuralBatches(selected)
    : planWritingBatches(selected, BATCH_MAX_CHARS, opts.op === "proofread");
  const texts: string[] = batches.map((b) => b.text);
  const outcomes: WritingToolOutcome["batchOutcomes"] = [];
  const failReasons: string[] = [];
  let diagnosis: string | undefined;
  let cancelled = false;

  // ★ PROVISION BEFORE GENERATING: a character the INSTRUCTION names gets
  //   their info even when the batch paragraph never mentions them — "add
  //   more detail about Mira's action" needs Mira's sheet exactly when she
  //   is absent from the text.
  const instructionNames = new Set(
    opts.op === "custom" && opts.instruction
      ? namesInInstruction(opts.instruction, (opts.characters ?? []).map((c) => c.name))
      : [],
  );
  const profile = gateProfileFor(opts.op, reading);
  const maxAttempts = opts.op === "custom" ? MAX_ATTEMPTS_CUSTOM : MAX_ATTEMPTS_DEFAULT;

  for (const batch of batches) {
    // Separator-only batches (a leading blank line in the selection) carry
    // no prose; sending an empty PASSAGE to the model helps no one.
    if (batch.text === "") { outcomes.push("unchanged"); continue; }
    const beforeThis =
      batch.index === 0
        ? opts.before.slice(-CONTEXT_BEFORE_CHARS)
        : (opts.before + assembleRevision(batches.slice(0, batch.index), texts)).slice(-CONTEXT_BEFORE_CHARS);
    const revisedTail =
      batch.index === 0 ? "" : texts[batch.index - 1].slice(-REVISED_TAIL_CHARS);
    const characters = opts.characters?.filter(
      (c) => batch.text.includes(c.name) || instructionNames.has(c.name),
    );

    // ── the bounded diagnose-adjust-retry loop ──
    // Attempt 0 is today's behavior exactly. A gate failure retries with the
    // diagnosis as one plain line of external feedback; the LAST custom
    // retry resamples at temperature (a different candidate, not a plea).
    // Runner failures (low-memory, timeout, busy) never retry — they have
    // honest labels and a retry would fight the memory guard.
    let attempt = 0;
    let retryNote: string | undefined;
    for (;;) {
      const request = buildWritingRequest(opts.op, batch, {
        before: beforeThis, revisedTail, instruction: opts.instruction,
        characters, reading, retryNote,
      });
      const sampled = opts.op === "custom" && attempt === MAX_ATTEMPTS_CUSTOM - 1;
      const result = await opts.run<{ text?: unknown }>({
        task: WRITING_TASK,
        tag: `batch-${batch.index}-a${attempt}`,
        systemPrompt: request.systemPrompt,
        userText: request.userText,
        schema: request.schema,
        maxTokens: request.maxTokens,
        timeoutMs: opts.timeoutMs ?? timeoutFor(request.maxTokens),
        jsonStyle: "compact",
        ...(sampled ? { temperature: 0.7, minP: 0.05 } : {}),
      });
      if (!result.ok) {
        outcomes.push("failed");
        failReasons.push(result.reason);
        if (result.reason === "cancelled") cancelled = true;
        break;
      }
      const raw = typeof result.json?.text === "string" ? result.json.text.trim() : "";
      const text = matchQuoteStyle(batch.text, fromWire(raw));
      if (text === batch.text.trim() || text === "") {
        // Unchanged is a GOOD proofread/rewrite answer and a REFUSAL on
        // custom ("returning it unchanged is a wrong answer" is in every
        // custom-family prompt) — so custom retries it, others accept it.
        if (opts.op !== "custom") { outcomes.push("unchanged"); break; }
        if (++attempt >= maxAttempts) {
          outcomes.push("kept-original");
          diagnosis ??= "every attempt came back unchanged";
          break;
        }
        retryNote = unchangedRetryNote(reading);
        continue;
      }
      const verdict = judgeRevision(batch.text, text, profile);
      if (verdict.ok) {
        texts[batch.index] = text;
        outcomes.push("revised");
        break;
      }
      if (++attempt >= maxAttempts) {
        outcomes.push("kept-original");
        diagnosis ??= verdict.failure.detail;
        break;
      }
      retryNote = verdict.failure.detail;
    }
    opts.onProgress?.({
      batchIndex: batch.index,
      batchCount: batches.length,
      preview: assembleRevision(batches, texts),
    });
    if (cancelled) break;
  }
  while (outcomes.length < batches.length) outcomes.push(cancelled ? "failed" : "unchanged");

  return { revised: assembleRevision(batches, texts), batchOutcomes: outcomes, failReasons, diagnosis, cancelled };
}
