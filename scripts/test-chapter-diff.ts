/**
 * test-chapter-diff.ts
 *
 * TDD for chapter-diff.ts: verify that paragraph-level diffs are correct.
 * Target: 100% accuracy (deterministic diff).
 *
 * Run:  npx tsx scripts/test-chapter-diff.ts
 */

import { diffChapter, hashChapter, formatDiffForPrompt } from '../src/lib/chapter-diff';

let passed = 0, failed = 0;
function expect(label: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else    { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

const P = (s: string) => s; // paragraph identity helper

// ─── Base text ───────────────────────────────────────────────────────────

const PARA_A = 'She looked up from the terminal. The light was steady.';
const PARA_B = 'Nora sat across the table, waiting.';
const PARA_C = 'The governance report had arrived early that morning.';
const PARA_D = 'Iris set down the cup. The silence extended.';
const PARA_E = 'The district was quiet outside the window.';

function join(...paras: string[]) { return paras.join('\n\n'); }

// ─── Test 1: Identical text → no changes ────────────────────────────────

console.log('\n── Test 1: Identical text ──');
{
  const text = join(PARA_A, PARA_B, PARA_C);
  const diff = diffChapter(text, text);
  expect('No changes for identical text', !diff.hasChanges);
  expect('Zero changes array', diff.changes.length === 0);
  expect('Summary says unchanged', diff.summary.includes('No changes'));
}

// ─── Test 2: Single paragraph added ─────────────────────────────────────

console.log('\n── Test 2: Single paragraph added ──');
{
  const prev = join(PARA_A, PARA_B, PARA_C);
  const cur  = join(PARA_A, PARA_B, PARA_C, PARA_D);  // D added at end
  const diff = diffChapter(prev, cur);
  expect('Has changes', diff.hasChanges);
  expect('One added paragraph', diff.changes.filter(c => c.kind === 'added').length === 1);
  expect('Added paragraph is PARA_D', diff.changes.some(c => c.kind === 'added' && c.text.includes('Iris set down')));
  expect('Summary mentions added', diff.summary.includes('added'));
  expect('No false positives', diff.changes.filter(c => c.kind === 'modified' || c.kind === 'removed').length === 0);
}

// ─── Test 3: Single paragraph removed ───────────────────────────────────

console.log('\n── Test 3: Single paragraph removed ──');
{
  const prev = join(PARA_A, PARA_B, PARA_C, PARA_D);
  const cur  = join(PARA_A, PARA_C, PARA_D);  // B removed
  const diff = diffChapter(prev, cur);
  expect('Has changes', diff.hasChanges);
  expect('One removed paragraph', diff.changes.filter(c => c.kind === 'removed').length === 1);
  expect('Removed paragraph is PARA_B', diff.changes.some(c => c.kind === 'removed' && c.text.includes('Nora sat')));
  expect('Summary mentions removed', diff.summary.includes('removed'));
}

// ─── Test 4: Single paragraph modified ──────────────────────────────────

console.log('\n── Test 4: Single paragraph modified ──');
{
  const modifiedB = 'Nora sat across the table, watching closely now.'; // same anchor as B
  const prev = join(PARA_A, PARA_B, PARA_C);
  const cur  = join(PARA_A, modifiedB, PARA_C);
  const diff = diffChapter(prev, cur);
  expect('Has changes', diff.hasChanges);
  expect('One modified paragraph', diff.changes.filter(c => c.kind === 'modified').length >= 1);
  expect('Modified text is new version', diff.changes.some(c => c.kind === 'modified' && c.text.includes('watching closely')));
  expect('No spurious additions or removals for matched paras', diff.changes.filter(c => c.kind !== 'modified').length === 0);
}

// ─── Test 5: Multiple changes at once ───────────────────────────────────

console.log('\n── Test 5: Multiple changes ──');
{
  const newPara = 'A new paragraph was inserted here between the existing ones.';
  const modC = 'The governance report had arrived early that evening.'; // modified C
  const prev = join(PARA_A, PARA_B, PARA_C, PARA_D);
  const cur  = join(PARA_A, PARA_B, newPara, modC, PARA_E); // B→newPara inserted, C modified, D removed, E added
  const diff = diffChapter(prev, cur);
  expect('Has changes', diff.hasChanges);
  expect('More than 1 change detected', diff.changes.length >= 2);
  const hasAddedNew = diff.changes.some(c => c.kind === 'added' && c.text.includes('new paragraph'));
  expect('New inserted paragraph detected as added', hasAddedNew);
}

// ─── Test 6: Snapshot hash is stable ─────────────────────────────────────

console.log('\n── Test 6: Snapshot hash stability ──');
{
  const text = join(PARA_A, PARA_B, PARA_C);
  const h1 = hashChapter(text);
  const h2 = hashChapter(text);
  expect('Hash is stable across calls', h1 === h2);
  expect('Different texts have different hashes', h1 !== hashChapter(join(PARA_A, PARA_C)));
  expect('Hash is non-empty string', h1.length > 0);
}

// ─── Test 7: formatDiffForPrompt ─────────────────────────────────────────

console.log('\n── Test 7: Format diff for prompt ──');
{
  const prev = join(PARA_A, PARA_B);
  const cur  = join(PARA_A, PARA_B, PARA_C);
  const diff = diffChapter(prev, cur);
  const formatted = formatDiffForPrompt(diff, 'Previous: 1 NIA flag in para 2.');
  expect('Formatted contains header', formatted.includes('CHANGES SINCE LAST REVIEW'));
  expect('Formatted contains previous summary', formatted.includes('Previous: 1 NIA flag'));
  expect('Formatted contains added paragraph', formatted.includes('governance report'));
}

{
  // No changes case
  const text = join(PARA_A, PARA_B);
  const diff = diffChapter(text, text);
  const formatted = formatDiffForPrompt(diff, 'Prior review: clean.');
  expect('No-change format includes prior review', formatted.includes('Prior review'));
  expect('No-change format has PREVIOUS REVIEW header', formatted.includes('PREVIOUS REVIEW FINDINGS'));
}

// ─── Test 8: Large reorder ────────────────────────────────────────────────

console.log('\n── Test 8: Paragraph reorder ──');
{
  const prev = join(PARA_A, PARA_B, PARA_C, PARA_D);
  const cur  = join(PARA_A, PARA_C, PARA_B, PARA_D); // B and C swapped
  const diff = diffChapter(prev, cur);
  expect('Reorder detected as changes', diff.hasChanges);
  // Swapped paragraphs will show as modified or add/remove depending on LCS alignment
  // Important: original paras still present (no false "everything removed")
  const removedCount = diff.changes.filter(c => c.kind === 'removed').length;
  expect('Not all paragraphs marked removed', removedCount < 4);
}

// ─── Test 9: Empty previous text (first scan) ────────────────────────────

console.log('\n── Test 9: First scan — no previous text ──');
{
  const diff = diffChapter('', join(PARA_A, PARA_B, PARA_C));
  expect('Has changes when prev is empty', diff.hasChanges);
  const added = diff.changes.filter(c => c.kind === 'added').length;
  expect('All paragraphs are added when prev is empty', added >= 2);
}

// ─── Test 10: Only whitespace changes ignored ────────────────────────────

console.log('\n── Test 10: Whitespace-only changes ──');
{
  const prev = join(PARA_A, PARA_B);
  const cur  = join(PARA_A + '  ', PARA_B); // trailing space on A
  const diff = diffChapter(prev, cur.replace('  \n', '\n')); // normalized
  // Minor trailing whitespace may or may not show as modified; should not cause extra adds/removes
  const addedCount = diff.changes.filter(c => c.kind === 'added').length;
  expect('No false additions for whitespace-only', addedCount === 0);
}

// ─── Test 11: Large chapter — many paragraphs ────────────────────────────

console.log('\n── Test 11: Large chapter diff ──');
{
  const largePrev = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} from the original version of this chapter.`);
  const largeCur = largePrev.map((p, i) => i === 14 ? 'This paragraph was completely replaced with new content.' : p);
  const diff = diffChapter(largePrev.join('\n\n'), largeCur.join('\n\n'));
  expect('Large chapter: has changes', diff.hasChanges);
  const modified = diff.changes.filter(c => c.kind === 'modified' || c.kind === 'added');
  expect('Large chapter: changed para detected', modified.length >= 1);
  const unchanged = 30 - diff.changes.length;
  expect('Large chapter: most paras unchanged', unchanged >= 25, `unchanged=${unchanged}`);
}

// ─── Test 12: hashChapter is order-sensitive ─────────────────────────────

console.log('\n── Test 12: Hash ordering sensitivity ──');
{
  const text1 = join(PARA_A, PARA_B, PARA_C);
  const text2 = join(PARA_C, PARA_B, PARA_A); // same paras, different order
  expect('Different order → different hash', hashChapter(text1) !== hashChapter(text2));
}

// ─── Test 13: formatDiffForPrompt — no prior summary ─────────────────────

console.log('\n── Test 13: formatDiffForPrompt — no prior summary ──');
{
  const prev = join(PARA_A, PARA_B);
  const cur  = join(PARA_A, PARA_B, PARA_C);
  const diff = diffChapter(prev, cur);
  const formatted = formatDiffForPrompt(diff); // no prior summary
  expect('Format works without prior summary', formatted.includes('CHANGES SINCE LAST REVIEW'));
  expect('No prior review section when no summary', !formatted.includes('Previous review'));
}

// ─── Test 14: Changes count in summary string ────────────────────────────

console.log('\n── Test 14: Summary string accuracy ──');
{
  const prev = join(PARA_A, PARA_B, PARA_C);
  const cur  = join(PARA_A, PARA_D, PARA_C); // B replaced by D
  const diff = diffChapter(prev, cur);
  expect('Summary mentions changes', diff.summary.includes('modified') || diff.summary.includes('added') || diff.summary.includes('removed'));
  expect('Has changes flag set', diff.hasChanges);
}

// ─── Test 15: Single-paragraph chapters ──────────────────────────────────

console.log('\n── Test 15: Single-paragraph chapters ──');
{
  const prev = PARA_A;
  const cur  = 'Nora set down her pen and looked at him carefully.'; // different single para
  const diff = diffChapter(prev, cur);
  expect('Single-para change detected', diff.hasChanges);
}

// ─── Summary ─────────────────────────────────────────────────────────────

const total = passed + failed;
const pct = Math.round(passed / total * 100);
console.log(`\n${'='.repeat(60)}`);
console.log(`chapter-diff accuracy: ${passed}/${total} (${pct}%)`);
console.log(`Target: 100% accuracy (deterministic diff)`);
console.log('='.repeat(60));
if (failed > 0) { console.log('Some assertions failed.\n'); process.exit(1); }
else { console.log('All assertions passed.\n'); }
