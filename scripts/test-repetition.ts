/**
 * test-repetition.ts
 *
 * TDD accuracy for repetition.ts (powers RepetitionWidget).
 * Run:  npx tsx scripts/test-repetition.ts
 * Target: ≥85%
 */

import { findEchoes, REPETITION_STOPWORDS } from '../src/lib/repetition';

let passed = 0, failed = 0;

function expect(label: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else    { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

// Helper: repeat a phrase N times in longer context — filler ensures > 200 chars total
const FILLER = 'The morning was quiet and the city settled into its usual rhythm. The district had its own pace, and she had learned to work within it.';
function makeText(phrase: string, n: number, filler = FILLER): string {
  const chunks: string[] = [];
  for (let i = 0; i < n; i++) chunks.push(`${filler} ${phrase}.`);
  return chunks.join(' ');
}

// ─── Basic detection ──────────────────────────────────────────────────────

console.log('\n── 4-gram detection (threshold: 2 repetitions) ──');
{
  const text = makeText('the cold dark silence', 3);
  const echoes = findEchoes(text);
  const found = echoes.some(e => e.phrase.includes('cold dark silence'));
  expect('4-gram repeated 3× is detected', found, `echoes: ${echoes.map(e => e.phrase).join(', ')}`);
}

{
  // Exactly 2 repetitions — at the minimum 4-gram threshold
  const text = makeText('the cold dark silence', 2);
  const echoes = findEchoes(text);
  const found = echoes.some(e => e.phrase.includes('cold dark silence'));
  expect('4-gram at exactly 2 repetitions detected', found);
}

{
  // Only 1 repetition — below threshold
  const text = makeText('the silver compass needle', 1);
  const echoes = findEchoes(text);
  const found = echoes.some(e => e.phrase.includes('silver compass'));
  expect('4-gram with only 1 occurrence: not detected', !found);
}

// ─── 3-gram detection (threshold: 3 repetitions) ─────────────────────────

console.log('\n── 3-gram detection (threshold: 3 repetitions) ──');
{
  const text = makeText('the cold silence', 4);
  const echoes = findEchoes(text);
  const found = echoes.some(e => e.phrase.includes('cold silence'));
  expect('3-gram repeated 4× is detected', found, `echoes: ${echoes.map(e => e.phrase).join(', ')}`);
}

{
  // 3-gram at exactly threshold (3)
  const text = makeText('the cold silence', 3);
  const echoes = findEchoes(text);
  const found = echoes.some(e => e.phrase.includes('cold silence'));
  expect('3-gram at exactly 3 repetitions detected', found);
}

{
  // 3-gram with only 2 — below threshold
  const text = makeText('the cold silence', 2);
  const echoes = findEchoes(text);
  const found = echoes.some(e => e.phrase.includes('cold silence'));
  expect('3-gram with 2 occurrences (below threshold): not detected', !found);
}

// ─── Stopword filtering ───────────────────────────────────────────────────

console.log('\n── Stopword filtering (grammatical glue suppressed) ──');
{
  // "of the way" = 2/3 stopwords → stop-heavy → filtered
  const text = makeText('of the way', 5);
  const echoes = findEchoes(text);
  const found = echoes.some(e => e.phrase.includes('of the way'));
  expect('"of the way" (stop-heavy) is not detected', !found);
}

{
  // "and the time" = 2/3 stopwords → filtered
  const text = makeText('and the time', 5);
  const echoes = findEchoes(text);
  const found = echoes.some(e => e.phrase.includes('and the time'));
  expect('"and the time" (stop-heavy) is not detected', !found);
}

{
  // Real literary tic: "the cold smile" (only 1/3 are stopwords → not stop-heavy)
  const text = makeText('the cold smile', 4);
  const echoes = findEchoes(text);
  const found = echoes.some(e => e.phrase.includes('cold smile'));
  expect('"the cold smile" (not stop-heavy) is detected', found, `echoes: ${echoes.map(e => e.phrase).join(', ')}`);
}

// ─── Short text boundary ─────────────────────────────────────────────────

console.log('\n── Short text / boundary conditions ──');
{
  const echoes = findEchoes('');
  expect('Empty text returns []', echoes.length === 0);
}

{
  const echoes = findEchoes('She walked. He sat.');  // < 200 chars
  expect('Very short text (< 200 chars) returns []', echoes.length === 0);
}

{
  const echoes = findEchoes('Word. '.repeat(15)); // > 200 chars but sparse
  expect('Sparse text with no repeats returns []', echoes.length === 0);
}

// ─── 4-gram covers 3-gram ─────────────────────────────────────────────────

console.log('\n── 4-gram covers constituent 3-grams (no double-reporting) ──');
{
  // "the cold dark silence" repeated 3×: both 4-gram AND 3-grams "cold dark silence"
  // and "the cold dark" should NOT appear (covered by 4-gram)
  const text = makeText('the cold dark silence', 3);
  const echoes = findEchoes(text);
  const has4gram = echoes.some(e => e.k === 4 && e.phrase.includes('cold dark silence'));
  const has3gramCovered = echoes.some(e => e.k === 3 && (
    e.phrase === 'cold dark silence' || e.phrase === 'the cold dark'
  ));
  expect('4-gram detected', has4gram, `echoes: ${echoes.map(e => `[${e.k}] ${e.phrase}`).join(', ')}`);
  expect('Covered 3-grams NOT reported separately', !has3gramCovered);
}

// ─── Top-N limit ─────────────────────────────────────────────────────────

console.log('\n── Top-N limit ──');
{
  // Create text with 8 different repeated phrases
  let text = '';
  for (let i = 0; i < 8; i++) {
    text += makeText(`content word phrase${i}`, 3, 'Some context fills the space between.');
  }
  const echoes = findEchoes(text, 5);
  expect('Top-5 limit enforced', echoes.length <= 5, `got ${echoes.length}`);
}

// ─── First paragraph attribution ─────────────────────────────────────────

console.log('\n── First-paragraph attribution ──');
{
  const text = [
    'She looked at the silent dark room and waited. The afternoon had grown heavy with the kind of quiet that precedes decision.',
    'The silent dark room held everything she feared. She had been here before, and she would return.',
    'Eventually the silent dark room would reveal its purpose. She was certain of that. The evidence was there.',
  ].join('\n\n');
  const echoes = findEchoes(text);
  const echo = echoes.find(e => e.phrase.includes('silent dark room'));
  expect('Silent dark room detected', !!echo, `echoes: ${echoes.map(e => e.phrase).join(', ')}`);
  expect('First para index set to 1', echo?.firstParaIndex === 1, `got ${echo?.firstParaIndex}`);
}

// ─── Cross-genre ─────────────────────────────────────────────────────────

console.log('\n── Cross-genre: fantasy tic ──');
{
  const text = [
    'The lattice network pulsed with activity. Kira crossed the room and confirmed the reading. The data was clear.',
    'She checked the lattice network status again before leaving. The numbers had not changed.',
    'The lattice network had confirmed the pattern twice already. She had no reason to doubt the result.',
  ].join('\n\n');
  const echoes = findEchoes(text);
  const found = echoes.some(e => e.phrase.includes('lattice network'));
  expect('Fantasy tech phrase "lattice network" detected', found, `echoes: ${echoes.map(e => e.phrase).join(', ')}`);
}

// ─── Stopwords set sanity check ───────────────────────────────────────────

console.log('\n── Stopwords set ──');
{
  expect('"the" is a stopword', REPETITION_STOPWORDS.has('the'));
  expect('"of" is a stopword', REPETITION_STOPWORDS.has('of'));
  expect('"silence" is NOT a stopword', !REPETITION_STOPWORDS.has('silence'));
  expect('"coldness" is NOT a stopword', !REPETITION_STOPWORDS.has('coldness'));
}

// ─── Summary ──────────────────────────────────────────────────────────────

const total = passed + failed;
const pct = Math.round(passed / total * 100);
console.log(`\n${'='.repeat(60)}`);
console.log(`repetition accuracy: ${passed}/${total} (${pct}%)`);
console.log(`Target: ≥85%`);
console.log('='.repeat(60));
if (pct < 85) { console.log('Below target. Review failures.\n'); process.exit(1); }
else { console.log('Target met.\n'); }
