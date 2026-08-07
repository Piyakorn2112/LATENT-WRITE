/**
 * max-ask.ts — "what about this paragraph?", answered from assembled context.
 *
 * The deterministic engines in this app can tell you WHERE things are: who is
 * present, who speaks, which names recur, which sentence opens a thread. What
 * they cannot do is say what a passage MEANS in the story around it. That gap
 * is what max mode exists to fill, and it is the only thing this module is for.
 *
 * ── THE HARNESS CARRIES THE INTELLIGENCE, NOT THE MODEL ────────────────────
 *
 * Same thesis as evidence-pack.ts, and this is deliberately its sibling: a
 * PURE function from already-derived story data to the exact text the model is
 * allowed to see. The model never searches, never reads the manuscript, and
 * never chooses what to look at. Everything measured in this repo says a 4B
 * reasons well over evidence in front of it and fails the moment it has to go
 * and FIND the evidence — so finding is the harness's job and reasoning is the
 * model's, and the split is not negotiable.
 *
 * ── WHY A LADDER AND NOT A TEMPLATE ────────────────────────────────────────
 *
 * On 8 GB the context window is 4096 tokens, of which a thinking model needs a
 * large slice for its own reasoning. So the budget for evidence is small and
 * hard, and the only question that matters is WHAT GETS IN. Rungs fill
 * top-down and whatever does not fit is dropped from the bottom, WHOLE — a
 * half-included dossier is worse than an absent one, because the model cannot
 * tell a truncated fact from a complete one.
 *
 *   1. the paragraph itself                          — always
 *   2. the writer's question, if they asked one      — always
 *   3. who is in this scene, and what they are       — always
 *   4. the paragraphs either side                    — budget
 *   5. what this chapter has established so far      — budget
 *   6. open threads this passage could be touching   — budget
 *   7. earlier passages about the same people        — budget
 *
 * ── THE LOOP, AND WHY IT CANNOT SPIN ───────────────────────────────────────
 *
 * ★★ THE LOOP ADVANCES ON ONE SIGNAL AND ONE ONLY: the model reporting that
 *    what it was given does not contain the answer, while the ladder still has
 *    an unspent rung. Not "am I confident enough", not "should I think more" —
 *    those are judgements a small model makes badly and they are how an agent
 *    gets stuck. Insufficiency is a fact about the PACK, which the harness can
 *    check and act on.
 *
 * ★ FOUR INDEPENDENT BREAKS, so no single failure can hang it:
 *      · MAX_STEPS               — a hard count, never conditional
 *      · rungs exhausted         — nothing left to add, so retrying is a repeat
 *      · a repeated answer       — same text twice means adding context changed
 *                                  nothing, so more will not either
 *      · a wall-clock deadline   — covers a model that is slow rather than stuck
 *
 *   Every break returns the best answer so far. There is no path that returns
 *   nothing because the loop ran out — a stuck harness must degrade to its last
 *   good result, not to silence.
 */
/**
 * ── MEASURED · scripts/probe-max-ask.cjs · qwen3-4b-thinking-2507 · 5 packs ──
 *
 * contextSize 4096, noThink:false, grammar-constrained. First call 6.7s warm
 * (~15s with a cold model load), then ~2.4s per answer — right-click viable.
 *
 *   explain   grounded, specific, basis=passage            REACHES THE WRITER
 *   flag      "taking the short way conflicts with her     REACHES THE WRITER
 *              refusal in chapter 8" — the planted
 *              contradiction, found and named
 *   control   no invented problem (a bland restatement,    ships, harmless
 *              not a false positive)
 *   widen-2   "forty marks … the name Elena Vasquez",      REACHES THE WRITER
 *              basis=open-threads — correct rung cited
 *
 * ★★ ROUND 1 FAILED ON AN INSTRUMENT BUG, NOT THE MODEL: the pack's headings
 *    said "THE STORY BEFORE THIS" while the enum said "story-so-far". Answers
 *    drawn from the passage cited `passage` correctly; answers drawn from ANY
 *    other rung fell back to the abstention, because the heading the model was
 *    reading did not exist in the list it was allowed to answer with. Correct,
 *    grounded answers shipped as "not in what I was given" — including the
 *    flag case, whose text explicitly cited chapter 8 while its label said the
 *    pack contained nothing. THE ENUM AND THE PAGE MUST BE THE SAME
 *    VOCABULARY; every heading now begins with its rung token verbatim.
 *    Also fixed on the same round: `check` on clean prose reported "the tin is
 *    not mentioned before this" — novelty read as anomaly — so the ask now
 *    states that absence is not a conflict. One re-run taken; the numbers
 *    above are that run.
 *
 * ★ RESIDUAL, RECORDED NOT PATCHED: on a deliberately starved pack the model
 *   phrases absence as an answer ("the notice does not specify the amount",
 *   basis=passage) instead of abstaining — so the loop's widen signal
 *   UNDER-fires and a step-1 answer that sounds like a claim about the story
 *   can ship. In practice the default 1600-token budget holds every rung of a
 *   realistic input (full packs measure ~320 tokens), so a dropped rung —
 *   the only state where this matters — is close to unreachable outside a
 *   harness. Do not fix this by iterating the prompt against the probe cases;
 *   they are the measurement.
 */
import { fnv1a } from "./evidence-pack";
import { tidyTruncatedText } from "./assistant-client";
import { decideAskThinking, runThinkPass, notesBlock } from "./think";
import type { AssistantJSONRunner } from "./assistant-client";
import type { WorldData } from "../types";

export const MAX_ASK_TASK = "max-ask";
export const MAX_ASK_PROMPT_VERSION = 3;

const CHARS_PER_TOKEN = 4;
/** Evidence budget. Q8_0 KV halved the cache, so the ask surface now runs an
 *  8k window at the memory the old 4k f16 window cost — and the budget grows
 *  with it. The rest of the window belongs to the model's thinking. */
