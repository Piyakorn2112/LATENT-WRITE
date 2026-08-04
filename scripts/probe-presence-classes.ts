/**
 * probe-presence-classes.ts — is a name in a chapter the same thing as a
 * character IN that chapter?
 *
 * The timeline's cast ledger draws a bar whenever a character's name matches
 * anywhere in a chapter (`buildTimelineCharacterTracks`, countMatchers), and
 * `charactersPresent` is built from a bare `chapter.content.includes(c.name)`.
 * Both say PRESENT for a woman three counties away whose sister mentions her.
 *
 * The literature has a name for the distinction and, importantly, does NOT
 * solve it: the Corpus Novelties NER guidelines annotate presence and evocation
 * IDENTICALLY and say "we assume that distinguishing both types of entity
 * mentions (presence vs. evocation) can be done in a later step". So there is
 * no gold set to borrow and no off-the-shelf classifier — but the distinction
 * is real and it is exactly the one the ledger is getting wrong.
 *
 * ★ WHAT THE FIRST TWO RUNS OF THIS PROBE TAUGHT, both by READING the samples:
 *
 *   1. A verb WORD LIST cannot carry this. "Elizabeth Bennet had been obliged
 *      to sit down", "Jane was as much gratified", "when Jane and Elizabeth
 *      were alone" are all presence and all missed by NAME+action-verb, because
 *      real prose puts auxiliaries and appositives between the two.
 *   2. The signal that DOES separate them is positional and costs nothing:
 *      **where the name sits relative to the quotation marks.** A name that
 *      appears only INSIDE dialogue is being talked about. A name in NARRATION
 *      is on the page. Vocatives are the one systematic exception and they are
 *      cheap to catch.
 *
 *   /opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs scripts/probe-presence-classes.ts
 */
import { loadBook } from "./print-chapter";
import { resolveSpeakerCandidates } from "../src/lib/world-data";

// ★ DEV half of the fixed split, INLINED. Importing it from
//   test-masked-attribution runs that module's main() — 786 masked lines and
//   45s of attribution — as a side effect of asking for a constant.
const BOOKS = ["sherlock", "pride", "dracula", "carol", "expectations", "webnovel"];
const MAX_CHAPTERS = 14;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * ★ `returned` AND `called` ARE AMBIGUOUS, and that was a measured defect in
 *   the first run: "he returned to England" and "a place called London" put
 *   England, London and Baker Street into the cast as speaking characters, so
 *   39% of the "mention-only" marks were place names. Both are genuine
 *   Victorian dialogue tags AND high-frequency non-speech verbs; the QUOTE
 *   ADJACENCY below is what disambiguates them, not the word list.
 */
const SPEECH_VERB =
  "(?:said|says|asked|asks|replied|answered|cried|whispered|shouted|murmured|" +
  "added|told|muttered|observed|remarked|exclaimed|repeated|returned|called)";
const CLOSE_Q = `["”]`;
const OPEN_Q = `["“]`;

/** Finite-verb heads, INCLUDING auxiliaries. "had been obliged" is a predicate
 *  even though none of its words is an action.
 *
 *  ★ THE SPEECH VERBS ARE IN HERE TOO, and leaving them out was a measured
 *    recall bug: "Mr. Darcy said very little" is a narrator's REPORT of speech
 *    with no quotation anywhere near it, so the quote-adjacent `speaks` test
 *    cannot see it and the subject test skipped the commonest verb in fiction. */
const FINITE =
  "(?:was|were|is|are|am|had|has|have|would|could|should|will|shall|did|does|" +
  "do|might|may|must|been|being|seemed|felt|knew|thought|saw|heard|looked|" +
  "turned|took|came|went|made|gave|found|began|stood|sat|rose|walked|" +
  "stepped|entered|smiled|laughed|nodded|spoke|watched|waited|left|" +
  "said|says|asked|asks|replied|answered|cried|whispered|shouted|murmured|" +
  "added|told|muttered|observed|remarked|exclaimed|repeated)";

/** Titles ride WITH the name in prose, so any pattern that anchors on a
 *  delimiter before the name has to step over them. "welcome, Mr. Harker, to
 *  my house" is a vocative and the first version of this probe missed it. */
const TITLE = "(?:Mr|Mrs|Ms|Miss|Dr|Sir|Lord|Lady|Captain|Colonel|Professor|" +
  "Madam|Madame|Monsieur|Aunt|Uncle|Father|Mother)\\.?\\s+";

/** Verbs whose COMPLEMENT CLAUSE is an intensional context: a name inside
 *  "she asked whether X had been at Longbourn" is evoked, never present. This
 *  is the one principled veto in the set — it is about clause embedding, not
 *  about which words happen to be nearby. */
const REPORT_VERB =
  "(?:said|says|asked|asks|replied|answered|told|thought|believed|hoped|" +
  "wondered|supposed|imagined|remembered|heard|knew|feared|declared|wrote)";

/** Replace every quoted span with same-length spaces, so offsets survive and
 *  narration can be searched on its own. */
