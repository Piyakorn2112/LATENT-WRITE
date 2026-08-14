/**
 * evidence-pack.ts — the dynamic evidence assembler (the harness core).
 *
 * A PURE function from a candidate plus already-derived story data to the
 * exact text the local model is allowed to see. The model never searches and
 * never sees the manuscript; it sees what this module selected, nothing else.
 * That is the whole thesis: the harness, not the base model, carries the
 * intelligence. Design: plans/knowledge-ledger-and-local-adjudicator.md §6.
 *
 * DYNAMIC means a priority ladder under a token budget, not a fixed template:
 *   1. the claim (quote + enclosing paragraph)            — always
 *   2. the fact block (structured presence/exposure)      — always
 *   3. the entity dossier (+ first-exposure paragraph)    — always
 *   4. the speaker dossier                                — budget
 *   5. story events touching the entity, by rank          — budget
 *   6. related passages (pre-retrieved via embeddings)    — budget
 *   7. prior rulings on either name                       — budget
 * Rungs fill top-down; whatever does not fit is dropped from the bottom.
 * Retrieval (rung 6) is ASYNC and lives with the caller — this module stays
 * synchronous and deterministic so it can be snapshot-tested without a model.
 *
 * ★ SECTIONS ARE LABELED PLAIN TEXT, NOT MARKDOWN TABLES. Small models read
 *   labeled blocks far more reliably than table syntax.
 * ★ THE PACK HASH IS PART OF THE VERDICT CACHE KEY. Any change to packing or
 *   PACK_VERSION invalidates exactly the affected verdicts and nothing else.
 */
import type {
  ChapterKnowledgeFacts,
  KnowledgeCandidate,
  KnowledgeFact,
  WriterDecision,
} from "./knowledge-store";
import type { WorldData } from "../types";

/** Bump when the serialization changes shape — it invalidates cached verdicts. */
export const PACK_VERSION = 1;

const CHARS_PER_TOKEN = 4;
const PARAGRAPH_CAP = 700;   // chars; keeps rungs 1–3 affordable at any budget
const EVENT_LIMIT = 3;
const RELATED_LIMIT = 4;

export interface RelatedPassage {
  chapterNumber: number;
  text: string;
  score: number;
}

export interface EvidencePackInput {
  candidate: KnowledgeCandidate;
  /** Ledger chapter facts in reading order. */
  chapters: readonly ChapterKnowledgeFacts[];
  facts: readonly KnowledgeFact[];
  decisions?: Record<string, WriterDecision>;
  /** Paragraphs of each chapter, for the claim and first-exposure context. */
  paragraphsByChapterId: ReadonlyMap<string, readonly string[]>;
  worldData?: WorldData | null;
  /** Events already selected by the sanctioned rank-based picker upstream. */
  majorEvents?: ReadonlyArray<{
    chapterNumber: number;
    label: string;
    sentence?: string;
    rank?: number;
    agent?: string;
  }>;
  related?: readonly RelatedPassage[];
  /** Default 2000 (Metal tier); pass 1200 on the CPU tier. */
  budgetTokens?: number;
}

export interface EvidencePack {
  text: string;
  tokensEstimate: number;
  rungsIncluded: string[];
  packHash: string;
}

const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

/** FNV-1a, hex — stable across sessions, no crypto dependency in the renderer. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Join fields into a string only those exact fields can produce.
 *
 * ★ A DELIMITER IS NOT ENOUGH WHEN THE FIELDS ARE PROSE. Prompts, chip labels
 *   and character names can contain any character, so any separator could be
 *   forged by the content itself and let two different requests collide on one
 *   cache key — which shows a stale answer as a fresh one. Prefixing each
 *   field with its own length is unambiguous whatever the field contains.
 */
export function keyFields(fields: readonly string[]): string {
  return fields.map((field) => `${field.length}:${field}`).join("");
}

const cap = (text: string, max = PARAGRAPH_CAP) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const chapterList = (numbers: number[]) =>
  numbers.length === 0 ? "none" : numbers.join(", ");

function characterDossier(worldData: WorldData | null | undefined, name: string): string | null {
  const entry = worldData?.characters.find(
    (c) => c.name === name || c.aliases?.includes(name),
  );
  if (!entry) return null;
  const bits = [entry.role, entry.description].filter(Boolean);
  return bits.length ? `${entry.name}: ${bits.join(". ")}` : null;
}

