/**
 * root-crown-buckets.ts — hand-labelled bucket gold for The Root Crown.
 *
 * ★ WHY A WHOLE-BOOK GOLD AND NOT MORE SYNTHETIC CASES. The synthetic groups in
 *   test-name-bucket-accuracy.ts each isolate ONE mechanism, which is what makes
 *   them good unit tests and exactly what makes them blind to the failure the
 *   writer actually sees: a 660KB manuscript where the same head word lands in
 *   two buckets and the tie-breaks all drain into one. Only a real book has the
 *   frequency distribution that produces that.
 *
 * ★ EVERY LABEL WAS READ OUT OF THE PROSE, not inferred from the name. The
 *   comment on each disputed entry is the sentence that decided it. A label
 *   nobody can point at a sentence for is not in here.
 *
 * ★ THIN NAMES ARE EXCLUDED BY A RULE, NOT BY A LIST. A name appearing fewer
 *   than THIN_OCCURRENCE_FLOOR times has been seen in fewer than three distinct
 *   sentences, which is not a usage pattern. Gating on those means tuning against noise —
 *   and a hand-written exclusion list is worse than useless, because the
 *   temptation is to move whichever name is currently failing into it. The
 *   harness computes the count from the manuscript and REPORTS the thin names
 *   and their accuracy separately. They are never hidden, only ungated.
 *
 * ★ AMBIGUOUS NAMES CARRY EVERY DEFENSIBLE LABEL. "The Pale House" is a
 *   building and a bureau in the same sentences; a gold that insists on one is
 *   measuring my preference, not the system's accuracy.
 */

export type GoldLabel = "character" | "place" | "faction" | "entity" | "drop";

export interface GoldEntry {
  /** Every label a careful reader could defend. First is the preferred one. */
  accept: GoldLabel[];
  /** The prose that decided it, when the name is not self-evident. */
  why?: string;
}

/** Below this many whole-word occurrences in the manuscript, a name is
 *  reported but not gated. See the header. */
export const THIN_OCCURRENCE_FLOOR = 3;

