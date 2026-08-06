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
 */
export function planWritingBatches(selected: string, maxChars = BATCH_MAX_CHARS): WritingBatch[] {
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
  revise or repeat them; revise only the PASSAGE.`;

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

export const CUSTOM_SYSTEM = `${SHARED_RULES}

The writer gives one INSTRUCTION for how to revise the passage. Follow it
within the hard rules above; where the instruction conflicts with a hard
rule, the rule wins (you may change wording, never facts, names, POV or
paragraph breaks).

Answer as JSON: {"text": the revised passage}.`;

export const WRITING_SCHEMA_BASE = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
} as const;

export interface WritingRequest {
  systemPrompt: string;
  userText: string;
  schema: object;
  maxTokens: number;
}

export function buildWritingRequest(
  op: WritingOp,
  batch: WritingBatch,
  context: { before: string; revisedTail: string; instruction?: string },
): WritingRequest {
  const systemPrompt =
    op === "proofread" ? PROOFREAD_SYSTEM : op === "rewrite" ? REWRITE_SYSTEM : CUSTOM_SYSTEM;
  const lines: string[] = [];
  if (context.before) {
    lines.push("CONTEXT — the manuscript just before this passage (do not revise):");
    lines.push(context.before, "");
  }
  if (context.revisedTail) {
    lines.push("CONTEXT — your own revision continues from here (do not repeat it):");
    lines.push(context.revisedTail, "");
  }
  if (op === "custom" && context.instruction) {
    lines.push(`INSTRUCTION: ${context.instruction}`, "");
  }
  lines.push("PASSAGE:", batch.text);
  return {
    systemPrompt,
    userText: lines.join("\n"),
    // maxLength headroom over the batch so the grammar never guillotines a
    // legitimate revision; the length rule lives in the prompt.
    schema: {
      ...WRITING_SCHEMA_BASE,
      properties: { text: { type: "string", maxLength: Math.ceil(batch.text.length * 1.6) + 240 } },
    },
    // ~chars/3.2 tokens for English prose, 1.5x slack + scaffold.
    maxTokens: Math.ceil((batch.text.length / 3.2) * 1.5) + 96,
  };
}

// ── the grammar gate ──────────────────────────────────────────────────────

/** Hard errors only — style counts are the writer's business, not the gate's. */
export function hardErrorCount(text: string): number {
  return checkGrammar(text).filter((s) => s.severity === "error").length;
}

/**
 * A revision ships only if it does not LOSE to the deterministic checker:
 * fewer-or-equal hard errors than the original, and non-trivially shaped
 * (non-empty, same paragraph count, not wildly shorter/longer).
 */
export function revisionAcceptable(original: string, revised: string): boolean {
  const r = revised.trim();
  if (!r) return false;
  const paraCount = (t: string) => t.split(/\n[ \t]*\n/).length;
  if (paraCount(original) !== paraCount(r)) return false;
  if (r.length < original.length * 0.5 || r.length > original.length * 1.8) return false;
  return hardErrorCount(r) <= hardErrorCount(original);
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
  const batches = planWritingBatches(selected);
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
    const text = typeof result.json?.text === "string" ? result.json.text.trim() : "";
    if (text === batch.text.trim() || text === "") {
      outcomes.push("unchanged");
    } else if (revisionAcceptable(batch.text, text)) {
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
