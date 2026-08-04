/**
 * alias-review.ts — are these two names the same person?
 *
 * alias-propose.ts links what morphology can prove: titles, given names,
 * surnames, initials, and the derivable English hypocorism (Lizzy → Elizabeth).
 * Two things it cannot do, by construction:
 *
 *   1. THE BARE-SURNAME PROPOSALS IT FLAGS `uncertain`. "Bennet" surviving the
 *      uniqueness check only means no OTHER character in worldData claims it —
 *      and the writer may simply not have added the father yet.
 *   2. CULTURAL NICKNAMES. Kitty → kit ⊄ catherine; Peggy ⊄ Margaret; Jack ⊄
 *      John. These are not derivable from the strings at all. The proposer's
 *      own gate asserts it misses them, because the alternative is shipping a
 *      name-nickname lexicon — which would be English-only in an app whose
 *      users write in every naming tradition there is.
 *
 * ★★ THE MODEL VERIFIES PAIRS; IT NEVER SCANS FOR THEM. Deterministic blocking
 *    generates candidates and tolerates false positives, a model judges only
 *    those. That is where entity-resolution practice landed and it is the same
 *    split as entity-review, chekhov-review and presence-review here.
 *
 * ★★ A WRONG MERGE IS WORSE THAN A MISSED ONE AND THE ASYMMETRY IS IN THE CODE.
 *    Two characters collapsing into one speaker corrupts every downstream count
 *    silently and forever; a missed nickname costs a nickname. So `applied` is
 *    only ever `same-person` above a high floor, the answer is a PROPOSAL the
 *    writer confirms, and nothing here writes to worldData.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ THIS MODULE IS UNWIRED. IT WAS MEASURED OUT, LIKE attribution-review.ts.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * scripts/probe-alias-review.cjs, qwen3-1.7b, eight pairs — four real (one of
 * them a cultural nickname no string test can derive) and four families
 * carrying the same surface similarity:
 *
 *     right, and a merge proposed        1
 *     WRONG, and a merge proposed        1    ← corrupts the cast
 *     real pair missed                   3
 *     two people correctly left apart    3
 *
 *   confidence, TRUE pairs called same  : [1]
 *   confidence, FALSE pairs called same : [1]
 *
 * ★★ THE FALSE MERGE STATED THE RULE THAT REFUTES IT AND MERGED ANYWAY.
 *    "Alise Verrin" and "Mera Verrin", at confidence 1.0, reasoning: "Both
 *    names share the same surname Verrin and are given different first names."
 *    That sentence is Vala et al.'s own veto — it is the proof they are two
 *    people — and the model produced it as the justification for saying they
 *    are one. Reason first in the schema did not help, because this is not the
 *    model committing before it reasons; it reasons correctly and then assigns
 *    the opposite label. More prompt text cannot fix that: the prompt already
 *    says "a shared surname is the commonest trap" and names two sisters as
 *    the example.
 *
 * ★ AND NO THRESHOLD SEPARATES THEM — both the true and the false merge came
 *   back at exactly 1.0. For a marking task an interleaved floor is survivable
 *   because a declined answer falls back on the deterministic call. A MERGE has
 *   no answer underneath it. That makes this disqualifying rather than
 *   merely disappointing.
 *
 * ★ THE DETERMINISTIC ENGINE WAS ALREADY SAFE ON THE CASE THE MODEL BROKE.
 *   alias-propose.ts fires no rule for "Alise Verrin" ~ "Mera Verrin", so on
 *   this set the model's entire contribution was one true nickname and one
 *   cast-corrupting merge. Net negative.
 *
 * ★ WIRE IT BACK WHEN: wrong-and-surfaced is 0 on that probe, on a model that
 *   also finds at least two of the four real pairs. A better "right" alone is
 *   not the condition — zero wrong with zero right means the task does nothing.
 *   Re-run the probe; do not re-argue from the prompt.
 */
import { fnv1a } from "./evidence-pack";
import { tidyTruncatedText } from "./assistant-client";
import { reasonEchoesSentence } from "./chekhov-review";
import type { AssistantJSONRunner } from "./assistant-client";
import type { AliasProposal } from "./alias-propose";

