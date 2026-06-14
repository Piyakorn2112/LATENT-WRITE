/**
 * Smart chapter auto-paragraphing — "respect & augment" auditor.
 *
 * Behaviour (chosen deliberately, see the design notes in the test suite):
 *   • The author's existing paragraph breaks are AUTHORITATIVE. Every newline
 *     in the chapter is a paragraph boundary (matching the app's own
 *     `toParagraphs` split, `content.split(/\n{2,}|\n/)`). We never merge two
 *     existing paragraphs and never flatten the document.
 *   • Each existing paragraph is AUDITED independently and split only where a
 *     break is *clearly missing* — two speakers jammed together, a dialogue
 *     speaker change, or a time/place jump mid-paragraph.
 *   • A chapter that is a single unbroken block (a pasted wall of text) is the
 *     one case we fully reconstruct: there are no authorial breaks to respect,
 *     so the richer rule set (incl. narration→dialogue, pure-narration actor
 *     switches, and a length cap) rebuilds sane paragraphing.
 *
 * High-precision posture: when a boundary signal is ambiguous we do NOT break.
 * A missed split costs the writer one keystroke; a wrong split corrupts their
 * formatting and erodes trust.
 *
 * All linguistic work is delegated to the shared, unit-tested primitives in
 * `prose-segments.ts` (sentence tokenizer, apostrophe-safe quote analyzer,
 * discourse-marker taxonomy). This module only owns the break-decision policy.
 */

import {
  splitSentences,
  analyzeQuotes,
  classifyOpener,
  stripQuotes,
  isSceneBreakLine,
  type QuoteAnalysis,
} from "./prose-segments";

/** Force-break a wall-of-text paragraph once it reaches this many sentences. */
const MAX_SENTENCES_PER_PARA = 5;

const NOMINATIVE_PRONOUN = /\b(he|she|they|i|we)\b/i;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface NameMatcher {
  key: string;
  re: RegExp;
}

function buildNameMatchers(knownNames: string[]): NameMatcher[] {
  const out: NameMatcher[] = [];
  for (const name of knownNames) {
    const trimmed = name?.trim();
    if (!trimmed) continue;
    out.push({ key: trimmed.toLowerCase(), re: new RegExp(`\\b${escapeRegex(trimmed)}\\b`, "i") });
  }
  return out;
}

/**
 * The acting subject of a sentence: the first person referenced in its
 * narration (a known character name or a nominative pronoun), reading OUTSIDE
 * any quoted span so dialogue-internal pronouns don't masquerade as the
 * speaker. Returns a normalized key, or undefined when no person is found
 * (e.g. a bare quote line, or scene-setting narration with no actor).
 */
function sentenceSubject(text: string, names: NameMatcher[]): string | undefined {
  const narration = stripQuotes(text);
  let best: { key: string; pos: number } | undefined;

  const pm = NOMINATIVE_PRONOUN.exec(narration);
  if (pm) best = { key: pm[1].toLowerCase(), pos: pm.index };

  for (const { key, re } of names) {
    const m = re.exec(narration);
    if (m && (!best || m.index < best.pos)) best = { key, pos: m.index };
  }
  return best?.key;
}

const PRONOUN_KEYS = new Set(["he", "she", "they", "i", "we"]);

type Gender = "m" | "f" | undefined;

function pronounGender(key: string): Gender {
  return key === "he" ? "m" : key === "she" ? "f" : undefined;
}

const MALE_TITLE =
  "mr|mister|sir|lord|king|prince|father|fr|brother|br|master|duke|count|baron|monsieur|herr|don|uncle";
const FEMALE_TITLE =
  "mrs|ms|miss|mistress|lady|queen|princess|mother|sister|madam|madame|mlle|mme|duchess|countess|baroness|dame|aunt|nan";

/**
 * Infer a gender for known names from honorifics in the text ("Mr. Poole",
 * "Lady Vale"). Titles are high-precision, low-risk evidence — far safer than
 * pronoun-proximity guessing, which can misfire when two characters share a
 * sentence. Names without a title stay unknown (and are then treated as
 * gender-compatible, i.e. we don't break on them).
 */
