/**
 * alias-propose.ts — which other names in this book are THIS character?
 *
 * A manuscript calls one woman Elizabeth, Elizabeth Bennet, Miss Bennet, Lizzy
 * and Eliza. The app stores those as five unrelated strings, so weights,
 * rosters, scene pairs, the cast ledger and the presence classifier all
 * fragment one person into five — and an attribution of "Lizzy" scores wrong
 * against a tag that says "Elizabeth" although both are the same woman.
 * Measured directly: the presence probe counts "Holmes" and "Sherlock Holmes"
 * as two separate characters on every DEV book.
 *
 * ── WHAT THE FIELD DOES ────────────────────────────────────────────────────
 *
 * BookNLP clusters character NAMES first and only then lets pronouns attach,
 * and it forbids common nouns ("the boy") from ever coreferring to a named
 * entity — because full coreference over a book-length text "tends to
 * erroneously conflate multiple distinct entities into one".
 *
 * Vala et al. (2015), and Renard's GraphRulesCharacterUnifier after it, build a
 * graph over name mentions, add edges from LINK rules (hypocorism, match after
 * stripping titles, shared family name, shared given name), then REMOVE edges
 * along the shortest path between any pair caught by a VETO rule (same surname
 * but different given names; conflicting inferred gender), and take connected
 * components as characters.
 *
 * ── WHAT THIS DOES DIFFERENTLY, AND WHY ────────────────────────────────────
 *
 * ★★ NO CONNECTED COMPONENTS. Components are how "Elizabeth Bennet" reaches
 *    "Mr. Bennet" through the shared node "Bennet" and two people become one —
 *    which is exactly why Vala needs path surgery to undo it. This proposes
 *    links only from a surface form to a CANONICAL character the writer already
 *    has, and drops any form that could belong to more than one of them. That
 *    is the same protection with none of the graph, and it fits what the UI
 *    needs anyway: a per-character list the writer confirms.
 *
 * ★ A WRONG MERGE IS FAR WORSE THAN A MISSED ONE. Two characters collapsing
 *   into one speaker everywhere is silent and corrupts every downstream count;
 *   a missed nickname costs nothing but a nickname. Every ambiguity resolves to
 *   "propose nothing".
 *
 * ★ PROPOSALS, NEVER MERGES. Nothing here writes to worldData. The output
 *   carries the rule that fired and a verbatim line of evidence, so the writer
 *   is confirming something they can check rather than a machine's assertion.
 */

export type AliasRule =
  | "given-name"     // canonical "Elizabeth" ⊂ "Elizabeth Bennet"
  | "family-name"    // canonical "Elizabeth Bennet" → "Miss Bennet"
  | "title-stripped" // "Mr. Darcy" → "Darcy"
  | "hypocorism"     // "Lizzy" → "Elizabeth"
  | "initial";       // "E. Bennet" → "Elizabeth Bennet"

export type AliasVeto =
  | "coordination"     // "X and Y" anywhere is proof of two people
  | "ambiguous"        // the form fits more than one character
  | "honorific-gender" // Mr against Mrs/Miss on the two names themselves
  | "shared-surname"   // the surname is a FAMILY's — "Mr." and "Miss" both use it
  | "distinct-given"   // same surname, different given names: two relatives
  | "too-rare";        // not enough occurrences to be worth confirming

/**
 * ★★ MERGE IS A DIFFERENT PROPOSAL FROM ALIAS AND IT IS THE IMPORTANT ONE.
 *    The first version of this file rejected any form that was already a
 *    canonical name — which threw away "Holmes" ↔ "Sherlock Holmes", the exact
 *    fragmentation the presence probe measured, along with "Quincey" ↔
 *    "Quincey Morris" and "Morris" ↔ "Quincey Morris". A cast list holding two
 *    entries for one person is the commonest way this goes wrong, because the
 *    scan produced both and the writer confirmed both.
 *
 *    `merge` needs a different UI verb ("these are the same person; keep which
 *    name?") and a different consequence (one entry disappears), so it is a
 *    field rather than an inference the caller has to make.
 */
export type AliasKind = "alias" | "merge";

export interface AliasProposal {
  /** The canonical character this form belongs to. */
  character: string;
  /** The surface form found in the text. */
  alias: string;
  /** `merge` when `alias` is itself an entry in the writer's cast. */
  kind: AliasKind;
  rule: AliasRule;
  /** 0..1. Ranking and the review gate, never a merge threshold. */
  confidence: number;
  occurrences: number;
  /** A verbatim line showing the form in use, so the writer can check it. */
  evidence: string;
  /** The deterministic rules could not settle it; a model may be asked. */
  uncertain: boolean;
}

