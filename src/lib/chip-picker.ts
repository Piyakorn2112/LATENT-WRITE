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
/** Bump on ANY change to the prompt text or the schema. Invalidates stored picks.
 *  v3: the rich detail rule was rewritten (short phrase, never a sentence copy)
 *  after the 4B copied near-whole sentences into `detail` and blew the token
 *  budget — see RICH_MAX_TOKENS.
 *  v4: the rich answer moved to the TUPLE WIRE (see CHIP_SCHEMA_RICH) — same
 *  content, half the generated tokens. */
export const CHIP_PROMPT_VERSION = 4;

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
export const CHIP_TARGET_MIN = 4;

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

/**
 * ★★ THE RICH ANSWER IS A DIFFERENT SIZE AND 160 WAS A GUILLOTINE. Measured on
 *    the 4B (scripts/probe-chip-max.cjs): with `detail` in the schema the model
 *    hit maxTokens at pick two, the JSON arrived truncated, grammar.parse threw,
 *    and the tick skip-keyed the chapter — max-mode chips silently never
 *    updated. On the tuple wire the full answer measures ~72 tokens
 *    (probe-decode-speed.ts); 224 is 3x slack and costs nothing when the
 *    grammar completes early.
 */
export const RICH_MAX_TOKENS = 224;
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

/** Display cap for a chip's second line; schema allows headroom over it so a
 *  runaway detail arrives whole and is DROPPED in normalize, never silently
 *  clipped by the grammar into something that merely fits. */
export const CHIP_DETAIL_MAX = 72;
const SCHEMA_DETAIL_MAX = 96;

/**
 * The rich variant: same picks, plus an optional grounded second line —
 * carried on the TUPLE WIRE.
 *
 * ★★ THE WIRE IS HALF THE ANSWER'S TOKENS AND THE MODEL DOES NOT CARE.
 *    Measured on the 4B (scripts/probe-decode-speed.ts, temperature 0, same
 *    candidates): keyed objects spent 120 generated tokens, this tuple shape
 *    72 — warm wall 3.6s → 2.2s, content judged equivalent by hand (labels
 *    keep their articles, details stay grounded). Two rejected alternatives,
 *    so nobody re-runs the sweep: 1-char KEYS (r/l/d) saved less and degraded
 *    the register into telegraphese ("Ferren admits count short");
 *    InputLookupTokenPredictor was output-identical but 18% SLOWER (short
 *    compressed spans + scaffold are not in the prompt, so drafts mostly
 *    miss and their validation overhead is pure cost).
 *
 * ★ RENAMED ON THE WIRE ONLY (the [[small-model-harness-lessons]] rule):
 *   `decodeRichChipWire` maps the tuples straight back to {rank,label,detail}
 *   picks, so validation, caching, display and tests never see the wire.
 *   Pairs with jsonStyle:"compact" — the whitespace the pretty grammar
 *   invites can never be content, only cost.
 */
export const CHIP_SCHEMA_RICH = {
  type: "object",
  properties: {
    p: {
      type: "array",
      maxItems: CHIP_PICK_CAP,
      items: {
        type: "array",
        prefixItems: [
          { type: "integer" },
          { type: "string", maxLength: SCHEMA_LABEL_MAX },
          { type: "string", maxLength: SCHEMA_DETAIL_MAX },
        ],
        minItems: 2,
        maxItems: 3,
      },
    },
  },
} as const;

/** The paragraph that teaches the wire. Appended after the rich detail rule so
 *  the content instructions stay byte-identical to what was measured. */
export const CHIP_RICH_WIRE = `\n\nWIRE FORMAT: answer as {"p":[[rank,"label","detail"], ...]} — each pick is\nan array of the rank number, then the label, then the detail (omit the third\nentry instead of an empty detail). Same content as described above, this shape.`;

/**
 * Tuple wire → canonical picks. Anything that is not the wire shape is passed
 * through untouched, so `normalizeChipPicks` stays the single judge of what a
 * usable answer is.
 */
export function decodeRichChipWire(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const p = (raw as Record<string, unknown>).p;
  if (!Array.isArray(p)) return raw;
  return {
    picks: p.map((item) => {
      if (!Array.isArray(item)) return item;
      const [rank, label, detail] = item as [unknown, unknown, unknown];
      return {
        rank,
        label,
        ...(typeof detail === "string" && detail !== "" ? { detail } : {}),
      };
    }),
  };
}

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