export const ALIAS_TASK = "alias-review";
export const ALIAS_PROMPT_VERSION = 1;

/** Per-scan budget. This runs once when the writer opens the cast, not per key. */
export const ALIAS_CAP = 6;
/**
 * ★ HIGHER THAN EVERY OTHER TASK'S FLOOR IN THIS REPO (0.7), on purpose. The
 *   others mark or label something; this one MERGES TWO PEOPLE. The cost of a
 *   false positive is not a wrong badge, it is a cast that can never be
 *   un-fragmented without the writer noticing and undoing it by hand.
 */
export const ALIAS_MIN_CONFIDENCE = 0.85;

export type AliasVerdict = "same-person" | "different-people" | "unsure";
export const ALIAS_VERDICTS: readonly AliasVerdict[] =
  ["same-person", "different-people", "unsure"];

const SNIPPET_MAX = 220;
const REASON_MAX = 110;
const DEFAULT_MAX_TOKENS = 128;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * ★★ REASON FIRST — a grammar emits properties in declaration order, and with
 *    the verdict first the model commits before writing a word of evidence.
 * ★ "unsure" LAST: it is the abstention, not a third reading.
 */
export const ALIAS_SCHEMA = {
  type: "object",
  properties: {
    reason: { type: "string", maxLength: REASON_MAX },
    verdict: { enum: ["same-person", "different-people", "unsure"] },
    confidence: { type: "number" },
  },
} as const;

export const ALIAS_SYSTEM = `Two names appear in one novel. You say whether they name the SAME PERSON or two
different people.

You are given both names and short passages showing each one in use. Those
passages are all the evidence there is.

Answer "same-person" only when one name is plainly another way of saying the
other:
- a familiar or shortened form of the same given name
- the same person with and without a title or rank
- a given name and the full name that contains it

Answer "different-people" when anything shows two people:
- both names appear in the same sentence as separate participants
- one is addressed while the other is spoken about
- they are related rather than identical — a father and a son, two sisters, a
  husband and a wife often share a surname and are not the same person
- their titles disagree about gender

A shared surname is the commonest trap. Novels are full of families, and two
people with one surname are usually two people.

Answer "unsure" when the passages do not settle it. That is the right answer
far more often than not, and it costs nothing: the names simply stay separate,
which is how they already are.

Answer as JSON: {"reason","verdict","confidence"} in that order.
reason: FIRST, one clause of at most 14 words saying what in the passages
  decided it. Do not copy a passage back.
verdict: same-person, different-people, or unsure.
confidence: a number from 0 to 1. Use a high number only when a passage shows
  it outright, not when it merely seems likely. Never above 1.`;

/**
 * The instruction text a reason must not simply hand back.
 *
 * ★★ MEASURED: four of eight answers came back with the reason "Both names
 *    appear in the same sentence as separate participants" — a verbatim bullet
 *    from the list above — for pairs whose two names sit in SEPARATE snippets
 *    and never share a sentence. The echo guard compared reasons against the
 *    SNIPPETS only, so a reason echoing the INSTRUCTIONS sailed through. Same
 *    defect found and fixed in presence-review.ts; it is here because the fix
 *    did not travel with the pattern.
 */
export const ALIAS_EXAMPLE_TEXT =
  "both names appear in the same sentence as separate participants one is addressed " +
  "while the other is spoken about they are related rather than identical a father " +
  "and a son two sisters a husband and a wife often share a surname and are not the " +
  "same person their titles disagree about gender a shared surname is the commonest trap";

// ── candidates ────────────────────────────────────────────────────────────