export interface AliasRejection {
  character: string;
  alias: string;
  veto: AliasVeto;
}

export interface AliasProposalResult {
  proposals: AliasProposal[];
  /** Kept and reported rather than dropped silently — a feature that says
   *  nothing looks identical to a feature that is switched off. */
  rejected: AliasRejection[];
}

export const TITLES = [
  "Mr", "Mrs", "Ms", "Miss", "Dr", "Sir", "Lord", "Lady", "Captain", "Colonel",
  "Professor", "Madam", "Madame", "Monsieur", "Mademoiselle", "Aunt", "Uncle",
  "Father", "Mother", "Brother", "Sister", "Master", "Major", "General",
  "Sergeant", "Reverend", "Saint", "Dame", "Baron", "Count", "Countess",
  "Duke", "Duchess", "Prince", "Princess", "King", "Queen",
];
const TITLE_SET = new Set(TITLES.map((t) => t.toLowerCase()));
/** Titles that assert a gender. Mr against Mrs is proof of two people. */
const MALE_TITLES = new Set(["mr", "sir", "lord", "master", "father", "brother", "uncle", "king", "prince", "duke", "baron", "count"]);
const FEMALE_TITLES = new Set(["mrs", "ms", "miss", "lady", "madam", "madame", "mademoiselle", "mother", "sister", "aunt", "queen", "princess", "duchess", "countess", "dame"]);

/** Below this many occurrences a form is not worth a confirmation click. */
const MIN_OCCURRENCES = 3;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Underscore is a word character and Gutenberg wraps names in it; `\b` would
 *  silently never match. Same boundary as character-presence.ts. */
const LB = "(?<![A-Za-z0-9])";
const RB = "(?![A-Za-z0-9])";

export interface NameParts {
  /** Title token without the dot, lower-cased, or "". */
  title: string;
  /** Everything after the title, original case. */
  bare: string;
  tokens: string[];
}

export function splitName(name: string): NameParts {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  let title = "";
  if (tokens.length > 1) {
    const head = tokens[0].replace(/\.$/, "").toLowerCase();
    if (TITLE_SET.has(head)) { title = head; tokens.shift(); }
  }
  return { title, bare: tokens.join(" "), tokens };
}

/**
 * The classic English hypocorism test: lower-case the short form, strip a
 * trailing y/ie/ey, collapse a doubled final consonant, and require the ≥3
 * letter stem to appear inside the long form.
 *
 * Lizzy → lizz → liz ⊂ elizabeth. Kitty → kit ⊄ catherine, correctly missed:
 * that nickname is cultural knowledge, not derivable, and guessing it would
 * need a word list this app has no business shipping.
 */
export function hypocorismOf(short: string, long: string): boolean {
  if (short.length < 4 || long.length <= short.length) return false;
  let stem = short.toLowerCase().replace(/(?:ey|ie|y)$/, "");
  stem = stem.replace(/([a-z])\1$/, "$1");
  if (stem.length < 3) return false;
  return long.toLowerCase().includes(stem);
}

/** "X and Y" / "X or Y" anywhere in the book is proof of two people. An author
 *  never coordinates a character with her own nickname.
 *
 *  Exported because alias-scan.ts harvests forms this file's morphology can
 *  never link — a vocative nickname, an epithet — and those need the SAME
 *  vetoes. A second copy of a safety rule is a rule that drifts. */
export function coordinated(text: string, a: string, b: string): boolean {
  const A = esc(a), B = esc(b);
  return new RegExp(
    `${LB}(?:${A}\\s+(?:and|or)\\s+${B}|${B}\\s+(?:and|or)\\s+${A})${RB}`, "i",
  ).test(text);
}

function countOf(text: string, form: string): number {
  return (text.match(new RegExp(`${LB}${esc(form)}${RB}`, "g")) ?? []).length;
}

function evidenceFor(text: string, form: string): string {
  const m = new RegExp(`${LB}${esc(form)}${RB}`).exec(text);
  if (!m) return "";
  const at = m.index;
  return text.slice(Math.max(0, at - 60), Math.min(text.length, at + form.length + 70))
    .replace(/\s+/g, " ").trim();
}

/**
 * Same surname, different given names — two relatives, never one person.
 * An INITIAL is not a different given name: "A. Verrin" and "Alise Verrin"
 * agree, and the `initial` link rule has to survive this veto.
 */
