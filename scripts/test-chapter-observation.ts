/**
 * test-chapter-observation.ts
 *
 * Contract tests for the "This chapter" brief (chapter-observation.ts).
 *
 * Run:  npx tsx scripts/test-chapter-observation.ts     (exit 1 on failure)
 *
 * ─── WHAT CHANGED, AND WHY THIS FILE WAS REWRITTEN ───────────────────────────
 *
 * The previous version asserted on the exact wording of a five-branch template
 * waterfall ("One spike at ¶16 carries the chapter", "holds high from ¶11"). That
 * waterfall is gone, and it is worth recording why rather than just deleting the
 * assertions: over 52 real chapters it produced only SIX distinct sentences, gave
 * 17 chapters the same one verbatim, and cited paragraph numbers located by
 * inverting the ≤30-bucket tension curve — which named a paragraph that was not
 * at the chapter's peak in 47.5% of cases.
 *
 * So this suite no longer tests wording. It tests the brief's CONTRACT:
 *
 *   · the guards hold
 *   · a chapter with a turn leads on that turn; one without says so plainly
 *   · every paragraph number cited is real and in range
 *   · supporting lines never repeat a dimension, and cap at three
 *   · no em or en dashes reach shipped copy (house rule)
 *
 * Detection ACCURACY is not this file's job — that is scripts/test-event-detect.ts
 * against the hand-annotated gold set. Fixtures here therefore use short, blunt
 * prose: enough for the assembly logic to have something to assemble.
 */

import { buildChapterBrief } from '../src/lib/chapter-observation';
import type { ChapterAnalysisResult } from '../src/lib/chapter-analysis-runner';
import type { ChapterParaResult } from '../src/lib/speech-detect';

let passed = 0;
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
};

/** A calm speech result per paragraph, or a given tension pattern. */
function speech(paraCount: number, tension?: Array<'calm' | 'rising' | 'high'>): ChapterParaResult[] {
  return Array.from({ length: paraCount }, (_, i) => ({
    segments: [],
    meta: {
      tension: tension?.[i] ?? 'calm',
      dialogueDensity: 0,
    },
  })) as ChapterParaResult[];
}

function fixture(over: {
  paragraphs: string[];
  curve?: number[];
  peakParagraph?: number;
  arcShape?: string;
  tension?: Array<'calm' | 'rising' | 'high'>;
  diagnostics?: Array<{ code: string; message: string; severity: 'warning' | 'info' }>;
  speakers?: Array<{ name: string; chars: number; turns: number }>;
}): ChapterAnalysisResult {
  return {
    contentSnapshot: '',
    paragraphs: over.paragraphs,
    speechResults: speech(over.paragraphs.length, over.tension),
    speechPredictions: [],
    actionPredictions: [],
    endContext: null,
    analysis: {
      tensionCurve: over.curve ?? [],
      peakParagraph: over.peakParagraph ?? 0,
      arcShape: (over.arcShape ?? 'flat') as never,
      writerDiagnostics: over.diagnostics ?? [],
      speakerCounts: over.speakers ?? [],
    } as never,
  } as ChapterAnalysisResult;
}

/**
 * Filler that cannot itself contain an event: no agent performing a change verb.
 * It DOES name Mira, because the engine requires an unlisted proper noun to
 * recur before treating it as a character — a name mentioned once in a chapter
 * is more often a place in passing, and admitting the singletons cost real
 * precision on the gold set. A fixture where the protagonist appears exactly
 * once is not a realistic chapter.
 */
const filler = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    i % 3 === 0
      ? `The room was quiet in the way of rooms at that hour, number ${i}.`
      : `Around Mira the light was the colour of old paper, number ${i}.`);

/** A blunt, unambiguous turn. */
const TURN = 'Mira refused the contract and walked out of the Assembly hall.';

console.log('\n══ Guards ══');
{
  ok(buildChapterBrief(fixture({ paragraphs: filler(5) })) === null,
    'chapters under 6 paragraphs produce no brief');
  const b = buildChapterBrief(fixture({ paragraphs: filler(12) }));
  ok(b !== null, 'a chapter with enough prose ALWAYS produces a brief');
  // The old box rendered nothing for 7.7% of real chapters. An empty surface is
  // a wasted one; honest emptiness is a finding and has to be stated.
  ok(!!b && b.eventless && /Nothing here reads as a turn/.test(b.headline),
    'a chapter with no turn says so, rather than rendering nothing');
}

console.log('\n══ The lead line follows the prose ══');
{
  const paras = [...filler(6), TURN, ...filler(6)];
  const b = buildChapterBrief(fixture({ paragraphs: paras }));
  ok(!!b && !b.eventless, 'a chapter containing a turn is not reported as eventless');
  ok(!!b && b.events.length > 0, 'the turn is detected and carried on the brief');
  ok(!!b && /refuse/i.test(b.headline), `the lead line names what happens (got "${b?.headline}")`);
  ok(!!b && /¶\d+/.test(b.headline), 'the lead line locates it');
}
{
  // Two different chapters must not produce the same sentence. This is the single
  // property the previous implementation failed hardest: 17 of 52 chapters shared
  // one line.
  const a = buildChapterBrief(fixture({ paragraphs: [...filler(6), TURN, ...filler(6)] }));
  const c = buildChapterBrief(fixture({
    paragraphs: [
      ...filler(4),
      'Beside Gareth the ledger lay open to the wrong page.',
      'Gareth signed the transfer order for the northern fields.',
      ...filler(8),
    ],
  }));
  ok(!!a && !!c && a.headline !== c.headline,
    'different prose produces different lead lines');
}