Each candidate carries a "draft" — a rough headline an earlier pass already
wrote for it. The draft is usually RIGHT ABOUT WHAT HAPPENED and clumsy about
how it reads. Your job is the wording, not the judgement:

- NEVER WEAKEN THE OUTCOME. If the draft says someone FAILED, REFUSED, was
  TOLD, or ADMITTED something, your chip says the same. "fails to reach" must
  not become "tries to reach"; a refusal must not become an agreement; a thing
  someone did to an object must not become the object acting.
- CHECK THE DRAFT AGAINST THE SENTENCE FIRST. If the draft names an action the
  sentence does not contain — the sentence says she put it in the WATER and the
  draft says she BURNED it — the sentence wins and you rewrite from it.
- Otherwise improve only the WORDING: make it read like a person wrote it, in
  the fewest words that still carry the outcome. If the draft is already the
  clearest way to say it, return it unchanged. That is a good answer.

Each chip COMPRESSES its moment into a headline. You are not quoting the
sentence, you are boiling it down to what happened. Two worked examples —
they are from a DIFFERENT story, so never write these names in your answer:

  moment: "Sefa Turow told the assembly that the well had been dry since the
           spring, and that she had known it the whole time."
  chip:   Sefa admits the well is dry

  moment: "The harbour warden set the tally board against the wall and broke
           it across his knee where everyone could see."
  chip:   The warden breaks the tally board

- FIVE WORDS. Not six, not a clause with "and" in it. If you cannot say it in
  five words you are still quoting, so cut until only the action is left.
- NEVER start a chip with "He", "She", "They" or "It", and never use a pronoun
  where a person is meant. The sentence may say "he" — the "who" line under the
  candidate tells you which person that is, so write that name instead. A chip
  is read on its own, with no sentence beside it to explain a pronoun.
- Say who does what. Use the shortest name that identifies them. Drop the
  numbers, the reasons, the manner and the second half of the sentence.
- EVERY NAME YOU WRITE MUST COME FROM THIS CHAPTER — from the candidate's own
  sentence or its "who" line. Never carry a name in from anywhere else.
- Sentence case. Present tense. No quotation marks. No full stop at the end.
- No melodrama and no selling: not "shocking", "at last", "everything changes",
  "the truth is revealed".

Answer as JSON: {"picks":[{"rank","label"}]}, in the order the moments happen.
rank: the number of a candidate you were given, exactly as written.
label: the compressed headline, five words at most.`;

// ── the repair pass ───────────────────────────────────────────────────────
//
// ★★ A TARGETED SECOND TASK, NOT A SELF-CRITIQUE. Apple's on-device guidance
//    (WWDC25 session 248, "Explore prompt design & safety") answers "the model
//    got it wrong" with DECOMPOSITION — "break down your task prompt into
//    simpler steps" — and teaches nothing about asking a small model to grade
//    its own work. So this pass never says "review your answer". It is a second,
//    much smaller task: here is one sentence, here is who acts in it, write the
//    headline. It runs ONLY for the chips a deterministic check already
//    rejected, so a clean answer costs nothing extra.
//
//    The same session is why the ground truth is handed over rather than
//    recalled: for anything the model cannot be trusted to know, Apple's advice
//    is to inject the verified fact into the prompt. The engine's resolved
//    agent is exactly that — it is what turns "he" into a name.

export const CHIP_REPAIR_SCHEMA = {
  type: "object",
  properties: {
    rewrites: {
      type: "array",
      maxItems: CHIP_PICK_CAP,
      items: {
        type: "object",
        properties: {
          rank: { type: "integer" },
          label: { type: "string", maxLength: SCHEMA_LABEL_MAX },
        },
        required: ["rank", "label"],
      },
    },
  },
  required: ["rewrites"],
} as const;

export const CHIP_REPAIR_SYSTEM = `You write one short headline for each moment you are given. Each moment comes
with the sentence it was found in and the name of the person who acts in it.

- FIVE WORDS. Not six, and no clause with "and" in it.
- Use the name from "who". DO NOT begin with "He", "She", "They" or "It", and
  do not use a pronoun where a person is meant.
- Say who does what. Drop the numbers, the reasons and the second half of the
  sentence.