function distinctGivenNames(a: NameParts, b: NameParts): boolean {
  const at = a.tokens, bt = b.tokens;
  if (at.length < 2 || bt.length < 2) return false;
  if (at[at.length - 1].toLowerCase() !== bt[bt.length - 1].toLowerCase()) return false;
  const initial = /^[a-z]\.?$/i;
  if (initial.test(at[0]) || initial.test(bt[0])) return false;
  return at[0].toLowerCase() !== bt[0].toLowerCase();
}

/** Do two names' gendered titles contradict each other? */
export function genderConflict(a: NameParts, b: NameParts): boolean {
  const g = (t: string) => (MALE_TITLES.has(t) ? "m" : FEMALE_TITLES.has(t) ? "f" : "");
  const ga = g(a.title), gb = g(b.title);
  return ga !== "" && gb !== "" && ga !== gb;
}

/**
 * Does the book use this bare name with BOTH a male and a female title?
 *
 * ★★ THIS IS THE RULE THAT STOPS A SISTER BEING MERGED INTO HER BROTHER.
 *    Measured, on the first run of the proposer: "Miss Darcy" was proposed as
 *    an alias of "Darcy" — and Miss Darcy is Georgiana, Darcy's sister, 39
 *    occurrences of a silent catastrophic merge. The pairwise gender check
 *    could not see it, because the CANONICAL entry is bare "Darcy" with no
 *    title at all and a conflict needs two titles to compare.
 *
 *    The text has the answer: Pride and Prejudice writes both "Mr. Darcy" and
 *    "Miss Darcy", so "Darcy" is a FAMILY name, and no bare-surname link to it
 *    can be trusted for anybody. Vala et al. reach the same conclusion through
 *    inferred gender plus shortest-path surgery; asking the text directly is
 *    cheaper and needs no name-gender lexicon, which is worth avoiding in an
 *    app whose users write in every naming tradition there is.
 *
 *    Deliberately NOT a majority vote. "Mr. Darcy" outnumbers "Miss Darcy"
 *    many times over, so a majority would confidently return "male" and merge
 *    Georgiana anyway. The presence of both is the signal; the ratio is noise.
 */
export function surnameSharedByFamily(text: string, bare: string): boolean {
  if (!bare || bare.includes(" ")) return false;
  const n = esc(bare);
  const has = (titles: Iterable<string>) => {
    const alt = [...titles].join("|");
    return new RegExp(`${LB}(?:${alt})\\.?\\s+${n}${RB}`, "i").test(text);
  };
  return has(MALE_TITLES) && has(FEMALE_TITLES);
}

/**
 * Which rule, if any, links `form` to `canonical`? Null when nothing does.
 *
 * ★ ORDERED MOST-SPECIFIC FIRST, and the order carries the confidence. A form
 *   that is the canonical name plus a surname is near-certain; a bare surname
 *   is a guess that only survives because the uniqueness check upstream has
 *   already proved no other character could own it.
 */
function ruleFor(canonical: NameParts, form: NameParts): { rule: AliasRule; confidence: number } | null {
  if (canonical.bare.toLowerCase() === form.bare.toLowerCase()) {
    // Same name, different title: "Darcy" / "Mr. Darcy".
    return form.title || canonical.title ? { rule: "title-stripped", confidence: 0.95 } : null;
  }

  const cTok = canonical.tokens.map((t) => t.toLowerCase());
  const fTok = form.tokens.map((t) => t.toLowerCase());

  // "Elizabeth" → "Elizabeth Bennet": the canonical is the given name.
  if (cTok.length === 1 && fTok.length > 1 && fTok[0] === cTok[0]) {
    return { rule: "given-name", confidence: 0.9 };
  }
  // "Elizabeth Bennet" → "Elizabeth": the form is the given name.
  if (fTok.length === 1 && cTok.length > 1 && cTok[0] === fTok[0]) {
    return { rule: "given-name", confidence: 0.9 };
  }
  // "Elizabeth Bennet" → "Miss Bennet" / "Bennet": the form is the surname.
  if (cTok.length > 1 && fTok.length === 1 && cTok[cTok.length - 1] === fTok[0]) {
    return { rule: "family-name", confidence: 0.6 };
  }
  // ★ AND THE MIRROR: canonical "Holmes" → form "Sherlock Holmes". Without it
  //   the single case that motivated this whole file — a cast holding both
  //   "Holmes" and "Sherlock Holmes" — matched no rule at all.
  if (cTok.length === 1 && fTok.length > 1 && fTok[fTok.length - 1] === cTok[0]) {
    return { rule: "family-name", confidence: 0.6 };
  }
  // "E. Bennet" → "Elizabeth Bennet".
  if (cTok.length > 1 && fTok.length > 1
    && cTok[cTok.length - 1] === fTok[fTok.length - 1]
    && /^[a-z]\.?$/.test(fTok[0]) && cTok[0].startsWith(fTok[0][0])) {
    return { rule: "initial", confidence: 0.85 };
  }
  // "Lizzy" → "Elizabeth". Single token on both sides: multi-word forms encode
  // honorific conventions where the surname names a whole FAMILY, and merging
  // those needs context no morphology supplies.
  if (cTok.length === 1 && fTok.length === 1) {
    if (hypocorismOf(form.bare, canonical.bare)) return { rule: "hypocorism", confidence: 0.7 };
    if (hypocorismOf(canonical.bare, form.bare)) return { rule: "hypocorism", confidence: 0.7 };
  }
  return null;
}

