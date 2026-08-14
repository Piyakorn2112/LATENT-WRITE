/**
 * chapter-summary.ts — two sentences saying what actually happens in a chapter.
 *
 * The FOURTH consumer of the assistant runtime, and the same contract as the
 * others: the model never sees the manuscript. It is handed the ranked events
 * the deterministic engine already found, the cast, and the chapter's shape,
 * and its whole job is to say plainly what those add up to. A summary it
 * cannot ground in an offered event is a summary it cannot write.
 *
 * ★ REASON-SHAPED ORDER. `summary` is emitted before `throughline`, because a
 *   grammar emits properties in declaration order and the throughline is a
 *   judgement ABOUT the summary. The entity reviewer paid for this lesson the
 *   expensive way: with the label first, it produced labels that contradicted
 *   their own reasons. Do not reorder these.
 *
 * ★ WORD BUDGET, NOT A CHARACTER CAP. Measured in chip-picker across seven
 *   variants: a character cap overruns and gets guillotined mid-word, a word
 *   budget lands. Same lesson, same reason, stated again here because the next
 *   person to tune this prompt will reach for a character count first.
 */
import { fnv1a, keyFields } from "./evidence-pack";
import { tidyTruncatedText } from "./assistant-client";
import type { AssistantJSONRunner } from "./assistant-client";
import type { ChapterGraphEntry, MajorEvent } from "../types";

export const SUMMARY_TASK = "chapter-summary";
export const SUMMARY_PROMPT_VERSION = 1;

/** Events offered as material. Beyond this the prompt stops being a summary
 *  brief and starts being the chapter. */
export const SUMMARY_EVENT_CAP = 6;
export const SUMMARY_MAX_CHARS = 320;
export const THROUGHLINE_MAX_CHARS = 90;

const DEFAULT_MAX_TOKENS = 160;
const DEFAULT_TIMEOUT_MS = 45_000;

export const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", maxLength: 420 },
    throughline: { type: "string", maxLength: 140 },
  },
} as const;

/** Precompiled compact grammar for the SIDECAR path — same generator, same
 *  stripped stop-tail, same regeneration rule as CHIP_RICH_GBNF (see the ★
 *  there). Regenerate whenever SUMMARY_SCHEMA changes. */
export const SUMMARY_GBNF = `root ::= "{" whitespace-no-new-lines-rule "\\"summary\\"" ":" [ ]? string-0-420-rule comma-whitespace-no-new-lines-rule "\\"throughline\\"" ":" [ ]? string-0-140-rule whitespace-no-new-lines-rule "}"
string-char-rule ::= [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" ["\\\\/bfnrt] | "\\\\u" [0-9a-fA-F]{4}
string-0-420-rule ::= "\\"" ( string-char-rule ){0,420} "\\""
comma-whitespace-no-new-lines-rule ::= "," [ ]?
string-0-140-rule ::= "\\"" ( string-char-rule ){0,140} "\\""
whitespace-no-new-lines-rule ::= [ ]?`;

export const SUMMARY_SYSTEM = `You write the short summary shown beside a novel chapter on its timeline.

You are given the chapter's number and title, the moments an analysis engine
found in it (verbatim sentences from the chapter), who is present, and how
tense the chapter gets. You do NOT have the chapter itself. Everything you
write must come from the moments you were given.

summary: what happens in this chapter. Two sentences, about 35 words in total.
Plain past tense. Name the people and what they actually did. If the moments
only support one sentence, write one.

throughline: at most 8 words naming what the chapter moves forward. Leave it
empty if the moments do not show one.

Never do these:
- Do not invent an event, a motive, or a detail that is not in the moments.
- Do not write a blurb. No "in this gripping chapter", no rhetorical questions,
  no teasing what happens next.
- Do not start with "In this chapter" or the chapter's title.
- Do not describe the writing. Describe the story.

Answer as JSON: {"summary","throughline"} in that order.`;

// ── request ───────────────────────────────────────────────────────────────

export interface SummaryRequest {
  systemPrompt: string;
  userText: string;
  schema: typeof SUMMARY_SCHEMA;
  maxTokens: number;
  /** Rank-ordered events actually offered, for the caller's own assertions. */
  offered: MajorEvent[];
}

const byRank = (events: readonly MajorEvent[]) =>
  events
    .map((event, index) => ({ event, rank: event.rank ?? index }))
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.event);

export function buildSummaryRequest(
  entry: ChapterGraphEntry,
  maxTokens = DEFAULT_MAX_TOKENS,
): SummaryRequest {
  const offered = byRank(entry.majorEvents).slice(0, SUMMARY_EVENT_CAP);
  const cast = entry.charactersPresent.slice(0, 6);
  const lines = [
    `CHAPTER ${entry.chapterNumber}: ${entry.chapterTitle || "(untitled)"}`,
    cast.length ? `PRESENT: ${cast.join(", ")}` : "PRESENT: (nobody named)",
    `TENSION PEAK: ${Math.round(entry.tensionPeak * 100)} of 100`,
    "",
    "MOMENTS (in order of importance)",
    ...offered.map((event, i) => `${i + 1}. ${event.sentence || event.label}`),
    "",
    "Write the summary from these moments only.",
  ];
  return {
    systemPrompt: SUMMARY_SYSTEM,
    userText: lines.join("\n"),
    schema: SUMMARY_SCHEMA,
    maxTokens,
    offered,
  };
}

