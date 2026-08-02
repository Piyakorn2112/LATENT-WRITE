/**
 * knowledge-ledger.ts — pure derivation of "who knows what, and since when",
 * and of the candidates where a character references someone the story never
 * gave them a way to know.
 *
 * Everything here is a pure function over analysis results the app already
 * computes (speech segments, paragraph text, character names). No worker
 * changes, no new NLP passes. Design and measured rationale:
 * plans/knowledge-ledger-and-local-adjudicator.md §4–§5.
 *
 * ★★ THE GUARDS COME FROM A MEASURED FUNNEL, NOT TASTE. The probe
 *    (scripts/probe-knowledge-ledger.ts, 7 books / 1049 pairs) found raw
 *    precision ≈ 1-in-8 with three deterministic failure classes:
 *      1. attribution errors → attested-confidence floor + addressee guards
 *      2. entity-type confusion → characters-only pools (caller's contract)
 *      3. vocatives → vocative + grammatical-role classification
 *    The fourth class (legitimate offscreen knowledge) is NOT deterministic;
 *    it belongs to the adjudicator. Do not try to regex it away here.
 *
 * ★ PRESENCE IS WIDE, AND WIDENING ONLY SUPPRESSES. "Present" = spoke with
 *   usable confidence ∪ named in NARRATION (stripQuotes'd text). Being named
 *   inside someone else's dialogue is exposure, not presence — treating it as
 *   presence would silently excuse real breaks. A candidate can only ever be
 *   killed by widening, never created, which the harness asserts.
 *
 * ★ A REFERENCE CANNOT SUPPORT ITSELF. Support for a pair is facts from
 *   STRICTLY PRIOR chapters, plus same-chapter presence of the entity (they
 *   are meeting on the page right now). Same-chapter EXPOSURE must not count:
 *   the reference under test is itself exposure, and counting it would erase
 *   every candidate by construction.
 */
import { stripQuotes } from "./prose-segments";
import { isCommonWordName } from "./action-detect";
import type { ChapterParaResult } from "./speech-detect";
import type {
  ChapterKnowledgeFacts,
  KnowledgeCandidate,
  KnowledgeFact,
  KnowledgeLedgerStore,
  KnowledgeReference,
  ReferenceRole,
  WriterDecision,
} from "./knowledge-store";

/** Attribution below this cannot carry a knowledge claim (speech-detect's ATTESTED_FLOOR). */
export const REFERENCE_CONFIDENCE_FLOOR = 0.78;
/** Presence needs less: a wrong-but-confident speaker is still SOMEBODY in the room. */
const PRESENCE_CONFIDENCE_FLOOR = 0.65;
const SENTENCE_ANCHOR_MAX = 220;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TITLE = "(?:mr|mrs|miss|ms|dr|st|sir|lady|lord|captain|colonel|count|old|young|poor)";

/** Same cheap recipe StoryGraph uses; shared so staleness checks agree. */
export function knowledgeContentHash(content: string): string {
  return `${content.length}|${content.slice(0, 60)}`;
}

// ── Reference shape classification (guard class 3) ────────────────────────

const VOCATIVE_LEAD =
  "oh|well|yes|no|now|come|listen|look|please|why|ah|hush|indeed|nay|so|but|and|good\\s+\\w+|my\\s+dear|dear|thank\\s+you";

/** "Now Joseph, you know the case" — talking TO someone, not about them. */
export function isVocative(quote: string, entity: string): boolean {
  const e = esc(entity);
  return new RegExp(
    `(?:^["'“”‘’\\s]*|[,;:!?]|\\b(?:${VOCATIVE_LEAD}))\\s*` +
    `(?:${TITLE})?\\.?\\s*${e}\\b\\s*[,.!?;:—-]`,
    "i",
  ).test(quote);
}

/** Narration marks the entity as the person being spoken to. */
export function isAddressee(narration: string, entity: string): boolean {
  const e = esc(entity);
  return new RegExp(
    `\\b(?:to|told|asked|begged|assured|warned|reminded|thanked|greeted|addressed|answered|informed|whispered\\s+to|turned\\s+to|turning\\s+to)\\s+` +
    `(?:${TITLE})?\\.?\\s*${e}\\b`,
    "i",
  ).test(narration);
}

const KNOWING_VERBS =
  "know|knew|known|knows|met|meets|remember|remembers|remembered|recognise[ds]?|recognize[ds]?|heard|seen|saw|trusts?|trusted|fears?|feared|hates?|hated|loves?|loved|serves?|served|owes?|owed|betray(?:s|ed)?";

/** How much does this reference actually claim? Bare mentions claim least. */
export function classifyReferenceRole(quote: string, entity: string): ReferenceRole {
  const e = esc(entity);
  if (new RegExp(`\\b${e}(?:['’]s|s['’])`, "i").test(quote)) return "possessive";
  if (new RegExp(`\\b(?:about|of|from|concerning|against|after)\\s+(?:(?:${TITLE})\\.?\\s+)?${e}\\b`, "i").test(quote)) {
    return "about";
  }
  if (new RegExp(`\\b(?:${KNOWING_VERBS})\\b[^.!?;]{0,40}?\\b${e}\\b`, "i").test(quote)) {
    return "subject-of-knowing-verb";
  }
  return "bare-mention";
}