export const DEFAULT_BUDGET_TOKENS = 2400;
const PARAGRAPH_CAP = 900;
const NEIGHBOUR_CAP = 420;
const ANSWER_MAX = 700;
const DEFAULT_MAX_TOKENS = 640;
const DEFAULT_TIMEOUT_MS = 90_000;

/** ★ TWO. One ask, one retry with more context. A third step has never had new
 *  evidence to justify it, because the ladder is spent by then. */
export const MAX_STEPS = 2;
/**
 * The widened budget can never exceed this.
 *
 * ★ 5600 leaves ~2k of the 8k window for the model's own thinking and its
 *   answer, which a THINKING model needs more of than an instruct one. Widening
 *   to "whatever it takes" would let a long chapter's rungs push the prompt past
 *   the window and get silently truncated at the far end — where the retrieved
 *   passages are, which is the rung the retry was for.
 */
export const WIDEN_CEILING_TOKENS = 5600;
/** Covers a model that is slow rather than stuck; the step count covers stuck. */
export const DEFAULT_DEADLINE_MS = 150_000;

/** The abstention, and the ONLY thing that makes the loop take another step. */
export const NOT_IN_CONTEXT = "not-in-what-i-was-given";
/**
 * ★ THE CLEAN-BILL OUTLET FOR A CHECK, measured into existence: on the golden
 *   control the model INVENTED a non-sequitur conflict rather than say
 *   "nothing conflicts" — the ask-line offered the words but the schema
 *   offered no label for them, and a schema outlet is what a grammar-bound
 *   model actually reaches for (same lesson as the abstention). check-kind
 *   only; everywhere else "fits" would be noise.
 */
export const FITS = "fits";

export type AskKind = "check" | "suggest" | "explain" | "question";

export interface MaxAskInput {
  /** The paragraph the writer right-clicked. */
  paragraph: string;
  paragraphIndex: number;
  chapterNumber: number;
  chapterTitle?: string;
  /** What they want. `question` carries `question`. */
  kind: AskKind;
  question?: string;
  /** Paragraphs of the current chapter, for the neighbours rung. */
  chapterParagraphs?: readonly string[];
  /** Cast members the engine says are in this scene. */
  present?: readonly string[];
  worldData?: WorldData | null;
  /** One line per earlier chapter, in reading order. */
  chapterSummaries?: ReadonlyArray<{ chapterNumber: number; summary: string }>;
  /** Threads the story has opened and not closed. */
  openThreads?: ReadonlyArray<{ chapterNumber: number; text: string }>;
  /** Pre-retrieved passages about the same people. Retrieval is the CALLER's
   *  job — this module stays synchronous so it can be tested without a model. */
  related?: ReadonlyArray<{ chapterNumber: number; text: string }>;
  budgetTokens?: number;
}

export interface MaxAskPack {
  text: string;
  tokensEstimate: number;
  /** Which rungs made it in, in order. Reported so a thin answer can be told
   *  apart from a thin PACK — they look identical from the outside. */
  rungsIncluded: string[];
  /** Rungs the budget refused. Non-empty means step 2 has something to add. */
  rungsDropped: string[];
  /**
   * What the budget would have to be for NOTHING to be dropped.
   *
   * ★★ WITHOUT THIS THE WIDENING STEP IS A COIN FLIP. The first version simply
   *    doubled the budget, and the gate caught it: the always-rungs alone cost
   *    111 tokens, so doubling 60 to 120 still fitted nothing new and step 2
   *    was a byte-identical second call. A retry that cannot change the prompt
   *    is not a retry, it is a wasted inference and a slower answer.
   */
  tokensIfComplete: number;
  packHash: string;
}

const estimateTokens = (t: string) => Math.ceil(t.length / CHARS_PER_TOKEN);
const cap = (t: string, max = PARAGRAPH_CAP) => (t.length <= max ? t : `${t.slice(0, max - 1)}…`);
const collapse = (t: string) => t.replace(/\s+/g, " ").trim();

// ── question analysis ──────────────────────────────────────────────────────

const STOP_QWORDS = new Set([
  "what", "did", "does", "who", "whom", "why", "how", "when", "where", "which",
  "the", "this", "that", "these", "those", "chapter", "paragraph", "scene",
  "story", "book", "happen", "happens", "happened", "between", "about", "tell",
  "mean", "means", "meant", "doing", "and", "was", "were", "they", "she", "him",
  "her", "his", "hers", "their", "you", "your", "with", "for", "from", "into",
  "before", "after", "here", "there", "would", "could", "should", "have", "has",
]);

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * ★ THE QUESTION NAMES ITS OWN EVIDENCE. "what did Tim do to Annaha" needs
 *   the chapter's Tim-and-Annaha passages, not the neighbours of the clicked
 *   paragraph — and the writer types names lowercase, so each is resolved
 *   two ways: against the cast list (names + aliases, case-insensitive) and
 *   against the CHAPTER TEXT's own capitalization ("tim" finds "Tim" even
 *   when the cast sheet has never heard of him).
 */
