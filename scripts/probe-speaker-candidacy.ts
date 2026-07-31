/**
 * probe-speaker-candidacy.ts — which cheap signals separate an entity that CAN
 * speak from one that cannot?
 *
 * The failure funnel says 15.2% of bare dialogue lines are attributed to
 * something that never speaks anywhere in the book — `Body`, `Assembly`,
 * `Meridian`, `The Drift Belt`. That is not an extraction bug: in the manuscript
 * where it happens, `Body` really is capitalised mid-sentence 74 times
 * (`Body-A`, `Body C`), so it is a genuine in-world proper noun. It is simply
 * not a PERSON, and `resolveKnownNames` hands characters, places, factions and
 * entities to speech-detect as one flat list of candidate speakers.
 *
 * Before writing a rule, measure which signals actually discriminate. Each rule
 * below is scored against the label "carries an explicit speech tag somewhere in
 * this book", reported as: of the entities the rule ADMITS, what share are real
 * speakers (precision), and of the real speakers, what share survive (recall).
 *
 * Recall is the one that matters most: dropping a real character from the
 * candidate set makes every line they speak unattributable, which is a worse
 * failure than admitting a distractor that context will usually outvote.
 *
 * ★ The label has known false negatives — first-person narrators (Watson, Pip)
 * speak constantly and are rarely tagged — so a rule that "loses" those is not
 * necessarily wrong. Reported, not hidden.
 */

import { BOOKS, CORPUS_BOOKS, loadBook, splitParagraphs } from "./print-chapter";
import { resolveKnownNames } from "../src/lib/world-data";

const ALL_BOOK_KEYS = [...Object.keys(BOOKS), ...Object.keys(CORPUS_BOOKS)].filter((k) => k !== "sample");

const HONORIFIC_ALT = [
  "Mr", "Mrs", "Ms", "Dr", "Miss", "Sir", "Lord", "Lady", "Captain", "Colonel",
  "Professor", "Aunt", "Uncle", "Madame", "Monsieur", "Mademoiselle",
].join("|");
const VERBS = "said|asked|replied|answered|cried|exclaimed|murmured|whispered|shouted|added|returned";
const NAME = `(?:(?:${HONORIFIC_ALT})\\.?\\s+)?[A-Z][A-Za-z'’-]+`;
const TAG_G = new RegExp(
  `[”"]\\s*,?\\s*(?:(?:${VERBS})\\s+(${NAME})|(${NAME})\\s+(?:\\w+\\s+){0,1}(?:${VERBS}))\\s*[.!?]`, "g");

function bareSurname(raw: string): string {
  const s = raw.replace(new RegExp(`^(?:${HONORIFIC_ALT})\\.?\\s+`), "");
  return s.trim().split(/\s+/).pop() ?? s;
}
function esc(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

interface Feat {
  name: string;
  book: string;
  isSpeaker: boolean;
  occ: number;
  theRatio: number;      // share of occurrences preceded by "the"/"a"/"an"
  possRatio: number;     // share followed by 's  (Nora's hand)
  verbRatio: number;     // share followed by a person-action/speech verb
  pronounRatio: number;  // share within 60 chars of he/she/him/her
  multiWord: boolean;
}

async function main() {
  const feats: Feat[] = [];

  for (const key of ALL_BOOK_KEYS) {
    let novel;
    try { novel = await loadBook(key); } catch { continue; }
    const knownNames = resolveKnownNames(novel);
    const paras: string[] = [];
    for (const c of novel.chapters) paras.push(...splitParagraphs(c.content));
    const text = paras.join("\n");

    const speakers = new Set<string>();
    TAG_G.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_G.exec(text))) {
      const raw = m[1] ?? m[2];
      if (raw) speakers.add(bareSurname(raw).toLowerCase());
    }

    for (const name of knownNames) {
      const re = new RegExp(`(.{0,6})\\b${esc(name)}\\b(.{0,26})`, "g");
      let occ = 0, the = 0, poss = 0, verb = 0, pron = 0;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(text))) {
        occ++;
        if (/\b(?:the|a|an)\s$/i.test(mm[1])) the++;
        if (/^['’]s\b/.test(mm[2])) poss++;
        if (/^\s+(?:said|asked|replied|answered|cried|nodded|shrugged|smiled|frowned|laughed|sighed|looked|turned|walked|stood|sat|thought|knew|felt|whispered|muttered|added)\b/i.test(mm[2])) verb++;
        if (/\b(?:he|she|him|her|his|hers)\b/i.test(mm[2])) pron++;
      }
      if (occ < 2) continue;
      feats.push({
        name, book: key,
        isSpeaker: speakers.has(bareSurname(name).toLowerCase()),
        occ,
        theRatio: the / occ, possRatio: poss / occ, verbRatio: verb / occ, pronounRatio: pron / occ,
        multiWord: /\s/.test(name),
      });
    }
  }

  const nSpk = feats.filter((f) => f.isSpeaker).length;
  console.log(`\n═══ SPEAKER CANDIDACY — ${feats.length} entities, ${nSpk} of them real speakers ═══\n`);

  const rules: Array<[string, (f: Feat) => boolean]> = [
    ["admit everything (today)",        () => true],
    ["theRatio < 0.10",                 (f) => f.theRatio < 0.10],
    ["theRatio < 0.25",                 (f) => f.theRatio < 0.25],
    ["theRatio < 0.50",                 (f) => f.theRatio < 0.50],
    ["single word only",                (f) => !f.multiWord],
    ["possRatio > 0",                   (f) => f.possRatio > 0],
    ["verbRatio > 0",                   (f) => f.verbRatio > 0],
    ["theRatio<0.25 AND single word",   (f) => f.theRatio < 0.25 && !f.multiWord],
    ["theRatio<0.25 OR possRatio>0",    (f) => f.theRatio < 0.25 || f.possRatio > 0],
    ["theRatio<0.5 AND (poss|verb)",    (f) => f.theRatio < 0.5 && (f.possRatio > 0 || f.verbRatio > 0)],
    ["poss>0 OR verb>0",                (f) => f.possRatio > 0 || f.verbRatio > 0],
  ];

  console.log(`  ${"rule".padEnd(32)}${"admits".padStart(8)}${"prec".padStart(8)}${"recall".padStart(8)}   lost speakers`);
  for (const [label, fn] of rules) {
    const admitted = feats.filter(fn);
    const tp = admitted.filter((f) => f.isSpeaker).length;
    const lost = feats.filter((f) => f.isSpeaker && !fn(f));
    const prec = admitted.length ? (tp / admitted.length) * 100 : 0;
    const rec = nSpk ? (tp / nSpk) * 100 : 0;
    const names = lost.slice(0, 4).map((f) => f.name).join(", ");
    console.log(`  ${label.padEnd(32)}${String(admitted.length).padStart(8)}${prec.toFixed(1).padStart(7)}%${rec.toFixed(1).padStart(7)}%   ${lost.length}${names ? ` (${names})` : ""}`);
  }

  console.log(`\n  ── entities the "theRatio<0.25 OR poss>0" rule would DROP, most frequent first ──`);
  const dropped = feats.filter((f) => !(f.theRatio < 0.25 || f.possRatio > 0)).sort((a, b) => b.occ - a.occ);
  for (const f of dropped.slice(0, 24)) {
    console.log(`    ${f.name.padEnd(24)} ${f.book.padEnd(13)} occ=${String(f.occ).padStart(4)} the=${(f.theRatio * 100).toFixed(0).padStart(3)}%  ${f.isSpeaker ? "★ IS A SPEAKER" : ""}`);
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
