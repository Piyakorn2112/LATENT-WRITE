/**
 * knowledge-store.ts — persistence for the knowledge ledger ("who knows what,
 * and since when"), plus the writer's durable rulings on its findings.
 *
 * Shapes and contract come from plans/knowledge-ledger-and-local-adjudicator.md
 * §4–§5. Storage mirrors annotation-store.ts exactly: desktop → one JSON file
 * at .renderer/knowledge-ledger.json via project state; browser → localStorage.
 *
 * ★ DECISIONS ARE DURABLE. A writer ruling ("they knew already" / "good catch")
 *   is a DECISION, not a score. No rebuild, re-scoring pass, or model upgrade
 *   may resurrect a dismissed candidate; the only thing that reopens a pair is
 *   the anchor text itself changing (see retireDeadAnchors in knowledge-ledger).
 */
import { isDesktopApp, saveProjectState, loadProjectState } from "./project-manager";

const KEY = "glass-editor:knowledge-ledger-v1";

// ── Facts ─────────────────────────────────────────────────────────────────

/** How a character came to know an entity. */
export type KnowledgeChannel =
  | "present"           // subject and entity shared a scene (wide presence)
  | "told"              // entity came up while the subject was in the scene
  | "reference-implied" // adjudicated plausible_offscreen — knowledge assumed
  | "author-asserted";  // the writer ruled "they knew already"

export interface KnowledgeFact {
  subject: string;      // canonical character name
  entity: string;       // canonical entity name (characters only in v1)
  chapterId: string;
  chapterNumber: number;
  how: KnowledgeChannel;
  sentence?: string;    // verbatim anchor for jumps (told / reference-implied)
}

/** Per-chapter derived facts; recomputed whenever the chapter's hash changes. */
export interface ChapterKnowledgeFacts {
  chapterId: string;
  chapterNumber: number;
  contentHash: string;  // `${content.length}|${content.slice(0,60)}` — StoryGraph's recipe
  present: string[];    // WIDE presence: spoke ∪ named in narration
  presentNarrow: string[]; // spoke with usable attribution confidence
  exposed: string[];    // named anywhere in the chapter (incl. inside dialogue)
  references: KnowledgeReference[];
}

/** The grammatical shape of a reference decides how much it claims. */
export type ReferenceRole =
  | "about"                    // "heard of Flint", "about Flint"
  | "possessive"               // "Flint's fist"
  | "subject-of-knowing-verb"  // "I knew Flint"
  | "bare-mention";            // named with no knowing frame

export interface KnowledgeReference {
  speaker: string;
  entity: string;
  paragraphIndex: number;
  sentence: string;            // verbatim (≤ 220 chars) — the re-anchor key
  speakerConfidence: number;
  grammaticalRole: ReferenceRole;
  /** Text-dependent guard flags, computed at extraction while text is in hand. */
  vocative: boolean;           // "Now Joseph, you know…" — talking TO, not about
  addressee: boolean;          // narration marks the entity as the person spoken to
}

// ── Candidates & rulings ──────────────────────────────────────────────────

export type CandidateStatus = "pending" | "adjudicated" | "retired";

export interface AdjudicationVerdict {
  verdict: "break" | "plausible_offscreen" | "unsure";
  confidence: number;          // 0..1
  reason: string;              // one sentence, shown verbatim in the popover
  citedChapter: number | null;
}

export interface KnowledgeCandidate {
  key: string;                 // `${subject}→${entity}`, book-scoped
  speaker: string;
  entity: string;
  chapterId: string;
  chapterNumber: number;
  paragraphIndex: number;
  sentence: string;
  band: "normal" | "low";      // bare-mention references are demoted, never promoted
  status: CandidateStatus;
  verdict?: AdjudicationVerdict;
  verdictKey?: string;         // sha of candidateKey|packHash|modelId|promptVersion
}

export interface WriterDecision {
  key: string;
  ruling: "knew-already" | "good-catch";
  timestamp: number;
  /** The sentence the ruling was made against — a materially different
   *  sentence for the same pair is a NEW question. */
  sentence: string;
}

export interface KnowledgeLedgerStore {
  version: 1;
  chapters: Record<string, ChapterKnowledgeFacts>;
  facts: KnowledgeFact[];
  candidates: KnowledgeCandidate[];
  decisions: Record<string, WriterDecision>;
}

// ── Storage (annotation-store contract) ───────────────────────────────────

export function emptyKnowledgeLedger(): KnowledgeLedgerStore {
  return { version: 1, chapters: {}, facts: [], candidates: [], decisions: {} };
}

function valid(store: KnowledgeLedgerStore | null | undefined): store is KnowledgeLedgerStore {
  return !!store && store.version === 1 && !!store.chapters &&
    Array.isArray(store.facts) && Array.isArray(store.candidates) && !!store.decisions;
}

export function loadKnowledgeLedger(): KnowledgeLedgerStore {
  if (isDesktopApp()) return emptyKnowledgeLedger();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyKnowledgeLedger();
    const parsed = JSON.parse(raw) as KnowledgeLedgerStore;
    return valid(parsed) ? parsed : emptyKnowledgeLedger();
  } catch {
    return emptyKnowledgeLedger();
  }
}

export async function loadKnowledgeLedgerFromProject(): Promise<KnowledgeLedgerStore | null> {
  const data = await loadProjectState<KnowledgeLedgerStore>("knowledge-ledger");
  return valid(data) ? data : null;
}

export function saveKnowledgeLedger(store: KnowledgeLedgerStore): void {
  if (isDesktopApp()) { saveProjectState("knowledge-ledger", store); return; }
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* quota — silently ignore */
  }
}

/** Record a writer ruling. Durable: see the header note. */
export function addDecision(
  store: KnowledgeLedgerStore,
  decision: WriterDecision,
): KnowledgeLedgerStore {
  return { ...store, decisions: { ...store.decisions, [decision.key]: decision } };
}