export function questionEntities(input: MaxAskInput): string[] {
  if (input.kind !== "question" || !input.question) return [];
  const q = input.question;
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    const k = name.toLowerCase();
    if (!seen.has(k)) { seen.add(k); found.push(name); }
  };
  const cast = new Set<string>();
  for (const c of input.worldData?.characters ?? []) {
    if (c.name) cast.add(c.name);
    for (const a of c.aliases ?? []) if (a) cast.add(a);
  }
  for (const p of input.present ?? []) if (p) cast.add(p);
  for (const name of cast) {
    if (new RegExp(`(^|[^\\p{L}])${escRe(name)}([^\\p{L}]|$)`, "iu").test(q)) push(name);
  }
  const chapterText = (input.chapterParagraphs ?? []).join("\n");
  for (const word of q.match(/\b[\p{L}][\p{L}'’-]{2,}\b/gu) ?? []) {
    const lower = word.toLowerCase();
    if (STOP_QWORDS.has(lower) || seen.has(lower)) continue;
    const capitalized = lower[0].toUpperCase() + lower.slice(1);
    if (new RegExp(`(^|[^\\p{L}])${escRe(capitalized)}([^\\p{L}]|$)`, "u").test(chapterText)) {
      push(capitalized);
    }
  }
  return found.slice(0, 4);
}

const ASK_LINE: Record<AskKind, string> = {
  // ★ "ABSENCE IS NOT A CONFLICT" is load-bearing. Measured without it: on a
  //   perfectly consistent paragraph the model reported "the tin is not
  //   mentioned in the story before this" — the classic small-model check
  //   failure, novelty read as anomaly. A check surface that flags clean prose
  //   trains the writer to ignore it.
  check: "What in this paragraph CONFLICTS with something another section "
    + "establishes? Something merely not mentioned before is not a conflict. "
    + "If nothing conflicts, say the paragraph fits.",
  suggest: "What could plausibly happen next here, given what the story has already established?",
  explain: "What is this paragraph doing in the story — what work is it performing?",
  question: "",
};

/**
 * Build the pack. `extraRungs` lets step 2 spend a bigger budget on the same
 * input rather than re-deriving anything.
 */
export function buildMaxAskPack(input: MaxAskInput, budgetOverride?: number): MaxAskPack {
  const budget = budgetOverride ?? input.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const included: string[] = [];
  const dropped: string[] = [];
  const parts: string[] = [];
  let spent = 0;

  /** Add a rung if it fits WHOLE; otherwise record it as dropped. */
  let ifComplete = 0;
  const add = (name: string, body: string, always = false) => {
    const cost = estimateTokens(body);
    ifComplete += cost;
    if (!always && spent + cost > budget) { dropped.push(name); return; }
    parts.push(body);
    included.push(name);
    spent += cost;
  };

  // ★★ EVERY HEADING BELOW STARTS WITH ITS RUNG TOKEN, VERBATIM, because the
  //    heading is what the model reads and the rung token is what the schema
  //    lets it say. Measured with prose headings ("THE STORY BEFORE THIS"
  //    against an enum saying "story-so-far"): answers drawn from the passage
  //    cited `passage` correctly, and answers drawn from ANY other rung fell
  //    back to the abstention — the model could not find the heading it was
  //    reading in the list it was allowed to answer with, so a correct,
  //    grounded answer shipped as "not in what I was given". The enum and the
  //    page must be the same vocabulary.

  // ── 1 · the passage ─────────────────────────────────────────────────────
  add("passage",
    `PASSAGE — chapter ${input.chapterNumber}`
    + `${input.chapterTitle ? `, ${input.chapterTitle}` : ""}, paragraph ${input.paragraphIndex + 1}\n`
    + cap(collapse(input.paragraph)),
    true);

  // ── 2 · the ask ─────────────────────────────────────────────────────────
  // ★ ENTITY QUESTIONS GET A SCOPE NOTE. The system prompt anchors answers
  //   to "that paragraph" — right for the menu kinds, wrong for "what did
  //   Tim do to Annaha in this chapter", which was answered from the first
  //   matching beat alone (measured, probe-think-ask). The note rides the
  //   user turn and names the MENTIONS rung as the answer's span.
  const askEntities = questionEntities(input);
  const scopeNote = askEntities.length > 0
    ? "\n(Answer from EVERY passage under MENTIONS that bears on this: name each act, in story order, in one answer. Not only the first, and not from the clicked paragraph alone.)"
    : "";
  const ask = input.kind === "question"
    ? collapse(input.question ?? "").slice(0, 300) + scopeNote
    : ASK_LINE[input.kind];
  add("ask", `ASK\n${ask || ASK_LINE.explain}`, true);

  // ── 3 · who is here ─────────────────────────────────────────────────────
  const present = (input.present ?? []).slice(0, 6);
  if (present.length) {
    const lines = present.map((name) => {
      const c = input.worldData?.characters.find(
        (x) => x.name === name || x.aliases?.includes(name));
      const bits = [c?.role, c?.description].filter(Boolean).join(". ");
      return bits ? `${name}: ${cap(bits, 160)}` : name;
    });
    add("who", `WHO — is in this scene\n${lines.join("\n")}`, true);
  }

  // ── 3b · how the chapter began ──────────────────────────────────────────
  //
  // ★ Situating context the neighbours cannot give: a paragraph deep in a
  //   chapter is read against where the chapter STARTED (who arrived, what was
  //   wrong, what the writer promised). Only added once the passage is far
  //   enough in that the opening is not already a neighbour.
  const paras0 = input.chapterParagraphs ?? [];
  if (input.paragraphIndex > 2 && paras0[0]) {
    add("opening", `OPENING — how this chapter begins\n${cap(collapse(paras0[0]), 300)}`);
  }

  // ── 4 · either side ─────────────────────────────────────────────────────
  const paras = input.chapterParagraphs ?? [];
  const before = paras[input.paragraphIndex - 1];
  const after = paras[input.paragraphIndex + 1];
  if (before || after) {
    add("neighbours",
      `NEIGHBOURS — immediately around it\n`
      + (before ? `Before: ${cap(collapse(before), NEIGHBOUR_CAP)}\n` : "")
      + (after ? `After: ${cap(collapse(after), NEIGHBOUR_CAP)}` : ""));
  }

  // ── 4b · the question's own evidence ────────────────────────────────────
  //
  // ★ CO-MENTIONS FIRST: for "what did Tim do to Annaha", a paragraph naming
  //   BOTH is worth more than any paragraph naming one. Chronological within
  //   each group, the clicked paragraph excluded (it is already the passage
  //   rung), each row labeled with its paragraph number so the model can
  //   point at evidence and the writer can find it.
  const entities = questionEntities(input);
  if (entities.length > 0 && paras.length > 0) {
    const res = entities.map((e) => new RegExp(`(^|[^\\p{L}])${escRe(e)}([^\\p{L}]|$)`, "iu"));
    const rows: Array<{ i: number; all: boolean }> = [];
    for (let i = 0; i < paras.length; i++) {
      if (i === input.paragraphIndex) continue;
      const hits = res.filter((re) => re.test(paras[i])).length;
      if (hits > 0) rows.push({ i, all: hits === res.length });
    }
    rows.sort((a, b) => (a.all === b.all ? a.i - b.i : a.all ? -1 : 1));
    const picked = rows.slice(0, 6).sort((a, b) => a.i - b.i);
    if (picked.length > 0) {
      add("mentions",
        `MENTIONS — this chapter's passages naming ${entities.join(", ")}\n`
        + picked.map((r) => `P${r.i + 1}: ${cap(collapse(paras[r.i]), 220)}`).join("\n"));
    }
  }

  // ── 5 · the story so far ────────────────────────────────────────────────
  const summaries = (input.chapterSummaries ?? [])
    .filter((s) => s.chapterNumber < input.chapterNumber)
    .slice(-8);
  if (summaries.length) {
    add("story-so-far",
      `STORY-SO-FAR — what earlier chapters established\n`
      + summaries.map((s) => `Ch ${s.chapterNumber}: ${cap(collapse(s.summary), 220)}`).join("\n"));
  }

  // ── 6 · open threads ────────────────────────────────────────────────────
  const threads = (input.openThreads ?? []).slice(0, 5);
  if (threads.length) {
    add("open-threads",
      `OPEN-THREADS — still unresolved\n`
      + threads.map((t) => `Ch ${t.chapterNumber}: ${cap(collapse(t.text), 180)}`).join("\n"));
  }

  // ── 7 · related passages ────────────────────────────────────────────────
  const related = (input.related ?? []).slice(0, 4);
  if (related.length) {
    add("related",
      `RELATED — earlier passages about the same people\n`
      + related.map((r) => `Ch ${r.chapterNumber}: ${cap(collapse(r.text), 240)}`).join("\n"));
  }

  const text = parts.join("\n\n");
  return {
    text,
    tokensEstimate: estimateTokens(text),
    rungsIncluded: included,
    rungsDropped: dropped,
    tokensIfComplete: ifComplete,
    packHash: fnv1a(`${MAX_ASK_PROMPT_VERSION}|${text}`),
  };
}

// ── the request ────────────────────────────────────────────────────────────

/**
 * ★★ ANSWER FIRST, THEN THE LABEL ABOUT IT. A constrained grammar emits
 *    properties in declaration order, and this repo has measured twice what
 *    happens when a label comes first: the model commits and then writes
 *    reasoning that contradicts it. `basis` is a classification OF the answer,
 *    so it comes after the answer.
 *
 * ★ `basis` IS THE GROUNDING CHECK. It has to name the section the answer came
 *   out of, and the sections are the rung names actually in the pack — so an
 *   answer citing a rung that was never included is detectable, and an answer
 *   that came from the model's own training has nowhere honest to point.
 */
export function maxAskSchema(rungs: readonly string[], kind?: AskKind) {
  return {
    type: "object",
    properties: {
      answer: { type: "string", maxLength: ANSWER_MAX },
      basis: { enum: kind === "check" ? [...rungs, FITS, NOT_IN_CONTEXT] : [...rungs, NOT_IN_CONTEXT] },
      confidence: { type: "number" },
    },
  } as const;
}

export const MAX_ASK_SYSTEM = `You are reading one paragraph of a novel, with some of what the story has
already established around it. Answer the question about that paragraph.

Everything you are given is under a heading. Use only what is there. You have
not read the rest of the book and must not pretend to — if the answer needs
something you were not given, say so with basis "${NOT_IN_CONTEXT}".

Be concrete and specific to this passage. Name the people and the things that
are actually in it. Do not summarise the paragraph back — the writer wrote it
and knows what it says. Do not give writing advice in general terms.

Answer as JSON: {"answer","basis","confidence"} in that order.
answer: FIRST. Two or three sentences. Say the useful thing straight away.
basis: the NAME of the section your answer relies on, in lower case — the word
  before the dash in its heading, such as "story-so-far" or "passage". If you
  answered the question from a section, that section is your basis. Use
  "${NOT_IN_CONTEXT}" only when NO section contains what the question needs —
  never on an answer you actually gave.
confidence: a decimal between 0 and 1, such as 0.9 or 0.4. Never above 1.`;

export interface MaxAskRequest {
  systemPrompt: string;
  userText: string;
  schema: ReturnType<typeof maxAskSchema>;
  maxTokens: number;
  rungs: readonly string[];
}

export function buildMaxAskRequest(pack: MaxAskPack, maxTokens = DEFAULT_MAX_TOKENS, kind?: AskKind): MaxAskRequest {
  return {
    systemPrompt: kind === "check"
      ? `${MAX_ASK_SYSTEM}\n\nThis is a fits-or-conflicts question. If nothing in the passage conflicts\nwith what the other sections establish, say the paragraph fits and use basis\n"${FITS}". A conflict requires two sections to state OPPOSITE things — a\ndetail merely absent elsewhere is not a conflict.`
      : MAX_ASK_SYSTEM,
    userText: pack.text,
    schema: maxAskSchema(pack.rungsIncluded, kind),
    maxTokens,
    rungs: pack.rungsIncluded,
  };
}

// ── validation ─────────────────────────────────────────────────────────────

export interface MaxAskAnswer {
  answer: string;
  basis: string;
  confidence: number;
}

export function normalizeMaxAsk(
  raw: unknown,
  rungs: readonly string[],
): MaxAskAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.answer !== "string" || typeof v.basis !== "string") return null;
  if (typeof v.confidence !== "number" || !Number.isFinite(v.confidence)) return null;

  const answer = tidyTruncatedText(collapse(v.answer).slice(0, ANSWER_MAX), ANSWER_MAX);
  if (!answer) return null;

  // ★ Matched back against the rungs WE SENT, never taken as written. A grammar
  //   constrains tokens, not meaning: a basis that is not one of ours is a
  //   citation to something that was not in the pack.
  const wanted = collapse(v.basis).toLowerCase();
  const basis = wanted === NOT_IN_CONTEXT ? NOT_IN_CONTEXT
    : wanted === FITS ? FITS
    : rungs.find((r) => r.toLowerCase() === wanted);
  if (!basis) return null;

  return { answer, basis, confidence: Math.min(1, Math.max(0, v.confidence)) };
}

