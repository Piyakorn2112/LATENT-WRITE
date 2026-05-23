// Lightweight prose-profile metrics for a chapter.
//
// Everything here is single-pass, regex-based, no NLP dependency. The
// numbers are reported as confidence-banded labels in the UI, not as
// authoritative classifications, so the heuristics can be wrong on
// individual sentences without misleading the writer.

export type Pov = "first" | "second" | "third" | "mixed";
export type Tense = "past" | "present" | "mixed";
export type RhythmLabel = "monotonous" | "even" | "varied" | "erratic";

export interface ProseProfile {
  pov: Pov;
  povRatio: { first: number; second: number; third: number };
  tense: Tense;
  tenseRatio: { past: number; present: number };
  fleschGrade: number;        // Flesch-Kincaid grade level
  fleschBand: "easy" | "medium" | "hard";
  rhythmCv: number;           // coefficient of variation, sentence word counts
  rhythm: RhythmLabel;
  filterDensity: number;      // filter words per 100 words (0..100)
  showTellRatio: number;      // sensory/concrete tokens ÷ filter tokens
  showTell: "showing" | "balanced" | "telling";
  sentences: number;
  words: number;
}

// ─── Tokenizers ──────────────────────────────────────────────────────────

const WORD_RE = /\b[A-Za-z][A-Za-z'\-]*\b/g;

function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n++;
  return n;
}

function splitSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?]+[.!?]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  if (out.length === 0 && text.trim()) out.push(text.trim());
  return out;
}

// Cheap syllable counter — vowel-group heuristic with exception trimming.
// Accuracy ~ ±1 syllable per long word; fine for the smoothing FK does.
function syllableCount(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 3) return 1;
  // Trim silent endings.
  const trimmed = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "")
    .replace(/^y/, "");
  const groups = trimmed.match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

// ─── POV detection ───────────────────────────────────────────────────────

// gi flags so sentence-initial capitalized forms ("My", "We", "You") are counted
const FIRST_RE  = /\b(I|me|my|mine|we|us|our|ours|myself|ourselves)\b/gi;
const SECOND_RE = /\b(you|your|yours|yourself|yourselves)\b/gi;
const THIRD_RE  = /\b(he|him|his|himself|she|her|hers|herself|they|them|their|theirs|themselves)\b/gi;

function detectPov(text: string): { pov: Pov; r: { first: number; second: number; third: number } } {
  // Exclude dialogue from POV count — characters speaking in 1st/2nd person
  // shouldn't flip a third-person narrative's classification.
  const narration = stripDialogue(text);
  const f = countMatches(narration, FIRST_RE);
  const s = countMatches(narration, SECOND_RE);
  const t = countMatches(narration, THIRD_RE);
  const total = f + s + t;
  // Lowered from 20 → 8: short prose samples (100–150 words) can have fewer than
  // 20 pronouns yet still be clearly first-person or third-person.
  if (total < 8) return { pov: "third", r: { first: 0, second: 0, third: 0 } };
  const fr = f / total, sr = s / total, tr = t / total;
  // Strong dominance threshold; otherwise mixed (e.g., epistolary, head-hop).
  let pov: Pov = "third";
  if (fr >= 0.55) pov = "first";
  else if (sr >= 0.45) pov = "second";
  else if (tr >= 0.55) pov = "third";
  else pov = "mixed";
  return { pov, r: { first: fr, second: sr, third: tr } };
}

function stripDialogue(text: string): string {
  // Conservative: remove anything between matched smart/dumb double quotes.
  return text
    .replace(/"[^"]*"/g, " ")
    .replace(/[“][^”]*[”]/g, " ")
    .replace(/[‘][^’]*[’]/g, " ");
}

// ─── Tense detection ─────────────────────────────────────────────────────

const PAST_MARKERS_RE = /\b(was|were|had|did|said|went|got|came|took|made|saw|knew|thought|told|looked|asked|seemed|felt|heard|moved|turned|reached|stepped|walked|stood|sat|held|kept|left|brought|caught|fell|gave|tried|pulled|pushed)\b/gi;
const PRESENT_MARKERS_RE = /\b(is|are|has|does|says|goes|gets|comes|takes|makes|sees|knows|thinks|tells|looks|asks|seems|feels|hears|moves|turns|reaches|steps|walks|stands|sits|holds|keeps|leaves|brings|catches|falls|gives|tries|pulls|pushes)\b/gi;

