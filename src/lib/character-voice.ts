// Per-character voice signals derived from the existing speech-detect
// output and worldData. Three families of insight:
//
//   1. Pronoun ⇄ role mismatch — the worldData "role" / "description"
//      fields often disclose gender ("the queen", "her brother", "the
//      old man"); we check whether the chapter's pronouns aimed at this
//      character agree with that signal.
//   2. Voice fingerprint — average dialogue length and dominant
//      register per speaker, so the writer can spot voice drift.
//   3. Tag variety — the ratio of plain "said" attributions to coloured
//      verbs ("muttered", "snapped"). Either extreme is a red flag.

import type { ChapterParaResult } from "./speech-detect";
import type { WorldCharacter, WorldData } from "../types";

// ─── Pronoun / gender detection from worldData ───────────────────────────

type Gender = "male" | "female" | "nonbinary" | "unknown";

const MALE_HINTS = /\b(king|prince|duke|earl|baron|knight|lord|sir|brother|father|dad|husband|son|nephew|grandfather|grandson|uncle|man|gentleman|guy|boy|monk|priest|emperor|tsar|pharaoh|sultan|patriarch|mister|mr)\b/i;
const FEMALE_HINTS = /\b(queen|princess|duchess|countess|baroness|dame|lady|sister|mother|mom|wife|daughter|niece|grandmother|granddaughter|aunt|woman|gentlewoman|gal|girl|nun|priestess|empress|tsarina|matriarch|mrs|miss|ms|madam)\b/i;
const NB_HINTS = /\b(monarch|sibling|parent|spouse|child|cousin|partner|enby|nonbinary|non-binary|they\/them)\b/i;

const PRONOUN_HE  = /\b(he|him|his|himself)\b/gi;
const PRONOUN_SHE = /\b(she|her|hers|herself)\b/gi;
const PRONOUN_THEY = /\b(they|them|their|theirs|themself|themselves)\b/gi;

export function inferGender(c: WorldCharacter): Gender {
  const blob = `${c.role ?? ""} ${c.description ?? ""}`;
  if (NB_HINTS.test(blob)) return "nonbinary";
  if (FEMALE_HINTS.test(blob)) return "female";
  if (MALE_HINTS.test(blob)) return "male";
  return "unknown";
}

// ─── Per-character speech and prose statistics ───────────────────────────

export interface CharacterVoiceStat {
  name: string;
  gender: Gender;
  /** Number of dialogue segments attributed to this character. */
  speeches: number;
  /** Sum of word counts in all attributed segments. */
  words: number;
  /** Mean words per dialogue line. */
  avgLineLength: number;
  /** Span (max − min word count) — variance signal. */
  lineSpan: number;
  /** Pronoun mismatch — characters near this name are referred to by a
   *  pronoun that disagrees with the inferred gender. */
  pronounMismatch?: { expected: "he" | "she" | "they"; observed: "he" | "she" | "they" };
}

function wordCount(s: string): number {
  const t = s.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

function expectedPronoun(g: Gender): "he" | "she" | "they" | null {
  if (g === "male")   return "he";
  if (g === "female") return "she";
  if (g === "nonbinary") return "they";
  return null;
}

export function profileCharacterVoices(
  paragraphs: string[],
  speechResults: ChapterParaResult[],
  worldData: WorldData | undefined,
): CharacterVoiceStat[] {
  // Build name → WorldCharacter map (canonical names + aliases).
  const charByName = new Map<string, WorldCharacter>();
  for (const c of worldData?.characters ?? []) {
    charByName.set(c.name.toLowerCase(), c);
    for (const a of c.aliases ?? []) charByName.set(a.toLowerCase(), c);
  }

  // Aggregate per canonical character.
  const stats = new Map<string, {
    name: string;
    gender: Gender;
    lines: number[];        // word counts of each attributed line
    surroundingPronouns: { he: number; she: number; they: number };
  }>();

  // Iterate every speech segment with high enough confidence to count.
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const r = speechResults[i];
    if (!r) continue;
    for (const seg of r.segments) {
      if (seg.type !== "speech" || !seg.speaker || seg.confidence < 0.55) continue;
      const canon = charByName.get(seg.speaker.toLowerCase());
      const name = canon?.name ?? seg.speaker;
      const gender = canon ? inferGender(canon) : "unknown";
      const text = para.slice(seg.start, seg.end);
      const wc = wordCount(text);
      const entry = stats.get(name) ?? {
        name,
        gender,
        lines: [],
        surroundingPronouns: { he: 0, she: 0, they: 0 },
      };
      entry.lines.push(wc);
      // Look at the +/-150 char window around the segment for pronoun cues.
      const winStart = Math.max(0, seg.start - 150);
      const winEnd   = Math.min(para.length, seg.end + 150);
      const window   = para.slice(winStart, winEnd);
      entry.surroundingPronouns.he   += (window.match(PRONOUN_HE)   ?? []).length;
      entry.surroundingPronouns.she  += (window.match(PRONOUN_SHE)  ?? []).length;
      entry.surroundingPronouns.they += (window.match(PRONOUN_THEY) ?? []).length;
      stats.set(name, entry);
    }
  }

  // Materialise final stat objects, computing avg/span and mismatch.
  const out: CharacterVoiceStat[] = [];
  for (const { name, gender, lines, surroundingPronouns } of stats.values()) {
    if (lines.length === 0) continue;
    const sum = lines.reduce((a, b) => a + b, 0);
    const avg = sum / lines.length;
    const span = lines.length > 1 ? Math.max(...lines) - Math.min(...lines) : 0;

    let mismatch: CharacterVoiceStat["pronounMismatch"];
    const expected = expectedPronoun(gender);
    if (expected) {
      const totalP = surroundingPronouns.he + surroundingPronouns.she + surroundingPronouns.they;
      if (totalP >= 3) {
        const counts: Record<"he"|"she"|"they", number> = {
          he: surroundingPronouns.he,
          she: surroundingPronouns.she,
          they: surroundingPronouns.they,
        };
        const observed = (Object.entries(counts) as ["he"|"she"|"they", number][])
          .sort((a, b) => b[1] - a[1])[0][0];
        if (observed !== expected && counts[observed] > counts[expected] * 1.5) {
          mismatch = { expected, observed };
        }
      }
    }

    out.push({
      name,
      gender,
      speeches: lines.length,
      words: sum,
      avgLineLength: avg,
      lineSpan: span,
      pronounMismatch: mismatch,
    });
  }

  out.sort((a, b) => b.speeches - a.speeches);
  return out;
}