/** Does this answer reach the writer? A clean bill ("fits") does. */
export function isUsefulAnswer(a: MaxAskAnswer | null | undefined): boolean {
  return !!a && a.basis !== NOT_IN_CONTEXT && a.answer.length > 0;
}

/**
 * ★ AN ABSTENTION WRITTEN AS PROSE IS STILL AN ABSTENTION. Measured twice —
 *   the starved-pack probe and the golden unanswerable — the model answers
 *   "the passage does not mention X" with basis=passage, which sails past the
 *   abstention check, ships as an answer, and never lets the loop widen. The
 *   coercion is deterministic, question-kind only (a check saying "nothing
 *   conflicts" is a VERDICT, not an abstention), and shared by the loop and
 *   every probe so the control flow cannot drift.
 */
const PROSE_ABSTAIN_RE = /\b(?:does not|do not|doesn't|don't|no section|none of the sections|never|not)\s+(?:mention|mentions|say|says|said|state|states|stated|specify|specifies|provide|provides|contain|contains|reveal|reveals|indicate|indicates)|no information\b/i;
export function coerceProseAbstention(a: MaxAskAnswer, kind: AskKind): MaxAskAnswer {
  if (kind !== "question" || a.basis === NOT_IN_CONTEXT) return a;
  return PROSE_ABSTAIN_RE.test(a.answer) ? { ...a, basis: NOT_IN_CONTEXT } : a;
}