function buildGenderMap(content: string, knownNames: string[]): Map<string, Gender> {
  const map = new Map<string, Gender>();
  for (const name of knownNames) {
    const trimmed = name?.trim();
    if (!trimmed) continue;
    const nm = escapeRegex(trimmed);
    if (new RegExp(`\\b(?:${MALE_TITLE})\\.?\\s+${nm}\\b`, "i").test(content)) {
      map.set(trimmed.toLowerCase(), "m");
    } else if (new RegExp(`\\b(?:${FEMALE_TITLE})\\.?\\s+${nm}\\b`, "i").test(content)) {
      map.set(trimmed.toLowerCase(), "f");
    }
  }
  return map;
}

/**
 * Is moving from subject `a` to subject `b` a *confident* change of person?
 * Coreference- and gender-aware, high-precision:
 *   • two different names                → change
 *   • two contrastive pronouns (he↔she)  → change
 *   • name ↔ pronoun                     → change ONLY if a known title gives
 *                                          the name a gender that the pronoun
 *                                          contradicts ("Mr. Poole" → "she");
 *                                          otherwise assumed coreferent.
 * This avoids the classic false split across a speaker's own dialogue
 * (`Aldous said … he asked`) while still catching real handoffs.
 */
function isSubjectChange(
  a: string | undefined,
  b: string | undefined,
  genderOf: (key: string) => Gender,
): boolean {
  if (!a || !b || a === b) return false;
  const pa = PRONOUN_KEYS.has(a);
  const pb = PRONOUN_KEYS.has(b);
  if (pa && pb) return true; // he vs she vs they — distinct persons
  if (!pa && !pb) return true; // two different names — distinct persons
  const name = pa ? b : a;
  const pron = pa ? a : b;
  const ng = genderOf(name);
  const pg = pronounGender(pron);
  return !!ng && !!pg && ng !== pg; // gendered contradiction ⇒ different person
}

/** Confident that `a` and `b` are the SAME speaker (so a new quoted turn is a
 *  continuation, not a handoff). Both must be identified and not a change. */
function confidentlySameSpeaker(
  a: string | undefined,
  b: string | undefined,
  genderOf: (key: string) => Gender,
): boolean {
  return !!a && !!b && !isSubjectChange(a, b, genderOf);
}

/** Does the previous sentence set up the following quote ("…, she said," /
 *  "…as follows:")? Then a following quote belongs with it, not a new para. */
function endsWithLeadIn(text: string): boolean {
  return /[,:]\s*$/.test(text);
}

interface SentenceInfo {
  text: string;
  q: QuoteAnalysis;
  subject: string | undefined;
  opener: ReturnType<typeof classifyOpener>;
}

/**
 * Audit a single existing paragraph and return it, possibly subdivided into
 * several paragraphs joined by `sep`. `wallMode` enables the fuller
 * reconstruction rule set used only when the whole chapter is one block.
 */