function maskDialogue(text: string): { narration: string; dialogue: string } {
  const chars = text.split("");
  const narr = text.split("");
  let inQ = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === "“" || (c === '"' && !inQ)) { inQ = true; narr[i] = " "; continue; }
    if (c === "”" || (c === '"' && inQ)) { inQ = false; narr[i] = " "; continue; }
    if (inQ) narr[i] = " ";
  }
  const dial = chars.map((c, i) => (narr[i] === " " && c !== " " ? c : " ")).join("");
  return { narration: narr.join(""), dialogue: dial };
}

interface Evidence {
  mentions: number;
  narrationHits: number;
  dialogueHits: number;
  speaks: boolean;
  addressed: boolean;
  subject: boolean;
  object: boolean;
  reported: boolean;
}

function evidenceFor(text: string, name: string): Evidence {
  const n = esc(name);
  const word = new RegExp(`\\b${n}\\b`, "g");
  const { narration, dialogue } = maskDialogue(text);

  const mentions = (text.match(word) ?? []).length;
  const narrationHits = (narration.match(word) ?? []).length;
  const dialogueHits = (dialogue.match(word) ?? []).length;

  // SPEAKS — a dialogue tag, which by definition sits against a QUOTE.
  // Requiring the quote separates "'Yes,' he returned" from "he returned to
  // England": same verb, and only one of them is speech.
  const speaks =
    new RegExp(`${CLOSE_Q}\\s*[,.]?\\s*(?:${SPEECH_VERB}\\s+${n}|${n}\\s+(?:\\w+\\s+){0,2}${SPEECH_VERB})\\b`).test(text) ||
    new RegExp(`\\b(?:${SPEECH_VERB}\\s+${n}|${n}\\s+(?:\\w+\\s+){0,2}${SPEECH_VERB})\\b\\s*[,:]?\\s*${OPEN_Q}`).test(text);

  // ADDRESSED — a vocative inside dialogue. If someone in the scene speaks to
  // them by name they are in the scene, and no mention count can see this.
  const addressed = new RegExp(
    `(?:^|[,;:!?]\\s*|\\b(?:oh|well|yes|no|but|why|now|dear|my|good|thank you)\\s+)` +
    `(?:${TITLE})?${n}\\b\\s*[,.!?]`, "i",
  ).test(dialogue);

  // SUBJECT — the name heads a finite clause in NARRATION. Allows one
  // appositive or coordination between the name and its verb, which is what
  // "Catherine and Lydia had been fortunate" needs.
  const subject = new RegExp(
    `\\b${n}\\b(?:\\s+(?:and|or)\\s+[A-Z]\\w+|,[^,.;!?]{2,40},)?\\s+(?:\\w+ly\\s+)?${FINITE}\\b`,
  ).test(narration);

  // OBJECT — someone in the scene acts ON them: "danced with Miss Bingley",
  // "waited on Mr. Bingley", "desiring her mother to visit Jane".
  const object = new RegExp(
    `\\b${FINITE}\\b(?:\\s+\\w+){0,2}\\s+(?:with|on|at|to|upon|toward|towards|for|from|after|beside)?\\s*(?:${TITLE})?${n}\\b`,
  ).test(narration);

  // REPORTED — every narration mention sits inside a complement clause of a
  // speech or cognition verb, so the name is inside someone's words or head.
  const reported = new RegExp(
    `\\b${REPORT_VERB}\\b(?:\\s+\\w+){0,3}\\s+(?:that|whether|if|about|of)\\s+(?:\\w+\\s+){0,4}(?:${TITLE})?${n}\\b`,
  ).test(narration);

  return { mentions, narrationHits, dialogueHits, speaks, addressed, subject, object, reported };
}

/** How many times the whole book tags this name as a speaker. The cast filter
 *  wants TWO, so one accidental match cannot admit a place name. */
function dialogueTagCount(text: string, name: string): number {
  const n = esc(name);
  const g = (src: string) => (text.match(new RegExp(src, "g")) ?? []).length;
  return (
    g(`${CLOSE_Q}\\s*[,.]?\\s*(?:${SPEECH_VERB}\\s+${n}|${n}\\s+(?:\\w+\\s+){0,2}${SPEECH_VERB})\\b`) +
    g(`\\b(?:${SPEECH_VERB}\\s+${n}|${n}\\s+(?:\\w+\\s+){0,2}${SPEECH_VERB})\\b\\s*[,:]?\\s*${OPEN_Q}`)
  );
}