// ── self-review: claim decomposition, verdict computed by code ─────────────
//
// ★★ THE MONOLITHIC JUDGE WAS MEASURED TWICE AND RETIRED. Asked "is this
//    answer supported by the sections?", the 4B flagged a correct check for
//    reporting the very conflict it was asked to find ("contradicted" @0.9),
//    and flagged fair interpretation as overreach ("meticulous nature" @0.9)
//    — so review was scoped down to typed questions, and the checking phase
//    never appeared on the menu asks at all.
//
// ★★ THE REDESIGN IS THE FIELD'S ANSWER, NOT A REWORDED PROMPT. Claim
//    decomposition + per-claim verification against the source is the reliably
//    automatable shape (SelfCheckGPT-family literature). Three measured rounds
//    got it here, each fixing a mechanism:
//
//    ROUND 2 — decomposition with section LABELS: the interpretation exemption
//    worked (readings exempt by type), but the poisoned compound escaped —
//    "Elena counts coins to pay off Captain Vale" was located in `passage`,
//    the true half anchoring the invented half. A label is sympathetic.
//
//    ROUND 3 — decomposition with verbatim QUOTES, verdict by string
//    arithmetic (below). On the real 4B: the poisoned claim borrowed the tin
//    quote and the enclosing-sentence name check failed it (overreaches, the
//    claim named); the correct flag reviewed clean on a real quote ("Elena
//    took the short way past the burn"); the explain answer decomposed to
//    nothing checkable and stayed quiet (facts:0, no badge). The model
//    extracts and quotes; the harness verifies with indexOf. Runs on EVERY
//    kind.

export const REVIEW_MAX_TOKENS = 320;
const CLAIM_MAX = 60;
const QUOTE_MAX = 160;

export type ClaimKind = "fact" | "reading";

export interface ReviewClaim {
  claim: string;
  kind: ClaimKind;
  /** Verbatim words from a section that state the claim; "" when nothing does. */
  quote: string;
}

export interface ReviewAnswer {
  verdict: "supported" | "overreaches";
  /** The first unsupported fact, verbatim — what the caution shows. */
  note?: string;
  facts: number;
  readings: number;
}

/**
 * ★★ THE QUOTE IS THE LOCATION, AND THE HARNESS CHECKS IT WITH indexOf.
 *    Round 2 of measuring this: asked to LOCATE each claim in a section, the
 *    model located "Elena counts coins to pay off Captain Vale" in `passage`
 *    — the true half of a compound claim anchored the invented half, and the
 *    poisoned case escaped. A label is sympathetic; a QUOTE is checkable. The
 *    model must now hand over the exact words that state each fact, and the
 *    verdict verifies two things deterministically: the quote actually occurs
 *    in the pack (normalised substring), and every capitalised name in the
 *    claim appears in the quote — so a tin-counting quote can never support a
 *    claim about Captain Vale. Extraction stays with the model; verification
 *    is string arithmetic. (SelfCheckGPT-family decomposition, adapted to a
 *    grammar-constrained 4B with the repo's verbatim-anchor tradition.)
 */
