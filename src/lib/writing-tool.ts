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
  context: { before: string; revisedTail: string; instruction?: string; characters?: WritingCharacter[] },
): WritingRequest {
  const systemPrompt =
    op === "proofread" ? PROOFREAD_SYSTEM
    : op === "rewrite" ? REWRITE_SYSTEM
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
  lines.push("PASSAGE:", toWire(batch.text));
  return {
    systemPrompt,
    userText: lines.join("\n"),
    // maxLength headroom over the batch so the grammar never guillotines a
    // legitimate revision; the length rule lives in the prompt. A CUSTOM
    // instruction may legitimately EXPAND ("make it longer"), so its ceiling
    // is a multiple the others never need.
    schema: {
      ...WRITING_SCHEMA_BASE,
      properties: {
        text: {
          type: "string",
          maxLength: op === "custom"
            ? Math.ceil(batch.text.length * 3) + 400
            : Math.ceil(batch.text.length * 1.6) + 240,
        },
      },
    },
    // ~chars/3.2 tokens for English prose, slack + scaffold; custom gets
    // expansion headroom for the same reason as the schema ceiling.
    maxTokens: op === "custom"
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
export function revisionAcceptable(original: string, revised: string, op: WritingOp = "rewrite"): boolean {
  const r = revised.trim();
  if (!r) return false;
  const paraCount = (t: string) => t.split(/\n[ \t]*\n/).length;
  // ★ CUSTOM MAY RESHAPE PARAGRAPHS A LITTLE. "Add more detail" legitimately
  //   splits a grown paragraph in two; strict equality was refusing most
  //   creative requests wholesale. Proofread/rewrite keep the strict rule —
  //   they promise structure — while custom allows a drift of two.
  const paraDelta = Math.abs(paraCount(original) - paraCount(r));
  if (op === "custom" ? paraDelta > 2 : paraDelta !== 0) return false;
  // Ratios alone are twitchy on SHORT selections (a sentence doubled is a
  // huge ratio and a modest edit), so custom's ceiling carries absolute
  // slack alongside the multiple.
  const max = op === "custom"
    ? original.length * 3.2 + 240
    : original.length * 1.8;
  const min = original.length * (op === "custom" ? 0.3 : 0.5);
  if (r.length < min || r.length > max) return false;
  return op === "custom"
    ? mechanicalErrorCount(r) <= mechanicalErrorCount(original)
    : hardErrorCount(r) <= hardErrorCount(original);
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
  cancelled: boolean;
}

export function assembleRevision(batches: readonly WritingBatch[], texts: readonly string[]): string {
  return batches.map((b, i) => (texts[i] ?? b.text) + b.sep).join("");
}

/** Pure splice: the revised selection back into the chapter. */
export function applyRevision(fullText: string, selStart: number, selEnd: number, revised: string): string {
  return fullText.slice(0, selStart) + revised + fullText.slice(selEnd);
}

export async function runWritingTool(
  selected: string,
  opts: WritingToolOptions,
): Promise<WritingToolOutcome> {
  // Proofread packs paragraphs per batch (mechanical, structure-safe);
  // rewrite/custom take one paragraph per batch — see planWritingBatches.
  const batches = planWritingBatches(selected, BATCH_MAX_CHARS, opts.op === "proofread");
  const texts: string[] = batches.map((b) => b.text);
  const outcomes: WritingToolOutcome["batchOutcomes"] = [];
  let cancelled = false;

  for (const batch of batches) {
    const beforeThis =
      batch.index === 0
        ? opts.before.slice(-CONTEXT_BEFORE_CHARS)
        : (opts.before + assembleRevision(batches.slice(0, batch.index), texts)).slice(-CONTEXT_BEFORE_CHARS);
    const revisedTail =
      batch.index === 0 ? "" : texts[batch.index - 1].slice(-REVISED_TAIL_CHARS);
    const request = buildWritingRequest(opts.op, batch, {
      before: beforeThis,
      revisedTail,
      instruction: opts.instruction,
      // Only the cast that actually appears in THIS batch — a paragraph
      // without a character does not pay prefill for their bio.
      characters: opts.characters?.filter((c) => batch.text.includes(c.name)),
    });
    const result = await opts.run<{ text?: unknown }>({
      task: WRITING_TASK,
      tag: `batch-${batch.index}`,
      systemPrompt: request.systemPrompt,
      userText: request.userText,
      schema: request.schema,
      maxTokens: request.maxTokens,
      timeoutMs: opts.timeoutMs ?? 60_000,
      jsonStyle: "compact",
    });
    if (!result.ok) {
      outcomes.push("failed");
      if (result.reason === "cancelled") { cancelled = true; break; }
      continue;
    }
    const raw = typeof result.json?.text === "string" ? result.json.text.trim() : "";
    const text = matchQuoteStyle(batch.text, fromWire(raw));
    if (text === batch.text.trim() || text === "") {
      outcomes.push("unchanged");
    } else if (revisionAcceptable(batch.text, text, opts.op)) {
      texts[batch.index] = text;
      outcomes.push("revised");
    } else {
      outcomes.push("kept-original");
    }
    opts.onProgress?.({
      batchIndex: batch.index,
      batchCount: batches.length,
      preview: assembleRevision(batches, texts),
    });
  }
  while (outcomes.length < batches.length) outcomes.push(cancelled ? "failed" : "unchanged");

  return { revised: assembleRevision(batches, texts), batchOutcomes: outcomes, cancelled };
}
