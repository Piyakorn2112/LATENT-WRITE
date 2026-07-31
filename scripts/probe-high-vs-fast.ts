/**
 * probe-high-vs-fast.ts — WHERE does high mode's extra cost go?
 *
 * High costs 9.9x fast and scores 0.2pp BEHIND it on real prose. The totals say
 * how that happens but not why: high leaves 24 lines unattributed where fast
 * leaves 36, and turns those 12 extra answers into 14 extra WRONG ones. So its
 * additional machinery is not adding knowledge, it is lowering the bar for
 * guessing.
 *
 * This pairs the two modes line by line on the masked benchmark and cross-tabs
 * them, because the aggregate cannot distinguish two very different worlds:
 * high being right about a DIFFERENT set of lines (a real capability that is
 * merely offset), versus high being a strictly noisier fast (nothing gained).
 *
 * LOSSES= dumps the lines where fast is right and high is wrong, with the
 * context high had and fast did not — that is where its six-paragraph window is
 * actively hurting, and it is the only category whose fix is obvious.
 */

import { BOOKS, CORPUS_BOOKS, loadBook, splitParagraphs } from "./print-chapter";
import { resolveKnownNames, filterSpeakerCandidates } from "../src/lib/world-data";
import { detectSpeechInChapter } from "../src/lib/speech-detect";
import { DEV_BOOKS } from "./test-masked-attribution";

const ALL = [...Object.keys(BOOKS), ...Object.keys(CORPUS_BOOKS)].filter((k) => k !== "sample");
const HON = ["Mr","Mrs","Ms","Dr","Miss","Sir","Lord","Lady","Captain","Colonel",
  "Professor","Aunt","Uncle","Madame","Monsieur","Mademoiselle"].join("|");
const VERBS = "said|asked|replied|answered|cried|exclaimed|murmured|whispered|shouted|added|returned";
const NAME = `(?:(?:${HON})\\.?\\s+)?[A-Z][A-Za-z'’-]+`;
const TAG = new RegExp(`[”"]\\s*,?\\s*(?:(?:${VERBS})\\s+(${NAME})|(${NAME})\\s+(?:\\w+\\s+){0,1}(?:${VERBS}))\\s*[.!?]`);

