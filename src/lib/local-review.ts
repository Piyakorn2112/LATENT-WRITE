/**
 * Local Renderer review engine — calibrated against actual Hollow Iris /
 * Root Crown scan reports (NovelDraft/review-logs, TheRootCrownDraft/review-logs).
 *
 * Patterns implemented:
 *  over-explanation       — Shows action/image then explains its meaning
 *  ai-register            — AI-typical indirect introspection phrasing
 *  acquisition-backstory  — Dense past-perfect bio dump mid-scene
 *  belief-elaboration     — States belief then justifies it
 *  crowd-quantification   — Specific numbers on undramatic groups
 *  emotion-label          — Abstract emotion word without physical grounding
 *  annotation             — [NEW] Image shown + simile/gloss explaining it
 *  nia                    — [NEW] Named Intermediate Abstraction: "slightly",
 *                           "somehow", "subtly", "a kind of feeling"
 *
 * Architecture:
 *  Pass 1: Heuristic detectors (regex/statistics) — fast, all sentences
 *  Pass 2: LM semantic similarity validation (Electron main process, optional)
 */

import type { ReviewFlag, ReviewResult } from "../types";

const DEV = (import.meta as { env?: { DEV?: boolean } }).env?.DEV ?? false;

// LM validation removed after calibration (see narrative-lm.ts comments).
// all-MiniLM-L6-v2 produces 0.08–0.33 similarity scores for both genuine prose
// failures AND clean prose against editorial pattern anchors — near-random for
// this task because the model measures semantic TOPIC overlap, not prose QUALITY.
// Pure heuristic thresholds (0.60–0.72 per pattern) are more precise and instant.
const MAX_CANDIDATES = 22;

// ─── Utilities ────────────────────────────────────────────────────────────────

interface Candidate {
  type: string;
  sentence: string;
  heuristicConf: number;
  fix: string;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 15 && s.length < 400);
}

// ─── 1: Over-explanation ──────────────────────────────────────────────────────
// An action/image is shown, then the SAME sentence or next sentence explains it.

const OVER_EXPLAIN_PHRASES = [
  "in other words", "that is to say",
  "which explained", "which was why", "as if to say", "meaning that",
  "so that she would know", "so that he would know", "so that they would know",
  "the reason she", "the reason he", "the reason they",
  "this was because", "as though to explain",
  "what she meant", "what he meant",
];

// `which meant` is too broad on its own: in literary prose it often marks
// logistics or causality rather than an image being glossed. Keep it only for
// explicit human-state explanations where the clause turns into interpretation.
const OVER_EXPLAIN_WHICH_MEANT_RE =
  /\bwhich mean(?:s|t) (?:that )?(?:she|he|they)\s+(?:was|were|felt|had|could|would|knew|understood|meant|showed|proved)\b/i;

function detectOverExplanation(paras: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const para of paras) {
    for (const sent of sentences(para)) {
      const lower = sent.toLowerCase();
      if (OVER_EXPLAIN_PHRASES.some(p => lower.includes(p)) || OVER_EXPLAIN_WHICH_MEANT_RE.test(sent)) {
        out.push({
          type: "over-explanation",
          sentence: sent,
          heuristicConf: 0.72,
          fix: "Remove the gloss — the image before it already carries the meaning.",
        });
      }
    }
  }
  return out;
}

// ─── 2: AI register ───────────────────────────────────────────────────────────

const AI_REGISTER_PATTERNS: RegExp[] = [
  /couldn't help but\b/i,
  /something (?:she|he|they) couldn't quite (?:name|describe|explain|put into words|articulate)\b/i,
  /(?:a feeling|a sense|a weight|a pang|an ache) (?:she|he|they) couldn't (?:quite |fully )?(?:name|place|describe|explain)\b/i,
  /made (?:her|him|them) realize\b/i,
  /was the kind of (?:person|woman|man|girl|boy) who\b/i,
  /there was something (?:about the way|in the way)\b/i,
  /for the first time in (?:years|months|a long time|as long as)\b/i,
  /part of (?:her|him|them) (?:wanted|knew|felt|understood|wondered)\b/i,
  /she (?:had always|had never) quite\b/i,
  /he (?:had always|had never) quite\b/i,
  /(?:she|he|they) wasn't sure (?:when|why|how|what) exactly\b/i,
  /(?:she|he|they) filed it under\b/i,
  // Modern analytical register in non-analytical context
  /\b(?:processing|categorizing|cataloguing|archiving) (?:the|her|his|their)\b(?!.*lattice)/i,
];

