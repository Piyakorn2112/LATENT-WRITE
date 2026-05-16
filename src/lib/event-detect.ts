/**
 * Event detection engine — calibrated for literary prose (Hollow Iris / Root Crown).
 *
 * Key design: the semantic dictionaries cover FOUR prose registers:
 *   1. Action fiction (physical confrontation, flight, loss)
 *   2. Intellectual/political fiction (Hollow Iris) — governance, philosophy, public address
 *   3. Psychological/intimate fiction — internal revelation, quiet emotional turning points
 *   4. Rural/sensory fiction (Root Crown) — absence-sensing, ritual, natural consequence
 *
 * The INTELLECTUAL_DISCOURSE dictionary is the critical addition — without it, all
 * Hollow Iris events score 0.0 (the existing dicts only catch action verbs).
 *
 * Scene transition weight is conditional: 2.0 only when NO other signal is present.
 * With any dramatic content, transition drops to 0.3 (a background marker, not an event).
 */

import type { WorldData } from "../types";
import type { ChapterAnalysisResult } from "./use-analysis";

export interface MajorEvent {
  label: string;
  type: "climax" | "transition" | "introduction" | "confrontation" | "revelation" | "scene-break";
  tensionPosition: number;
  confidence: number;
}

// ─── Semantic field dictionaries ──────────────────────────────────────────────

const CONFRONTATION: Record<string, number> = {
  // Physical conflict
  "attacked": 1, "struck": 1, "slapped": 1, "grabbed": 1, "shoved": 1,
  "seized": 1, "slammed": 1, "threw": 1, "kicked": 1, "stabbed": 1,
  "shot": 1, "punched": 1, "screamed": 1, "shouted": 1,
  "accused": 1, "threatened": 1, "demanded": 1, "confronted": 1, "challenged": 1,
  "betrayed": 1, "exposed": 1, "lied": 1, "denied": 1, "refused": 1,
  // Verbal / ideological confrontation (critical for Hollow Iris)
  "argued": 0.9, "insisted": 0.9, "rejected": 0.9, "countered": 0.9,
  "pushed back": 0.85, "would not accept": 0.9, "could not accept": 0.85,
  "stood her ground": 0.8, "made clear": 0.8, "said directly": 0.8,
  "the confrontation": 0.8, "ideological": 0.7, "in direct opposition": 0.85,
  "your interpretation": 0.75, "my interpretation": 0.75,
  "the point is": 0.6, "that is not": 0.65, "this is not": 0.65,
  // Escalation
  "glared": 0.75, "stormed": 0.75, "raised her voice": 0.75,
  "cornered": 0.75, "fought": 0.75, "struggled": 0.75, "fled": 0.75,
  "how dare": 0.75, "you lied": 0.75, "you knew": 0.75,
  // Implied
  "tension": 0.45, "disagreed": 0.45, "interrupted": 0.45, "silence fell": 0.45,
};

const REVELATION: Record<string, number> = {
  // Intellectual realization (Hollow Iris)
  "without awareness": 1.0, "without any awareness": 1.0, "without their awareness": 0.95,
  "without knowing": 0.95, "had not known": 0.95,
  "could not explain": 0.9, "made visible": 0.9, "is erasure": 1.0,
  "the why": 0.95, "the reasoning behind": 0.85, "is not sufficient": 0.9,
  "is not enough": 0.85, "the limitation": 0.75, "the insufficiency": 0.8,
  "both things were true": 1.0, "the fact of it": 0.85, "made real": 0.8,
  "the record is not": 0.85, "the documentation cannot": 0.85,
  "the compression": 0.75, "the erasure": 0.85, "what is lost": 0.9,
  "cannot erase": 0.85, "the minimum": 0.8,
  // Classic revelation
  "realized": 1, "understood": 1, "discovered": 1, "recognized": 1,
  "found out": 1, "learned": 1, "finally knew": 1, "truth was": 1,
  "the truth": 0.9, "had been hiding": 1, "had lied": 1,
  "all along": 0.9, "never told": 1, "had known": 0.9, "confessed": 1,
  "admitted": 0.85, "revealed": 1, "uncovered": 1,
  "suddenly understood": 0.8, "it hit her": 0.8, "it dawned": 0.8,
  "changed everything": 0.75, "made sense now": 0.75,
  // Root Crown (absence-sensing, Network events)
  "tonight there was nothing": 1.0, "felt for it": 0.85, "nothing came back": 1.0,
  "the warmth was absent": 0.9, "the quality of attended": 0.9,
  "felt the silence": 0.8, "the connection was": 0.75, "the network": 0.7,
};