/**
 * Propose aliases for every canonical character, from the surface forms the
 * book actually uses.
 *
 * `candidates` is the extracted name list (resolveSpeakerCandidates, or the
 * scan's own output); `characters` is what the writer has in worldData.
 */
export function proposeAliases(
  characters: readonly { name: string; aliases?: readonly string[] }[],
  candidates: readonly string[],
  text: string,
): AliasProposalResult {
  const proposals: AliasProposal[] = [];
  const rejected: AliasRejection[] = [];

  const canonicals = characters
    .map((c) => ({ raw: c.name.trim(), parts: splitName(c.name), known: new Set(
      [c.name, ...(c.aliases ?? [])].map((v) => v.trim().toLowerCase()),
    ) }))
    .filter((c) => c.raw.length >= 2);
  if (canonicals.length === 0) return { proposals, rejected };

  // Every canonical name and every already-confirmed alias, so a form that IS
  // somebody's name is never proposed as somebody else's nickname.
  const takenNames = new Set(canonicals.map((c) => c.raw.toLowerCase()));

  const seen = new Set<string>();
  for (const raw of candidates) {
    const form = raw.trim();
    const key = form.toLowerCase();
    if (form.length < 2 || seen.has(key)) continue;
    seen.add(key);

    const parts = splitName(form);

    // ★★ VALA ET AL.'S FIRST VETO, RECORDED BEFORE ANY LINK RULE RUNS. Same
    //    non-empty surname, different non-empty given names, is proof of two
    //    relatives. No link rule fires for that shape, so it was already
    //    refused — but by SILENCE, and a rule that exists only as a gap cannot
    //    be relied on or found by anyone reading the code. Written down
    //    because the model probe showed exactly what happens without it:
    //    qwen3-1.7b merged "Alise Verrin" into "Mera Verrin" at confidence 1.0,
    //    reasoning "both names share the same surname Verrin and are given
    //    different first names" — which is the proof they are two people.
    for (const c of canonicals) {
      if (c.known.has(key)) continue;
      if (distinctGivenNames(c.parts, parts)) {
        rejected.push({ character: c.raw, alias: form, veto: "distinct-given" });
      }
    }

    // Which canonical characters could own this form?
    const hits = canonicals
      .map((c) => ({ c, hit: c.known.has(key) ? null : ruleFor(c.parts, parts) }))
      .filter((h): h is { c: typeof canonicals[number]; hit: { rule: AliasRule; confidence: number } } => h.hit !== null);
    if (hits.length === 0) continue;

    // ★★ AMBIGUITY IS A VETO, NOT A TIE-BREAK. "Bennet" fits Elizabeth Bennet,
    //    Jane Bennet and Mr. Bennet; picking the most frequent would merge a
    //    family into one person, silently, everywhere. This is the check that
    //    replaces Vala's shortest-path surgery — a form that could belong to
    //    two characters belongs to neither.
    if (hits.length > 1) {
      for (const h of hits) rejected.push({ character: h.c.raw, alias: form, veto: "ambiguous" });
      continue;
    }

    const { c, hit } = hits[0];
    if (distinctGivenNames(c.parts, parts)) continue;   // already recorded above
    if (genderConflict(c.parts, parts)) {
      rejected.push({ character: c.raw, alias: form, veto: "honorific-gender" });
      continue;
    }
    // The surname the two names share belongs to a family, not to a person.
    // For `family-name` that surname is whichever side is a single token.
    const sharedBare = c.parts.bare.toLowerCase() === parts.bare.toLowerCase()
      ? c.parts.bare
      : hit.rule === "family-name"
        ? (parts.tokens.length === 1 ? parts.bare : c.parts.bare)
        : "";
    if (sharedBare && surnameSharedByFamily(text, sharedBare)) {
      rejected.push({ character: c.raw, alias: form, veto: "shared-surname" });
      continue;
    }
    if (coordinated(text, c.raw, form)) {
      rejected.push({ character: c.raw, alias: form, veto: "coordination" });
      continue;
    }
    const occurrences = countOf(text, form);
    if (occurrences < MIN_OCCURRENCES) {
      rejected.push({ character: c.raw, alias: form, veto: "too-rare" });
      continue;
    }

    // ★ WHICH NAME SURVIVES A MERGE IS THE ONE THE BOOK USES MORE, not the one
    //   that happens to be iterated first. The writer can still override it;
    //   the default should just match what they will see on the page.
    const isMerge = takenNames.has(key);
    let character = c.raw, alias = form;
    if (isMerge && countOf(text, form) > countOf(text, c.raw)) {
      character = form; alias = c.raw;
    }

    proposals.push({
      character,
      alias,
      kind: isMerge ? "merge" : "alias",
      rule: hit.rule,
      confidence: hit.confidence,
      // Of the name being FOLDED AWAY, which is what the writer is deciding
      // about. Before the flip this counted whichever side happened to be the
      // loop's `form`, so one pair reported 458 and its twin reported 94.
      occurrences: alias === form ? occurrences : countOf(text, alias),
      evidence: evidenceFor(text, alias),
      // A bare surname is the one rule that is a guess even after uniqueness:
      // "Bennet" surviving only means no OTHER character in worldData claims
      // it, and the writer may simply not have added the father yet.
      uncertain: hit.rule === "family-name",
    });
  }

  // ── two post-passes the per-form loop cannot do ─────────────────────────
  //
  // ★ A MERGE IS AN UNORDERED PAIR AND THE LOOP SEES IT TWICE. "Holmes" reaches
  //   "Sherlock Holmes" and "Sherlock Holmes" reaches "Holmes"; both flip to
  //   the same survivor and the writer would be asked the identical question
  //   twice in a row.
  const byPair = new Map<string, AliasProposal>();
  for (const p of proposals) {
    const pair = [p.character.toLowerCase(), p.alias.toLowerCase()].sort().join(" ");
    const prior = byPair.get(pair);
    if (!prior || p.confidence > prior.confidence) byPair.set(pair, p);
  }

  // ★★ AMBIGUITY HAS TO BE RE-CHECKED AFTER THE FLIP. The per-form check asks
  //    "could this FORM belong to two characters"; it cannot see that
  //    "Quincey" and "Morris" both resolved to swallowing "Quincey Morris", so
  //    the writer would get two independent-looking merges that fold one name
  //    into two different survivors. Same principle as before — a name claimed
  //    by two characters belongs to neither — applied to the output rather than
  //    to the input.
  const claimants = new Map<string, Set<string>>();
  for (const p of byPair.values()) {
    const key = p.alias.toLowerCase();
    const set = claimants.get(key) ?? new Set<string>();
    set.add(p.character.toLowerCase());
    claimants.set(key, set);
  }
  const kept: AliasProposal[] = [];
  for (const p of byPair.values()) {
    if ((claimants.get(p.alias.toLowerCase())?.size ?? 0) > 1) {
      rejected.push({ character: p.character, alias: p.alias, veto: "ambiguous" });
      continue;
    }
    kept.push(p);
  }

  kept.sort((a, b) =>
    a.character.localeCompare(b.character)
    || b.confidence - a.confidence
    || b.occurrences - a.occurrences
    || a.alias.localeCompare(b.alias));

  // The per-form pass and the post-pass can both refuse the same pair, and a
  // veto list that double-counts overstates how much the engine is refusing —
  // which is the number this file asks to be judged on.
  const seenRejection = new Set<string>();
  const uniqueRejections = rejected.filter((r) => {
    const key = `${r.character.toLowerCase()}|${r.alias.toLowerCase()}|${r.veto}`;
    if (seenRejection.has(key)) return false;
    seenRejection.add(key);
    return true;
  });
  return { proposals: kept, rejected: uniqueRejections };
}

/** Proposals for one character, in the order the UI should list them. */
export function proposalsFor(
  result: AliasProposalResult,
  character: string,
): AliasProposal[] {
  const key = character.trim().toLowerCase();
  return result.proposals.filter((p) => p.character.trim().toLowerCase() === key);
}