- Sentence case. Present tense. No quotation marks. No full stop at the end.

Answer as JSON: {"rewrites":[{"rank","label"}]}, one entry per moment given.`;

export interface ChipRepairRequest {
  systemPrompt: string;
  userText: string;
  schema: typeof CHIP_REPAIR_SCHEMA;
  maxTokens: number;
}

export function buildChipRepairRequest(
  needing: readonly ChipCandidate[],
  maxTokens = 120,
): ChipRepairRequest {
  const lines = needing.map(
    (c) => `[${c.rank}]${c.agent ? `\n    who: ${c.agent}` : ""}\n    ${c.sentence}`,
  );
  return {
    systemPrompt: CHIP_REPAIR_SYSTEM,
    // Example in the prompt, not the instructions — same reason as the picker.
    userText: [
      "HOW TO COMPRESS (not from this story; its names must not appear in your answer):",
      '  moment → "Sefa Turow told the assembly that the well had been dry since',
      '            the spring, and that she had known it the whole time."',
      "  who    → Sefa Turow",
      "  chip   → Sefa admits the well is dry",
      "",
      "MOMENTS",
      ...lines,
      "",
      "Write one headline for each, using only names that appear above them.",
    ].join("\n"),
    schema: CHIP_REPAIR_SCHEMA,
    maxTokens,
  };
}

/** Apply repaired labels, keeping every mechanical guard the first pass used. */
export function applyChipRepairs(
  picks: readonly TimelineChipPick[],
  raw: unknown,
  candidates: readonly ChipCandidate[],
  cast: readonly string[] = [],
): TimelineChipPick[] {
  if (!raw || typeof raw !== "object") return [...picks];
  const rewrites = (raw as Record<string, unknown>).rewrites;
  if (!Array.isArray(rewrites)) return [...picks];

  const byRank = new Map<number, string>();
  for (const item of rewrites) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    if (typeof value.rank !== "number" || typeof value.label !== "string") continue;
    const candidate = candidates.find((c) => c.rank === value.rank);
    if (!candidate) continue;
    const repaired = repairLeadingPronoun(value.label, candidate);
    if (!repaired || repaired.length > CHIP_LABEL_MAX) continue;
    if (/[\r\n]/.test(repaired) || startsWithPronoun(repaired)) continue;
    if (!labelIsGrounded(repaired, candidate, cast)) continue;
    byRank.set(value.rank, repaired);
  }
  return picks.map((p) => (byRank.has(p.rank) ? { ...p, label: byRank.get(p.rank)! } : p));
}

// ── request assembly ──────────────────────────────────────────────────────

/** One offered event: the rank the model answers with, plus what it is told. */
export interface ChipCandidate {
  rank: number;
  /** The heuristic label — the per-pick fallback, never shown to the model. */
  label: string;
  sentence: string;
  /** Who the engine resolved as acting here. Shown to the model as "who", and
   *  used to repair a chip that reached for a pronoun anyway. */
  agent?: string;
}

export interface ChipRequest {
  candidates: ChipCandidate[];
  systemPrompt: string;
  userText: string;
  schema: typeof CHIP_SCHEMA | typeof CHIP_SCHEMA_RICH;
  maxTokens: number;
}

export interface BuildChipRequestOptions {
  candidateCap?: number;
  maxTokens?: number;
  /**
   * ★ MAX MODE ONLY: each pick may carry a `detail` — one grounded phrase
   *   under the label, so a chip can be two lines of accurate context instead
   *   of one compressed clause. The small tier never sees this schema; its
   *   prompts stay byte-identical to what was measured.
   */
  rich?: boolean;
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
  // ★ THE DETAIL MUST BE ASKED FOR AS A FRAGMENT, NOT "FROM THE SENTENCE".
  //   Measured (probe-chip-max.cjs): "drawn from the moment's own sentence"
  //   made the 4B COPY the sentence — 90+ characters, cut by the grammar cap,
  //   then dropped by the mid-clause check, so rich mode shipped no details at
  //   all while paying ~25 generated tokens per pick for them. The rule now
  //   names the shape (a fragment of 8 words or fewer, never a copy) and what
  //   it is for (the concrete thing the label had no room for).
  const richLine = opts.rich
    ? `\n\nAlso give each pick a "detail": a second line shown under the chip in small