// ─── Tag variety: said vs flavoured attribution verbs ────────────────────

const PLAIN_TAGS = /\b(said|asked|replied|answered)\b/gi;
const COLOURED_TAGS =
  /\b(whispered|shouted|yelled|muttered|cried|sighed|laughed|snapped|growled|purred|hissed|barked|rasped|shrieked|stammered|breathed|drawled|grunted|snorted|roared|murmured|gasped|hollered|wailed)\b/gi;

export interface TagVariety {
  plain: number;
  coloured: number;
  /** said% — fraction of attribution verbs that are plain "said". */
  saidPct: number;
  /** Verdict on health of the variety. */
  verdict: "balanced" | "said-heavy" | "purple" | "no-data";
}

export function computeTagVariety(text: string): TagVariety {
  const plain    = (text.match(PLAIN_TAGS) ?? []).length;
  const coloured = (text.match(COLOURED_TAGS) ?? []).length;
  const total    = plain + coloured;
  if (total < 6) return { plain, coloured, saidPct: 0, verdict: "no-data" };
  const saidPct = plain / total;
  let verdict: TagVariety["verdict"] = "balanced";
  if (saidPct > 0.92) verdict = "said-heavy";
  else if (saidPct < 0.55) verdict = "purple";
  return { plain, coloured, saidPct, verdict };
}

// ─── Cliffhanger score ───────────────────────────────────────────────────
//
// A simple chapter-ending tension lift score: compare the last 15% of
// paragraphs' tension to the average, and check for unresolved-question
// markers in the closing prose. 0..1 scale.

export function cliffhangerScore(
  paragraphs: string[],
  speechResults: ChapterParaResult[],
): { score: number; label: "soft" | "lift" | "hook"; note: string } {
  if (paragraphs.length < 4) return { score: 0, label: "soft", note: "Too short to score." };
  const tail = Math.max(1, Math.ceil(paragraphs.length * 0.15));
  const tensionMap: Record<"calm"|"rising"|"high", number> = { calm: 0, rising: 0.5, high: 1 };
  const avg = speechResults.reduce((s, r) => s + (tensionMap[r?.meta?.tension ?? "calm"] ?? 0), 0) / speechResults.length;
  const tailAvg = speechResults
    .slice(-tail)
    .reduce((s, r) => s + (tensionMap[r?.meta?.tension ?? "calm"] ?? 0), 0) / tail;

  // Question or unresolved-marker boost on the very last paragraph.
  const last = paragraphs[paragraphs.length - 1] ?? "";
  const hookBoost =
    /\?\s*$/.test(last.trim()) ? 0.25 :
    /\b(but|yet|until|what if|could it|would it|never|nothing|nobody|gone|lost|missing|silence|dark)\b/i.test(last)
      ? 0.15 : 0;

  const lift = Math.max(0, tailAvg - avg);
  const raw = Math.min(1, lift + hookBoost);
  const score = Math.round(raw * 100) / 100;
  let label: "soft" | "lift" | "hook" = "soft";
  if (score >= 0.55) label = "hook";
  else if (score >= 0.25) label = "lift";

  const note =
    label === "hook"
      ? "Closing tension lifts above the chapter's baseline — strong hook."
      : label === "lift"
      ? "Mild closing lift — consider sharpening the final beat or question."
      : "Calm landing — fine for a denouement chapter, lukewarm for mid-arc.";

  return { score, label, note };
}
