/**
 * chip-picker.ts — the timeline chip task: which three beats does a chapter
 * show, and what does each chip say?
 *
 * THIRD consumer of the assistant runtime, after the adjudicator and the entity
 * scan review. Same client, same grammar-constrained JSON, a third unrelated
 * domain question, zero runtime changes — which is the point of the runtime
 * being generic.
 *
 * ★ THE MODEL PICKS AND RELABELS. IT NEVER INVENTS. Its whole input is the
 *   chapter's own rank-ordered candidate events, each with the verbatim clause
 *   it was detected in. It answers with RANKS — never with free-form events —
 *   so an answer can only ever be a subset of what the engine already found.
 *   A label it writes must be grounded in the sentence beside the rank it
 *   picked, and if it is not usable the pick keeps the heuristic label.
 *
 * ★ ABSTENTION IS VALID AND IS NOT DELETION. An empty `picks` is a legitimate
 *   answer (a quiet chapter deserves silence) and is cached like any other, so
 *   the question is not asked again. It does NOT blank the timeline: the
 *   display selector treats an empty pick list as "the heuristic chips stand".
 *   The LM may reorder and rename what the writer sees; it may never empty it.
 *
 * ★ THE CACHE KEY CARRIES THE EVENTS, NOT JUST THE CONTENT HASH.
 *   `contentHash` is a deliberately coarse dedup key (`length|first 60 chars`),
 *   so an engine change that re-ranks or re-sentences the same prose leaves it
 *   untouched — and every stored pick would then point at the wrong event.
 *   `chipKeyFor` folds a fingerprint of the rank-ordered sentences, so engine
 *   drift invalidates exactly the affected chapters.
 */
import { fnv1a } from "./evidence-pack";
import { effectiveRank } from "./narrative-events";
import type { AssistantJSONRunner } from "./assistant-client";
import type { ChapterGraphEntry, MajorEvent, TimelineChipPick } from "../types";

export const CHIP_TASK = "timeline-chips";
/** Bump on ANY change to the prompt text or the schema. Invalidates stored picks. */
export const CHIP_PROMPT_VERSION = 2;

/** How many candidates the model is shown. Above this the ranking is guessing
 *  anyway, and a longer list costs prefill for events that cannot be picked. */
export const CHIP_CANDIDATE_CAP = 8;
/** Matches TIMELINE_CHIP_BUDGET — the model may not propose more chips than a
 *  chapter can show. Enforced in the grammar AND in `normalizeChipPicks`. */
export const CHIP_PICK_CAP = 4;

/**
 * How many chips a chapter with real material should end up showing.
 *
 * ★★ THE JOB IS COVERAGE, NOT FILTERING. v1 told the model "pick at most 3,
 *    and fewer is better than padding", and it obliged — chapters went from
 *    three chips to one. That one was usually the strongest single moment, but
 *    a timeline is read at a GLANCE and one chip cannot remind a writer what a
 *    chapter was. The chips TOGETHER have to say what happens. So the model is
 *    asked to cover the chapter, and `normalizeChipPicks` backfills from the
 *    engine's own ranking when it under-delivers: the count can no longer
 *    collapse, and the engine is the harness that catches the model's misses.
 */
export const CHIP_TARGET_MIN = 3;

/**
 * Hard ceiling for a label, enforced mechanically.
 *
 * ★ POINTED AT THE DISPLAY, NOT AT VALIDATION. TimelineGraphFull truncates a
 *   chip at BOX_LABEL_MAX; this constant and that one are raised together so a
 *   label that validates is a label that FITS. A chip the writer reads with an
 *   ellipsis in the middle has failed at the only thing it does.
 */
export const CHIP_LABEL_MAX = 38;

/**
 * ★ THE GRAMMAR'S CAP IS DELIBERATELY LOOSER THAN THE VALIDATION CAP. A
 *   `maxLength` in a JSON schema is a hard guillotine (see the ★ in
 *   assistant-client.ts): a string that wants to run long is cut mid-word at
 *   exactly the cap. Capping the grammar at 44 would make "every label is ≤44"
 *   true by construction and would ship the mid-word cut as a chip. With
 *   headroom the runaway label arrives whole, fails validation here, and the
 *   pick falls back to the heuristic label — a real measurement instead of a
 *   guaranteed one.
 */
const SCHEMA_LABEL_MAX = 72;

/** 3 picks of ~15 tokens plus JSON scaffolding; ~90 observed, 160 is slack. */
const DEFAULT_MAX_TOKENS = 160;
const DEFAULT_TIMEOUT_MS = 30_000;