// ── L1: per-chapter fact extraction ───────────────────────────────────────

export interface ChapterFactsInput {
  chapterId: string;
  chapterNumber: number;
  content: string;
  paragraphs: string[];
  speechResults: ChapterParaResult[];
  /** Canonical CHARACTER names only (guard class 2 lives in this contract). */
  characterNames: readonly string[];
  aliasCanon?: ReadonlyMap<string, string>;
  /** Corpus for the common-word name test. Chapter-scoped counts are too
   *  noisy ("Let me see" chapters read "Let" as a name); pass the whole
   *  book's text when available. Defaults to the chapter content. */
  nameFilterText?: string;
}

export function buildChapterKnowledgeFacts(input: ChapterFactsInput): ChapterKnowledgeFacts {
  const canon = (name: string) => input.aliasCanon?.get(name) ?? name;
  // ★ CASE-SENSITIVE, and never inside a contraction. A case-blind \bDon\b
  //   matches "Don't" and a pool leak like "Try" matches sentence-initial
  //   "Try not to die" — both produced junk candidates in the first harness
  //   run. Proper names are capitalised in prose; match them as written, and
  //   drop pool entries that read as common words in this chapter
  //   (knownNames pool ≠ character list — the standing lesson).
  const nameFilterText = input.nameFilterText ?? input.content;
  const patterns = input.characterNames
    .filter((name) => !isCommonWordName(name, nameFilterText))
    .map((name) => ({
      name: canon(name),
      re: new RegExp(`\\b${esc(name)}\\b(?!['’])`),
    }));

  const exposed = new Set<string>();
  for (const { name, re } of patterns) if (re.test(input.content)) exposed.add(name);

  const presentNarrow = new Set<string>();
  const present = new Set<string>();
  const references: KnowledgeReference[] = [];

  input.speechResults.forEach((result, paragraphIndex) => {
    const paragraph = input.paragraphs[paragraphIndex] ?? "";
    const narration = stripQuotes(paragraph);
    for (const { name, re } of patterns) if (re.test(narration)) present.add(name);

    for (const seg of result.segments) {
      if (seg.type !== "speech" || !seg.speaker) continue;
      const speaker = canon(seg.speaker);
      if (seg.confidence >= PRESENCE_CONFIDENCE_FLOOR) {
        presentNarrow.add(speaker);
        present.add(speaker);
      }
      const quote = paragraph.slice(seg.start, seg.end);
      for (const { name, re } of patterns) {
        if (name === speaker) continue; // naming yourself is not a reference
        if (!re.test(quote)) continue;
        references.push({
          speaker,
          entity: name,
          paragraphIndex,
          sentence: quote.trim().slice(0, SENTENCE_ANCHOR_MAX),
          speakerConfidence: seg.confidence,
          grammaticalRole: classifyReferenceRole(quote, name),
          vocative: isVocative(quote, name),
          addressee: isAddressee(narration, name),
        });
      }
    }
  });

  return {
    chapterId: input.chapterId,
    chapterNumber: input.chapterNumber,
    contentHash: knowledgeContentHash(input.content),
    present: [...present].sort(),
    presentNarrow: [...presentNarrow].sort(),
    exposed: [...exposed].sort(),
    references,
  };
}

// ── L2: ledger + guarded candidate generation ─────────────────────────────

export const candidateKey = (speaker: string, entity: string) => `${speaker}→${entity}`;

/** Every stage a pair can die at. Counted, never hypothesised. */
export interface LedgerFunnel {
  pairs: number;
  supportedPrior: number;      // a prior-chapter fact already explains it
  meetingNow: number;          // entity is present in the reference's own chapter
  droppedConfidence: number;
  droppedVocative: number;
  droppedAddressee: number;
  droppedFirstChapter: number; // entity is page-one cast, not a mid-book secret
  decided: number;             // writer already ruled on the pair
  survivors: number;
  lowBand: number;             // bare-mention survivors, demoted
}

export interface LedgerBuildResult {
  facts: KnowledgeFact[];
  candidates: KnowledgeCandidate[];
  funnel: LedgerFunnel;
}

export interface LedgerBuildOptions {
  confidenceFloor?: number;
  /** Author-asserted / adjudicated facts carried in the store — merged as support. */
  extraFacts?: readonly KnowledgeFact[];
  decisions?: Record<string, WriterDecision>;
}

/**
 * Build the cross-chapter ledger from per-chapter facts (in reading order).
 * Facts record the FIRST time each pair gains a channel; candidates are first
 * references with no support and no guard hit.
 */