// Intellectual / philosophical discourse — the Hollow Iris register
const INTELLECTUAL_DISCOURSE: Record<string, number> = {
  // Public address / declaration
  "i am asking": 1.0, "i want to tell you": 0.95, "from the platform": 0.85,
  "addressed the": 0.8, "spoke publicly": 0.85, "in their own name": 0.9,
  "the speech": 0.8, "the argument is": 0.85, "the right to": 0.85,
  // Governance / institutional crisis
  "the governance decision": 1.0, "the decision was made": 0.95,
  "was made without": 1.0, "governance function": 0.8, "the institutional": 0.7,
  "the documentation": 0.75, "the record": 0.7, "accountability": 0.75,
  "the compression": 0.8, "the reasoning": 0.75, "the function is": 0.7,
  "without reasoning": 0.85, "the governance": 0.7,
  // Ethical weight / cost-of-decision language
  "the cost of": 0.8, "the weight of the decision": 0.9,
  "paid for the decision": 1.0, "who paid": 0.9, "who would pay": 0.9,
  "the minimum we owe": 1.0, "we owe": 0.8, "we have been accepting": 0.9,
  // Philosophical statement patterns
  "the thing it needed to be": 1.0, "the thing only": 0.85,
  "this was the": 0.6, "the distinction": 0.75, "the difference": 0.65,
  "is the journalism": 0.8, "is not the journalism": 0.85,
  "makes the": 0.5, "the frame": 0.65, "the function": 0.6,
  // Personal reckoning / declaration
  "i held": 0.85, "i know her name": 1.0, "i know the names": 0.9,
  "i could not": 0.75, "i did not know": 0.75,
  "the documentation is not sufficient": 1.0, "not sufficient": 0.8,
  // Hollow Iris: lattice / fragment language
  "the fragment": 0.7, "the lattice": 0.7, "governance consciousness": 0.8,
  "the analytical capacity": 0.75, "the distributed consciousness": 0.8,
  "the narrowed": 0.7, "bandwidth drain": 0.75,
};

const EMOTIONAL_PEAK: Record<string, number> = {
  // Physical emotion
  "heart": 0.6, "throat tightened": 0.9, "eyes filled": 0.9, "couldn't breathe": 1,
  "tears": 0.75, "wept": 0.9, "sobbed": 1, "shaking": 0.8, "trembling": 0.8,
  "grief": 0.8, "despair": 0.85, "rage": 0.85, "terror": 0.9, "horror": 0.9,
  "couldn't move": 0.75, "couldn't speak": 0.75,
  // Quiet emotional weight (literary register)
  "the warmth of the body": 0.85, "both present": 0.85, "both watching": 0.8,
  "the ambient heat": 0.7, "the amber held": 0.9, "in the amber": 0.8,
  "the three seconds": 0.85, "their eyes met": 0.8,
  "let the response be what it was": 0.9, "did not perform": 0.75,
  "the domestic practice": 0.7, "the speech is yours": 1.0,
  "was enough": 0.8, "had been enough": 0.85,
  // Root Crown
  "the valley took": 0.7, "the quality of the house": 0.8,
  "his absence in it": 0.85, "the full-body hug": 0.8,
  "you're going to outlive": 1.0, "speak to it carefully": 1.0,
};

const INTIMACY: Record<string, number> = {
  "kissed": 1, "held": 0.7, "embraced": 0.9, "touched": 0.65, "pressed": 0.6,
  "reached for": 0.65, "didn't let go": 0.85, "pulled close": 0.85,
  "stayed": 0.5, "together": 0.45, "warmth": 0.6, "hand in hand": 0.85,
  "forehead": 0.7, "looked at each other": 0.7,
  // Quiet intimacy (literary)
  "close enough to": 0.7, "beside her": 0.5, "sat beside": 0.65,
  "the cup beside her": 0.8, "both hands": 0.7, "making tea": 0.6,
  "the domestic": 0.6, "the person who loved": 0.9,
};