export const CHIP_SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      maxItems: CHIP_PICK_CAP,
      items: {
        type: "object",
        properties: {
          rank: { type: "integer" },
          label: { type: "string", maxLength: SCHEMA_LABEL_MAX },
        },
      },
    },
  },
} as const;

/**
 * Frozen v1 system prompt.
 *
 * The register rules are the owner's house voice for chip copy, stated as
 * constraints with one banned example rather than as adjectives — a small model
 * follows "name who does what" far better than "be specific". The trailing
 * `/no_think` is NOT here; the runtime appends it from its own `noThink` flag
 * and a duplicate toggle confuses Qwen3.
 *
 * ★ THE LENGTH RULE IS IN WORDS, AND THAT IS WHY IT WORKS. MEASURED on
 *   Qwen3-1.7B against the two harness chapters. "At most 44 characters" alone
 *   produced 55, 66 and 71-char labels — 3 of 6 over the cap, one long enough
 *   to hit the grammar's own guillotine mid-word. A 1.7B model cannot count
 *   characters it has not written yet. Naming a WORD budget, plus a
 *   short-vs-long example of the SAME label, cut that to 1 of 4. Same lesson as
 *   entity-review's "one clause of at most 15 words": state a limit in a unit
 *   the model can track. The budget is 5 rather than 6 for the reason
 *   LABEL_BUDGET gives in narrative-events.ts — build to the lower bound, so
 *   the measured one-word overshoot still lands inside the cap.
 *
 * ★★ AND THE LAST CHARACTER IS NOT WINNABLE BY WORDING. Seven variants were
 *    measured (chars only; + 6 words; + "a two-word name spends two of them";
 *    + the limit repeated in the closing JSON line; a two-word exemplar name;
 *    a WHO-does-WHAT shape rule; + 5 words). ONE label came back BYTE-IDENTICAL
 *    and one character over in ALL SEVEN, including the two variants that fixed
 *    every other label — a lexical attractor for that sentence, not a wording
 *    problem. Two further findings, so nobody re-runs this sweep:
 *      · the variants that ADDED a clause about names or shape made things
 *        WORSE (3 of 5 over), even while keeping both caps. More rule text is
 *        not more compliance.
 *      · the QUIET chapter is at a decision boundary — its pick count moved
 *        between 1, 2 and 3 across variants while the strong chapter's picks
 *        barely moved. Judge a prompt change on the strong case; the quiet one
 *        is measuring the boundary, not the change.
 *    This is why the harness REPORTS the overrun rate instead of gating it:
 *    `normalizeChipPicks` spends an unusable label and keeps the pick, which is
 *    the half worth keeping.
 */
export const CHIP_SYSTEM = `You write the handful of chips a novel chapter shows on its timeline. A writer
glances at them and should immediately remember what happens in that chapter.
You are given the chapter's candidate moments, numbered, each with the verbatim
sentence it was found in. Those sentences are all the evidence there is.

Your job is COVERAGE: the chips together should tell the chapter's story.

- Choose 3 or 4 moments, spread across the chapter rather than clustered on one
  beat. Choose 4 whenever the chapter supports it. Choose fewer only when the
  candidates genuinely describe fewer distinct happenings.
- Prefer the moments that CHANGE something: a decision, a revelation, a
  confrontation, an arrival or departure that costs someone something. Take
  quieter moments too when they are what the chapter is made of.
- Read the whole list before choosing. If two candidates describe the same
  happening, use one of them and spend the other chip elsewhere.

Each chip COMPRESSES its moment into a headline. You are not quoting the
sentence, you are boiling it down to what happened:

  moment: "Sefa Turow told the assembly that the well had been dry since the
           spring, and that she had known it the whole time."
  chip:   Sefa admits the well is dry

  moment: "The harbour warden set the tally board against the wall and broke
           it across his knee where everyone could see."
  chip:   The warden breaks the tally board

- FIVE WORDS. Not six, not a clause with "and" in it. If you cannot say it in
  five words you are still quoting, so cut until only the action is left.
- Say who does what. Use the shortest name that identifies them. Drop the
  numbers, the reasons, the manner and the second half of the sentence.
- Every name you write must appear in the sentence you anchored to.
- Sentence case. Present tense. No quotation marks. No full stop at the end.
- No melodrama and no selling: not "shocking", "at last", "everything changes",
  "the truth is revealed".

Answer as JSON: {"picks":[{"rank","label"}]}, in the order the moments happen.
rank: the number of a candidate you were given, exactly as written.
label: the compressed headline, five words at most.`;

