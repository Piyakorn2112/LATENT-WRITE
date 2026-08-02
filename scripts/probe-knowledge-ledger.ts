/**
 * probe-knowledge-ledger.ts — is the "who knew what, when" check a product or a demo?
 *
 * The proposal: derive, from the draft alone, which characters have been
 * PRESENT when something came up, and flag when a character then talks about
 * something they were never in a scene for. Story bibles cannot do this
 * because they are maintained beside the manuscript and rot; a derived ledger
 * rebuilds on every edit.
 *
 * The question this probe answers is NOT "is it a good idea". It is: does a
 * usable number of candidates actually fall out of real books? Both failure
 * modes kill the feature:
 *
 *   ~0 per book   → nothing to show; it is a demo
 *   ~hundreds     → noise; every chapter lights up and the writer turns it off
 *
 * Definitions, deliberately narrow (see the honest-scope note at the bottom):
 *   entity     — a resolved cast/known name. Stands in for "a fact"; open-ended
 *                fact extraction is not tractable without a generative model.
 *   presence   — X spoke in chapter C (attributed dialogue).
 *   exposure   — entity E was named anywhere in chapter C.
 *   reference  — X, speaking, names E inside their own dialogue.
 *   candidate  — X references E in chapter N, and in NO chapter < N was X
 *                present while E was exposed. i.e. the first time X talks
 *                about E, X was never in a room where E came up.
 *
 * Reports raw and filtered rates, plus real citations to eyeball, because a
 * count without samples cannot tell noise from signal.
 *
 * ── WHAT THIS MEASURED (7 books, 141 chapters, 1049 speaker→entity pairs) ──
 *
 * VOLUME IS FINE. 1.55 surfaced per chapter after filtering — comfortably
 * inside the band where a writer would actually review them. The funnel also
 * named two whole failure classes and killed them:
 *
 *     620  no prior scene, narrow presence (raw)
 *    −155  25% were PRESENCE BUGS — "present" meant "spoke with ≥0.65
 *          attribution confidence", which misses everyone who is in the scene
 *          silently or is only named in narration
 *     −68  11% were DIRECT ADDRESS — "Good evening, Dance" is talking TO
 *          someone, not revealing knowledge of them
 *     397  survive
 *
 * ★★ PRECISION IS NOT. Reading the survivors, roughly one in eight is a real
 *    candidate. The residual failures are:
 *      1. attribution errors upstream — a line of Anne's attributed to Marilla
 *         because Marilla is named in it (she is the ADDRESSEE, not the speaker)
 *      2. entity-type confusion — Netherfield and Whitby are PLACES. The corpus
 *         carries no types; the real app HAS them via world-data scanAndClassify,
 *         so this class is an artifact of the probe, not of the product
 *      3. direct address the regex missed — "Now Joseph, you know the case"
 *      4. ★ LEGITIMATE OFFSCREEN / BACKSTORY KNOWLEDGE — pirates discussing
 *         Flint, a client briefing Holmes on people he has never met
 *
 * Classes 1–3 are fixable with signals that already exist. Class 4 is NOT a
 * lexical problem: telling "knows it from before page one" from "could not
 * possibly know this yet" is a judgment about the story, and no amount of
 * regex tuning reaches it. That is the honest boundary of the deterministic
 * approach, and it is exactly where an adjudication layer earns its place.
 *
 * So the shape of the feature is settled by measurement: the engines are a
 * high-recall CANDIDATE GENERATOR (cheap, deterministic, ~1.5/chapter), and
 * something with judgment adjudicates. Do not ship the generator alone.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/probe-knowledge-ledger.ts
 *   ... --samples 15
 */

import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { resolveKnownNames } from "../src/lib/world-data";
import { loadBook, splitParagraphs } from "./print-chapter";

const SAMPLES = Number(
  (process.argv.find((a) => a.startsWith("--samples="))?.split("=")[1]) ??
  (process.argv.includes("--samples") ? process.argv[process.argv.indexOf("--samples") + 1] : 8));

const BOOKS = ["pride", "sherlock", "anne", "dracula", "gatsby", "expectations", "treasure"];
const MAX_CHAPTERS = 24;
/** Attribution below this is too unsure to build a knowledge claim on. */
const MIN_ATTRIB_CONF = 0.65;

interface Ref { speaker: string; entity: string; chapter: number; book: string; quote: string; }

