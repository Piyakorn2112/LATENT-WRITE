/**
 * ood-language-audit.ts — OUT-OF-DISTRIBUTION language-processing audit.
 *
 * Every other suite in scripts/ is a curated-case suite. This one runs the REAL
 * pipeline over TWO complete manuscripts and reports label-free health metrics.
 *
 *   Hollow Iris    — IN-DISTRIBUTION (22 of 37 accuracy-suite cases came from it)
 *   The Root Crown — HELD OUT (no suite was ever tuned against it)
 *
 * Three NAME conditions, to separate extractor failure from detector failure:
 *   A cold-start  — resolveKnownNames(), i.e. what the app actually uses today
 *   B relevance   — autoExtractEntities(), i.e. the one-line comparator fix
 *   C curated     — hand-supplied cast, i.e. the ceiling
 *
 * Label-free metrics (no ground truth needed):
 *   1. UNKNOWN rate — how often the writer is shown no speaker at all
 *   2. mean confidence
 *   3. DEFAULT vs HIGH disagreement — an accuracy lower bound needing no labels.
 *      If two modes name a different speaker for the same quote, one is wrong,
 *      and the writer has no way to tell which.
 *
 * Run: node <tsx> scripts/ood-language-audit.ts    (AUDIT_JSON=path to dump)
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runChapterAnalysis } from '../src/lib/chapter-analysis-runner';
import { resolveKnownNames, autoExtractEntities } from '../src/lib/world-data';
import type { ChapterEndContext, IntelligenceLevel } from '../src/lib/speech-detect';
import type { Chapter, Novel } from '../src/types';

const ROOT = '/Users/piyakorn/Desktop/Testwriting';
const CHAPTER_LIMIT = Number(process.env.LIMIT ?? 40);

interface Corpus {
  key: string;
  label: string;
  dir: string;
  distribution: 'in-distribution' | 'held-out';
  cast: string[];
}

const CORPORA: Corpus[] = [
  {
    key: 'hollow-iris',
    label: 'Hollow Iris',
    dir: join(ROOT, 'NovelDraft/drafts'),
    distribution: 'in-distribution',
    cast: ['Iris', 'Nora', 'Mareth', 'Helia', 'Doran', 'Kael', 'Marcus'],
  },
  {
    key: 'root-crown',
    label: 'The Root Crown',
    dir: join(ROOT, 'TheRootCrownDraft/drafts'),
    distribution: 'held-out',
    cast: ['Mira', 'Gareth', 'Tessa', 'Brennan', 'Vey', 'Dowsa'],
  },
];

function loadChapters(dir: string, limit: number): Chapter[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.txt'));
  const byNum = new Map<number, string>();
  for (const f of files) byNum.set(parseInt(f.replace(/\D+/g, '') || '0', 10), f);
  return [...byNum.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, limit)
    .map(([n, f], i) => ({
      id: `ch${n}`,
      number: i + 1,
      title: f.replace('.txt', ''),
      content: readFileSync(join(dir, f), 'utf8'),
    }));
}

interface ModeRun {
  speakers: Map<string, string>;
  segments: number;
  unknown: number;
  confSum: number;
  ms: number;
}

function runCorpusAtMode(chapters: Chapter[], knownNames: string[], level: IntelligenceLevel): ModeRun {
  const out: ModeRun = { speakers: new Map(), segments: 0, unknown: 0, confSum: 0, ms: 0 };
  let prevContext: ChapterEndContext | null = null;

  for (const chapter of chapters) {
    const t0 = performance.now();
    const res = runChapterAnalysis({ chapter, prevContext, siblingStats: [], knownNames, level });
    out.ms += performance.now() - t0;
    prevContext = res.endContext;

    res.speechResults.forEach((para, pi) => {
      for (const seg of para.segments) {
        if (seg.type !== 'speech') continue;
        const k = `${chapter.id}|${pi}|${seg.start}|${seg.end}`;
        const speaker = seg.speaker ?? '';
        out.speakers.set(k, speaker);
        out.segments++;
        if (!speaker) out.unknown++;
        out.confSum += seg.confidence ?? 0;
      }
    });
  }
  return out;
}

const pct = (n: number, d: number) => (d === 0 ? 0 : (n / d) * 100);
const f1 = (n: number) => n.toFixed(1);

const reports: any[] = [];

for (const corpus of CORPORA) {
  const chapters = loadChapters(corpus.dir, CHAPTER_LIMIT);
  const words = chapters.reduce((a, c) => a + c.content.split(/\s+/).length, 0);
  const novel = { meta: { title: corpus.label, author: '', description: '' }, chapters } as Novel;

  process.stderr.write(`\n▶ ${corpus.label} — ${chapters.length} ch, ${words} words\n`);

  const coldStart = resolveKnownNames(novel);
  const relevance = autoExtractEntities(novel, 2, 30);
  const curated = corpus.cast;

  const has = (list: string[], n: string) => list.some((x) => x.toLowerCase() === n.toLowerCase());
  const castRecall = (list: string[]) => pct(corpus.cast.filter((c) => has(list, c)).length, corpus.cast.length);

  const conditions: Array<{ key: string; label: string; names: string[] }> = [
    { key: 'cold', label: 'A cold-start (shipping today)', names: coldStart },
    { key: 'relevance', label: 'B relevance-ranked (one-line fix)', names: relevance },
    { key: 'curated', label: 'C curated cast (ceiling)', names: curated },
  ];

  const condOut: any = {};

  for (const cond of conditions) {
    const runs: Record<string, ModeRun> = {};
    for (const m of ['default', 'high'] as IntelligenceLevel[]) {
      process.stderr.write(`   ${cond.key}/${m}…\n`);
      runs[m] = runCorpusAtMode(chapters, cond.names, m);
    }

    const d = runs['default'];
    const h = runs['high'];
    let comparable = 0;
    let bothNamedButDiffer = 0;
    let highResolvesUnknown = 0;
    for (const [k, ds] of d.speakers) {
      if (!h.speakers.has(k)) continue;
      comparable++;
      const hs = h.speakers.get(k)!;
      if (ds === hs) continue;
      if (!ds && hs) highResolvesUnknown++;
      else if (ds && hs) bothNamedButDiffer++;
    }

    condOut[cond.key] = {
      label: cond.label,
      nameCount: cond.names.length,
      castRecall: castRecall(cond.names),
      sampleNames: cond.names.slice(0, 6),
      modes: {
        default: {
          segments: d.segments,
          unknownPct: pct(d.unknown, d.segments),
          meanConf: d.segments ? d.confSum / d.segments : 0,
          msPerChapter: d.ms / chapters.length,
        },
        high: {
          segments: h.segments,
          unknownPct: pct(h.unknown, h.segments),
          meanConf: h.segments ? h.confSum / h.segments : 0,
          msPerChapter: h.ms / chapters.length,
        },
      },
      disagreement: {
        comparable,
        highResolvesUnknown,
        bothNamedButDiffer,
        bothNamedDifferPct: pct(bothNamedButDiffer, comparable),
      },
    };
  }

  reports.push({
    key: corpus.key,
    label: corpus.label,
    distribution: corpus.distribution,
    chapters: chapters.length,
    words,
    conditions: condOut,
  });
}

console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
console.log('║  OUT-OF-DISTRIBUTION AUDIT — real manuscripts, label-free metrics    ║');
console.log('╚══════════════════════════════════════════════════════════════════════╝');

for (const r of reports) {
  console.log(`\n━━━ ${r.label}  [${r.distribution}] — ${r.chapters} ch, ${r.words.toLocaleString()} words ━━━`);
  console.log('\n  condition                            cast   UNK@def  UNK@high  conf@def  def↔high conflict');
  for (const key of ['cold', 'relevance', 'curated']) {
    const c = r.conditions[key];
    console.log(
      `  ${c.label.padEnd(34)} ${(f1(c.castRecall) + '%').padStart(6)}  ${(f1(c.modes.default.unknownPct) + '%').padStart(7)}  ${(f1(c.modes.high.unknownPct) + '%').padStart(8)}  ${c.modes.default.meanConf.toFixed(2).padStart(8)}  ${(f1(c.disagreement.bothNamedDifferPct) + '%').padStart(9)}`,
    );
  }
  const cold = r.conditions.cold;
  const cur = r.conditions.curated;
  console.log(
    `\n  → fixing the name list alone moves UNKNOWN@default ${f1(cold.modes.default.unknownPct)}% → ${f1(cur.modes.default.unknownPct)}%`,
  );
  console.log(`  → cold-start names sample: ${cold.sampleNames.join(' | ')}`);
  console.log(`  → curated names sample   : ${cur.sampleNames.join(' | ')}`);
}

const outPath = process.env.AUDIT_JSON;
if (outPath) {
  writeFileSync(outPath, JSON.stringify(reports, null, 2));
  console.log(`\nJSON → ${outPath}`);
}