function detectAiRegister(paras: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const para of paras) {
    for (const sent of sentences(para)) {
      const lower = sent.toLowerCase();
      for (const re of AI_REGISTER_PATTERNS) {
        if (re.test(lower)) {
          out.push({
            type: "ai-register",
            sentence: sent,
            heuristicConf: 0.70,
            fix: "Replace with a physical action or sensation grounded in the scene.",
          });
          break;
        }
      }
    }
  }
  return out;
}

// ─── 3: Acquisition-backstory ─────────────────────────────────────────────────
// Dense past-perfect cluster + strong personal-history temporal marker.

const HAD_VERB_RE  = /\bhad\s+[a-z]+(?:ed|en|t)\b/gi;
const BACKSTORY_TEMPORAL = /\b(years ago|when (?:she|he|they) (?:was|were) young|back then|long before|in (?:her|his|their) (?:youth|childhood|past)|growing up|as a child|before she (?:was|became)|before he (?:was|became))\b/i;

function detectBackstory(paras: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const para of paras) {
    const hadCount = (para.match(HAD_VERB_RE) ?? []).length;
    if (hadCount >= 4 && BACKSTORY_TEMPORAL.test(para)) {
      const sents = sentences(para);
      // Show the sentence that actually contains the backstory pattern
      const relevant = sents.find(s => /\bhad\s+[a-z]+(?:ed|en|t)\b/i.test(s) && BACKSTORY_TEMPORAL.test(s))
                    ?? sents.find(s => /\bhad\s+[a-z]+(?:ed|en|t)\b/i.test(s))
                    ?? sents[0];
      if (relevant) {
        out.push({
          type: "acquisition-backstory",
          sentence: relevant,
          heuristicConf: 0.65,
          fix: "Move backstory to its own flashback scene or cut — it interrupts the present action.",
        });
      }
    }
  }
  return out;
}

// ─── 4: Belief-elaboration ────────────────────────────────────────────────────

const BELIEF_STMT   = /\b(?:she|he|they)\s+(?:believed|thought|knew|understood|had always known|had always believed|had never thought|had always felt)\s+that\b/i;
const BELIEF_FOLLOW = /\b(?:because|since|for|which was why|the reason|this (?:was|meant)|it (?:was|meant))\b/i;

function detectBeliefElaboration(paras: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const para of paras) {
    if (BELIEF_STMT.test(para) && BELIEF_FOLLOW.test(para)) {
      const sents  = sentences(para);
      const match  = sents.find(s => BELIEF_STMT.test(s)) ?? sents[0];
      if (match) {
        out.push({
          type: "belief-elaboration",
          sentence: match,
          heuristicConf: 0.60,
          fix: "Show the belief through action or decision — remove the statement and its justification.",
        });
      }
    }
  }
  return out;
}

// ─── 5: Crowd-quantification ──────────────────────────────────────────────────

const CROWD_NUM_RE = /\b(\d+|dozens?|hundreds?|thousands?|scores?|several|(?:a |the )?(?:few|many|number of))\s+(?:people|persons?|students?|soldiers?|guards?|figures?|men|women|children|voices?|faces?|bodies|civilians?|citizens?|individuals?|members?)\b/i;
const CROWD_DRAMATIC_EXEMPT = /\b(?:killed|dead|wounded|executed|arrested|missing|survived|escaped)\b/i;