function esc(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

async function analyseBook(book: string) {
  const novel = await loadBook(book);
  const known = resolveKnownNames(novel);
  if (known.length < 3) return null;

  const chapters = novel.chapters.slice(0, MAX_CHAPTERS);
  // Per chapter: who was present (spoke), which entities were exposed, and
  // every (speaker → entity) reference made inside attributed dialogue.
  const present: Array<Set<string>> = [];
  const exposed: Array<Set<string>> = [];
  const refs: Ref[] = [];

  const patterns = known.map((n) => ({ name: n, re: new RegExp(`\\b${esc(n)}\\b`, "i") }));

  chapters.forEach((ch, ci) => {
    const paras = splitParagraphs(ch.content);
    const res = detectSpeechInChapter(paras, known);
    const p = new Set<string>();
    const e = new Set<string>();

    // Exposure: any known name appearing anywhere in the chapter.
    const whole = ch.content;
    for (const { name, re } of patterns) if (re.test(whole)) e.add(name);

    res.forEach((r, pi) => {
      for (const seg of r.segments) {
        if (seg.type !== "speech" || !seg.speaker) continue;
        if (seg.confidence < MIN_ATTRIB_CONF) continue;
        p.add(seg.speaker);
        const quote = paras[pi].slice(seg.start, seg.end);
        for (const { name, re } of patterns) {
          if (name === seg.speaker) continue;            // naming yourself is not a reference
          if (re.test(quote)) {
            refs.push({ speaker: seg.speaker, entity: name, chapter: ci, book, quote: quote.replace(/\s+/g, " ").slice(0, 150) });
          }
        }
      }
    });
    present.push(p);
    exposed.push(e);
  });

  // First chapter each entity is exposed at all — used to separate entities
  // INTRODUCED mid-book from ones the cast plausibly knew before page one.
  const firstExposure = new Map<string, number>();
  exposed.forEach((set, ci) => {
    for (const n of set) if (!firstExposure.has(n)) firstExposure.set(n, ci);
  });

  // ── FIX 1: presence was far too narrow ────────────────────────────────
  // "Present" was "spoke with ≥0.65 attribution confidence", which misses
  // every character who is in the scene silently or is only named in
  // narration. That inflates "never had a chance to learn it" enormously.
  // A character NAMED anywhere in a chapter is a much better proxy for
  // having been around for it.
  const presentWide = exposed.map((e, ci) => new Set([...present[ci], ...e]));

  // ── FIX 2: naming someone in the room is not a knowledge claim ────────
  // "Good evening, Dance" and "I trust, Mr. Holder, that you..." are direct
  // ADDRESS. The speaker is not revealing knowledge of a person, they are
  // talking to them. This was the single most common false positive.
  const vocative = (quote: string, entity: string) => {
    const e = esc(entity);
    return new RegExp(
      `(?:^|[,;:]|\\b(?:oh|well|yes|no|good\\s+\\w+|my\\s+dear|dear|thank\\s+you))\\s*` +
      `(?:mr|mrs|miss|ms|dr|sir|lady|lord)?\\.?\\s*${e}\\b\\s*[,.!?;:]`, "i").test(quote);
  };

  // Candidate = the FIRST time a speaker references an entity, with no prior
  // chapter where they were present while it was exposed.
  const seenPair = new Set<string>();
  const rawCandidates: Ref[] = [];
  const candidates: Ref[] = [];
  let droppedVocative = 0;
  let rescuedByPresence = 0;

  for (const r of refs) {
    const key = `${r.speaker}|${r.entity}`;
    if (seenPair.has(key)) continue;
    seenPair.add(key);

    let narrowChance = false, wideChance = false;
    for (let c = 0; c < r.chapter; c++) {
      if (present[c].has(r.speaker) && exposed[c].has(r.entity)) narrowChance = true;
      if (presentWide[c].has(r.speaker) && exposed[c].has(r.entity)) wideChance = true;
    }
    if (!narrowChance) rawCandidates.push(r);
    if (narrowChance) continue;
    if (wideChance) { rescuedByPresence++; continue; }
    if (vocative(r.quote, r.entity)) { droppedVocative++; continue; }
    candidates.push(r);
  }

  // The confound: entities present from chapter 0 are plausibly common
  // knowledge or backstory. An entity that only APPEARS at chapter k > 0 is
  // the interesting case, because someone had to learn it on the page.
  const midBook = candidates.filter((r) => (firstExposure.get(r.entity) ?? 0) > 0);

  return {
    book,
    chapters: chapters.length,
    cast: known.length,
    speakers: new Set(refs.map((r) => r.speaker)).size,
    refs: refs.length,
    pairs: seenPair.size,
    candidates,
    midBook,
    rawCount: rawCandidates.length,
    rescuedByPresence,
    droppedVocative,
  };
}

function pct(a: number, b: number) { return b ? `${((a / b) * 100).toFixed(1)}%` : "—"; }

async function main() {
  console.log("═".repeat(74));
  console.log("knowledge-ledger feasibility — does a usable number of candidates exist?");
  console.log("═".repeat(74));
  console.log(`\n  ${"book".padEnd(13)} ${"ch".padStart(3)} ${"cast".padStart(5)} ${"refs".padStart(6)} ${"pairs".padStart(6)} ${"cand".padStart(5)} ${"mid-book".padStart(9)} ${"per ch".padStart(7)}`);

  let T = { ch: 0, refs: 0, pairs: 0, cand: 0, mid: 0, raw: 0, resc: 0, voc: 0 };
  const allMid: Ref[] = [];

  for (const b of BOOKS) {
    const r = await analyseBook(b);
    if (!r) { console.log(`  ${b.padEnd(13)} (cast too small to test)`); continue; }
    T.ch += r.chapters; T.refs += r.refs; T.pairs += r.pairs;
    T.cand += r.candidates.length; T.mid += r.midBook.length;
    T.raw += r.rawCount; T.resc += r.rescuedByPresence; T.voc += r.droppedVocative;
    allMid.push(...r.midBook);
    console.log(
      `  ${r.book.padEnd(13)} ${String(r.chapters).padStart(3)} ${String(r.cast).padStart(5)} ` +
      `${String(r.refs).padStart(6)} ${String(r.pairs).padStart(6)} ${String(r.candidates.length).padStart(5)} ` +
      `${String(r.midBook.length).padStart(9)} ${(r.midBook.length / r.chapters).toFixed(2).padStart(7)}`);
  }

  console.log(`\n  ${"TOTAL".padEnd(13)} ${String(T.ch).padStart(3)} ${"".padStart(5)} ` +
    `${String(T.refs).padStart(6)} ${String(T.pairs).padStart(6)} ${String(T.cand).padStart(5)} ${String(T.mid).padStart(9)} ` +
    `${(T.mid / Math.max(1, T.ch)).toFixed(2).padStart(7)}`);

  console.log("\n  ── the funnel (each filter is a named failure class) ──");
  console.log(`  speaker→entity pairs found                  ${T.pairs}`);
  console.log(`  no prior scene, NARROW presence (raw)       ${T.raw}  (${pct(T.raw, T.pairs)})`);
  console.log(`   − had a chance once presence is widened    ${T.resc}  (${pct(T.resc, T.raw)} of raw were presence bugs)`);
  console.log(`   − direct address, not a knowledge claim    ${T.voc}  (${pct(T.voc, T.raw)} of raw)`);
  console.log(`  = survives both filters                     ${T.cand}  (${pct(T.cand, T.pairs)} of pairs)`);
  console.log(`  never had a scene to learn it (raw)   ${T.cand}  (${pct(T.cand, T.pairs)} of pairs)`);
  console.log(`  ...and the entity APPEARS mid-book    ${T.mid}  (${pct(T.mid, T.pairs)} of pairs)`);
  console.log(`  surfaced per chapter                  ${(T.mid / Math.max(1, T.ch)).toFixed(2)}`);

  // ── The verdict band ────────────────────────────────────────────────────
  const perCh = T.mid / Math.max(1, T.ch);
  console.log(`\n  ${"─".repeat(70)}`);
  if (perCh < 0.05) {
    console.log(`  ✗ TOO SPARSE — ${perCh.toFixed(2)}/chapter. Nothing to show; this is a demo.`);
  } else if (perCh > 4) {
    console.log(`  ✗ TOO NOISY — ${perCh.toFixed(2)}/chapter. Every chapter lights up; it gets switched off.`);
  } else {
    console.log(`  ✓ IN BAND — ${perCh.toFixed(2)}/chapter is a reviewable number.`);
    console.log(`    Precision is NOT measured here. Read the samples below and judge.`);
  }
  console.log(`  ${"─".repeat(70)}`);

  console.log(`\n  ── samples (read these; the count alone cannot tell noise from signal) ──`);
  const step = Math.max(1, Math.floor(allMid.length / SAMPLES));
  for (let i = 0, n = 0; i < allMid.length && n < SAMPLES; i += step, n++) {
    const r = allMid[i];
    console.log(`\n  [${r.book} ch${r.chapter + 1}] ${r.speaker} names "${r.entity}" with no prior shared scene`);
    console.log(`     “${r.quote}”`);
  }
  console.log(`\n${"═".repeat(74)}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