type. It is a FRAGMENT of 8 words or fewer — the concrete thing from that
moment's sentence the label had no room for: the number, the object, the
condition, the place. Never copy or rephrase the whole sentence, never repeat
the label, no new names, no new facts. If the sentence adds nothing beyond the
label, leave detail empty.`
    : "";

  const candidates = entry.majorEvents
    .map((event, index) => ({ event, rank: effectiveRank(event, index) }))
    .filter(({ event }) => typeof event.sentence === "string" && event.sentence.trim() !== "")
    .sort((a, b) => a.rank - b.rank)
    .slice(0, cap)
    .map(({ event, rank }) => ({
      rank,
      label: event.label,
      sentence: (event.sentence as string).replace(/\s+/g, " ").trim(),
      // The engine already resolved who acts here. Carried on the candidate so
      // the pronoun repair in `normalizeChipPicks` has a name to substitute.
      agent: event.agent,
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
        event.channel,
        pct(event.tensionPosition),
      ].filter(Boolean);
      const sentence = candidates.find((c) => c.rank === rank)!.sentence;
      // ★ WHO ON ITS OWN LINE. The agent used to sit in the facet run, where
      //   the model read past it and copied the sentence's own "he"/"she" into
      //   the chip. A chapter's chips are read out of context, so a pronoun in
      //   one is unreadable. This is the engine acting as the model's harness:
      //   it resolved the reference already, and the prompt says to spend it.
      const who = event.agent ? `\n    who: ${event.agent}` : "";
      // ★★ THE ENGINE'S OWN LABEL IS SHOWN AS A DRAFT. Hiding it made the model
      //    re-derive the verb from raw prose, and it inverted the meaning:
      //    "put the office seal in the fire" came back as "Marda seals the
      //    office" while the engine had already written "Marda burns the seal".
      //    The engine knows the event TYPE, so its verb carries polarity and
      //    outcome ("fails", "refuses", "admits") that a five-word compression
      //    of the sentence drops. The model's job is prose, not re-derivation.
      const draft = event.label && draftIsTrueOfSentence(event.label, sentence)
        ? `\n    draft: ${event.label}`
        : "";
      return `[${rank}] ${facets.join(" · ")}${who}${draft}\n    ${sentence}`;
    });

  const userText = [
    ...header,
    "",
    // ★★ WHERE THE EXAMPLES LIVE IS A MEASURED TRADE, NOT A STYLE CHOICE.
    //    In the SYSTEM prompt they teach compression well (12–40 char labels)
    //    but their own names leak into unrelated chapters. Moved to the USER
    //    turn — Apple's split (WWDC25 248: instructions are rules, examples go
    //    in the prompt) — leakage stopped and COMPRESSION COLLAPSED: the quiet
    //    chapter went straight back to 50–62 char transcriptions. So the
    //    examples stay in the instructions where they work, and leakage is
    //    caught by `labelIsGrounded` instead, which no wording could do.
    "CANDIDATES — the only material for your answer",
    ...lines,
    "",
    `Pick ${CHIP_TARGET_MIN} or ${CHIP_PICK_CAP} of these ranks and write a label for each,`,
    "using only names that appear above.",
  ].join("\n");

  return {
    candidates,
    systemPrompt: CHIP_SYSTEM + richLine + (opts.rich ? CHIP_RICH_WIRE : ""),
    userText,
    schema: opts.rich ? CHIP_SCHEMA_RICH : CHIP_SCHEMA,
    maxTokens: opts.maxTokens ?? (opts.rich ? RICH_MAX_TOKENS : DEFAULT_MAX_TOKENS),
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
/** Subject pronouns that make a chip unreadable on its own. */
const LEADING_PRONOUN = /^(he|she|they|it|his|her|their|its|him|them)\b/i;

export function startsWithPronoun(label: string): boolean {
  return LEADING_PRONOUN.test(label.trim());
}

/**
 * "He admits the count is short" → "Ferren admits the count is short".
 *
 * ★ REPAIR, NOT REJECT, WHEN A NAME IS KNOWN. The model's SELECTION and its
 *   compression are usually right even when it copies the sentence's pronoun,
 *   and the engine already resolved the referent — throwing the whole chip away
 *   over one word would discard the better half of the answer. When no agent
 *   was resolved there is nothing to substitute, so the caller falls back.
 */
export function repairLeadingPronoun(label: string, candidate: ChipCandidate): string {
  const trimmed = label.trim();
  if (!candidate.agent || !startsWithPronoun(trimmed)) return trimmed;
  // The shortest name that still identifies them — chips are tight.
  const name = candidate.agent.split(/\s+/)[0];
  const repaired = trimmed.replace(LEADING_PRONOUN, name);
  // A possessive pronoun becomes a possessive name: "Her ledger" → "Marda's".
  return /^(his|her|their|its)\b/i.test(trimmed)
    ? repaired.replace(new RegExp(`^${name}\\b`), `${name}'s`)
    : repaired;
}

