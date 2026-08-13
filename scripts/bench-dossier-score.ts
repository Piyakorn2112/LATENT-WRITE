/**
 * bench-dossier-score.ts — grade dossier bench results against the gold
 * fact files in scripts/fixtures/dossier-gold/.
 *
 * Axes, per card:
 *   coverage   how many gold CORE facts the description states (any key hit,
 *              case-insensitive substring), plus EXTENDED facts as depth
 *   fabrication  antiFact key hits (claims the book never makes) and
 *              invented particulars (proper nouns / numbers not in the book)
 *   grounding  content words that locate nowhere in the book (informational:
 *              abstractive trait vocabulary legitimately fails this)
 *   naturalness  fragment ratio (sentences with no finite verb), telegraph
 *              ratio (sentences under 4 words), mean sentence length
 *   latency    the runner's wall clock per card
 *
 * The numbers RANK variants; the printed descriptions are for reading,
 * because naturalness is finally a judgement call.
 *
 *   /opt/homebrew/bin/node node_modules/tsx/dist/cli.mjs \
 *     scripts/bench-dossier-score.ts bench-results/dossier-max-baseline.json [more.json…]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { missingWords } from "../src/lib/character-dossier";
import { loadBook } from "./print-chapter";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLD_DIR = path.join(HERE, "fixtures", "dossier-gold");

interface GoldFact { kind: string; weight: "core" | "extended"; fact: string; keys: string[]; quote: string }
interface GoldAnti { claim: string; keys: string[]; why: string }
interface GoldCharacter { name: string; aliases: string[]; facts: GoldFact[]; antiFacts: GoldAnti[] }
interface GoldBook { book: string; characters: GoldCharacter[] }

interface BenchRow {
  spec: string; book: string; name: string; forms: string[];
  mode: string; label: string; role: string;
  description: string; generated: boolean; extractive: string;
  timings: Record<string, number>; totalMs: number;
}

const FINITE_VERB_RE =
  /\b(?:is|was|were|are|am|has|had|have|does|did|do|can|could|will|would|shall|should|may|might|must|[a-z]{3,}(?:ed|es|s))\b/i;

function loadGold(): Map<string, GoldCharacter & { book: string }> {
  const out = new Map<string, GoldCharacter & { book: string }>();
  if (!existsSync(GOLD_DIR)) return out;
  for (const file of readdirSync(GOLD_DIR).filter((f) => f.endsWith(".json"))) {
    const gold = JSON.parse(readFileSync(path.join(GOLD_DIR, file), "utf8")) as GoldBook;
    for (const c of gold.characters) {
      out.set(`${gold.book}:${c.name.toLowerCase()}`, { ...c, book: gold.book });
      for (const alias of c.aliases) out.set(`${gold.book}:${alias.toLowerCase()}`, { ...c, book: gold.book });
    }
  }
  return out;
}

/** Proper nouns and numbers in the line that appear nowhere in the book. */
function inventedParticulars(line: string, bookLower: string, ownForms: readonly string[]): string[] {
  const own = new Set(ownForms.flatMap((f) => f.toLowerCase().split(/\s+/)));
  const out = new Set<string>();
  for (const m of line.matchAll(/(?<=[a-z,;]\s)([A-Z][a-z]{2,})/g)) {
    const w = m[1].toLowerCase();
    if (!own.has(w) && !bookLower.includes(w)) out.add(m[1]);
  }
  for (const m of line.matchAll(/\b(\d+|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b/gi)) {
    if (!bookLower.includes(m[1].toLowerCase())) out.add(m[1]);
  }
  return [...out];
}

interface CardScore {
  spec: string; core: number; coreTotal: number; ext: number; extTotal: number;
  kindsCovered: string[]; antiHits: string[]; invented: string[]; offText: string[];
  fragRatio: number; telegraphRatio: number; meanSentenceWords: number;
  words: number; ms: number; description: string; role: string;
}

function scoreRow(row: BenchRow, gold: GoldCharacter, bookText: string): CardScore {
  const desc = row.description ?? "";
  const descLower = desc.toLowerCase();
  const hit = (keys: string[]) => keys.some((k) => descLower.includes(k.toLowerCase()));

  const core = gold.facts.filter((f) => f.weight === "core");
  const ext = gold.facts.filter((f) => f.weight === "extended");
  const coveredCore = core.filter((f) => hit(f.keys));
  const coveredExt = ext.filter((f) => hit(f.keys));
  const kindsCovered = [...new Set([...coveredCore, ...coveredExt].map((f) => f.kind))];

  const antiHits = gold.antiFacts.filter((a) => hit(a.keys)).map((a) => a.claim);
  const bookLower = bookText.toLowerCase();
  const invented = desc ? inventedParticulars(desc, bookLower, row.forms) : [];
  const offText = desc ? missingWords(desc, [bookText, row.role]) : [];

  const sentences = desc.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const frag = sentences.filter((s) => !FINITE_VERB_RE.test(s));
  const telegraph = sentences.filter((s) => s.split(/\s+/).filter(Boolean).length < 4);
  const words = desc.split(/\s+/).filter(Boolean).length;

  return {
    spec: row.spec,
    core: coveredCore.length, coreTotal: core.length,
    ext: coveredExt.length, extTotal: ext.length,
    kindsCovered, antiHits, invented, offText,
    fragRatio: sentences.length ? frag.length / sentences.length : 0,
    telegraphRatio: sentences.length ? telegraph.length / sentences.length : 0,
    meanSentenceWords: sentences.length ? words / sentences.length : 0,
    words, ms: row.totalMs, description: desc, role: row.role,
  };
}

const pct = (n: number, d: number) => (d === 0 ? "  —" : `${Math.round((n / d) * 100)}%`.padStart(4));
const pad = (v: string | number, n: number) => String(v).padStart(n);
const padR = (v: string | number, n: number) => String(v).padEnd(n);

async function main() {
  const files = process.argv.slice(2).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.error("usage: bench-dossier-score.ts <results.json> [more.json…]");
    process.exit(1);
  }
  const gold = loadGold();
  if (gold.size === 0) {
    console.error(`no gold files in ${GOLD_DIR}`);
    process.exit(1);
  }
  const bookTexts = new Map<string, string>();

  const aggregates: Array<{
    file: string; mode: string; label: string; cards: number;
    core: number; coreTotal: number; ext: number; extTotal: number;
    anti: number; invented: number; fragMean: number; telegraphMean: number;
    wordsMean: number; msMean: number; msMax: number;
  }> = [];

  for (const file of files) {
    const data = JSON.parse(readFileSync(file, "utf8")) as { mode: string; label: string; rows: BenchRow[] };
    console.log(`\n${"═".repeat(90)}\n${file}   mode=${data.mode}  label=${data.label}\n${"═".repeat(90)}`);

    const scores: CardScore[] = [];
    for (const row of data.rows) {
      const g = gold.get(`${row.book}:${row.name.toLowerCase()}`)
        ?? row.forms.map((f) => gold.get(`${row.book}:${f.toLowerCase()}`)).find(Boolean);
      if (!g) {
        console.log(`── ${row.spec}  (no gold — skipped)`);
        continue;
      }
      if (!bookTexts.has(row.book)) {
        const novel = await loadBook(row.book);
        bookTexts.set(row.book, novel.chapters.map((c) => c.content).join("\n"));
      }
      const s = scoreRow(row, g, bookTexts.get(row.book)!);
      scores.push(s);

      console.log(`\n── ${row.spec}   core ${s.core}/${s.coreTotal}  ext ${s.ext}/${s.extTotal}  kinds [${s.kindsCovered.join(",")}]  ${s.words}w  ${Math.round(s.ms / 100) / 10}s`);
      if (s.antiHits.length) console.log(`   ⚠ ANTI-FACT: ${s.antiHits.join("; ")}`);
      if (s.invented.length) console.log(`   ⚠ INVENTED: ${s.invented.join(", ")}`);
      if (s.offText.length) console.log(`   off-text words: ${s.offText.join(", ")}`);
      console.log(`   frag ${Math.round(s.fragRatio * 100)}%  telegraph ${Math.round(s.telegraphRatio * 100)}%  ${Math.round(s.meanSentenceWords)}w/sentence`);
      console.log(`   role: ${s.role}`);
      console.log(`   ${JSON.stringify(s.description)}`);
    }

    const sum = (f: (s: CardScore) => number) => scores.reduce((a, s) => a + f(s), 0);
    aggregates.push({
      file: path.basename(file), mode: data.mode, label: data.label, cards: scores.length,
      core: sum((s) => s.core), coreTotal: sum((s) => s.coreTotal),
      ext: sum((s) => s.ext), extTotal: sum((s) => s.extTotal),
      anti: sum((s) => s.antiHits.length), invented: sum((s) => s.invented.length),
      fragMean: scores.length ? sum((s) => s.fragRatio) / scores.length : 0,
      telegraphMean: scores.length ? sum((s) => s.telegraphRatio) / scores.length : 0,
      wordsMean: scores.length ? sum((s) => s.words) / scores.length : 0,
      msMean: scores.length ? sum((s) => s.ms) / scores.length : 0,
      msMax: scores.reduce((a, s) => Math.max(a, s.ms), 0),
    });
  }

  console.log(`\n${"═".repeat(90)}\nAGGREGATE\n${"═".repeat(90)}`);
  console.log(`${padR("file", 36)} ${pad("cards", 5)} ${pad("core", 5)} ${pad("ext", 5)} ${pad("anti", 4)} ${pad("invent", 6)} ${pad("frag", 5)} ${pad("teleg", 5)} ${pad("words", 5)} ${pad("s/card", 6)} ${pad("max s", 6)}`);
  for (const a of aggregates) {
    console.log(
      `${padR(a.file, 36)} ${pad(a.cards, 5)} ${pct(a.core, a.coreTotal)} ${pct(a.ext, a.extTotal)}`
      + ` ${pad(a.anti, 4)} ${pad(a.invented, 6)} ${pad(`${Math.round(a.fragMean * 100)}%`, 5)}`
      + ` ${pad(`${Math.round(a.telegraphMean * 100)}%`, 5)} ${pad(Math.round(a.wordsMean), 5)}`
      + ` ${pad(Math.round(a.msMean / 100) / 10, 6)} ${pad(Math.round(a.msMax / 100) / 10, 6)}`,
    );
  }
  console.log("");
}

main();