const pairs = (p: string) => {
  const c = (p.match(/[“”]/g) ?? []).length;
  return c > 0 ? Math.floor(c / 2) : Math.floor((p.match(/"/g) ?? []).length / 2);
};
const bare = (r: string) => {
  const s = r.replace(new RegExp(`^(?:${HON})\\.?\\s+`), "");
  return s.trim().split(/\s+/).pop() ?? s;
};
function mask(p: string) {
  if (pairs(p) !== 1) return undefined;
  const m = TAG.exec(p);
  if (!m || m.index < 0) return undefined;
  const raw = m[1] ?? m[2];
  if (!raw) return undefined;
  const gold = bare(raw);
  if (gold.length < 3) return undefined;
  const before = p.slice(0, m.index), after = p.slice(m.index + m[0].length);
  const bf = before.replace(/,\s*$/, ".");
  const inner = bf.replace(/^["“]/, "");
  if (!/[.!?…]["”]?\s*$/.test(inner) && !/[—–-]\s*$/.test(bf)) return undefined;
  const masked = (bf + p[m.index] + after).replace(/\s+/g, " ").trim();
  return masked ? { masked, gold } : undefined;
}

const STRIDE = Number(process.env.STRIDE ?? 6);
const DUMP = Number(process.env.LOSSES ?? 0);
const DEVONLY = process.env.DEVONLY === "1";

async function main() {
  const cell = new Map<string, number>();
  const bump = (k: string) => cell.set(k, (cell.get(k) ?? 0) + 1);
  const losses: string[] = [];
  const confs = new Map<number, number>();
  let n = 0;

  for (const key of ALL) {
    if (DEVONLY && !DEV_BOOKS.has(key)) continue;
    let novel; try { novel = await loadBook(key); } catch { continue; }
    const names = resolveKnownNames(novel);
    const cand = filterSpeakerCandidates(names, novel.chapters.map((c) => c.content).join("\n"));

    for (const ch of novel.chapters) {
      const paras = splitParagraphs(ch.content);
      if (paras.length < 4) continue;
      const el: Array<{ i: number; masked: string; gold: string }> = [];
      for (let i = 0; i < paras.length; i++) { const r = mask(paras[i]); if (r) el.push({ i, ...r }); }
      if (!el.length) continue;

      for (let off = 0; off < STRIDE; off++) {
        const batch = el.filter((_, k) => k % STRIDE === off);
        if (!batch.length) continue;
        const text = [...paras];
        for (const b of batch) text[b.i] = b.masked;
        const F = detectSpeechInChapter(text, names, { intelligenceLevel: "fast", speakerCandidates: cand });
        const H = detectSpeechInChapter(text, names, { intelligenceLevel: "high", speakerCandidates: cand });

        for (const b of batch) {
          n++;
          const fs = F[b.i]?.segments?.find((s) => s.type === "speech");
          const hs = H[b.i]?.segments?.find((s) => s.type === "speech");
          const f = fs?.speaker?.trim();
          const h = hs?.speaker?.trim();
          const ok = (x?: string) => !!x && bare(x).toLowerCase() === b.gold.toLowerCase();
          const st = (x?: string) => (!x ? "silent" : ok(x) ? "right" : "wrong");
          bump(`${st(f)} → ${st(h)}`);
          if (st(f) === "right" && st(h) === "wrong") {
            confs.set(hs?.confidence ?? 0, (confs.get(hs?.confidence ?? 0) ?? 0) + 1);
          }
          if (st(f) === "right" && st(h) === "wrong" && losses.length < DUMP) {
            const ctx: string[] = [];
            for (let j = Math.max(0, b.i - 3); j < b.i; j++) ctx.push(`      ${text[j].slice(0, 120)}`);
            losses.push(`\n── ${key} ch${ch.number} p${b.i}  gold=${b.gold}  fast=${f}  HIGH=${h}\n${ctx.join("\n")}\n   >>> ${b.masked.slice(0, 120)}`);
          }
        }
      }
    }
  }

  const order = ["right","wrong","silent"];
  console.log(`\n═══ FAST vs HIGH, line by line (N=${n}${DEVONLY ? ", DEV books" : ""}) ═══\n`);
  console.log(`            ${"HIGH right".padStart(12)}${"HIGH wrong".padStart(12)}${"HIGH silent".padStart(13)}`);
  for (const f of order) {
    const row = order.map((h) => String(cell.get(`${f} → ${h}`) ?? 0));
    console.log(`  fast ${f.padEnd(7)}${row[0].padStart(11)}${row[1].padStart(12)}${row[2].padStart(13)}`);
  }

  const g = (k: string) => cell.get(k) ?? 0;
  const highWins = g("wrong → right") + g("silent → right");
  const highLoses = g("right → wrong") + g("right → silent");
  console.log(`\n  HIGH gains ${highWins} lines fast gets wrong or misses`);
  console.log(`  HIGH loses ${highLoses} lines fast gets RIGHT`);
  console.log(`  net ${highWins - highLoses >= 0 ? "+" : ""}${highWins - highLoses} for ~10x the cost\n`);
  console.log(`  Of the ${g("silent → right") + g("silent → wrong")} lines fast declines to answer,`);
  console.log(`  high answers ${g("silent → right")} correctly and ${g("silent → wrong")} incorrectly ` +
    `(${((g("silent → right") / Math.max(1, g("silent → right") + g("silent → wrong"))) * 100).toFixed(0)}% hit rate).`);
  console.log(`  A blind guess among the cast would do about ${(100 / 8).toFixed(0)}%.\n`);
  console.log(`  ── which return site produced HIGH's 41 wrong answers (by confidence) ──`);
  for (const [c, k] of [...confs].sort((a, b) => b[1] - a[1])) console.log(`     conf ${c.toFixed(2)}   ${k}`);
  console.log("");
  for (const l of losses) console.log(l);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