const LOSS_ENDING: Record<string, number> = {
  "walked away": 0.9, "turned away": 0.85, "left": 0.55, "gone": 0.7,
  "never came back": 1, "would never": 0.75, "goodbye": 0.85,
  "finished": 0.55, "over": 0.6, "silence stretched": 0.8,
  "door closed": 0.8, "last time": 0.85, "final": 0.7,
  "died": 1, "death": 0.9, "dead": 0.9, "buried": 0.85, "funeral": 0.9,
  // Quiet loss / departure
  "the speech done": 0.85, "now dispersed": 0.75, "carrying what they had received": 0.8,
  "the draft in the private pages": 0.8, "now the past": 0.85,
  "frail this year": 0.8, "in stages": 0.7, "a smaller version": 0.75,
};

const SCENE_TRANSITIONS: Set<string> = new Set([
  "the next morning", "the next day", "the next week", "the following morning",
  "hours later", "days later", "weeks later", "months later", "years later",
  "that evening", "that night", "that afternoon", "that morning",
  "by the time", "when she arrived", "when he arrived", "when they arrived",
  "later that", "some time", "sometime", "after a week", "after a month",
  "three days", "two weeks", "a month later", "a year later",
  "the morning", "at dawn", "at dusk", "by nightfall", "by morning",
  "spring came", "summer ended", "winter", "autumn",
]);