// ── validation ────────────────────────────────────────────────────────────

export interface NormalizedSummary {
  summary: string;
  throughline?: string;
}

const clean = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Mechanical checks only. Whether the summary is TRUE of the chapter is not
 * decidable here; what is decidable is whether it is a summary at all.
 */
export function normalizeSummary(raw: unknown): NormalizedSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.summary !== "string") return null;

  let summary = clean(value.summary);
  if (!summary) return null;
  // A blurb opener is the one register failure worth rejecting outright: it is
  // never information, and it is the model's most habitual reflex.
  summary = summary.replace(/^in this chapter,?\s*/i, "");
  summary = summary.charAt(0).toUpperCase() + summary.slice(1);
  if (summary.length > SUMMARY_MAX_CHARS) {
    summary = tidyTruncatedText(summary.slice(0, SUMMARY_MAX_CHARS), SUMMARY_MAX_CHARS);
  }
  if (summary.length < 12) return null;

  let throughline: string | undefined;
  if (typeof value.throughline === "string") {
    const t = clean(value.throughline);
    if (t && t.length <= THROUGHLINE_MAX_CHARS) throughline = t;
  }
  return throughline ? { summary, throughline } : { summary };
}

// ── cache key ─────────────────────────────────────────────────────────────

/**
 * ★★ THE KEY IS THE REQUEST — the same rule as `chipKeyFor`, and the reasoning
 *    lives there in full. Two task-specific notes:
 *
 *    · This answer is a pure function of the prompt ALONE. `normalizeSummary`
 *      is mechanical text repair and reads nothing outside the response, so
 *      unlike the chip key there is no extra judged material to fold in.
 *    · The old key shared the chip key's `contentHash|eventFingerprint`
 *      recipe on the reasoning that a summary is built from the events. It is,
 *      but from only the top SUMMARY_EVENT_CAP of them and from none of their
 *      labels, agents or types — so the summary was being recomputed for
 *      changes it cannot see far more often than the chips were. MEASURED
 *      (scripts/probe-lane-staleness.ts): 97% of the summary runs a local
 *      revision triggers had a byte-identical prompt to the run before them.
 */
const KEY_RECIPE = "r1";

const requestCache = new WeakMap<ChapterGraphEntry, SummaryRequest>();

function cachedSummaryRequest(entry: ChapterGraphEntry): SummaryRequest {
  let request = requestCache.get(entry);
  if (!request) { request = buildSummaryRequest(entry); requestCache.set(entry, request); }
  return request;
}

export function summaryKeyFor(entry: ChapterGraphEntry, modelId: string): string {
  const request = cachedSummaryRequest(entry);
  return fnv1a(keyFields([
    request.systemPrompt,
    request.userText,
    modelId,
    `${KEY_RECIPE}v${SUMMARY_PROMPT_VERSION}`,
  ]));
}

// ── the pass ──────────────────────────────────────────────────────────────

export interface SummaryOptions {
  run: AssistantJSONRunner;
  modelId: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Failure-reason outlet, same contract as ChipPickOptions.onRunFailure:
   *  the caller must not skip-key a chapter over a transient runtime failure. */
  onRunFailure?: (reason: string) => void;
  /** "compact" = no pretty-printing in the grammar (max tier; ~12% of gen). */
  jsonStyle?: "compact";
}

export interface SummaryOutcome {
  lmSummary: string;
  lmThroughline?: string;
  lmSummaryKey: string;
}

/** Null on any failure: the timeline keeps its heuristic rendering. */
export async function runChapterSummary(
  entry: ChapterGraphEntry,
  opts: SummaryOptions,
): Promise<SummaryOutcome | null> {
  if (entry.majorEvents.length === 0) return null;
  const request = buildSummaryRequest(entry, opts.maxTokens ?? DEFAULT_MAX_TOKENS);
  const result = await opts.run<unknown>({
    task: SUMMARY_TASK,
    tag: entry.chapterId,
    systemPrompt: request.systemPrompt,
    userText: request.userText,
    schema: request.schema,
    maxTokens: request.maxTokens,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(opts.jsonStyle ? { jsonStyle: opts.jsonStyle, gbnf: SUMMARY_GBNF } : {}),
  });
  if (!result.ok) {
    opts.onRunFailure?.(result.reason);
    return null;
  }

  const normalized = normalizeSummary(result.json);
  if (!normalized) return null;
  return {
    lmSummary: normalized.summary,
    lmThroughline: normalized.throughline,
    lmSummaryKey: summaryKeyFor(entry, opts.modelId),
  };
}