export function buildLedger(
  chapters: readonly ChapterKnowledgeFacts[],
  options: LedgerBuildOptions = {},
): LedgerBuildResult {
  const floor = options.confidenceFloor ?? REFERENCE_CONFIDENCE_FLOOR;
  const decisions = options.decisions ?? {};

  const firstExposure = new Map<string, number>();
  chapters.forEach((ch, ci) => {
    for (const name of ch.exposed) if (!firstExposure.has(name)) firstExposure.set(name, ci);
  });

  // Derived facts: earliest channel per (subject, entity).
  const facts: KnowledgeFact[] = [];
  const factIndex = new Map<string, number>(); // pair key → chapter index of first fact
  const noteFact = (key: string, ci: number, fact: KnowledgeFact) => {
    const prior = factIndex.get(key);
    if (prior !== undefined && prior <= ci) return;
    factIndex.set(key, ci);
    facts.push(fact);
  };

  chapters.forEach((ch, ci) => {
    const wide = new Set(ch.present);
    for (const subject of wide) {
      for (const entity of ch.exposed) {
        if (entity === subject) continue;
        noteFact(candidateKey(subject, entity), ci, {
          subject,
          entity,
          chapterId: ch.chapterId,
          chapterNumber: ch.chapterNumber,
          how: wide.has(entity) ? "present" : "told",
        });
      }
    }
  });

  for (const extra of options.extraFacts ?? []) {
    const ci = chapters.findIndex((ch) => ch.chapterId === extra.chapterId);
    noteFact(candidateKey(extra.subject, extra.entity), ci === -1 ? 0 : ci, extra);
  }

  const funnel: LedgerFunnel = {
    pairs: 0, supportedPrior: 0, meetingNow: 0, droppedConfidence: 0,
    droppedVocative: 0, droppedAddressee: 0, droppedFirstChapter: 0,
    decided: 0, survivors: 0, lowBand: 0,
  };
  const candidates: KnowledgeCandidate[] = [];
  const seenPair = new Set<string>();

  chapters.forEach((ch, ci) => {
    const presentHere = new Set(ch.present);
    for (const ref of ch.references) {
      const key = candidateKey(ref.speaker, ref.entity);
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      funnel.pairs++;

      const supportCi = factIndex.get(key);
      if (supportCi !== undefined && supportCi < ci) { funnel.supportedPrior++; continue; }
      if (presentHere.has(ref.entity)) { funnel.meetingNow++; continue; }
      if (ref.speakerConfidence < floor) { funnel.droppedConfidence++; continue; }
      if (ref.vocative) { funnel.droppedVocative++; continue; }
      if (ref.addressee) { funnel.droppedAddressee++; continue; }
      if ((firstExposure.get(ref.entity) ?? 0) === 0) { funnel.droppedFirstChapter++; continue; }

      const decision = decisions[key];
      if (decision && decision.sentence === ref.sentence) {
        funnel.decided++;
        if (decision.ruling === "knew-already") continue; // settled canon, forever
      }

      const band = ref.grammaticalRole === "bare-mention" ? "low" : "normal";
      if (band === "low") funnel.lowBand++;
      funnel.survivors++;
      candidates.push({
        key,
        speaker: ref.speaker,
        entity: ref.entity,
        chapterId: ch.chapterId,
        chapterNumber: ch.chapterNumber,
        paragraphIndex: ref.paragraphIndex,
        sentence: ref.sentence,
        band,
        status: "pending",
      });
    }
  });

  return { facts, candidates, funnel };
}

// ── Anchors & selectors ───────────────────────────────────────────────────

/**
 * Retire candidates whose verbatim anchor no longer exists in the chapter.
 * The writer edited the line; the question no longer exists as asked.
 */
export function retireDeadAnchors(
  store: KnowledgeLedgerStore,
  contentByChapterId: ReadonlyMap<string, string>,
): KnowledgeLedgerStore {
  let changed = false;
  const candidates = store.candidates.map((c) => {
    if (c.status === "retired") return c;
    const content = contentByChapterId.get(c.chapterId);
    if (content !== undefined && !content.includes(c.sentence)) {
      changed = true;
      return { ...c, status: "retired" as const };
    }
    return c;
  });
  return changed ? { ...store, candidates } : store;
}

/** Per-character acquisition timeline — the story timeline's knowledge lens. */
export interface KnowledgeTrack {
  subject: string;
  acquisitions: Array<Pick<KnowledgeFact, "entity" | "chapterId" | "chapterNumber" | "how">>;
}

export function buildKnowledgeTracks(facts: readonly KnowledgeFact[]): KnowledgeTrack[] {
  const bySubject = new Map<string, KnowledgeTrack>();
  for (const fact of facts) {
    let track = bySubject.get(fact.subject);
    if (!track) { track = { subject: fact.subject, acquisitions: [] }; bySubject.set(fact.subject, track); }
    track.acquisitions.push({
      entity: fact.entity, chapterId: fact.chapterId,
      chapterNumber: fact.chapterNumber, how: fact.how,
    });
  }
  const tracks = [...bySubject.values()];
  for (const t of tracks) t.acquisitions.sort((a, b) => a.chapterNumber - b.chapterNumber);
  tracks.sort((a, b) => b.acquisitions.length - a.acquisitions.length);
  return tracks;
}
