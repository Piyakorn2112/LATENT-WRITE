/**
 * probe-character-dossier.ts — the dossier harvest measured on the corpus.
 *
 * ★ THIS DRIVES THE SHIPPED MODULE, NEVER A COPY. The first version of this
 *   probe carried its own harvester; when src/lib/character-dossier.ts became
 *   the shipping engine the probe was rewired onto it, because a harness that
 *   measures a copy measures the copy (the adjudicator and entity-review
 *   probes follow the same rule). Findings and history:
 *   plans/character-dossier-research-2026-08.md.
 *
 * Modes:
 *   (none)    coverage funnel over the DEV books
 *   --growth  coverage as a draft accrues, chapter by chapter
 *   --top1    the harness's own rank-1 pick per character, for hand judging
 *   --show B  every channel's spans for one book
 *   --pack B:Name [B:Name…]  assembled packs as JSON on stdout (for the
 *             model probe; includes the field gates)
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/probe-character-dossier.ts
 */
import {
  buildDossierPack,
  harvestDossierEvidence,
  DOSSIER_CHANNELS,
  type CharacterDossierEvidence,
  type DossierChannel,
  type DossierEvidence,
} from "../src/lib/character-dossier";
import { resolveSpeakerCandidates, buildSpeakerAliasMap } from "../src/lib/world-data";
import { loadBook } from "./print-chapter";

const DEV_BOOKS = ["pride", "sherlock", "anne", "dracula", "carol", "webnovel"];
/** ★ THE OPERATING POINT IS A DRAFT, NOT A FINISHED NOVEL. */
const DRAFT_BOOKS = ["hollow-iris", "root-crown", "webnovel"];
const CAST_LIMIT = 10;

const VISUAL: DossierChannel[] = ["appositive", "copular", "attributive", "possessive", "pronoun-attr", "pronoun-owned"];
const LORE: DossierChannel[] = ["lore-narrated", "lore-spoken", "relation"];

const pad = (v: string | number, n: number) => String(v).padStart(n);
const padR = (v: string | number, n: number) => String(v).padEnd(n);

interface BookRun {
  book: string;
  evidence: DossierEvidence;
  top: CharacterDossierEvidence[];
  chapters: number;
  words: number;
}

/**
 * The cast the app would have: auto-extracted speakers folded through the
 * nickname linker — the same cold-start path resolveEntityNameMap uses when
 * worldData is empty.
 */
async function run(book: string, chapterLimit = Infinity): Promise<BookRun | null> {
  const loaded = await loadBook(book);
  const novel = chapterLimit === Infinity
    ? loaded
    : { ...loaded, chapters: loaded.chapters.slice(0, chapterLimit) };
  const text = novel.chapters.map((c) => c.content).join("\n");
  const names = resolveSpeakerCandidates(novel).slice(0, CAST_LIMIT * 2);
  if (names.length === 0) return null;
  const aliasMap = buildSpeakerAliasMap(names, text);

  const byCanonical = new Map<string, Set<string>>();
  for (const n of names) {
    const canonical = aliasMap.get(n.toLowerCase().trim()) ?? n;
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, new Set());
    byCanonical.get(canonical)!.add(n);
  }
  const cast = [...byCanonical.entries()].map(([name, forms]) => ({
    name,
    aliases: [...forms].filter((f) => f !== name),
  }));

  const evidence = await harvestDossierEvidence(novel, cast, { yieldEvery: 8 });
  const top = [...evidence.characters]
    .sort((a, b) => b.counts.mentions - a.counts.mentions)
    .slice(0, CAST_LIMIT);

  return {
    book,
    evidence,
    top,
    chapters: novel.chapters.length,
    words: text.split(/\s+/).filter(Boolean).length,
  };
}

const visualCount = (ev: CharacterDossierEvidence) =>
  VISUAL.reduce((n, c) => n + ev.byChannel[c].length, 0);
const loreCount = (ev: CharacterDossierEvidence) =>
  LORE.reduce((n, c) => n + ev.byChannel[c].length, 0);

async function funnel() {
  console.log("\nCHARACTER DOSSIER EVIDENCE — how much is actually in the prose?\n");
  console.log("Per book: the top-10 cast by mention count. A character is COVERED in a");
  console.log("channel when the manuscript yields at least one verbatim span there.\n");

  const totals = { chars: 0, anyVisual: 0, visual3: 0, anyLore: 0, anyRelation: 0, spoken: 0 };
  const perChannel = Object.fromEntries(DOSSIER_CHANNELS.map((c) => [c, 0])) as Record<DossierChannel, number>;

  console.log(`${padR("book", 10)} ${pad("cast", 4)} ${pad("vis≥1", 6)} ${pad("vis≥3", 6)} ${pad("lore≥1", 7)} ${pad("rel≥1", 6)} ${pad("spoken", 7)}   median spans/char`);
  console.log("-".repeat(78));

  for (const book of DEV_BOOKS) {
    const result = await run(book);
    if (!result) continue;
    let anyVisual = 0, visual3 = 0, anyLore = 0, anyRelation = 0, spoken = 0;
    const perChar: number[] = [];
    for (const ev of result.top) {
      const visual = visualCount(ev);
      const lore = loreCount(ev);
      if (visual >= 1) anyVisual++;
      if (visual >= 3) visual3++;
      if (lore >= 1) anyLore++;
      if (ev.byChannel.relation.length >= 1) anyRelation++;
      if (ev.byChannel["lore-spoken"].length >= 1) spoken++;
      perChar.push(visual + lore);
      for (const c of DOSSIER_CHANNELS) perChannel[c] += ev.byChannel[c].length;
      totals.chars++;
    }
    totals.anyVisual += anyVisual;
    totals.visual3 += visual3;
    totals.anyLore += anyLore;
    totals.anyRelation += anyRelation;
    totals.spoken += spoken;
    perChar.sort((a, b) => a - b);
    const median = perChar[Math.floor(perChar.length / 2)] ?? 0;
    console.log(`${padR(book, 10)} ${pad(result.top.length, 4)} ${pad(anyVisual, 6)} ${pad(visual3, 6)} ${pad(anyLore, 7)} ${pad(anyRelation, 6)} ${pad(spoken, 7)}   ${median}`);
  }

  console.log("-".repeat(78));
  const pct = (n: number) => `${((n / Math.max(1, totals.chars)) * 100).toFixed(0)}%`;
  console.log(`${padR("ALL", 10)} ${pad(totals.chars, 4)} ${pad(pct(totals.anyVisual), 6)} ${pad(pct(totals.visual3), 6)} ${pad(pct(totals.anyLore), 7)} ${pad(pct(totals.anyRelation), 6)} ${pad(pct(totals.spoken), 7)}`);

  console.log("\nspans harvested by channel, whole corpus:");
  for (const c of DOSSIER_CHANNELS) console.log(`  ${padR(c, 14)} ${pad(perChannel[c], 6)}`);
  console.log("");
}