/**
 * Does every proper noun in the label come from THIS chapter?
 *
 * ★★ THE ANTI-LEAK CHECK. Worked examples in a prompt do not stay in the
 *    prompt: chips came back carrying the EXAMPLE'S names ("Sefa", "the
 *    warden") into unrelated chapters. Moving the examples out of the
 *    instructions and into the prompt reduces it, but a small model will still
 *    reach for a name it just read, and no wording makes that impossible. So
 *    the rule is enforced here instead: every capitalised word in a chip must
 *    appear in the moment it anchors to, in that moment's resolved actor, or in
 *    the chapter's cast. Anything else is a name from somewhere else, and the
 *    chip falls back to the engine's own label.
 *
 * Case-insensitive on purpose — a sentence-initial "Kettle" is the sentence's
 * own word, not a foreign name.
 */
export function labelIsGrounded(
  label: string,
  candidate: ChipCandidate,
  cast: readonly string[] = [],
): boolean {
  const haystack = `${candidate.sentence} ${candidate.agent ?? ""} ${cast.join(" ")}`.toLowerCase();
  const proper = label.match(/\b[A-Z][a-z']+/g) ?? [];
  return proper.every((word) => {
    const bare = word.replace(/['’]s?$/, "").toLowerCase();
    // One-letter and very short fragments carry no identity; skip them rather
    // than reject a chip over "A" or "In".
    return bare.length < 3 || haystack.includes(bare);
  });
}

/**
 * Verbs the ENGINE infers from an event's type rather than lifting from the
 * prose. "fails", "refuses", "admits" carry the outcome and are the reason a
 * draft is worth showing at all, so they are exempt from the grounding check
 * below — the sentence says "tried… and did not manage it", never "fails".
 */
const OUTCOME_VERBS =
  /\b(fails?|failed|refus\w+|declin\w+|admits?|admitted|confess\w+|reveals?|revealed|resigns?|resigned|is told|was told|loses?|lost|breaks?|broke|gives? up|surrenders?)\b/i;

/**
 * The subset whose loss INVERTS the moment.
 *
 * ★ NARROWED AFTER IT OVER-FIRED. Guarding every outcome verb rejected honest
 *   rewrites — "admits" → "says", "is told" → "hears" — which are the model
 *   doing its job. Only a NEGATIVE outcome flips the meaning when it is
 *   dropped: a failure becomes an attempt, a refusal becomes agreement. Those
 *   are guarded; positive verbs are left to the prompt.
 */
const NEGATIVE_OUTCOME =
  /\b(fails?|failed|failing|refus\w+|declin\w+|cannot|can't|loses?|lost|gives? up|gave up|surrenders?|never|unable)\b/i;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "with",
  "his", "her", "their", "its", "it", "is", "was", "be", "by", "from", "into",
  "that", "this", "as", "up", "down", "out", "back", "over",
]);

/**
 * ★★ IS THE ENGINE'S OWN DRAFT TRUE OF THE SENTENCE?
 *
 *    The draft is a heuristic label and it is sometimes WRONG: "Teva burns the
 *    ledger" for a sentence in which she carries it to the WATER and lets it
 *    go. Shown such a draft, the model copies it — correctly, by its
 *    instructions — and an engine error becomes a shipped chip. So a draft that
 *    names an action the sentence does not contain is not shown at all, and the
 *    model derives that one from the prose instead.
 *
 *    Outcome verbs are exempt: they are the engine's inference from the event
 *    TYPE, which is exactly the knowledge the model lacks.
 */
export function draftIsTrueOfSentence(draft: string, sentence: string): boolean {
  const src = sentence.toLowerCase();
  const words = (draft.toLowerCase().match(/\b[a-z]+\b/g) ?? [])
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
  return words.every((word) => {
    if (OUTCOME_VERBS.test(word)) return true;
    // Loose stem match: "burns"/"burned"/"burning" all reduce to "burn".
    const stem = word.replace(/(ing|ed|es|s)$/, "");
    return stem.length < 3 || src.includes(stem);
  });
}

/**
 * ★★ A CHIP MAY NOT SOFTEN THE ENGINE'S OUTCOME. Measured: told that "Ivo
 *    fails to reach the pier", the model returned "Ivo tries to reach the
 *    pier" — an attempt instead of a failure — and no wording of the rule
 *    stopped it across two variants. The draft's polarity comes from the event
 *    type and is the one thing it is most reliable about, so when the draft
 *    states an outcome and the rewrite drops it, the rewrite loses.
 */
export function preservesOutcome(label: string, draft: string): boolean {
  if (!NEGATIVE_OUTCOME.test(draft)) return true;
  return NEGATIVE_OUTCOME.test(label) || /\b(not|never|no)\b/i.test(label);
}

const TRAILING_FUNCTION_WORD = /\s+(?:the|a|an|to|of|in|on|at|for|with|and|or|its|his|her|their|down|up|back|over|into)$/i;

/**
 * Cut a too-long label at a word boundary, then shed any function word left
 * dangling at the end ("…down to the" → "…down").
 *
 * ★★ WHY THIS EXISTS: falling back to the engine label is only right when that
 *    label is TRUE. Measured — the model wrote "Teva carries the ledger down to
 *    the water" (41 chars, correct) and the length rule sent it back to the
 *    engine label "Teva burns the ledger", which the sentence contradicts: she
 *    put it in the WATER. A rule about LENGTH had quietly become a rule about
 *    MEANING. A correct-but-long label is now trimmed rather than surrendered
 *    to one already known to be wrong.
 */
const DANGLING_TAIL = /\b(?:was|were|is|are|be|been|being|had|has|have|did|does|do|and|but|that|which|who|when|while|than|as|so|if)$/i;

/**
 * Does a trimmed label end mid-clause? A chip ending on a verb or auxiliary
 * ("…the sluice was", "…the bank and finds") reads worse than a shorter true
 * label, so the caller surrenders to the engine draft instead. Verb-ish
 * endings are approximated by inflection, which is all a chip needs.
 */
export function endsMidClause(label: string): boolean {
  const last = label.trim().split(/\s+/).pop() ?? "";
  return DANGLING_TAIL.test(last) || (last.length > 3 && /(?:s|ed|ing)$/i.test(last));
}

export function trimToLength(label: string, max: number): string {
  if (label.length <= max) return label;
  let cut = label.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(" ");
  cut = lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, max);
  let prev = "";
  while (prev !== cut) { prev = cut; cut = cut.replace(TRAILING_FUNCTION_WORD, ""); }
  return cut.trim();
}

export function normalizeChipPicks(
  raw: unknown,
  candidates: readonly ChipCandidate[],
  cast: readonly string[] = [],
  /** Ranks whose label was REJECTED and fell back to the engine label. Only
   *  these are worth a repair call: a model that returns the draft unchanged
   *  is doing what the prompt asks, and re-asking wastes a whole inference. */
  outFallbacks?: Set<number>,
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
    const repaired = repairLeadingPronoun(labelRaw, candidate);
    // Everything except length. Length is recoverable by trimming; a pronoun,
    // a foreign name or a softened outcome is not.
    const sound =
      repaired !== "" && !/[\r\n]/.test(repaired) && !startsWithPronoun(repaired) &&
      labelIsGrounded(repaired, candidate, cast) &&
      preservesOutcome(repaired, candidate.label);
    // Surrender to the engine label ONLY if that label is true of the sentence.
    const draftUsable = draftIsTrueOfSentence(candidate.label, candidate.sentence);
    // A too-long label survives only if the engine draft is untrue AND the
    // trim still lands on a clean word. Otherwise the draft wins.
    const trimmed = trimToLength(repaired, CHIP_LABEL_MAX);
    const trimUsable = !draftUsable && !endsMidClause(trimmed);
    const usable = sound && (repaired.length <= CHIP_LABEL_MAX || trimUsable);
    if (!usable) outFallbacks?.add(rankRaw);
    // ★ THE DETAIL IS OPTIONAL DECORATION AND FAILS ALONE. A bad second line
    //   never costs the pick: single-line, inside the cap after a clean trim,
    //   grounded in the candidate's own material, different from the label.
    //
    // ★★ FRAGMENT RULES, NOT LABEL RULES. Measured (probe-chip-max.cjs): the
    //    label heuristics silently killed half the good details. `endsMidClause`
    //    reads a plural noun as a dangling verb, so "eleven years" died; exact
    //    word matching reads a tense shift as invention, so "wax runs off iron"
    //    died against a sentence saying "ran". A detail is ASKED FOR as a
    //    noun-ish fragment: only a genuinely dangling auxiliary rejects it,
    //    grounding uses the same loose stem the draft check uses, and one
    //    inflection-shifted word is allowed as long as at least half the
    //    content words are the sentence's own.
    let detail: string | undefined;
    const detailRaw = typeof value.detail === "string" ? value.detail.trim() : "";
    if (detailRaw && !/[\r\n]/.test(detailRaw)) {
      const cut = trimToLength(detailRaw, CHIP_DETAIL_MAX);
      const material = `${candidate.sentence} ${candidate.agent ?? ""}`.toLowerCase();
      const words = cut.toLowerCase().match(/[a-z']{4,}/g) ?? [];
      const grounded = words.filter((w) => {
        const stem = w.replace(/(ing|ed|es|s)$/, "");
        return stem.length >= 3 && material.includes(stem);
      }).length;
      const enough = grounded >= Math.max(1, Math.ceil(words.length / 2));
      const lastWord = cut.split(/\s+/).pop() ?? "";
      if (cut && !DANGLING_TAIL.test(lastWord) && enough &&
          cut.toLowerCase() !== (usable ? trimmed : candidate.label).toLowerCase()) {
        detail = cut;
      }
    }
    out.push({
      rank: rankRaw,
      label: usable ? trimmed : candidate.label,
      ...(detail ? { detail } : {}),
    });
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
  /** Max mode: picks may carry a grounded second line. See BuildChipRequestOptions. */
  rich?: boolean;
  /**
   * ★ Called with the runner's failure reason when the PRIMARY run fails.
   *   The caller needs it to tell a content-shaped failure (parse/schema —
   *   re-asking is pointless) from a transient one (busy/timeout/low-memory —
   *   a permanent skip key on those is how max-mode chips silently died).
   *   Not called for a repair-pass failure, which is tolerated by design.
   */
  onRunFailure?: (reason: string) => void;
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
    rich: opts.rich,
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
    // The measured fast path is tuple wire + compact grammar TOGETHER; see
    // the ★★ on CHIP_SCHEMA_RICH.
    ...(opts.rich ? { jsonStyle: "compact" as const } : {}),
  });
  if (!result.ok) {
    opts.onRunFailure?.(result.reason);
    return null;
  }

  const cast = entry.charactersPresent;
  const fallbacks = new Set<number>();
  const answer = opts.rich ? decodeRichChipWire(result.json) : result.json;
  const lmChips = normalizeChipPicks(answer, request.candidates, cast, fallbacks);
  if (!lmChips) return null;

  // A chip whose label came back as the ENGINE's own is one the first pass
  // failed to write: it ran long, led with a pronoun, or was blank. Those, and
  // only those, get the second, smaller task. A clean answer costs nothing.
  const needing = lmChips
    .map((pick) => request.candidates.find((c) => c.rank === pick.rank))
    .filter((c): c is ChipCandidate => !!c)
    .filter((c) => fallbacks.has(c.rank));

  let finalChips = lmChips;
  if (needing.length > 0) {
    const repair = buildChipRepairRequest(needing);
    const repaired = await opts.run<unknown>({
      task: CHIP_TASK,
      tag: `${entry.chapterId}:repair`,
      systemPrompt: repair.systemPrompt,
      userText: repair.userText,
      schema: repair.schema,
      maxTokens: repair.maxTokens,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    // A failed repair is not a failed chapter: the engine labels already there
    // are a working answer, which is the point of repairing rather than retrying.
    if (repaired.ok) finalChips = applyChipRepairs(lmChips, repaired.json, request.candidates, cast);
  }

  return { lmChips: finalChips, lmChipsKey: chipKeyFor(entry, opts.modelId) };
}