console.log('\n══ Every cited paragraph is real ══');
{
  const paras = [...filler(5), TURN, ...filler(10)];
  const tension: Array<'calm' | 'rising' | 'high'> = paras.map((_, i) => (i === 12 ? 'high' : 'calm'));
  const b = buildChapterBrief(fixture({
    paragraphs: paras,
    curve: Array.from({ length: 16 }, (_, i) => (i === 12 ? 1 : 0.1)),
    peakParagraph: 12,
    tension,
  }));
  const inRange = (n: number | undefined) => n === undefined || (n >= 0 && n < paras.length);
  ok(!!b && b.events.every((e) => inRange(e.paragraphIndex)), 'every event anchor is in range');
  ok(!!b && b.lines.every((l) => inRange(l.paragraphIndex)), 'every line anchor is in range');
  ok(!!b && b.lines.some((l) => l.kind === 'tension' && l.paragraphIndex === 12),
    'the tension line anchors to analysis.peakParagraph, not to an inverted curve index');
}
{
  // A real regression that shipped in the first draft of the rewrite: with no
  // events, the distance to "the nearest turn" was Infinity and the line read
  // "Tension peaks at ¶29, Infinity paragraphs from the nearest turn."
  const paras = filler(20);
  const b = buildChapterBrief(fixture({
    paragraphs: paras,
    curve: Array.from({ length: 20 }, (_, i) => (i === 15 ? 1 : 0.1)),
    peakParagraph: 15,
    tension: paras.map((_, i) => (i === 15 ? 'high' : 'calm')),
  }));
  const all = [b?.headline ?? '', ...(b?.lines.map((l) => l.text) ?? [])].join(' ');
  ok(!/Infinity|NaN|undefined/.test(all), 'no Infinity, NaN or undefined reaches the copy');
}

console.log('\n══ Supporting lines ══');
{
  const paras = [...filler(5), TURN, ...filler(10)];
  const b = buildChapterBrief(fixture({
    paragraphs: paras,
    curve: Array.from({ length: 16 }, (_, i) => (i === 12 ? 1 : 0.1)),
    peakParagraph: 12,
    tension: paras.map((_, i) => (i === 12 ? 'high' : 'calm')),
    diagnostics: [{ code: 'X', message: 'The middle third carries no dialogue.', severity: 'warning' }],
    speakers: [
      { name: 'Mira', chars: 900, turns: 14 },
      { name: 'Gareth', chars: 120, turns: 3 },
    ],
  }));
  ok(!!b && b.lines.length <= 3, 'at most three supporting lines');
  const kinds = b?.lines.map((l) => l.kind) ?? [];
  ok(new Set(kinds).size === kinds.length,
    `each supporting line comes from a DIFFERENT dimension (got ${kinds.join(', ')})`);
  ok(!!b && b.lines.every((l) => l.text.trim().length > 0), 'no empty lines');
}

console.log('\n══ House rules ══');
{
  // Sweep a spread of shapes rather than one, so a dash hiding in a rarely-taken
  // branch is still caught.
  const cases = [
    fixture({ paragraphs: filler(12) }),
    fixture({ paragraphs: [...filler(6), TURN, ...filler(6)] }),
    fixture({
      paragraphs: [...filler(5), TURN, ...filler(10)],
      curve: Array.from({ length: 16 }, (_, i) => (i === 12 ? 1 : 0.1)),
      peakParagraph: 12,
      tension: [...filler(5), TURN, ...filler(10)].map((_, i) => (i === 12 ? 'high' : 'calm')),
      arcShape: 'spike',
      diagnostics: [{ code: 'X', message: 'The middle third carries no dialogue.', severity: 'warning' }],
      speakers: [{ name: 'Mira', chars: 950, turns: 20 }, { name: 'Vey', chars: 60, turns: 2 }],
    }),
    fixture({
      paragraphs: filler(14),
      curve: Array(14).fill(0.3),
      arcShape: 'slope-up',
      diagnostics: [{ code: 'NO_CLEAR_CLIMAX', message: 'No clear tension peak detected.', severity: 'info' }],
    }),
  ];
  const texts = cases
    .map((c) => buildChapterBrief(c))
    .flatMap((b) => (b ? [b.headline, ...b.lines.map((l) => l.text)] : []));
  ok(texts.length > 0, 'the sweep produced copy to check');
  const dashed = texts.filter((t) => /[—–]/.test(t));
  ok(dashed.length === 0, `no em or en dashes in shipped copy${dashed.length ? ` (found: "${dashed[0]}")` : ''}`);
  const overlong = texts.filter((t) => t.length > 220);
  ok(overlong.length === 0, `no line runs past 220 characters${overlong.length ? ` (found ${overlong[0].length})` : ''}`);
}

console.log('\n════════════════════════════════════════════════════════════');
console.log(`chapter-observation: ${passed}/${passed + failed}`);
console.log('Target: 100% (contract, not wording)');
console.log('════════════════════════════════════════════════════════════\n');
if (failed > 0) process.exitCode = 1;