/**
 * ★★ COVERAGE AT THE LENGTH THE PANEL IS ACTUALLY OPENED AT. A writer who
 *    opens the world panel has written four chapters, not fifty-seven.
 */
async function growth() {
  const STEPS = [2, 4, 8, 16, 32, Infinity];
  console.log("\nEVIDENCE vs DRAFT LENGTH — coverage of the top-10 cast as chapters accrue\n");
  console.log(`${padR("book", 13)} ${padR("chapters", 9)} ${pad("words", 7)} ${pad("cast", 5)} ${pad("vis≥1", 6)} ${pad("vis≥3", 6)} ${pad("lore≥1", 7)}`);
  console.log("-".repeat(62));
  for (const book of [...DRAFT_BOOKS, "anne", "pride"]) {
    for (const step of STEPS) {
      const result = await run(book, step);
      if (!result) continue;
      if (step !== Infinity && result.chapters < step) break;
      let anyVisual = 0, visual3 = 0, anyLore = 0;
      for (const ev of result.top) {
        if (visualCount(ev) >= 1) anyVisual++;
        if (visualCount(ev) >= 3) visual3++;
        if (loreCount(ev) >= 1) anyLore++;
      }
      const label = step === Infinity ? `all (${result.chapters})` : String(step);
      console.log(`${padR(book, 13)} ${padR(label, 9)} ${pad(Math.round(result.words / 1000) + "k", 7)} ${pad(result.top.length, 5)} ${pad(anyVisual, 6)} ${pad(visual3, 6)} ${pad(anyLore, 7)}`);
      if (step === Infinity) console.log("");
    }
  }
}

/** The harness's own best guess, for hand judging — the no-model baseline. */
async function top1(books: string[]) {
  for (const book of books) {
    const result = await run(book);
    if (!result) continue;
    console.log(`\n══ ${book}`);
    for (const ev of result.top.slice(0, 6)) {
      const pack = buildDossierPack(ev);
      const first = pack.visualCandidates[0];
      const span = pack.spans.find((s) => s.n === first);
      console.log(`  ${padR(ev.name, 16)} ${span ? `(${span.channel}) ${span.text.slice(0, 132)}` : "— GATED, nothing describable"}`);
    }
  }
}

async function show(book: string) {
  const result = await run(book);
  if (!result) return;
  console.log(`\n══ ${book} — evidence spans, top ${CAST_LIMIT} cast ══`);
  for (const ev of result.top) {
    console.log(`\n── ${ev.name}  (${ev.counts.mentions} mentions · ${visualCount(ev)} visual · ${loreCount(ev)} lore)`);
    for (const channel of DOSSIER_CHANNELS) {
      const spans = ev.byChannel[channel];
      if (spans.length === 0) continue;
      console.log(`   ${channel} ×${spans.length}`);
      for (const span of spans.slice(0, 2)) {
        console.log(`     ch${span.chapter}: ${span.text.slice(0, 150)}`);
      }
    }
  }
}

/** Assembled packs as JSON on stdout, for the Electron model probe. */
async function packs(specs: string[]) {
  const byBook = new Map<string, string[]>();
  for (const spec of specs) {
    const [book, name] = spec.split(":");
    if (!byBook.has(book)) byBook.set(book, []);
    byBook.get(book)!.push(name);
  }
  const out: Array<{ book: string } & ReturnType<typeof buildDossierPack>> = [];
  for (const [book, wanted] of byBook) {
    const result = await run(book);
    if (!result) continue;
    for (const name of wanted) {
      const ev = result.top.find((e) => e.name === name || e.forms.includes(name));
      if (!ev) {
        console.error(`  ! ${book}:${name} not in the top-${CAST_LIMIT} cast (${result.top.map((e) => e.name).join(", ")})`);
        continue;
      }
      out.push({ book, ...buildDossierPack(ev) });
    }
  }
  console.log(JSON.stringify(out));
}

async function main() {
  const packIndex = process.argv.indexOf("--pack");
  if (packIndex >= 0) return packs(process.argv.slice(packIndex + 1));
  const showIndex = process.argv.indexOf("--show");
  if (showIndex >= 0) return show(process.argv[showIndex + 1] ?? "pride");
  if (process.argv.includes("--top1")) return top1(DEV_BOOKS);
  if (process.argv.includes("--growth")) return growth();
  return funnel();
}

main();
