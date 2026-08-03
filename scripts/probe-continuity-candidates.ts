/**
 * probe-continuity-candidates.ts — which replacement signals actually fire?
 *
 * probe-continuity-quality.ts established the diagnosis: out-of-order fires
 * 0.00 times per chapter (dead by construction), hand-off 0.03, and Chekhov
 * fires 4.92 times with phrases that are mostly not things. Before rebuilding
 * any of them, measure the CANDIDATE definitions the way the wave-2 funnels
 * were measured: a signal nobody can see fire is dead weight, and one that
 * fires a dozen times a chapter is a widget the writer stops opening.
 *
 * ★ MEASURE THE DEFINITION, NOT THE INTENTION. Every idea below sounds useful
 *   in prose. The rate is what decides.
 *
 *   /opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs scripts/probe-continuity-candidates.ts
 */
import { loadBook } from "./print-chapter";
import { resolveSpeakerCandidates } from "../src/lib/world-data";
import { findChekhovCandidates } from "../src/lib/continuity";
import type { Chapter } from "../src/types";

const DEV_BOOKS = ["pride", "sherlock", "anne", "dracula", "carol", "webnovel"];
const MAX_CHAPTERS = 12;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Speech verbs that mark a name as PRESENT rather than merely discussed. */
const SPEECH_VERB = "(?:said|asked|replied|answered|cried|whispered|shouted|murmured|added|told|muttered|called)";
/** Physical verbs — a thing someone HANDLES is a thing that can be a promise. */
const HANDLE_VERB = new Set([
  "put","took","take","held","hold","carried","carry","opened","open","closed",
  "locked","lock","hid","hide","drew","draw","set","lifted","lift","broke",
  "break","picked","pick","dropped","drop","pulled","pull","pushed","push",
  "wore","wear","gave","give","handed","hand","threw","throw","kept","keep",
  "reached","touched","touch","grabbed","grab","slipped","packed","loaded",
  "sealed","seal","buried","bury","wrapped","folded","placed","place","laid",
  "lay","pocketed","clutched","gripped","raised","turned","tore","cut",
]);
/** Abstract-noun endings. "plainness", "geniality", "resolution" are not props. */
const ABSTRACT_SUFFIX = /(?:ness|ity|tion|sion|ment|ance|ence|ism|ship|hood|acy|ancy|ency|itude|dom)$/;

/** Is this name PRESENT in the text — speaking or acting — not just named? */
function presentIn(text: string, names: string[]): boolean {
  for (const name of names) {
    const n = escapeRe(name);
    // "X said" / "said X" / X immediately before or after a quotation.
    if (new RegExp(`\\b${n}\\b[^.!?"“”]{0,40}\\b${SPEECH_VERB}\\b`, "i").test(text)) return true;
    if (new RegExp(`\\b${SPEECH_VERB}\\b\\s+${n}\\b`, "i").test(text)) return true;
    if (new RegExp(`["“][^"“”]{2,200}["”]\\s*[,.]?\\s*${n}\\b`, "i").test(text)) return true;
  }
  return false;
}

interface Row { label: string; hits: number }