// ── request assembly ──────────────────────────────────────────────────────

/** One offered event: the rank the model answers with, plus what it is told. */
export interface ChipCandidate {
  rank: number;
  /** The heuristic label — the per-pick fallback, never shown to the model. */
  label: string;
  sentence: string;
}

export interface ChipRequest {
  candidates: ChipCandidate[];
  systemPrompt: string;
  userText: string;
  schema: typeof CHIP_SCHEMA;
  maxTokens: number;
}

export interface BuildChipRequestOptions {
  candidateCap?: number;
  maxTokens?: number;
}

const pct = (position: number) =>
  `${Math.round(Math.max(0, Math.min(1, position)) * 100)}% in`;

/**
 * The exact bytes one chapter sends. Exported for the same reason the other two
 * task modules export theirs: the live harness must drive the real prompt, not
 * a copy of it that drifts the moment this file is edited.
 *
 * ★ ONLY EVENTS THAT CARRY A SENTENCE ARE OFFERED. The label rule is "grounded
 *   in the offered sentence", so an event stored before `sentence` existed has
 *   nothing to ground on and offering it would be an invitation to invent.
 * ★ CANDIDATES ARE NUMBERED BY RANK, NOT BY POSITION IN THIS LIST. The answer
 *   is resolved against the entry's events by the same rank, and a list index
 *   would silently re-point every pick the moment an event without a sentence
 *   sits between two that have one.
 */