export function buildEvidencePack(input: EvidencePackInput): EvidencePack {
  const { candidate } = input;
  const budget = input.budgetTokens ?? 2000;
  const S = candidate.speaker;
  const E = candidate.entity;

  const speakerPresent: number[] = [];
  const entityExposed: number[] = [];
  let firstExposureChapter: ChapterKnowledgeFacts | null = null;
  for (const ch of input.chapters) {
    if (ch.present.includes(S)) speakerPresent.push(ch.chapterNumber);
    if (ch.exposed.includes(E)) {
      entityExposed.push(ch.chapterNumber);
      if (!firstExposureChapter) firstExposureChapter = ch;
    }
  }

  // Rung 1 — the claim.
  const claimParagraph =
    input.paragraphsByChapterId.get(candidate.chapterId)?.[candidate.paragraphIndex] ?? candidate.sentence;
  const rung1 =
    `CLAIM\n` +
    `In chapter ${candidate.chapterNumber}, ${S} says: “${candidate.sentence}”\n` +
    `Full paragraph: ${cap(claimParagraph)}\n` +
    `The question: could ${S} plausibly know about ${E} at this point in the story?`;

  // Rung 2 — the fact block.
  const overlap = speakerPresent.filter(
    (n) => entityExposed.includes(n) && n < candidate.chapterNumber,
  );
  const rung2 =
    `KNOWN FACTS\n` +
    `${S} is present in chapters: ${chapterList(speakerPresent)}\n` +
    `${E} is named in chapters: ${chapterList(entityExposed)}\n` +
    (overlap.length
      ? `Chapters where ${S} was present while ${E} came up, before the claim: ${chapterList(overlap)}`
      : `Before this claim there is NO chapter where ${S} was present while ${E} came up.`);

  // Rung 3 — the entity dossier.
  const dossierE = characterDossier(input.worldData, E);
  let firstExposureText = "";
  if (firstExposureChapter) {
    const paras = input.paragraphsByChapterId.get(firstExposureChapter.chapterId) ?? [];
    const hit = paras.find((p) => p.includes(E));
    firstExposureText =
      `\nFirst named in chapter ${firstExposureChapter.chapterNumber}` +
      (hit ? `: ${cap(hit)}` : ".");
  }
  const rung3 =
    `WHO ${E.toUpperCase()} IS\n` +
    (dossierE ?? `${E}: no dossier; only what the manuscript shows.`) +
    firstExposureText;

  // Rungs 4–7, droppable from the bottom.
  const dossierS = characterDossier(input.worldData, S);
  const rung4 = dossierS ? `WHO ${S.toUpperCase()} IS\n${dossierS}` : null;

  const events = (input.majorEvents ?? [])
    .filter((e) => e.agent === E || (e.sentence?.includes(E) ?? false))
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
    .slice(0, EVENT_LIMIT);
  const rung5 = events.length
    ? `STORY EVENTS INVOLVING ${E.toUpperCase()}\n` +
      events.map((e) => `ch ${e.chapterNumber}: ${e.sentence ?? e.label}`).join("\n")
    : null;

  const related = (input.related ?? [])
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, RELATED_LIMIT);
  const rung6 = related.length
    ? `RELATED PASSAGES\n` +
      related.map((r) => `ch ${r.chapterNumber}: ${cap(r.text, 420)}`).join("\n")
    : null;

  const rulingLines: string[] = [];
  for (const fact of input.facts) {
    if (fact.how !== "author-asserted" && fact.how !== "reference-implied") continue;
    if (fact.subject !== S && fact.subject !== E && fact.entity !== S && fact.entity !== E) continue;
    rulingLines.push(
      `${fact.subject} knows ${fact.entity} since chapter ${fact.chapterNumber} (${
        fact.how === "author-asserted" ? "the writer confirmed this" : "judged plausible earlier"
      })`,
    );
  }
  const rung7 = rulingLines.length ? `PRIOR RULINGS\n${rulingLines.join("\n")}` : null;

  // Pack top-down under the budget. 1–3 are the claim's minimum honest context.
  const ladder: Array<{ name: string; text: string; always: boolean }> = [
    { name: "claim", text: rung1, always: true },
    { name: "facts", text: rung2, always: true },
    { name: "entity-dossier", text: rung3, always: true },
    ...(rung4 ? [{ name: "speaker-dossier", text: rung4, always: false }] : []),
    ...(rung5 ? [{ name: "events", text: rung5, always: false }] : []),
    ...(rung6 ? [{ name: "related", text: rung6, always: false }] : []),
    ...(rung7 ? [{ name: "rulings", text: rung7, always: false }] : []),
  ];

  const included: string[] = [];
  const parts: string[] = [];
  let spent = 0;
  for (const rung of ladder) {
    const tokens = estimateTokens(rung.text) + 1;
    if (!rung.always && spent + tokens > budget) continue;
    parts.push(rung.text);
    included.push(rung.name);
    spent += tokens;
  }

  const text = parts.join("\n\n");
  return {
    text,
    tokensEstimate: estimateTokens(text),
    rungsIncluded: included,
    packHash: fnv1a(`${PACK_VERSION}|${text}`),
  };
}