async function main() {
  console.log("═".repeat(78));
  console.log("continuity — candidate replacement signals, measured");
  console.log("═".repeat(78));

  const tally = new Map<string, number>();
  const samples = new Map<string, string[]>();
  const bump = (k: string, sample?: string) => {
    tally.set(k, (tally.get(k) ?? 0) + 1);
    if (sample) {
      const s = samples.get(k) ?? [];
      if (s.length < 6) { s.push(sample); samples.set(k, s); }
    }
  };
  let chapters = 0;

  for (const book of DEV_BOOKS) {
    const novel = await loadBook(book);
    const all: Chapter[] = novel.chapters;
    // ★ THE CAST COMES FROM THE ENGINE, NOT FROM worldData. DEV books ship
    //   with worldData.characters EMPTY, which is the second reason
    //   findOutOfOrderMentions never fires in the real app: even with its
    //   logic fixed it iterates a list that is usually empty. The app resolves
    //   the cast through resolveSpeakerCandidates, so the probe must too.
    const cast = resolveSpeakerCandidates(novel).map((name) => ({ name }));
    if (cast.length < 3) { console.log(`  (${book}: cast too small)`); continue; }

    // Per character: first chapter that MENTIONS them, first that has them PRESENT.
    const firstMention = new Map<string, number>();
    const firstPresent = new Map<string, number>();
    for (const ch of cast) {
      const names = [ch.name];
      const re = new RegExp(`\\b(?:${names.map(escapeRe).join("|")})\\b`, "i");
      for (let i = 0; i < all.length; i++) {
        if (firstMention.has(ch.name) === false && re.test(all[i].content)) firstMention.set(ch.name, i);
        if (firstPresent.has(ch.name) === false && presentIn(all[i].content, names)) firstPresent.set(ch.name, i);
        if (firstMention.has(ch.name) && firstPresent.has(ch.name)) break;
      }
    }

    all.slice(0, MAX_CHAPTERS).forEach((chapter, index) => {
      chapters++;
      const text = chapter.content;
      if (!text.trim()) return;

      for (const ch of cast) {
        const names = [ch.name];
        const re = new RegExp(`\\b(?:${names.map(escapeRe).join("|")})\\b`, "i");
        if (!re.test(text)) continue;
        const mention = firstMention.get(ch.name);
        const present = firstPresent.get(ch.name);

        // A · TALKED ABOUT LONG BEFORE THEY APPEAR. The reader hears the name
        //     for chapters before the character ever speaks or acts.
        if (mention === index && present !== undefined && present - index >= 3) {
          bump("A talked-about ≥3ch before appearing", `${book} ch${index + 1}: ${ch.name} → appears ch${present + 1}`);
        }
        // B · WALKS ON WITH NO SETUP. First time the book names them is also
        //     the chapter they speak/act in, and it is late in the book.
        if (mention === index && present === index && index >= Math.floor(all.length * 0.3)) {
          bump("B late arrival, no prior mention", `${book} ch${index + 1}: ${ch.name}`);
        }
        // C · NAMED BUT NEVER PRESENT ANYWHERE. Discussed the whole book and
        //     never once on the page.
        if (mention === index && present === undefined) {
          bump("C named but never appears", `${book} ch${index + 1}: ${ch.name}`);
        }
      }
    });
  }

  console.log(`\nover ${chapters} chapters\n`);
  const rows: Row[] = [...tally.entries()].map(([label, hits]) => ({ label, hits }));
  rows.sort((a, b) => b.hits - a.hits);
  for (const r of rows) {
    const per = r.hits / Math.max(1, chapters);
    const call = per < 0.03 ? "TOO SPARSE — dead weight"
      : per > 3 ? "TOO NOISY — the widget gets ignored"
      : per > 1 ? "HIGH — needs a cut"
      : "IN BAND";
    console.log(`  ${r.label.padEnd(34)} ${String(r.hits).padStart(4)}  ${per.toFixed(2)}/ch  ${call}`);
    for (const s of samples.get(r.label) ?? []) console.log(`      · ${s}`);
  }
  if (rows.length === 0) console.log("  (nothing fired at all)");

  // ── Chekhov concreteness, on the SHIPPED extractor's output ─────────────
  //
  // ★ MEASURED AGAINST findChekhovCandidates, NOT A COPY OF ITS REGEX. The
  //   first version of this probe re-implemented the pattern and so measured
  //   prose the shipped filters already reject ("disgust which", "subject
  //   which"), which made every filter look useless.
  console.log(`\n${"─".repeat(78)}\nchekhov concreteness, on what the engine actually emits\n`);
  let total = 0, abstract = 0, participle = 0, handled = 0;
  const kept: string[] = [], cutAbstract: string[] = [], cutVerb: string[] = [], cutUnhandled: string[] = [];
  for (const book of DEV_BOOKS) {
    const novel = await loadBook(book);
    for (let i = 0; i < Math.min(MAX_CHAPTERS, novel.chapters.length); i++) {
      const text = novel.chapters[i].content;
      for (const c of findChekhovCandidates(novel.chapters, i, 99)) {
        total++;
        const head = c.phrase.split(/\s+/).pop() ?? "";
        const isAbstract = ABSTRACT_SUFFIX.test(head);
        const isParticiple = /(?:ed|ing)$/.test(head);
        const at = text.toLowerCase().indexOf(c.phrase.toLowerCase());
        const before = at > 0 ? text.slice(Math.max(0, at - 70), at).toLowerCase() : "";
        const isHandled = before.split(/[^a-z]+/).some((w) => HANDLE_VERB.has(w));
        if (isAbstract) { abstract++; if (cutAbstract.length < 12) cutAbstract.push(c.phrase); }
        if (isParticiple) { participle++; if (cutVerb.length < 12) cutVerb.push(c.phrase); }
        if (isHandled) handled++;
        if (!isAbstract && !isParticiple && isHandled) { if (kept.length < 24) kept.push(c.phrase); }
        else if (!isAbstract && !isParticiple && cutUnhandled.length < 12) cutUnhandled.push(c.phrase);
      }
    }
  }
  const pct = (n: number) => `${Math.round((n / Math.max(1, total)) * 100)}%`;
  console.log(`  phrases the engine emits    ${String(total).padStart(5)}`);
  console.log(`  head is an abstract noun    ${String(abstract).padStart(5)}  ${pct(abstract)}`);
  console.log(`  head is an -ed/-ing form    ${String(participle).padStart(5)}  ${pct(participle)}`);
  console.log(`  HANDLED by someone nearby   ${String(handled).padStart(5)}  ${pct(handled)}`);
  console.log(`\n  KEPT (concrete + handled): ${kept.map((p) => `"${p}"`).join(", ")}`);
  console.log(`\n  cut, abstract head:  ${cutAbstract.map((p) => `"${p}"`).join(", ")}`);
  console.log(`  cut, verb head:      ${cutVerb.map((p) => `"${p}"`).join(", ")}`);
  console.log(`  cut, never handled:  ${cutUnhandled.map((p) => `"${p}"`).join(", ")}`);
  console.log("═".repeat(78));
}

main().catch((e) => { console.error(e); process.exit(1); });