export const MAX_ASK_REVIEW_SYSTEM = `An answer was written about a passage from a novel, using only the sections
provided. You break the answer into claims so each can be checked.

At most 5 claims, ONE assertion each, at most 10 words — split compound
statements ("she counts coins to pay Vale" is two claims). For each:
- kind "fact": it asserts something about the story — an event, a detail, a
  name, a stated reason.
- kind "reading": interpretation — what the paragraph is doing, what something
  suggests, advice, a possibility.
- quote: the EXACT words, copied from a section, that state the claim. Copy
  them verbatim. If no section states it, leave quote empty. A "reading"
  usually has an empty quote and that is fine.

Answer as JSON: {"claims":[{"claim","kind","quote"}]}.
claim: FIRST, the single assertion.`;

export function claimCheckSchema() {
  return {
    type: "object",
    properties: {
      claims: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            claim: { type: "string", maxLength: CLAIM_MAX },
            kind: { enum: ["fact", "reading"] },
            quote: { type: "string", maxLength: QUOTE_MAX },
          },
        },
      },
    },
  } as const;
}

export function buildReviewRequest(pack: MaxAskPack, answer: MaxAskAnswer) {
  return {
    systemPrompt: MAX_ASK_REVIEW_SYSTEM,
    userText: `${pack.text}\n\nTHE ANSWER UNDER REVIEW\n${answer.answer}`,
    schema: claimCheckSchema(),
    maxTokens: REVIEW_MAX_TOKENS,
  };
}

export function normalizeClaimCheck(raw: unknown): ReviewClaim[] | null {
  if (!raw || typeof raw !== "object") return null;
  const arr = (raw as Record<string, unknown>).claims;
  if (!Array.isArray(arr)) return null;
  const out: ReviewClaim[] = [];
  for (const item of arr.slice(0, 5)) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    if (typeof v.claim !== "string" || typeof v.kind !== "string") continue;
    const claim = collapse(v.claim).slice(0, CLAIM_MAX);
    const kind = v.kind === "fact" || v.kind === "reading" ? v.kind : null;
    if (!claim || !kind) continue;
    out.push({ claim, kind, quote: typeof v.quote === "string" ? collapse(v.quote).slice(0, QUOTE_MAX) : "" });
  }
  return out;
}

/** Quote-vs-text match that survives typography: whitespace collapsed, curly
 *  quotes and ellipses straightened, case-insensitive. */
const normText = (t: string) =>
  t.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, "...").replace(/\s+/g, " ").trim();

/** The claim's NAMES — capitalised tokens minus ordinary sentence furniture.
 *  These are what an invented entity smuggles in ("Captain Vale", "Fen
 *  Cross"), and what a borrowed quote about the tin can never contain. */
const CLAIM_STOPCAPS = new Set(["The", "A", "An", "She", "He", "It", "They",
  "Her", "His", "Their", "In", "On", "At", "When", "After", "Before", "This", "That"]);