export function buildChipRequest(
  entry: ChapterGraphEntry,
  opts: BuildChipRequestOptions = {},
): ChipRequest {
  const cap = opts.candidateCap ?? CHIP_CANDIDATE_CAP;

  const candidates = entry.majorEvents
    .map((event, index) => ({ event, rank: effectiveRank(event, index) }))
    .filter(({ event }) => typeof event.sentence === "string" && event.sentence.trim() !== "")
    .sort((a, b) => a.rank - b.rank)
    .slice(0, cap)
    .map(({ event, rank }) => ({
      rank,
      label: event.label,
      sentence: (event.sentence as string).replace(/\s+/g, " ").trim(),
    }));

  const header = [
    `CHAPTER ${entry.chapterNumber}${entry.chapterTitle ? ` — ${entry.chapterTitle}` : ""}`,
    `tension peak: ${entry.tensionPeak.toFixed(2)}`,
    // Three names is orientation, not a cast list: enough to tell the model who
    // the chapter belongs to, not enough to argue with the sentences.
    `present: ${entry.charactersPresent.slice(0, 3).join(", ") || "unknown"}`,
  ];

  const lines = entry.majorEvents
    .map((event, index) => ({ event, rank: effectiveRank(event, index) }))
    .filter(({ rank }) => candidates.some((c) => c.rank === rank))
    .sort((a, b) => a.rank - b.rank)
    .map(({ event, rank }) => {
      const facets = [
        event.narrativeType ?? event.type,
        event.agent,
        event.channel,
        pct(event.tensionPosition),
      ].filter(Boolean);
      const sentence = candidates.find((c) => c.rank === rank)!.sentence;
      return `[${rank}] ${facets.join(" · ")}\n    ${sentence}`;
    });

  const userText = [
    ...header,
    "",
    "CANDIDATES",
    ...lines,
    "",
    `Pick at most ${CHIP_PICK_CAP} of these ranks and write a label for each.`,
  ].join("\n");

  return {
    candidates,
    systemPrompt: CHIP_SYSTEM,
    userText,
    schema: CHIP_SCHEMA,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

// ── validation ────────────────────────────────────────────────────────────

/**
 * Mechanical checks only — nothing here judges prose.
 *
 * Whole-response failure (not an object, `picks` not an array) returns null and
 * the caller keeps its heuristics. Everything else is repaired per pick:
 *   · a rank that was not offered is dropped (the model cannot add an event)
 *   · a repeated rank is dropped after its first appearance
 *   · a label that is blank, multi-line, or over CHIP_LABEL_MAX falls back to
 *     the candidate's heuristic label — the SELECTION survives even when the
 *     prose does not, which is the half of the answer worth keeping
 *   · the list is capped at CHIP_PICK_CAP
 */
export function normalizeChipPicks(
  raw: unknown,
  candidates: readonly ChipCandidate[],
): TimelineChipPick[] | null {
  if (!raw || typeof raw !== "object") return null;
  const picksRaw = (raw as Record<string, unknown>).picks;
  if (!Array.isArray(picksRaw)) return null;

  const offered = new Map(candidates.map((c) => [c.rank, c]));
  const out: TimelineChipPick[] = [];
  const seen = new Set<number>();

  for (const item of picksRaw) {
    if (out.length >= CHIP_PICK_CAP) break;
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;

    const rankRaw = value.rank;
    if (typeof rankRaw !== "number" || !Number.isInteger(rankRaw)) continue;
    const candidate = offered.get(rankRaw);
    if (!candidate || seen.has(rankRaw)) continue;
    seen.add(rankRaw);

    const labelRaw = typeof value.label === "string" ? value.label.trim() : "";
    const usable =
      labelRaw !== "" && labelRaw.length <= CHIP_LABEL_MAX && !/[\r\n]/.test(labelRaw);
    out.push({ rank: rankRaw, label: usable ? labelRaw : candidate.label });
  }

  // ★★ BACKFILL FROM THE ENGINE. The model decides what the chips SAY; it does
  //    not get to decide that a chapter with five real moments shows one. When
  //    it returns fewer than the target, the engine's own top-ranked unused
  //    candidates fill the rest with their heuristic labels — the harness
  //    catching the model's miss, which is the right way round. An EMPTY answer
  //    is left empty: "nothing here turns" is a judgement worth honouring, and
  //    a chapter the engine found nothing in has nothing to backfill from.
  if (out.length > 0 && out.length < CHIP_TARGET_MIN) {
    for (const candidate of candidates) {
      if (out.length >= CHIP_TARGET_MIN) break;
      if (seen.has(candidate.rank)) continue;
      seen.add(candidate.rank);
      out.push({ rank: candidate.rank, label: candidate.label });
    }
  }

  return out;
}

// ── cache key ─────────────────────────────────────────────────────────────

/**
 * Fingerprint of the events a request would be built from.
 *
 * Covers EVERY stored event, not only the eight that get offered: the answer is
 * resolved back through `rank`, so a change anywhere in the array can re-point
 * a pick even when the offered slice looks identical.
 */
export function eventFingerprint(events: readonly MajorEvent[]): string {
  return fnv1a(
    events
      .map((event, index) => ({ rank: effectiveRank(event, index), sentence: event.sentence ?? "" }))
      .sort((a, b) => a.rank - b.rank)
      .map((x) => `${x.rank}:${x.sentence}`)
      .join("\n"),
  );
}

/** Cache key. `fnv1a` is shared with evidence-pack so the recipe lives once. */
export function chipKeyFor(entry: ChapterGraphEntry, modelId: string): string {
  return fnv1a(
    `${entry.contentHash}|${eventFingerprint(entry.majorEvents)}|${modelId}|v${CHIP_PROMPT_VERSION}`,
  );
}

// ── one chapter ───────────────────────────────────────────────────────────

export interface ChipPickOptions {
  run: AssistantJSONRunner;
  /** From `assistantStatus().model.id`; part of the cache key. */
  modelId: string;
  timeoutMs?: number;
  maxTokens?: number;
  candidateCap?: number;
}

export interface ChipPickOutcome {
  lmChips: TimelineChipPick[];
  lmChipsKey: string;
}

/**
 * Ask for one chapter's chips. Returns null — caller keeps the heuristics —
 * when there is nothing to ask about, when the run fails, or when the answer is
 * not a usable shape. An empty `lmChips` is a SUCCESS, not a failure: it is the
 * model declining to promote anything, and it is stored under the key so the
 * question costs one inference per event-set, not one per render.
 */
export async function runChipPick(
  entry: ChapterGraphEntry,
  opts: ChipPickOptions,
): Promise<ChipPickOutcome | null> {
  const request = buildChipRequest(entry, {
    candidateCap: opts.candidateCap,
    maxTokens: opts.maxTokens,
  });
  if (request.candidates.length === 0) return null;

  const result = await opts.run<unknown>({
    task: CHIP_TASK,
    tag: entry.chapterId,
    systemPrompt: request.systemPrompt,
    userText: request.userText,
    schema: request.schema,
    maxTokens: request.maxTokens,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (!result.ok) return null;

  const lmChips = normalizeChipPicks(result.json, request.candidates);
  if (!lmChips) return null;

  return { lmChips, lmChipsKey: chipKeyFor(entry, opts.modelId) };
}