async function main() {
  console.log("═".repeat(78));
  console.log("presence vs evocation — what the ledger's bars actually mean");
  console.log("═".repeat(78));

  let marks = 0, chapters = 0;
  const tally = {
    speaks: 0, addressed: 0, subject: 0, object: 0, reported: 0,
    onPage: 0, objectOnly: 0, narrOnlyWeak: 0, dialogueOnly: 0, bare: 0,
  };
  const dialogueOnlySamples: string[] = [];
  const weakSamples: string[] = [];

  for (const book of BOOKS) {
    const novel = await loadBook(book);
    // ★ THE CAST FILTER IS PART OF THE MEASUREMENT, NOT SETUP.
    //   resolveSpeakerCandidates returns speaker CANDIDATES; on Sherlock that
    //   list holds "London", "Baker Street" and "Let". A name tagged as a
    //   speaker twice in the book is a person.
    const whole = novel.chapters.map((c) => c.content).join("\n");
    const candidates = resolveSpeakerCandidates(novel);
    const cast = candidates.filter((n) => dialogueTagCount(whole, n) >= 2).slice(0, 12);
    if (cast.length < 3) { console.log(`  (${book}: cast too small — ${cast.length})`); continue; }

    let bookMarks = 0, bookEvocation = 0;
    for (const chapter of novel.chapters.slice(0, MAX_CHAPTERS)) {
      chapters++;
      const text = chapter.content;
      if (!text.trim()) continue;
      for (const name of cast) {
        const ev = evidenceFor(text, name);
        if (ev.mentions === 0) continue;      // the ledger draws nothing here
        marks++; bookMarks++;

        if (ev.speaks) tally.speaks++;
        if (ev.addressed) tally.addressed++;
        if (ev.subject) tally.subject++;
        if (ev.object) tally.object++;
        if (ev.reported) tally.reported++;

        if (ev.speaks || ev.addressed || ev.subject) { tally.onPage++; continue; }
        if (ev.object && !ev.reported) { tally.objectOnly++; continue; }

        if (ev.narrationHits === 0) {
          tally.dialogueOnly++; bookEvocation++;
          if (dialogueOnlySamples.length < 8) {
            const at = text.search(new RegExp(`\\b${esc(name)}\\b`));
            dialogueOnlySamples.push(`${book} ch${chapter.number} ${name} (${ev.mentions}×): …${
              text.slice(Math.max(0, at - 55), at + 75).replace(/\s+/g, " ")}…`);
          }
        } else {
          tally.narrOnlyWeak++;
          if (ev.mentions === 1) tally.bare++;
          if (weakSamples.length < 8) {
            const at = text.search(new RegExp(`\\b${esc(name)}\\b`));
            weakSamples.push(`${book} ch${chapter.number} ${name} (${ev.mentions}×): …${
              text.slice(Math.max(0, at - 55), at + 75).replace(/\s+/g, " ")}…`);
          }
        }
      }
    }
    console.log(`  ${book.padEnd(14)} ${String(bookMarks).padStart(4)} marks, ` +
      `${String(bookEvocation).padStart(3)} dialogue-only  ` +
      `${Math.round((bookEvocation / Math.max(1, bookMarks)) * 100)}%`);
  }

  const pct = (n: number) => `${Math.round((n / Math.max(1, marks)) * 100)}%`.padStart(4);
  console.log(`\nover ${chapters} chapters, ${marks} ledger marks — all drawn identically today\n`);
  console.log(`  speaks    (dialogue tag)        ${String(tally.speaks).padStart(5)}  ${pct(tally.speaks)}`);
  console.log(`  addressed (vocative in quote)   ${String(tally.addressed).padStart(5)}  ${pct(tally.addressed)}`);
  console.log(`  subject   (finite clause)       ${String(tally.subject).padStart(5)}  ${pct(tally.subject)}`);
  console.log(`  object    (acted upon)          ${String(tally.object).padStart(5)}  ${pct(tally.object)}`);
  console.log(`  reported  (complement clause)   ${String(tally.reported).padStart(5)}  ${pct(tally.reported)}`);
  console.log(`  ${"─".repeat(52)}`);
  console.log(`  ── ON PAGE  speaks|addressed|subject   ${String(tally.onPage).padStart(5)}  ${pct(tally.onPage)}`);
  console.log(`  ── OBJECT ONLY, not reported          ${String(tally.objectOnly).padStart(5)}  ${pct(tally.objectOnly)}`);
  console.log(`  ── narration, no predicate            ${String(tally.narrOnlyWeak).padStart(5)}  ${pct(tally.narrOnlyWeak)}`);
  console.log(`  ── DIALOGUE ONLY (evocation)          ${String(tally.dialogueOnly).padStart(5)}  ${pct(tally.dialogueOnly)}`);
  console.log(`       of the weak-narration set, a single bare mention: ${tally.bare}`);
  const ambiguous = tally.objectOnly + tally.narrOnlyWeak;
  console.log(`\n  ★ THE MODEL'S JOB IS THE MIDDLE: ${ambiguous} marks (${pct(ambiguous).trim()}) that the`);
  console.log(`    deterministic signals cannot call either way. Everything else is decided.`);

  console.log(`\nDIALOGUE-ONLY — named inside quotes, never in narration:`);
  for (const s of dialogueOnlySamples) console.log(`  · ${s}`);
  console.log(`\nNARRATION, NO PREDICATE — the genuinely ambiguous middle:`);
  for (const s of weakSamples) console.log(`  · ${s}`);
  console.log("═".repeat(78));
}

main().catch((e) => { console.error(e); process.exit(1); });