function detectTense(text: string): { tense: Tense; r: { past: number; present: number } } {
  const narration = stripDialogue(text);
  const past = countMatches(narration, PAST_MARKERS_RE);
  const pres = countMatches(narration, PRESENT_MARKERS_RE);
  const total = past + pres;
  // Lowered from 12 → 6: short prose (100 words) has fewer verbs, still detectable.
  if (total < 6) return { tense: "past", r: { past: 0, present: 0 } };
  const pr = past / total;
  const pp = pres / total;
  let t: Tense = "past";
  if (pr >= 0.7) t = "past";
  else if (pp >= 0.55) t = "present";
  else t = "mixed";
  return { tense: t, r: { past: pr, present: pp } };
}

// ─── Rhythm: sentence-length variance ────────────────────────────────────

function computeRhythm(sentences: string[]): { cv: number; label: RhythmLabel } {
  if (sentences.length < 4) return { cv: 0, label: "even" };
  const lens = sentences.map((s) => (s.match(WORD_RE) ?? []).length);
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  if (mean === 0) return { cv: 0, label: "even" };
  const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
  const cv = Math.sqrt(variance) / mean;
  let label: RhythmLabel = "even";
  if (cv < 0.25) label = "monotonous";
  else if (cv < 0.55) label = "even";
  else if (cv < 0.95) label = "varied";
  else label = "erratic";
  return { cv, label };
}

// ─── Filter / show-vs-tell ───────────────────────────────────────────────

const FILTER_WORDS_RE = /\b(saw|noticed|watched|heard|felt|thought|wondered|realized|decided|knew|remembered|seemed|looked|appeared|experienced|observed|considered)\b/gi;

// Concrete sensory / motion verbs and adjectives. Not exhaustive — a
// representative sample that correlates with "showing" prose. This is the
// numerator in the show:tell ratio.
const SENSORY_RE = /\b(creaked|groaned|hissed|whispered|rustled|crashed|thudded|hummed|rattled|clicked|crackled|thumped|slammed|rang|shimmered|gleamed|glinted|flickered|sparkled|glowed|smouldered|smoldered|smouldering|smoldering|burned|burned|smelled|tasted|stung|pricked|brushed|grazed|trembled|shivered|ached|throbbed|tingled|cold|warm|sharp|soft|rough|smooth|bitter|sweet|acrid|fragrant|metallic|crimson|scarlet|amber|umber|charcoal|ivory|pearl|jagged|brittle)\b/gi;

function computeShowTell(text: string): {
  filterPer100: number;
  ratio: number;
  label: "showing" | "balanced" | "telling";
} {
  const words = (text.match(WORD_RE) ?? []).length || 1;
  const filter = countMatches(text, FILTER_WORDS_RE);
  const sensory = countMatches(text, SENSORY_RE);
  const filterPer100 = (filter / words) * 100;
  const ratio = sensory / Math.max(1, filter);
  let label: "showing" | "balanced" | "telling" = "balanced";
  if (filterPer100 > 1.4 && ratio < 0.6) label = "telling";
  else if (filterPer100 < 0.6 && ratio > 1.5) label = "showing";
  return { filterPer100, ratio, label };
}

// ─── Flesch-Kincaid grade level ──────────────────────────────────────────

function fleschKincaidGrade(text: string, sentenceCount: number): { grade: number; band: "easy" | "medium" | "hard" } {
  const words = text.match(WORD_RE) ?? [];
  if (words.length === 0 || sentenceCount === 0) return { grade: 0, band: "easy" };
  const syl = words.reduce((s, w) => s + syllableCount(w), 0);
  const grade = 0.39 * (words.length / sentenceCount) + 11.8 * (syl / words.length) - 15.59;
  const rounded = Math.max(0, Math.round(grade * 10) / 10);
  const band: "easy" | "medium" | "hard" = rounded < 7 ? "easy" : rounded < 11 ? "medium" : "hard";
  return { grade: rounded, band };
}

// ─── Public ──────────────────────────────────────────────────────────────

export function profileChapter(text: string): ProseProfile {
  const sentences = splitSentences(text);
  const wordCount = (text.match(WORD_RE) ?? []).length;

  const { pov, r: povRatio } = detectPov(text);
  const { tense, r: tenseRatio } = detectTense(text);
  const { grade, band } = fleschKincaidGrade(text, sentences.length);
  const { cv, label: rhythm } = computeRhythm(sentences);
  const showTell = computeShowTell(text);

  return {
    pov,
    povRatio,
    tense,
    tenseRatio,
    fleschGrade: grade,
    fleschBand: band,
    rhythmCv: cv,
    rhythm,
    filterDensity: showTell.filterPer100,
    showTellRatio: showTell.ratio,
    showTell: showTell.label,
    sentences: sentences.length,
    words: wordCount,
  };
}