function detectCrowdQuantification(paras: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const para of paras) {
    for (const sent of sentences(para)) {
      if (CROWD_NUM_RE.test(sent) && !CROWD_DRAMATIC_EXEMPT.test(sent)) {
        out.push({
          type: "crowd-quantification",
          sentence: sent,
          heuristicConf: 0.55,
          fix: "Replace the count with a sensory detail — what the crowd looked, sounded, or felt like.",
        });
      }
    }
  }
  return out;
}

// ─── 6: Emotion-label ────────────────────────────────────────────────────────

const EMOTION_WORDS = "sad|sorrow|grief|despair|happy|joy|joyful|angry|anger|rage|fear|scared|terrified|lonely|loneliness|guilt|shame|ashamed|anxious|anxiety|nervous|confused|confusion|devastated|heartbroken|relieved|relief|hopeful|hope|disappointed|disappointment|bitter|bitterness|resentment|jealousy|jealous|envious|envy|content|contentment|dread|horror|horrified|melancholy|regret|remorse";
const EMOTION_LABEL_RE = new RegExp(
  `\\b(?:she|he|they|[A-Z][a-z]+)\\s+(?:felt|was|were|felt a wave of|felt the weight of|experienced|was filled with)\\s+(?:a wave of\\s+)?(?:${EMOTION_WORDS})\\b`,
  "i",
);
const PHYSICAL_GROUND = /\b(?:heart|chest|throat|hands|breath|stomach|shoulders|jaw|eyes|face|skin|bones|knees|legs|fists|teeth|lungs|neck|spine|gut|mouth|tongue|pulse|blood|cheek|palm)\b/i;

function detectEmotionLabel(paras: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const para of paras) {
    for (const sent of sentences(para)) {
      if (EMOTION_LABEL_RE.test(sent) && !PHYSICAL_GROUND.test(para)) {
        out.push({
          type: "emotion-label",
          sentence: sent,
          heuristicConf: 0.65,
          fix: "Replace with a physical gesture or sensation that embodies the emotion.",
        });
      }
    }
  }
  return out;
}

// ─── 7: Annotation [NEW] ─────────────────────────────────────────────────────
// From scan reports: image/action shown, then the NEXT sentence explains it with
// "the way X" / "as if X" / "in the way that X" — dissolving interpretive space.
// Examples from Root Crown scan: "...without naming it, the way you hold a
// relationship that has no name but is real."

// TRUE annotation: second-person "the way YOU/ONE [verb]" addresses the reader
// to explain an image. "as if to [verb]" explicitly names the intention.
//
// NOT annotation (Hollow Iris style anchor):
//   "the way SHE had been satisfied"   → third-person, just comparative style
//   "which was a different thing"      → plain descriptor, not a gloss
//   "which was the temperature"        → property description
//
// Only "which MEANT / signified" are true glossing verbs.
const ANNOTATION_SIMILE_RE = /,\s+(?:the way (?:you|one)\s+\w|as if to |as though to )/i;
const ANNOTATION_GLOSS_RE  = /\b(?:which (?:meant|signified|showed|proved|demonstrated|explained)\b|this was the (?:reason|point|function|purpose|way) (?:she|he|it)|what this (?:meant|showed|proved))\b/i;
const ANNOTATION_EXEMPT_RE = /\bthe way (?:she|he|they|Nora|Iris|Helia|Kael|Mira|Dowsa|Gareth)\s+/i;

function detectAnnotation(paras: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const para of paras) {
    for (const sent of sentences(para)) {
      if (ANNOTATION_EXEMPT_RE.test(sent)) continue; // Hollow Iris style anchor
      if ((ANNOTATION_SIMILE_RE.test(sent) || ANNOTATION_GLOSS_RE.test(sent)) && sent.length > 65) {
        out.push({
          type: "annotation",
          sentence: sent,
          heuristicConf: 0.70,
          fix: "Cut the 'the way you…' or gloss — the image already carries the meaning.",
        });
      }
    }
  }
  return out;
}

// ─── 8: NIA — Named Intermediate Abstraction [NEW] ───────────────────────────
// From scan reports: "slightly", "somehow", "subtly", "a kind of feeling",
// "something about the way", "the quality of" — naming a quality instead of showing it.