const claimNames = (claim: string): string[] =>
  (claim.match(/\b[A-Z][a-z'\u2019-]+/g) ?? [])
    .filter((w) => !CLAIM_STOPCAPS.has(w))
    .filter((w, i, a) => a.indexOf(w) === i);

/**
 * ★ THE VERDICT IS ARITHMETIC. A fact is SUPPORTED only when its quote really
 *   occurs in the pack AND carries every name the claim carries. Readings are
 *   exempt by type. No parsed claims = facts:0, so the UI can refuse to say
 *   "checked" rather than saying it about nothing.
 */
export function computeReviewVerdict(claims: readonly ReviewClaim[], packText: string): ReviewAnswer {
  const haystack = normText(packText);
  let facts = 0, readings = 0;
  let note: string | undefined;
  for (const c of claims) {
    if (c.kind !== "fact") { readings += 1; continue; }
    facts += 1;
    const quote = normText(c.quote);
    const at = quote.length >= 8 ? haystack.indexOf(quote) : -1;
    let ok = false;
    if (at >= 0) {
      // ★ NAMES ARE CHECKED AGAINST THE QUOTE'S ENCLOSING SENTENCE, not the
      //   quote alone. A minimal quote often omits its own subject ("counted
      //   what was left in the tin" — the sentence starts "Elena Vasquez
      //   sat…"), and requiring "Elena" INSIDE the span failed a true claim.
      //   The sentence around the located quote keeps the check deterministic
      //   while still failing the compound escape: the tin sentence contains
      //   no Captain Vale, wherever the claim smuggles him in.
      let s0 = at, s1 = at + quote.length;
      while (s0 > 0 && !".!?\n".includes(haystack[s0 - 1])) s0 -= 1;
      while (s1 < haystack.length && !".!?\n".includes(haystack[s1])) s1 += 1;
      const sentence = haystack.slice(s0, s1);
      ok = claimNames(c.claim).every((n) => sentence.includes(n.toLowerCase()));
    }
    if (!ok && !note) note = c.claim;
  }
  return { verdict: note ? "overreaches" : "supported", note, facts, readings };
}

// ── refine: revise on the verifier's feedback, once ────────────────────────
//
// ★★ THE SHAPE IS CRITIC, NOT SELF-REFLECTION. The literature is blunt that
//    intrinsic self-correction is unreliable — a model asked "was that right?"
//    with no new signal mostly says yes, or breaks a right answer. What works
//    is revision on EXTERNAL feedback, and this harness has a genuinely
//    external critic: the quote-check's string arithmetic. So the refine pass
//    fires only on a tool-flagged claim or a low-confidence answer, carries
//    the SPECIFIC flag into the prompt, and its output faces the same
//    deterministic re-check before anyone sees it. One revision, one
//    re-check, hard-capped.
//
// ★ A FLAGGED CLAIM IS NOT ALWAYS WRONG — the writer's own point: a fact can
//   be correct while worded differently from the prose (synthesis across two
//   sentences, a paraphrase). The refine prompt says exactly that, and the
//   way out it offers is GROUNDING, not deletion: restate the fact closer to
//   what a section says, or drop it if no section carries it.

export const REFINE_CONF_FLOOR = 0.6;

export function buildRefineRequest(
  pack: MaxAskPack,
  answer: MaxAskAnswer,
  flag: { kind: "overreach"; note: string } | { kind: "low-confidence" },
  kind?: AskKind,
) {
  const critique = flag.kind === "overreach"
    ? `A verification pass could not find this claim stated in any section:\n  "${flag.note}"\nThe claim may still be true but worded differently from the prose. If a\nsection does state it, restate it CLOSER to the section's own words. If no\nsection carries it, remove or correct it.`
    : `Your confidence was low. Make the answer concrete: name what the sections\nactually establish, and drop anything you were guessing at.`;
  return {
    systemPrompt: `${MAX_ASK_SYSTEM}\n\nYou already answered this once. Revise your answer using the note below.\nKeep it to two or three sentences. Do not mention the revision.`,
    userText: `${pack.text}\n\nYOUR EARLIER ANSWER\n${answer.answer}\n\nREVISION NOTE\n${critique}`,
    schema: maxAskSchema(pack.rungsIncluded, kind),
    maxTokens: DEFAULT_MAX_TOKENS,
    rungs: pack.rungsIncluded,
  };
}

// ── the bounded loop ───────────────────────────────────────────────────────

/**
 * What the model is doing RIGHT NOW, reported before each call — the same
 * live-phase courtesy every long harness in this app extends (the entity scan
 * narrates extract/classify, the download narrates bytes). "asking" is the
 * first read; "widening" is the retry with more of the story; "reviewing" is
 * the model checking its own answer. A surface that shows one spinner for all
 * three is hiding the most reassuring fact it has: that different work is
 * happening.
 */
export type MaxAskPhase = "thinking" | "asking" | "widening" | "reviewing" | "refining";

export interface MaxAskOptions {
  run: AssistantJSONRunner;
  /** Run the self-review pass on a useful answer. One extra call, bounded. */
  selfReview?: boolean;
  /** Adaptive reasoning: undefined = decide from the question's shape
   *  (decideAskThinking); false = never think (tests, probes' control arm). */
  think?: boolean;
  /** Live phase, fired immediately BEFORE the call it names. */
  onPhase?: (phase: MaxAskPhase) => void;
  maxTokens?: number;
  timeoutMs?: number;
  /** Wall-clock ceiling across every step. */
  deadlineMs?: number;
  maxSteps?: number;
  now?: () => number;
  onStep?: (step: number, why: string) => void;
}

export interface MaxAskResult {
  answer: MaxAskAnswer | null;
  /** The self-review verdict, when it ran and parsed. Decoration, never a veto. */
  review?: ReviewAnswer | null;
  /** True when the shipped answer is the REVISED one and it re-verified clean.
   *  The UI shows a small indicator, not a warning — the point of the refine
   *  pass is that the writer rarely sees a caution at all. */
  refined?: boolean;
  /** How many model calls it actually took. */
  steps: number;
  /** Why the loop stopped — always one of a closed set, never "it just did". */
  stopped: "answered" | "steps" | "rungs-exhausted" | "repeat" | "deadline" | "failed";
  /** The runtime's reason when stopped === "failed" — "low-memory" and "busy"
   *  deserve different words in the UI than a generic shrug. */
  failReason?: string;
  packHash: string;
  tokensEstimate: number;
  rungsIncluded: string[];
}

/**
 * Ask, and if the model says the pack did not contain the answer, widen the
 * budget once and ask again.
 *
 * ★★ EVERY EXIT IS NAMED AND EVERY EXIT RETURNS THE BEST ANSWER SO FAR. A
 *    harness that can end in an unnamed state is one nobody can debug from a
 *    bug report, and one that returns null on a break throws away a good step-1
 *    answer because step 2 was unlucky.
 */
export async function runMaxAsk(
  input: MaxAskInput,
  opts: MaxAskOptions,
): Promise<MaxAskResult> {
  const now = opts.now ?? (() => Date.now());
  const started = now();
  const deadline = started + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const maxSteps = Math.max(1, opts.maxSteps ?? MAX_STEPS);

  let budget = input.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  let pack = buildMaxAskPack(input, budget);
  let best: MaxAskAnswer | null = null;
  let lastAnswerText = "";
  let steps = 0;

  // ── adaptive reasoning ────────────────────────────────────────────────
  // Decided ONCE from the question's shape; the notes are produced against
  // the first pack and reused on widening (the reasoning is about the
  // question, not the pack size). A failed think pass costs its budget and
  // nothing else — the ask proceeds without notes.
  const decision = opts.think === false
    ? { think: false as const, budget: 0, reason: "disabled" }
    : decideAskThinking(input.kind, input.question, questionEntities(input).length);
  let notes: string | null = null;

  for (let step = 1; step <= maxSteps; step += 1) {
    if (now() >= deadline) {
      return { answer: best, steps, stopped: "deadline", packHash: pack.packHash,
        tokensEstimate: pack.tokensEstimate, rungsIncluded: pack.rungsIncluded };
    }

    const request = buildMaxAskRequest(pack, opts.maxTokens ?? DEFAULT_MAX_TOKENS, input.kind);
    steps = step;
    opts.onStep?.(step, step === 1 ? "first ask" : "context widened");

    if (step === 1 && decision.think && now() < deadline) {
      opts.onPhase?.("thinking");
      notes = await runThinkPass(opts.run, {
        task: MAX_ASK_TASK,
        tag: `${input.chapterNumber}:${input.paragraphIndex}`,
        systemPrompt: request.systemPrompt,
        userText: request.userText,
        schema: request.schema,
        budget: decision.budget,
        timeoutMs: Math.max(1000, Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, deadline - now())),
      });
    }
    opts.onPhase?.(step === 1 ? "asking" : "widening");

    const result = await opts.run<unknown>({
      task: MAX_ASK_TASK,
      tag: `${input.chapterNumber}:${input.paragraphIndex}`,
      systemPrompt: request.systemPrompt,
      userText: notes ? `${request.userText}\n\n${notesBlock(notes)}` : request.userText,
      schema: request.schema,
      maxTokens: request.maxTokens,
      // Never let one call outlive the whole budget.
      timeoutMs: Math.max(1000, Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, deadline - now())),
    });
    if (!result.ok) {
      return { answer: best, steps, stopped: "failed", failReason: result.reason,
        packHash: pack.packHash,
        tokensEstimate: pack.tokensEstimate, rungsIncluded: pack.rungsIncluded };
    }

    let answer = normalizeMaxAsk(result.json, pack.rungsIncluded);
    if (answer) answer = coerceProseAbstention(answer, input.kind);
    if (answer) best = answer;

    if (answer && isUsefulAnswer(answer)) {
      // ── self-review + refine: verify, revise on the flag, re-verify ──────
      // Claim decomposition (see the section above): the model extracts and
      // quotes, the verdict is computed here, and it runs on every kind.
      const runClaimCheck = async (target: MaxAskAnswer): Promise<ReviewAnswer | null> => {
        opts.onPhase?.("reviewing");
        const reviewRequest = buildReviewRequest(pack, target);
        const reviewed = await opts.run<unknown>({
          task: MAX_ASK_TASK,
          tag: `review:${input.chapterNumber}:${input.paragraphIndex}`,
          systemPrompt: reviewRequest.systemPrompt,
          userText: reviewRequest.userText,
          schema: reviewRequest.schema,
          maxTokens: reviewRequest.maxTokens,
          timeoutMs: Math.max(1000, Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, deadline - now())),
        }).catch(() => null);
        if (!reviewed || !reviewed.ok) return null;
        const claims = normalizeClaimCheck(reviewed.json);
        return claims ? computeReviewVerdict(claims, pack.text) : null;
      };

      let review: ReviewAnswer | null = null;
      let refined = false;
      if (opts.selfReview && now() < deadline) {
        review = await runClaimCheck(answer);

        // ★ REFINE, ONCE, ON A TOOL FLAG OR LOW CONFIDENCE — then the revised
        //   answer faces the SAME deterministic check. It ships only if it
        //   passes; a revision that still fails is discarded and the original
        //   ships with its caution, because "the model made it worse" is a
        //   documented failure mode of small-model self-correction.
        const flag = review?.verdict === "overreaches" && review.note
          ? { kind: "overreach" as const, note: review.note }
          : answer.confidence < REFINE_CONF_FLOOR
            ? { kind: "low-confidence" as const }
            : null;
        if (flag && now() < deadline) {
          opts.onPhase?.("refining");
          const refineRequest = buildRefineRequest(pack, answer, flag, input.kind);
          const revisedRaw = await opts.run<unknown>({
            task: MAX_ASK_TASK,
            tag: `refine:${input.chapterNumber}:${input.paragraphIndex}`,
            systemPrompt: refineRequest.systemPrompt,
            userText: refineRequest.userText,
            schema: refineRequest.schema,
            maxTokens: refineRequest.maxTokens,
            timeoutMs: Math.max(1000, Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, deadline - now())),
          }).catch(() => null);
          let revised = revisedRaw && revisedRaw.ok
            ? normalizeMaxAsk(revisedRaw.json, pack.rungsIncluded) : null;
          if (revised) revised = coerceProseAbstention(revised, input.kind);
          if (revised && isUsefulAnswer(revised) && now() < deadline) {
            const recheck = await runClaimCheck(revised);
            if (recheck && recheck.verdict === "supported") {
              answer = revised;
              review = recheck;
              refined = true;
            }
          }
        }
      }
      return { answer, review, refined, steps, stopped: "answered", packHash: pack.packHash,
        tokensEstimate: pack.tokensEstimate, rungsIncluded: pack.rungsIncluded };
    }

    // ── the only reason to go round again ────────────────────────────────
    if (pack.rungsDropped.length === 0) {
      return { answer: best, steps, stopped: "rungs-exhausted", packHash: pack.packHash,
        tokensEstimate: pack.tokensEstimate, rungsIncluded: pack.rungsIncluded };
    }
    // ★ A REPEATED ANSWER MEANS MORE CONTEXT CHANGED NOTHING. Without this a
    //   model that always says the same thing burns every remaining step.
    if (answer && answer.answer === lastAnswerText) {
      return { answer: best, steps, stopped: "repeat", packHash: pack.packHash,
        tokensEstimate: pack.tokensEstimate, rungsIncluded: pack.rungsIncluded };
    }
    if (answer) lastAnswerText = answer.answer;

    // ★ WIDEN TO WHAT IS ACTUALLY NEEDED, capped. Doubling was the obvious
    //   move and it was wrong: the pack knows exactly what everything costs, so
    //   ask for that and let the ceiling — not arithmetic — be the limiter.
    budget = Math.min(Math.max(budget * 2, pack.tokensIfComplete), WIDEN_CEILING_TOKENS);
    const wider = buildMaxAskPack(input, budget);
    // If widening changed nothing, another call is the same call.
    if (wider.rungsIncluded.length === pack.rungsIncluded.length) {
      return { answer: best, steps, stopped: "rungs-exhausted", packHash: pack.packHash,
        tokensEstimate: pack.tokensEstimate, rungsIncluded: pack.rungsIncluded };
    }
    pack = wider;
  }

  return { answer: best, steps, stopped: "steps", packHash: pack.packHash,
    tokensEstimate: pack.tokensEstimate, rungsIncluded: pack.rungsIncluded };
}