export const ROOT_CROWN_GOLD: Record<string, GoldEntry> = {
  // ── people ───────────────────────────────────────────────────────────────
  Kinoko:   { accept: ["character"] },
  Mira:     { accept: ["character"] },
  Vey:      { accept: ["character"] },
  Lyssa:    { accept: ["character"] },
  Gareth:   { accept: ["character"] },
  Dowsa:    { accept: ["character"] },
  Tessa:    { accept: ["character"] },
  Kel:      { accept: ["character"] },
  Anwen:    { accept: ["character"] },
  Vell:     { accept: ["character"] },
  Riven:    { accept: ["character"] },
  Halric:   { accept: ["character"] },
  Brennan:  { accept: ["character"] },
  Ifian:    { accept: ["character"] },
  Edrik:    { accept: ["character"] },
  Pala:     { accept: ["character"] },
  Lila:     { accept: ["character"] },
  Hessen:   { accept: ["character"] },
  Pella:    { accept: ["character"] },
  Tolen:    { accept: ["character"] },
  Anel:     { accept: ["character"] },
  Edis:     { accept: ["character"] },
  Halen:    { accept: ["character"] },
  Roak:     { accept: ["character"] },
  Caud:     { accept: ["character"] },
  Orest:    { accept: ["character"] },
  Torvan:   { accept: ["character"] },
  Prant:    { accept: ["character"] },
  Berwick:  { accept: ["character"] },
  Calwyn:   { accept: ["character"] },
  Marit:    { accept: ["character"] },
  Dovan:    { accept: ["character"] },
  Sera:     { accept: ["character"] },
  Odna:     { accept: ["character"] },
  Mer:      { accept: ["character"], why: '"Mer wanted the one about the mechanical systems"' },
  "Halen Drust": { accept: ["character"] },
  "Goodman Vell": { accept: ["character"] },
  "The Crown Prince": { accept: ["character"], why: "a titled person, determiner and all" },

  // A SURNAME IS A PERSON. Every determined use is attributive — the article
  // belongs to the head noun that follows, not to the name.
  Mosswell: {
    accept: ["character"],
    why: '"Tessa Mosswell", "Brennan Mosswell"; "the Mosswell loaves" is attributive',
  },

  // ── places ───────────────────────────────────────────────────────────────
  Myrhold:   { accept: ["place"], why: '"the modern city of Myrhold"' },
  Crossway:  { accept: ["place"], why: '"held the transit at Crossway"' },
  Mosshollow: {
    accept: ["place"],
    why: '"she felt for it at the Mosshollow", "returning to the Mosshollow house"',
  },
  Cymboll: {
    accept: ["place"],
    why: '"the substrate under Cymboll", "the Cymboll valley"',
  },
  Dovesmoor: {
    accept: ["place"],
    why: '"the Dovesmoor marshes", "his coat from the Dovesmoor meeting"',
  },
  "The Greythorn Quarter": { accept: ["place"] },
  "The Listenfold Clinic": { accept: ["place"] },
  "The Crown District":    { accept: ["place"] },
  "The Holden Street":     { accept: ["place"] },
  "The Anvas Quarter":     { accept: ["place"] },
  "The Outer Quarter":     { accept: ["place"] },
  "The Anvas Market":      { accept: ["place"] },
  "The Pale Office":       { accept: ["place"] },
  "The Quarry Edge":       { accept: ["place"] },
  "The Middle Ring":       { accept: ["place"] },
  "The Second Ring":       { accept: ["place"] },
  "The Outer Ring":        { accept: ["place"] },

  // A transit line and its station. "The Lift itself was a vertical transit —
  // a large counterweighted…" reads as a machine; "at the Drowner's Lift"
  // reads as a location. Both are defensible.
  Drowner: { accept: ["place", "entity"], why: '"the Drowner\'s Lift station bell"' },
  Lift:    { accept: ["place", "entity"], why: '"the Drowner\'s Lift running north-south"' },

  // ── institutions ─────────────────────────────────────────────────────────
  // school / college / guild are the codebase's own faction vocabulary, and
  // the four of them have to agree with each other whatever they get.
  "The Open School":        { accept: ["faction"] },
  "The Closed School":      { accept: ["faction"] },
  "The Mycomedical College": { accept: ["faction"] },
  "The Mycoflora Guild":    { accept: ["faction"] },
  "The Sealed Order":       { accept: ["faction"] },
  "The Pale House": {
    accept: ["place", "faction"],
    why: "a courtyard in one sentence, a bureau in the next",
  },

  // ── doctrines, systems, casting classes ──────────────────────────────────
  "The Old Script": { accept: ["entity"] },
  Growth:  { accept: ["entity"], why: '"the Growth foundational", "Growth-class substrate"' },
  Bind:    { accept: ["entity"], why: '"the Bind-containment, class A"' },
  Flow:    { accept: ["entity"], why: '"the Flow casting"' },
  Founding: { accept: ["entity"], why: '"pre-Founding notation", "Founding-era standardization"' },
  Network: { accept: ["entity", "faction"], why: '"asked the Network to intervene"' },
  "Outer Ring Anomaly": { accept: ["entity"], why: "a case file, not a group" },

  // ── named by their title, or by a family name ────────────────────────────
  "Magister Adena Volk": { accept: ["character"] },
  "Magister Volk":       { accept: ["character"] },
  "Crown Prince Sevren": { accept: ["character"] },
  "Pale Marshal Halen":  { accept: ["character"] },
  "Blacksmith Oren":     { accept: ["character"] },
  "Brother Ifian":       { accept: ["character"] },
  "Aunt Mira":           { accept: ["character"] },
  "Sarn Tolen":          { accept: ["character"] },
  "Pala Drest":          { accept: ["character"] },
  // Recovered when the context capture stopped swallowing repeat occurrences
  // inside its own 90-character window.
  Ovren: { accept: ["character"], why: '"the other one — Ovren\'s, on the north end"' },
  Mair:  { accept: ["character"], why: '"Mair\'s boy from the lower village"' },
  "Lila Vell":           { accept: ["character"] },
  "Anwen Vell":          { accept: ["character"] },
  "Tessa Mosswell":      { accept: ["character"] },
  "The Spore Warden": {
    accept: ["faction", "character"],
    why: '"a memorandum from the Spore Warden division" — a bureau named by a title',
  },

  // ── thin, but read and labelled like everything else ─────────────────────
  "Hollow Vein":  { accept: ["faction"], why: '"a Hollow Vein contact in the transit district"' },
  "The Northern Passes":  { accept: ["place"] },
  "The Hand Tower":       { accept: ["place"] },
  "The Inner Ring":       { accept: ["place"] },
  "The Tessane Lane":     { accept: ["place"] },
  "Conclave Closed School":    { accept: ["faction"] },
  "The Conclave Open School":  { accept: ["faction"] },
  "Pre-Imperial Monastic Practices": { accept: ["entity"] },
  "Greythorn Quarter Anomaly":       { accept: ["entity"] },
  "Active Investigation":            { accept: ["entity"] },
  Aldren: {
    accept: ["place", "faction"],
    why: '"the Aldren woman, the regional naming" — a region or the family from it',
  },

  // ── not names at all ─────────────────────────────────────────────────────
  Day:      { accept: ["drop"], why: '"Day 1", "Day 23", "Day 27" — a date label' },
  Don:      { accept: ["drop"], why: 'matched inside "Don\'t let them take it for scrap"' },
  Imperial: { accept: ["drop"], why: 'matched inside "pre-Imperial monastic chronicler"' },
  "Classify Crown Prince": { accept: ["drop"], why: "a verb glued to a title by a sentence boundary" },
  Mycomedical: { accept: ["drop", "entity"], why: "a fragment of The Mycomedical College" },
  Vells:       { accept: ["drop", "character"], why: '"the Vells had gone home" — the Vell family' },
};

/** Names the scan must not lose. Recall floor, checked separately from bucketing. */
export const MUST_FIND: readonly string[] = [
  "Kinoko", "Mira", "Vey", "Lyssa", "Gareth", "Dowsa", "Tessa", "Kel",
  "Myrhold", "Mosshollow", "Cymboll",
];
