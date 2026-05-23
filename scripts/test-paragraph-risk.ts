/**
 * test-paragraph-risk.ts
 *
 * TDD accuracy for paragraph-risk.ts.
 * Key metric: ≥80% recall — selected paragraphs must contain
 * at least 80% of the sentences that runLocalReview would flag.
 *
 * Run:  npx tsx scripts/test-paragraph-risk.ts
 */

import { runLocalReview } from '../src/lib/local-review';
import { detectSpeechInChapter } from '../src/lib/speech-detect';
import { scoreParagraphs, selectRiskExcerpt } from '../src/lib/paragraph-risk';
import type { ChapterParaResult } from '../src/lib/speech-detect';
import type { ReviewFlag } from '../src/types';

let passed = 0, failed = 0;
function expect(label: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else    { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

// ─── Helper: make mock ChapterParaResults from text ───────────────────────

function mockParaResults(paras: string[], tensions: ('calm' | 'rising' | 'high')[]): ChapterParaResult[] {
  return paras.map((_, i) => ({
    segments: [],
    meta: { tension: tensions[i] ?? 'calm', dialogueDensity: 0 },
  }));
}

// ─── Test chapter with known flagged paragraphs ────────────────────────────

// Paragraphs with clear heuristic issues:
const PARA_0 = 'The morning light came through the window.';   // clean
const PARA_1 = 'She set the report aside. In other words, she was done.';  // over-explanation
const PARA_2 = 'The committee was busy. Several members had gathered.';    // clean
const PARA_3 = 'She couldn\'t help but notice how different things felt.'; // ai-register
const PARA_4 = 'The trees were in bloom. The season was changing.';       // clean
const PARA_5 = 'Hundreds of people gathered in the plaza, waiting.';      // crowd-quantification
const PARA_6 = 'Something about the way she moved told him everything.';   // NIA
const PARA_7 = 'The evening came quietly over the district.';             // clean
const PARA_8 = 'She felt sadness when the news arrived. The days were difficult.'; // emotion-label

const PARAS = [PARA_0, PARA_1, PARA_2, PARA_3, PARA_4, PARA_5, PARA_6, PARA_7, PARA_8];
const TENSIONS: ('calm' | 'rising' | 'high')[] = [
  'calm', 'rising', 'calm', 'calm', 'calm', 'calm', 'rising', 'calm', 'calm'
];
const EXPECTED_FLAGGED = [1, 3, 5, 6, 8]; // indices that should be flagged

// ─── Test 1: Scoring ranks flagged paragraphs above clean ────────────────

console.log('\n── Test 1: Flagged paragraphs score higher ──');
async function test1() {
  const result = await runLocalReview('test', PARAS.join('\n\n'));
  const paraResults = mockParaResults(PARAS, TENSIONS);
  const scores = scoreParagraphs(PARAS, paraResults, result.flags);

  for (const idx of EXPECTED_FLAGGED) {
    const score = scores.find(s => s.index === idx)?.score ?? 0;
    expect(`Para ${idx} (flagged) has risk > 0`, score > 0, `score=${score}`);
  }

  const cleanIndices = [0, 2, 4, 7];
  for (const idx of cleanIndices) {
    const flagScore = scores.find(s => s.index === idx)?.score ?? 0;
    expect(`Para ${idx} (clean) has lower or equal score than flagged paras`,
      flagScore <= 3.0, `score=${flagScore}`);
  }
}
await test1();

// ─── Test 2: Recall ≥ 80% — selected excerpt must contain flagged paras ──

console.log('\n── Test 2: Recall ≥80% for selected excerpt ──');
async function test2() {
  const result = await runLocalReview('test', PARAS.join('\n\n'));
  const paraResults = mockParaResults(PARAS, TENSIONS);
  const scores = scoreParagraphs(PARAS, paraResults, result.flags);
  const excerpt = selectRiskExcerpt(PARAS, scores, 12_000);

  // Check each expected-flagged para appears in excerpt
  let caught = 0;
  for (const idx of EXPECTED_FLAGGED) {
    const inExcerpt = excerpt.selectedIndices.has(idx);
    if (inExcerpt) caught++;
    expect(`Para ${idx} in excerpt`, inExcerpt);
  }
  const recall = caught / EXPECTED_FLAGGED.length;
  expect('Overall recall ≥ 80%', recall >= 0.80, `recall=${Math.round(recall * 100)}%`);
}
await test2();

// ─── Test 3: Budget enforcement ───────────────────────────────────────────

console.log('\n── Test 3: Budget enforcement ──');
async function test3() {
  // Create a large chapter (50 paras) and set a tight budget
  const largeParagraphs = Array.from({ length: 50 }, (_, i) =>
    i === 10 ? 'She couldn\'t help but notice how different things felt now.' :
    i === 25 ? 'Something about the way the city looked had changed.' :
    `This is paragraph ${i}. It has clean prose with no heuristic issues to flag.`
  );
  const largeResult = await runLocalReview('test', largeParagraphs.join('\n\n'));
  const largeParaResults = mockParaResults(largeParagraphs, largeParagraphs.map(() => 'calm' as const));
  const scores = scoreParagraphs(largeParagraphs, largeParaResults, largeResult.flags);

  // Very tight budget: only ~1500 chars
  const excerpt = selectRiskExcerpt(largeParagraphs, scores, 1500);
  const totalChars = excerpt.paragraphs.reduce((s, p) => s + p.length, 0);
  expect('Budget not exceeded (approx)', totalChars <= 2200, `chars=${totalChars}`);
  expect('First para always included', excerpt.selectedIndices.has(0));
  expect('Last para always included', excerpt.selectedIndices.has(49));
  expect('Excerpt has gap markers when truncated',
    !excerpt.truncated || excerpt.paragraphs.some(p => p.includes('[...')));
}
await test3();

// ─── Test 4: All paragraphs fit when chapter is small ────────────────────

console.log('\n── Test 4: Small chapter fits entirely in budget ──');
async function test4() {
  const small = PARAS.slice(0, 3);
  const result = await runLocalReview('test', small.join('\n\n'));
  const paraResults = mockParaResults(small, ['calm', 'calm', 'calm']);
  const scores = scoreParagraphs(small, paraResults, result.flags);
  const excerpt = selectRiskExcerpt(small, scores, 12_000);

  expect('All paras selected when small chapter', excerpt.selectedIndices.size === 3);
  expect('Not truncated', !excerpt.truncated);
}
await test4();

// ─── Test 5: High-tension paragraphs get risk score ──────────────────────

console.log('\n── Test 5: Tension signal adds risk score ──');
async function test5() {
  const paras = [
    'She walked to the window.',   // calm
    'The confrontation grew sharp. He would not accept the terms.', // 'high'
    'She thought about it later.',  // calm
  ];
  const tensions: ('calm' | 'rising' | 'high')[] = ['calm', 'high', 'calm'];
  const paraResults = mockParaResults(paras, tensions);
  const scores = scoreParagraphs(paras, paraResults, []);

  const tenseScore = scores.find(s => s.index === 1)?.score ?? 0;
  const calmScore0 = scores.find(s => s.index === 0)?.score ?? 0;
  expect('High-tension para scores 2.0 (from tension signal)', tenseScore >= 2.0, `score=${tenseScore}`);
  expect('Calm para with no flags scores 0', calmScore0 === 0, `score=${calmScore0}`);
}
await test5();

// ─── Test 6: Rising tension also scores ───────────────────────────────────

console.log('\n── Test 6: Rising tension also adds risk ──');
async function test6() {
  const paras = ['The argument grew louder.', 'She turned away without speaking.', 'The door stayed shut.'];
  const paraResults = mockParaResults(paras, ['rising', 'calm', 'calm']);
  const scores = scoreParagraphs(paras, paraResults, []);

  const risingScore = scores.find(s => s.index === 0)?.score ?? 0;
  const calmScore = scores.find(s => s.index === 1)?.score ?? 0;
  expect('Rising tension scores 1.0', risingScore === 1.0, `score=${risingScore}`);
  expect('Rising scores more than calm', risingScore > calmScore);
}
await test6();

// ─── Test 7: Multiple flags in same paragraph multiply score ─────────────

console.log('\n── Test 7: Multiple flags stack on same paragraph ──');
async function test7() {
  const doubleFlag = 'She felt sadness and loneliness equally. In other words, she was lost.';
  const result = await runLocalReview('test', doubleFlag);
  const paraResults = mockParaResults([doubleFlag], ['calm']);
  const scores = scoreParagraphs([doubleFlag], paraResults, result.flags);
  const score = scores[0].score;
  expect('Multiple flags stack (score ≥ 6)', score >= 6.0, `score=${score}`);
}
await test7();

// ─── Test 8: All-clean chapter returns risk scores of 0 ──────────────────

console.log('\n── Test 8: All-clean chapter ──');
async function test8() {
  const cleanParas = [
    'She set the document aside and looked at the window.',
    'He crossed the room and sat down across from her.',
    'The afternoon was quiet and without incident.',
  ];
  const result = await runLocalReview('test', cleanParas.join('\n\n'));
  const paraResults = mockParaResults(cleanParas, ['calm', 'calm', 'calm']);
  const scores = scoreParagraphs(cleanParas, paraResults, result.flags);
  const allZero = scores.every(s => s.score === 0);
  expect('All-clean chapter: all scores zero', allZero);
  expect('All-clean: result has no flags', result.flags.length === 0);
}
await test8();

// ─── Test 9: First and last para always in excerpt ────────────────────────

console.log('\n── Test 9: First/last always included even with zero score ──');
async function test9() {
  const paras = Array.from({ length: 10 }, (_, i) =>
    `This is paragraph ${i + 1} with clean prose and no issues whatsoever here.`
  );
  const paraResults = mockParaResults(paras, paras.map(() => 'calm' as const));
  const scores = scoreParagraphs(paras, paraResults, []);
  const excerpt = selectRiskExcerpt(paras, scores, 12_000);
  expect('First paragraph always selected', excerpt.selectedIndices.has(0));
  expect('Last paragraph always selected', excerpt.selectedIndices.has(9));
}
await test9();

// ─── Test 10: Low-confidence speech segments add risk ────────────────────

console.log('\n── Test 10: Low-confidence speech segments add risk ──');
async function test10() {
  const paras = ['She said something quiet across the room.', 'The window was open.'];
  const paraResults: import('../src/lib/speech-detect').ChapterParaResult[] = [
    {
      segments: [{ start: 0, end: 40, type: 'speech', speaker: 'Iris', confidence: 0.45 }],
      meta: { tension: 'calm', dialogueDensity: 0.5 },
    },
    { segments: [], meta: { tension: 'calm', dialogueDensity: 0 } },
  ];
  const scores = scoreParagraphs(paras, paraResults, []);
  const p0score = scores.find(s => s.index === 0)?.score ?? 0;
  const p1score = scores.find(s => s.index === 1)?.score ?? 0;
  expect('Low-conf speech para scores higher', p0score > p1score, `p0=${p0score}, p1=${p1score}`);
  expect('Low-conf adds 1.5 to score', p0score === 1.5, `score=${p0score}`);
}
await test10();

// ─── Summary ──────────────────────────────────────────────────────────────

const total = passed + failed;
const pct = Math.round(passed / total * 100);
console.log(`\n${'='.repeat(60)}`);
console.log(`paragraph-risk accuracy: ${passed}/${total} (${pct}%)`);
console.log(`Target: ≥80% recall on flagged paragraphs`);
console.log('='.repeat(60));
if (failed > 0) { console.log('Some assertions failed.\n'); process.exit(1); }
else { console.log('All assertions passed.\n'); }