export interface AliasReviewCandidate {
  /** The name that would survive. */
  character: string;
  /** The name that would be folded into it. */
  alias: string;
  /** Where this pair came from — for ranking and for the UI's wording. */
  source: "uncertain-proposal" | "unlinked-pair";
  characterSnippets: readonly string[];
  aliasSnippets: readonly string[];
  /** Occurrences of the rarer of the two. Ranking only. */
  weight: number;
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LB = "(?<![A-Za-z0-9])";
const RB = "(?![A-Za-z0-9])";
const WINDOW = 110;

/** Verbatim windows around a name, non-overlapping. */
export function nameSnippets(text: string, name: string, limit = 2): string[] {
  const re = new RegExp(`${LB}${esc(name)}${RB}`, "g");
  const out: string[] = [];
  let lastEnd = -1;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at < lastEnd) continue;
    const end = Math.min(text.length, at + name.length + WINDOW);
    out.push(collapse(text.slice(Math.max(0, at - WINDOW), end)));
    lastEnd = end;
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * ★★ THE SAME-SENTENCE TEST IS DETERMINISTIC AND IT RUNS BEFORE THE MODEL. Two
 *    names in one sentence as separate participants are two people, and that is
 *    cheap to check — asking a 1.7B model to notice it would be spending an
 *    inference on something a regex settles. What reaches the model is only
 *    what survives this.
 */
export function sharesASentence(text: string, a: string, b: string): boolean {
  const re = new RegExp(
    `[^.!?]*${LB}${esc(a)}${RB}[^.!?]*${LB}${esc(b)}${RB}[^.!?]*` +
    `|[^.!?]*${LB}${esc(b)}${RB}[^.!?]*${LB}${esc(a)}${RB}[^.!?]*`);
  return re.test(text);
}

/**
 * Turn the proposer's `uncertain` output into questions, plus the unlinked
 * single-token pairs a nickname could hide in.
 *
 * ★ THE UNLINKED-PAIR SOURCE IS BOUNDED BY CONSTRUCTION AND STILL RANKED. A
 *   cast of ten single-token names is 45 pairs; the cap takes the few worth an
 *   inference and `log`-worthy truncation is reported by the caller. Both names
 *   must be reasonably frequent, or the pair is noise either way.
 */
export function aliasCandidatesFrom(
  proposals: readonly AliasProposal[],
  unlinkedNames: readonly string[],
  text: string,
  cap = ALIAS_CAP,
): AliasReviewCandidate[] {
  const out: AliasReviewCandidate[] = [];
  const countOf = (n: string) => (text.match(new RegExp(`${LB}${esc(n)}${RB}`, "g")) ?? []).length;

  for (const p of proposals) {
    if (!p.uncertain) continue;
    out.push({
      character: p.character,
      alias: p.alias,
      source: "uncertain-proposal",
      characterSnippets: nameSnippets(text, p.character),
      aliasSnippets: nameSnippets(text, p.alias),
      weight: p.occurrences,
    });
  }

  const singles = unlinkedNames
    .map((n) => n.trim())
    .filter((n) => n.length >= 4 && !n.includes(" "))
    .map((n) => ({ name: n, count: countOf(n) }))
    .filter((n) => n.count >= 4)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  for (let i = 0; i < singles.length; i += 1) {
    for (let j = i + 1; j < singles.length; j += 1) {
      const a = singles[i], b = singles[j];
      // Deterministic vetoes first — see the ★★ on sharesASentence.
      if (sharesASentence(text, a.name, b.name)) continue;
      const [longer, shorter] = a.name.length >= b.name.length ? [a, b] : [b, a];
      out.push({
        character: longer.name,
        alias: shorter.name,
        source: "unlinked-pair",
        characterSnippets: nameSnippets(text, longer.name),
        aliasSnippets: nameSnippets(text, shorter.name),
        weight: Math.min(a.count, b.count),
      });
    }
  }

  return out
    .filter((c) => c.characterSnippets.length > 0 && c.aliasSnippets.length > 0)
    .sort((a, b) =>
      (a.source === b.source ? 0 : a.source === "uncertain-proposal" ? -1 : 1)
      || b.weight - a.weight
      || a.alias.localeCompare(b.alias))
    .slice(0, Math.max(0, cap));
}

// ── request ───────────────────────────────────────────────────────────────

export interface AliasRequest {
  systemPrompt: string;
  userText: string;
  schema: typeof ALIAS_SCHEMA;
  maxTokens: number;
  offered: readonly AliasVerdict[];
}

function cutHead(text: string, max: number): string {
  const body = collapse(text);
  if (body.length <= max) return body;
  const cut = body.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function buildAliasRequest(
  candidate: AliasReviewCandidate,
  maxTokens = DEFAULT_MAX_TOKENS,
): AliasRequest {
  const userText = [
    `NAME A: ${collapse(candidate.character)}`,
    ...candidate.characterSnippets.slice(0, 2).map((s) => `  …${cutHead(s, SNIPPET_MAX)}…`),
    "",
    `NAME B: ${collapse(candidate.alias)}`,
    ...candidate.aliasSnippets.slice(0, 2).map((s) => `  …${cutHead(s, SNIPPET_MAX)}…`),
    "",
    `Are "${collapse(candidate.character)}" and "${collapse(candidate.alias)}" the same person?`,
  ].join("\n");
  return {
    systemPrompt: ALIAS_SYSTEM,
    userText,
    schema: ALIAS_SCHEMA,
    maxTokens,
    offered: ALIAS_VERDICTS,
  };
}

// ── validation ────────────────────────────────────────────────────────────

export interface AliasAnswer {
  verdict: AliasVerdict;
  confidence: number;
  reason: string;
}

export function normalizeAlias(raw: unknown, snippets: readonly string[] = []): AliasAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  const verdictRaw = value.verdict;
  if (typeof verdictRaw !== "string") return null;
  const verdict = ALIAS_VERDICTS.find((v) => v === collapse(verdictRaw).toLowerCase());
  if (!verdict) return null;

  const confidenceRaw = value.confidence;
  if (typeof confidenceRaw !== "number" || !Number.isFinite(confidenceRaw)) return null;

  const reasonRaw = value.reason;
  if (typeof reasonRaw !== "string") return null;
  const reason = tidyTruncatedText(collapse(reasonRaw).slice(0, REASON_MAX), REASON_MAX);
  if (!reason) return null;
  for (const s of snippets) if (s && reasonEchoesSentence(reason, s)) return null;
  // ★ AND against the INSTRUCTIONS — see ALIAS_EXAMPLE_TEXT.
  if (reasonEchoesSentence(reason, ALIAS_EXAMPLE_TEXT)) return null;

  return { verdict, confidence: Math.min(1, Math.max(0, confidenceRaw)), reason };
}

/** Does this answer produce a proposal the writer is shown? Nothing else does. */
export function isSurfacedAlias(answer: AliasAnswer | null | undefined): boolean {
  return !!answer
    && answer.verdict === "same-person"
    && answer.confidence >= ALIAS_MIN_CONFIDENCE;
}

export function aliasKeyFor(bookHash: string, a: string, b: string, modelId: string): string {
  const pair = [collapse(a).toLowerCase(), collapse(b).toLowerCase()].sort().join("|");
  return fnv1a(`${bookHash}|${pair}|${modelId}|v${ALIAS_PROMPT_VERSION}`);
}

// ── one pair ──────────────────────────────────────────────────────────────

export interface AliasReviewOptions {
  run: AssistantJSONRunner;
  modelId: string;
  bookHash: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface AliasReviewResult extends AliasAnswer {
  character: string;
  alias: string;
  source: AliasReviewCandidate["source"];
  /** True only for a confident `same-person` — the one case that is shown. */
  surfaced: boolean;
  key: string;
}

export async function runAliasReview(
  candidate: AliasReviewCandidate,
  opts: AliasReviewOptions,
): Promise<AliasReviewResult | null> {
  const snippets = [...candidate.characterSnippets, ...candidate.aliasSnippets]
    .filter((s) => s.trim() !== "");
  if (!candidate.character.trim() || !candidate.alias.trim() || snippets.length === 0) return null;

  const request = buildAliasRequest(candidate, opts.maxTokens ?? DEFAULT_MAX_TOKENS);
  const result = await opts.run<unknown>({
    task: ALIAS_TASK,
    tag: `${candidate.character}~${candidate.alias}`,
    systemPrompt: request.systemPrompt,
    userText: request.userText,
    schema: request.schema,
    maxTokens: request.maxTokens,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (!result.ok) return null;

  const answer = normalizeAlias(result.json, snippets);
  if (!answer) return null;

  return {
    character: candidate.character,
    alias: candidate.alias,
    source: candidate.source,
    ...answer,
    surfaced: isSurfacedAlias(answer),
    key: aliasKeyFor(opts.bookHash, candidate.character, candidate.alias, opts.modelId),
  };
}