const NIA_RE = /\b(?:somehow|a certain\s+\w+|a kind of\s+\w+|something about the way|something in the (?:room|air|silence|light|pause|space|between)|a sense of\s+\w+|in some way|in a way she|in a way he|certain kind of)\b/i;
const NIA_QUALITY_RE = /\b(?:the|a)\s+quality of\s+(?:presence|attention|absence|distance|wrongness|otherness|connection|feeling|sensation|emotion|meaning|silence|space)\b/i;
const NIA_SOFTENER_RE = /\b(?:slightly|subtly)\s+(?:off|wrong|different|odd|strange|uncertain|unclear|unreal|abstract|distant|detached|removed|blurred|hollow|empty|altered|changed|askew)\b/i;
const NIA_SOFTENER_EXEMPT = /\b(?:slightly|subtly)\s+different\s+(?:pressure|humidity|temperature|angle|pace|speed|register)\b/i;
// Exempt: "a kind of" used for specific material/object descriptions
const NIA_EXEMPT = /\b(?:a kind of (?:wood|stone|metal|cloth|plant|tree|grain|bread|rope|cloth|fabric|tool|container|building|instrument))\b/i;

function detectNIA(paras: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const para of paras) {
    for (const sent of sentences(para)) {
      if ((NIA_RE.test(sent) || NIA_QUALITY_RE.test(sent) || NIA_SOFTENER_RE.test(sent)) && !NIA_EXEMPT.test(sent) && !NIA_SOFTENER_EXEMPT.test(sent)) {
        out.push({
          type: "nia",
          sentence: sent,
          heuristicConf: 0.62,
          fix: "Replace the abstract qualifier with a concrete sensory or physical detail.",
        });
      }
    }
  }
  return out;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export async function runLocalReview(
  chapterId: string,
  chapterText: string,
): Promise<ReviewResult> {
  const paras = chapterText
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 40);

  // Pass 1: heuristic scan
  const all: Candidate[] = [
    ...detectOverExplanation(paras),
    ...detectAiRegister(paras),
    ...detectBackstory(paras),
    ...detectBeliefElaboration(paras),
    ...detectCrowdQuantification(paras),
    ...detectEmotionLabel(paras),
    ...detectAnnotation(paras),
    ...detectNIA(paras),
  ];

  if (DEV) console.log(`[LocalReview] Heuristics found ${all.length} candidate(s) in ${paras.length} paragraphs`);

  // Deduplicate by sentence
  const seen = new Map<string, Candidate>();
  for (const c of all) {
    const key = c.sentence.slice(0, 60);
    if (!seen.has(key) || c.heuristicConf > seen.get(key)!.heuristicConf) {
      seen.set(key, c);
    }
  }

  const candidates = [...seen.values()]
    .sort((a, b) => b.heuristicConf - a.heuristicConf)
    .slice(0, MAX_CANDIDATES);

  // Pass 2: Pure heuristic filtering by confidence threshold.
  //
  // LM validation was removed after calibration showed all-MiniLM-L6-v2 produces
  // near-random similarity scores (0.08–0.33) for both genuine prose failures and
  // clean prose against editorial pattern anchors. The model measures semantic TOPIC
  // overlap, not stylistic QUALITY patterns — wrong tool for this task.
  // Heuristic confidence thresholds (0.60–0.72) are more precise and 1-2s faster.
  const flags: ReviewFlag[] = [];
  for (const c of candidates) {
    // Only flag at or above the heuristic confidence set per-pattern
    if (c.heuristicConf >= 0.60) {
      flags.push({ type: c.type, quote: c.sentence.slice(0, 70), fix: c.fix });
    }
  }

  if (DEV) console.log(`[LocalReview] ✓ ${flags.length} flag(s) from ${candidates.length} candidates`);

  return {
    chapterId,
    model: "local-heuristic",
    timestamp: Date.now(),
    flags,
  };
}

export const LOCAL_REVIEW_MODEL = {
  id:    "local-nlm" as const,
  label: "Local NLM",
  note:  "No API key — runs on device. Checks annotation, NIA, AI register, and 6 Renderer patterns.",
};