function auditParagraph(
  para: string,
  names: NameMatcher[],
  genders: Map<string, Gender>,
  wallMode: boolean,
  sep: string,
): string {
  const genderOf = (key: string): Gender => genders.get(key);
  const sentences = splitSentences(para);
  if (sentences.length <= 1) return para;

  const infos: SentenceInfo[] = sentences.map((s) => ({
    text: s.text,
    q: analyzeQuotes(s.text),
    subject: sentenceSubject(s.text, names),
    opener: classifyOpener(s.text),
  }));

  // An "obvious exchange" = two or more quoted turns in this paragraph. The
  // aggressive per-turn split only fires inside one, so a lone embedded or
  // scare quote in narration is never treated as dialogue.
  const openQuoteCount = infos.filter((s) => s.q.startsWithOpenQuote).length;
  const hasExchange = openQuoteCount >= 2;

  const groups: string[][] = [[infos[0].text]];
  let currentSubject = infos[0].subject;
  let paraLen = 1;

  for (let i = 1; i < infos.length; i++) {
    const prev = infos[i - 1];
    const curr = infos[i];

    const subjChanged = isSubjectChange(currentSubject, curr.subject, genderOf);
    const dialogueInvolved = curr.q.hasQuote || prev.q.hasQuote;

    let brk = false;
    // 1a. Time/place jump opener — clearly a new beat, both modes.
    if (curr.opener === "time-major" || curr.opener === "place-shift") brk = true;
    // 1b. Abrupt pivot ("Suddenly…") — reconstruction only.
    else if (wallMode && curr.opener === "abrupt") brk = true;
    // 2. Dialogue exchange — a new quoted turn that isn't confidently the same
    //    speaker gets its own line (covers the cardinal "new speaker = new
    //    paragraph" rule AND tagged→bare replies like `"Get out," she said.
    //    "Why?"`). Gated to obvious exchanges; same-speaker continuations and
    //    one-sentence-of-a-longer-quote stay put.
    else if (
      hasExchange &&
      curr.q.startsWithOpenQuote &&
      prev.q.hasQuote &&
      !confidentlySameSpeaker(currentSubject, curr.subject, genderOf)
    )
      brk = true;
    // 3. Speaker change with dialogue elsewhere (a beat, then a new speaker).
    else if (subjChanged && dialogueInvolved) brk = true;
    // 3b. Pure-narration actor switch — reconstruction only.
    else if (wallMode && subjChanged) brk = true;
    // 4. Narration → dialogue with no identifiable actor — reconstruction only.
    else if (
      wallMode &&
      curr.q.startsWithOpenQuote &&
      !prev.q.hasQuote &&
      currentSubject == null &&
      !endsWithLeadIn(prev.text)
    )
      brk = true;
    // 5. Length cap — reconstruction only.
    else if (wallMode && paraLen >= MAX_SENTENCES_PER_PARA) brk = true;

    if (brk) {
      groups.push([curr.text]);
      paraLen = 1;
    } else {
      groups[groups.length - 1].push(curr.text);
      paraLen++;
    }

    // Track the most-specific antecedent: a name pins the subject; a pronoun
    // only replaces it when it's a genuine handoff (otherwise it corefers and
    // we keep the named subject so gender checks stay anchored).
    if (curr.subject) {
      if (!PRONOUN_KEYS.has(curr.subject) || subjChanged) currentSubject = curr.subject;
    }
  }

  if (groups.length === 1) return para;
  return groups.map((g) => g.join(" ")).join(sep);
}

/**
 * Re-paragraph a chapter's content. Existing paragraph breaks and scene-break
 * markers are preserved verbatim; each prose paragraph is audited for missing
 * internal breaks. Returns the (possibly unchanged) content.
 */
export function autoParagraph(content: string, knownNames: string[] = []): string {
  if (!content || !content.trim()) return content;

  const names = buildNameMatchers(knownNames);
  const genders = buildGenderMap(content, knownNames);
  const origParas = content
    .split(/\n{2,}|\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (origParas.length === 0) return content;

  const wallMode = origParas.length === 1;
  const docHasBlankLines = /\n[ \t]*\n/.test(content);
  const sep = wallMode || docHasBlankLines ? "\n\n" : "\n";

  // Walk the original content so we preserve the author's exact inter-paragraph
  // whitespace (and any preamble/trailing content) rather than re-joining.
  let out = "";
  let cursor = 0;
  for (const p of origParas) {
    const idx = content.indexOf(p, cursor);
    const audited = isSceneBreakLine(p) ? p : auditParagraph(p, names, genders, wallMode, sep);
    if (idx < 0) {
      if (out && !out.endsWith("\n")) out += sep;
      out += audited;
      continue;
    }
    out += content.slice(cursor, idx);
    out += audited;
    cursor = idx + p.length;
  }
  out += content.slice(cursor);
  return out;
}