const DRAMATIC_PUNCT  = /[!?]|—|\.{3}|…/g;
const QUOTE_RE        = /["""']/;
const UPPER_SENT_RE   = /[.!?]\s+[A-Z]/g;
const RHETORICAL_RE   = /\bwhy\b|\bhow could\b|\bwhat if\b|\bwhat happened\b/i;

const STOPWORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with",
  "was","were","is","are","be","been","being","have","has","had","do","did",
  "will","would","could","should","may","might","shall","can","it","its",
  "this","that","these","those","there","here","when","where","which","who",
  "what","how","why","all","any","both","each","few","more","most","other",
  "some","such","no","not","only","own","same","so","than","too","very",
  "just","because","as","until","while","although","though","if","after",
  "before","since","during","about","into","through","between","him","her",
]);

// ─── Pass 1: Vocabulary profile ────────────────────────────────────────────────

function buildVocabProfile(paragraphs: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const p of paragraphs) {
    const words = p.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? [];
    for (const w of words) {
      if (!STOPWORDS.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  return freq;
}

function salienceScore(text: string, globalFreq: Map<string, number>): number {
  const words = text.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? [];
  if (!words.length) return 0;
  let score = 0;
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    const f = globalFreq.get(w) ?? 0;
    if (f <= 2) score += 1.0 - f * 0.3;
    else if (f <= 4) score += 0.3;
  }
  return Math.min(1, score / Math.max(1, words.length * 0.3));
}

// ─── Pass 2: Paragraph scoring ────────────────────────────────────────────────

interface ParaScore {
  idx: number;
  text: string;
  total: number;
  dominantType: MajorEvent["type"];
  entityCount: number;
  transitionScore: number;
}

function scoreVocab(lower: string, dict: Record<string, number>): number {
  let score = 0;
  for (const [phrase, weight] of Object.entries(dict)) {
    if (lower.includes(phrase)) score += weight;
  }
  return Math.min(1, score);
}

function scoreParagraph(
  text: string,
  idx: number,
  _paraCount: number,
  nameRe: RegExp | null,
  globalFreq: Map<string, number>,
): ParaScore {
  const lower = text.toLowerCase();

  // Semantic fields
  const confrontScore  = scoreVocab(lower, CONFRONTATION);
  const revelScore     = scoreVocab(lower, REVELATION);
  const emoScore       = scoreVocab(lower, EMOTIONAL_PEAK);
  const intimScore     = scoreVocab(lower, INTIMACY);
  const lossScore      = scoreVocab(lower, LOSS_ENDING);
  const intellectScore = scoreVocab(lower, INTELLECTUAL_DISCOURSE);

  // Named entity density
  const nameMatches  = nameRe ? (text.match(nameRe) ?? []) : [];
  const entityCount  = new Set(nameMatches.map(m => m.toLowerCase())).size;
  const entityScore  = Math.min(1, entityCount * 0.35);

  // Dramatic punctuation
  const dramaticCount = (text.match(DRAMATIC_PUNCT) ?? []).length;
  const words         = text.split(/\s+/).length;
  const dramaticScore = Math.min(1, (dramaticCount / Math.max(1, words)) * 12);

  // Sentence rhythm (high variance = dramatic delivery)
  const sentences  = text.split(UPPER_SENT_RE).filter(s => s.trim().length > 8);
  const lens       = sentences.map(s => s.split(/\s+/).length);
  const avgLen     = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const variance   = lens.length > 1
    ? Math.sqrt(lens.reduce((s, l) => s + (l - avgLen) ** 2, 0) / lens.length)
    : 0;
  const rhythmScore = Math.min(1, variance / 8);

  // Vocabulary salience
  const salience = salienceScore(text, globalFreq);

  // Dialogue quality
  const hasDialogue    = QUOTE_RE.test(text);
  const isRhetorical   = RHETORICAL_RE.test(text);
  const dialogueScore  = hasDialogue ? 0.2 + (isRhetorical ? 0.3 : 0) : 0;

  // Scene transition marker
  let transitionScore = 0;
  for (const marker of SCENE_TRANSITIONS) {
    if (lower.includes(marker)) { transitionScore = 1; break; }
  }

  // How much dramatic / intellectual content is present?
  const dramaticContent = confrontScore + revelScore + emoScore + intellectScore + lossScore;

  // Scene transition score: dominates ONLY when nothing else is happening.
  // When a chapter has both a temporal marker AND significant content,
  // the transition is just a scene separator — not the narrative event.
  const transitionWeight = transitionScore > 0
    ? (dramaticContent < 0.35 ? 2.0 : 0.3)
    : 0;

  const total = (
    confrontScore   * 1.2 +
    revelScore      * 1.0 +
    emoScore        * 0.9 +
    lossScore       * 0.9 +
    intimScore      * 0.7 +
    intellectScore  * 1.1 +   // Hollow Iris / political prose
    entityScore     * 0.8 +
    dramaticScore   * 0.7 +
    rhythmScore     * 0.5 +
    salience        * 0.6 +
    dialogueScore   * 0.5 +
    transitionWeight
  );

  // Determine dominant event type — dramatic content beats transition
  let dominantType: MajorEvent["type"] = "confrontation";
  if (transitionScore > 0 && dramaticContent < 0.35) {
    // Pure transition: no meaningful dramatic content
    dominantType = "transition";
  } else if (lossScore > 0.5 && lossScore >= confrontScore && lossScore >= intellectScore) {
    dominantType = "scene-break";
  } else if (revelScore > confrontScore && revelScore >= intellectScore && revelScore > emoScore) {
    dominantType = "revelation";
  } else if (intellectScore > 0.5 && intellectScore >= confrontScore && intellectScore >= emoScore) {
    // Intellectual/philosophical event — classify by content nuance
    dominantType = confrontScore >= 0.3 ? "confrontation" : "revelation";
  } else if (emoScore > 0.5 && entityCount === 0) {
    dominantType = "climax";
  } else if (confrontScore >= 0.4) {
    dominantType = "confrontation";
  }

  return { idx, text, total, dominantType, entityCount, transitionScore };
}

// ─── Pass 3: Cluster ──────────────────────────────────────────────────────────

// 0.75 — catches literary prose with moderate intellectual content.
// Note: the transition condition was removed; pure transitions score ~2.0 and
// pass this threshold naturally. The dominantType logic handles classification.
const SCORE_THRESHOLD = 0.75;

function clusterScores(scores: ParaScore[]): ParaScore[][] {
  const clusters: ParaScore[][] = [];
  let cur: ParaScore[] = [];
  for (const s of scores) {
    if (s.total >= SCORE_THRESHOLD) {
      cur.push(s);
    } else if (cur.length > 0) {
      clusters.push(cur);
      cur = [];
    }
  }
  if (cur.length) clusters.push(cur);
  return clusters
    .map(c => ({ c, peak: Math.max(...c.map(p => p.total)) }))
    .sort((a, b) => b.peak - a.peak)
    .slice(0, 3)
    .map(({ c }) => c);
}

// ─── Pass 4: Label generation ─────────────────────────────────────────────────

// Intellectual declaration patterns (highest priority for literary prose)
const DECLARATION_PATTERNS: RegExp[] = [
  // First-person declarations
  /\bI (?:am asking|want to tell you|held|know the names?|could not|did not know|have been)\b(.{0,55})/i,
  // Governance/institutional revelation: "The X was made without Y"
  /\bThe (?:governance |institutional |)decision (?:was |had been |)(?:made |)[a-z ]+ (?:without|without any)\b(.{0,40})/i,
  // Philosophical conclusions: "The X is/was Y"
  /\bThe (?:documentation|record|governance|decision|speech|right|why|function|truth|compression|argument|minimum|cost) (?:is not?|was not?|cannot|requires|makes|is the|was the)\b(.{0,55})/i,
  // Aphorism pattern: "X is Y. Y is X." (Root Crown: "Managing doesn't ask.")
  /\b(?:managing|governing|the record|the documentation|the function|the saying|the speech|documenting|asking) (?:is |was |doesn't |does not )\b(.{0,45})/i,
  // "X is not sufficient / is not enough"
  /\b\w+(?:\s+\w+)? (?:is not sufficient|is not enough|are not sufficient|are not enough|cannot suffice)\b/i,
];

const SVO_PATTERNS: RegExp[] = [
  // Subject + active verb + object (standard / simple prepositional object)
  /\b(?:she|he|they|[A-Z][a-z]+)\b\s+(?!(?:is|was|were|are|am|be|been|being|has|had|have)\b)(?:[a-z]+ed|[a-z]+s|[a-z]+ing)\s+(?:(?:at|to|into|through|across|over|under|from|with|without|against|around|toward|towards)\s+)?(?!(?:on|of|in|to|for|with|without|from|by|at|as|than|that|which|who|whose|and|or|but|him|her|them|it)\b)(?:the\s+|a\s+|an\s+)?[a-z]+(?:\s[a-z]+){0,2}/,
];

const QUOTED_SPEECH_RE = /(?:^|[\s([{])["“]([^"“”]{8,60})["”]/;

function truncateLabelText(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  const cut = normalized.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const clipped = lastSpace > Math.max(12, Math.floor(max * 0.55))
    ? cut.slice(0, lastSpace)
    : cut;
  return `${clipped.trimEnd()}…`;
}

function extractLabel(text: string): string {
  // 1. Prefer a quoted speech snippet that isn't too long (ideally a declaration)
  const quoteMatch = text.match(QUOTED_SPEECH_RE);
  if (quoteMatch) {
    const q = quoteMatch[1].trim();
    if (q.length >= 6) return `"${truncateLabelText(q, 42)}"`;
  }

  // 2. Try intellectual declaration patterns (Hollow Iris / literary prose)
  for (const re of DECLARATION_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const phrase = m[0].replace(/\s+/g, " ").trim();
      if (phrase.length >= 8 && phrase.length <= 54) return capitalize(phrase);
      if (phrase.length > 54) return capitalize(truncateLabelText(phrase, 50));
    }
  }

  // 3. Try SVO pattern
  for (const re of SVO_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const phrase = m[0].replace(/\s+/g, " ").trim();
      if (/\b(?:and|or|but|of|to|for|with|without|from|by|at|in|on|the|a|an|one|more|than|had|has|have)\b$/i.test(phrase)) continue;
      if (phrase.length >= 8 && phrase.length <= 52) return capitalize(phrase);
    }
  }

  // 4. Best sentence: prefer sentences with intellectual/declaration keywords,
  // then complete sentences 20-60 chars, then first sentence.
  const sentences = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 10);
  const KEY_DECL  = /\b(?:I (?:am|held|know|want|could)|without|the why|not sufficient|governance|decision|record|truth|managing|governing|the speech|both things)\b/i;
  const preferredSent =
    sentences.find(s => s.length >= 15 && s.length <= 70 && KEY_DECL.test(s)) ??
    sentences.find(s => s.length >= 20 && s.length <= 65) ??
    sentences[0];
  const sentence = (preferredSent ?? text).replace(/^["""']+/, "").replace(/\s+/g, " ").trim();

  if (sentence.length <= 52) return capitalize(sentence);
  return capitalize(truncateLabelText(sentence, 48));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function detectMajorEvents(
  chapter: { content: string; number: number },
  result: ChapterAnalysisResult,
  worldData: WorldData | undefined,
): MajorEvent[] {
  const paragraphs = result.paragraphs.length > 0
    ? result.paragraphs
    : chapter.content.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);

  if (paragraphs.length < 2 || chapter.content.trim().length < 80) return [];

  // Build entity regex from world data + known speakers
  const knownNames = [
    ...(worldData?.characters ?? []).flatMap(c => [c.name, ...(c.aliases ?? [])]),
    ...result.analysis.speakerCounts.map(s => s.name),
  ].filter(n => n && n.length >= 2);

  const nameRe = knownNames.length
    ? new RegExp(`\\b(${knownNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "gi")
    : null;

  const globalFreq = buildVocabProfile(paragraphs);
  const scores     = paragraphs.map((text, i) =>
    scoreParagraph(text, i, paragraphs.length, nameRe, globalFreq),
  );
  const clusters   = clusterScores(scores);

  const events: MajorEvent[] = [];

  for (const cluster of clusters) {
    const peak       = cluster.reduce((a, b) => a.total > b.total ? a : b);
    const tensionPos = peak.idx / Math.max(1, paragraphs.length - 1);
    const type       = peak.dominantType;

    // Pure transitions get a minimal structural marker
    if (type === "transition" && peak.total < 0.8) {
      events.push({ label: "Scene transition", type: "scene-break", tensionPosition: tensionPos, confidence: 0.4 });
      continue;
    }

    const label = extractLabel(peak.text);
    if (label && label.length >= 4) {
      events.push({ label, type, tensionPosition: tensionPos, confidence: Math.min(1, peak.total / 2.5) });
    }
  }

  // Structural events from chapter role
  const role = result.analysis.chapterRole;
  if (role === "climax") {
    const peakIdx    = result.analysis.tensionCurve.length
      ? result.analysis.tensionCurve.indexOf(Math.max(...result.analysis.tensionCurve))
      : Math.floor(paragraphs.length * 0.7);
    const tensionPos = peakIdx / Math.max(1, result.analysis.tensionCurve.length - 1);
    if (!events.some(e => Math.abs(e.tensionPosition - tensionPos) < 0.15)) {
      events.push({ label: "Chapter climax", type: "climax", tensionPosition: tensionPos, confidence: 1 });
    }
  } else if (role === "pivot") {
    if (!events.some(e => e.tensionPosition > 0.4 && e.tensionPosition < 0.7)) {
      events.push({ label: "Narrative pivot", type: "revelation", tensionPosition: 0.55, confidence: 0.9 });
    }
  }

  // Character first-appearance introduction — very conservative:
  // Only fires when NO meaningful events were detected in the cluster pass,
  // AND the character appears in the opening few sentences (first 5% of text).
  // This prevents "Nora enters" from appearing in every Hollow Iris chapter
  // where the main character is present from the first word.
  const hasRealEvents = events.some(e => e.type !== "scene-break" && e.type !== "transition");
  if (!hasRealEvents && knownNames.length > 0) {
    for (const name of knownNames.slice(0, 4)) {
      const firstIdx = chapter.content.indexOf(name);
      if (firstIdx < 0) continue;
      const fraction = firstIdx / Math.max(1, chapter.content.length);
      if (fraction < 0.05) {
        events.push({ label: `${name} enters`, type: "introduction", tensionPosition: fraction, confidence: 0.55 });
        break;
      }
    }
  }

  // Deduplicate, spread, cap at 4
  events.sort((a, b) => a.tensionPosition - b.tensionPosition);
  const deduped: MajorEvent[] = [];
  for (const evt of events) {
    if (!deduped.some(e => Math.abs(e.tensionPosition - evt.tensionPosition) < 0.12)) {
      deduped.push(evt);
    }
  }

  return deduped
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4)
    .sort((a, b) => a.tensionPosition - b.tensionPosition);
}
