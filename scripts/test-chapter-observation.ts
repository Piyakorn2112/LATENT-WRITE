/**
 * test-chapter-observation.ts
 *
 * Deterministic template + branch-selection tests for chapter-observation.ts,
 * the one-sentence panel entry point. Fixtures are minimal hand-built
 * ChapterAnalysisResult shapes — the module is pure synthesis, so no engine
 * runs are needed.
 *
 * Run:  npx tsx scripts/test-chapter-observation.ts     (exit 1 on failure)
 */

import { buildChapterObservation } from '../src/lib/chapter-observation';
import type { ChapterAnalysisResult } from '../src/lib/chapter-analysis-runner';

let passed = 0;
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
};

function fixture(over: {
  paragraphs?: number;
  curve?: number[];
  arcShape?: string;
  diagnostics?: Array<{ code: string; message: string; severity: 'warning' | 'info' }>;
  speakers?: Array<{ name: string; chars: number; turns: number }>;
}): ChapterAnalysisResult {
  const paraCount = over.paragraphs ?? 20;
  return {
    contentSnapshot: '',
    paragraphs: Array.from({ length: paraCount }, (_, i) => `Paragraph ${i}.`),
    speechResults: [],
    speechPredictions: [],
    actionPredictions: [],
    endContext: null,
    analysis: {
      tensionCurve: over.curve ?? [],
      arcShape: (over.arcShape ?? 'flat') as never,
      writerDiagnostics: over.diagnostics ?? [],
      speakerCounts: over.speakers ?? [],
    } as never,
  } as ChapterAnalysisResult;
}

console.log('\n══ Distinctive tension shapes lead ══');
{
  // plateau-high: samples 10..29 high in a 30-sample curve over 30 paragraphs.
  const curve = Array.from({ length: 30 }, (_, i) => (i >= 10 ? 0.9 : 0.2));
  const o = buildChapterObservation(fixture({ paragraphs: 30, curve, arcShape: 'plateau-high' }));
  ok(!!o && o.kind === 'tension', 'plateau-high selects a tension observation');
  ok(!!o && /holds high from ¶11/.test(o.text), `high-run start maps to ¶11 (got "${o?.text}")`);
  ok(!!o && o.paragraphIndex === 10, 'anchor paragraph matches the run start');
}
{
  const curve = Array.from({ length: 30 }, (_, i) => (i === 15 ? 1 : 0.1));
  const o = buildChapterObservation(fixture({ paragraphs: 30, curve, arcShape: 'spike' }));
  ok(!!o && /One spike at ¶16/.test(o!.text), `spike names the peak paragraph (got "${o?.text}")`);
}
{
  // A calm chapter must NOT get a tension template; the engine's own info
  // diagnostic (when present) is the honest observation.
  const calm = fixture({ paragraphs: 20, curve: Array(20).fill(0.3), arcShape: 'flat' });
  ok(buildChapterObservation(calm) === null, 'calm flat chapter with no diagnostics produces null');
  const calmWithNote = fixture({
    paragraphs: 20, curve: Array(20).fill(0.3), arcShape: 'slope-up',
    diagnostics: [{ code: 'NO_CLEAR_CLIMAX', message: 'No clear tension peak detected.', severity: 'info' }],
  });
  const o = buildChapterObservation(calmWithNote);
  ok(!!o && o.kind === 'diagnostic' && /No clear tension peak/.test(o.text),
    'calm chapter surfaces the engine’s info note instead of inventing a shape');
}
{
  const curve = [...Array.from({ length: 10 }, () => 0.8), ...Array.from({ length: 10 }, () => 0.2), ...Array.from({ length: 10 }, () => 0.85)];
  const o = buildChapterObservation(fixture({ paragraphs: 30, curve, arcShape: 'valley' }));
  ok(!!o && /returns tense at ¶/.test(o!.text), 'valley names the return point');
}

console.log('\n══ Fallback ladder ══');
{
  // Non-distinctive shape + warning diagnostic → diagnostic wins.
  const o = buildChapterObservation(fixture({
    curve: Array(20).fill(0.4),
    arcShape: 'slope-up',
    diagnostics: [{ code: 'X', message: 'Dialogue tags repeat the same verb eleven times.', severity: 'warning' }],
  }));
  ok(!!o && o.kind === 'diagnostic' && /eleven times/.test(o.text), 'warning diagnostic outranks a plain slope');
}
{
  // No diagnostics → dominance beats the slope when extreme.
  const o = buildChapterObservation(fixture({
    curve: Array(20).fill(0.4),
    arcShape: 'slope-up',
    speakers: [
      { name: 'Mira', chars: 900, turns: 14 },
      { name: 'Gareth', chars: 120, turns: 3 },
    ],
  }));
  ok(!!o && o.kind === 'dialogue' && /Mira speaks 88%/.test(o.text), `dominance observation fires at 88% (got "${o?.text}")`);
}
{
  // Balanced dialogue → slope template with a located peak.
  const curve = Array.from({ length: 30 }, (_, i) => i / 29);
  const o = buildChapterObservation(fixture({ paragraphs: 30, curve, arcShape: 'slope-up' }));
  ok(!!o && /peaks at ¶30/.test(o!.text), `slope-up names the closing peak (got "${o?.text}")`);
}
{
  // Echo: same shape as previous chapter, nothing else notable.
  const cur = fixture({ curve: Array(20).fill(0.4), arcShape: 'double-peak' });
  // double-peak with a flat curve can't find two distinct peaks → falls through.
  const prev = fixture({ curve: Array(20).fill(0.4), arcShape: 'double-peak' });
  const o = buildChapterObservation(cur, prev);
  ok(!!o && o.kind === 'echo' && /Same double peak shape/.test(o.text), `echo fires when shapes repeat (got "${o?.text}")`);
}

console.log('\n══ Guards ══');
{
  const o = buildChapterObservation(fixture({ paragraphs: 4, curve: [0, 1, 0], arcShape: 'spike' }));
  ok(o === null, 'chapters under 6 paragraphs produce no observation');
}
{
  const o = buildChapterObservation(fixture({ paragraphs: 20, curve: [], arcShape: 'slope-up' }));
  ok(o === null, 'no curve and nothing else notable produces null, not filler');
}
{
  // Copy rules: no em/en dashes in any template output.
  const outputs: string[] = [];
  const shapes: Array<[string, number[]]> = [
    ['plateau-high', Array.from({ length: 30 }, (_, i) => (i >= 10 ? 0.9 : 0.2))],
    ['spike', Array.from({ length: 30 }, (_, i) => (i === 15 ? 1 : 0.1))],
        ['valley', [...Array(10).fill(0.8), ...Array(10).fill(0.2), ...Array(10).fill(0.85)]],
    ['slope-up', Array.from({ length: 30 }, (_, i) => i / 29)],
    ['slope-down', Array.from({ length: 30 }, (_, i) => 1 - i / 29)],
  ];
  for (const [shape, curve] of shapes) {
    const o = buildChapterObservation(fixture({ paragraphs: 30, curve, arcShape: shape }));
    if (o) outputs.push(o.text);
  }
  ok(outputs.length >= 5 && outputs.every((t) => !/[—–]/.test(t)), 'no em/en dashes in any template');
  ok(outputs.every((t) => t.length <= 160), 'every observation stays within one glanceable sentence');
}

console.log('\n' + '═'.repeat(60));
console.log(`chapter-observation: ${passed}/${passed + failed}`);
console.log('Target: 100% (deterministic templates)');
console.log('═'.repeat(60));
if (failed > 0) process.exit(1);
console.log('All assertions passed.');
