/**
 * test-chapter-dna.ts
 *
 * TDD accuracy suite for chapter-dna.ts formatters.
 * Verifies that the formatted brief correctly represents known analysis inputs.
 *
 * Run:  npx tsx scripts/test-chapter-dna.ts
 * Target: 100% pass (deterministic formatting, not heuristic)
 */

import { buildChapterDNA, buildNeighborhoodContext, buildContinuityBrief } from '../src/lib/chapter-dna';
import type { ChapterAnalysis } from '../src/lib/chapter-analysis';
import type { CharacterVoiceStat, TagVariety } from '../src/lib/character-voice';

// ─── Helpers ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function expect(label: string, got: boolean) {
  if (got) { passed++; process.stdout.write(`  ✓ ${label}\n`); }
  else      { failed++; process.stdout.write(`  ✗ ${label}\n`); }
}

// ─── Fixture: full-featured ChapterAnalysis ───────────────────────────────

function makeAnalysis(overrides: Partial<ChapterAnalysis> = {}): ChapterAnalysis {
  return {
    tensionCurve: [0, 0.5, 1, 0.5, 0],
    timelineSummary: 'Tension rises toward a climax.',
    eventSummary: 'A confrontation reaches its peak.',
    characterSummary: 'Iris dominates the interaction.',
    combinedSummary: 'A tense climax chapter.',
    peakTension: 'high',
    peakLabel: 'confrontation',
    speakerCounts: [
      { name: 'Iris', chars: 800, turns: 12 },
      { name: 'Nora', chars: 500, turns: 8 },
    ],
    guidance: {
      pacingAdvice: 'Read carefully',
      tensionPeakHint: 'Peak at 70%',
      contentProfile: 'Dense dialogue',
      readingStrategy: 'Attention required',
      estimatedMinutes: 18,
      density: 'dense',
      peakPosition: 73,
    },
    comparative: {
      dialogueVsAvg: 0.95,
      tensionVsAvg: 1.45,
      lengthVsAvg: 1.12,
      dialogueComparison: 'roughly on par',
      tensionTrend: 'well above average',
      paceComparison: 'slightly longer',
    },
    arcShape: 'spike',
    chapterRole: 'climax',
    register: 'literary',
    registerSignals: { literary: 65, introspective: 20, action: 10, expository: 5 },
    writerDiagnostics: [],
    ...overrides,
  };
}

// ─── Test 1: Basic DNA fields present ────────────────────────────────────

console.log('\n── Test 1: Basic DNA fields ──');
{
  const analysis = makeAnalysis();
  const dna = buildChapterDNA(analysis, undefined, undefined, 'Ch 12 — The Council');

  expect('Title in brief', dna.brief.includes('Ch 12 — The Council'));
  expect('Arc shape: spike', dna.brief.includes('spike'));
  expect('Chapter role: climax', dna.brief.includes('climax'));
  expect('Register: literary present', dna.brief.includes('literary'));
  expect('Peak tension: high', dna.brief.includes('high'));
  expect('Peak position: 73%', dna.brief.includes('73%'));
  expect('Peak label: confrontation', dna.brief.includes('confrontation'));
  expect('Speaker Iris mentioned', dna.brief.includes('Iris'));
  expect('Speaker Nora mentioned', dna.brief.includes('Nora'));
  expect('Iris turn count', dna.brief.includes('12 turns'));
  expect('Estimated minutes', dna.brief.includes('18 min'));
  expect('Density: dense', dna.brief.includes('dense'));
  expect('Token estimate reasonable', dna.tokenEstimate > 20 && dna.tokenEstimate < 600);
}

// ─── Test 2: Comparative stats ───────────────────────────────────────────

console.log('\n── Test 2: Comparative stats ──');
{
  const analysis = makeAnalysis({
    comparative: {
      dialogueVsAvg: 0.70,   // 30% below → should mention
      tensionVsAvg: 1.50,    // 50% above → should mention
      lengthVsAvg: 1.05,     // 5% above → too small, should NOT mention
      dialogueComparison: 'below average',
      tensionTrend: 'above average',
      paceComparison: 'on par',
    },
  });
  const dna = buildChapterDNA(analysis, undefined, undefined, 'Ch 20');

  expect('Tension above avg shows up', dna.brief.includes('above series avg') || dna.brief.includes('above'));
  expect('Dialogue below avg shows up', dna.brief.includes('below series avg') || dna.brief.includes('below'));
}

// ─── Test 3: No comparative (first chapter) ──────────────────────────────

console.log('\n── Test 3: No comparative (null) ──');
{
  const analysis = makeAnalysis({ comparative: null });
  const dna = buildChapterDNA(analysis);

  expect('Brief still works without comparative', dna.brief.includes('Arc:'));
  expect('No "series avg" when no comparative', !dna.brief.includes('series avg'));
}

// ─── Test 4: Voice fingerprints ──────────────────────────────────────────

console.log('\n── Test 4: Voice fingerprints ──');
{
  const voices: CharacterVoiceStat[] = [
    {
      name: 'Iris',
      gender: 'female',
      speeches: 12,
      words: 180,
      avgLineLength: 15,
      lineSpan: 25,
    },
    {
      name: 'Nora',
      gender: 'female',
      speeches: 8,
      words: 64,
      avgLineLength: 8,
      lineSpan: 4,
    },
    {
      name: 'Kael',
      gender: 'male',
      speeches: 4,
      words: 80,
      avgLineLength: 20,
      lineSpan: 18,
      pronounMismatch: { expected: 'he', observed: 'she' },
    },
  ];
  const tag: TagVariety = { plain: 15, coloured: 4, saidPct: 0.79, verdict: 'balanced' };
  const dna = buildChapterDNA(makeAnalysis(), voices, tag, 'Ch 12');

  expect('Voice section header present', dna.brief.includes('VOICE FINGERPRINTS'));
  expect('Iris voice entry', dna.brief.includes('Iris:'));
  expect('Nora voice entry', dna.brief.includes('Nora:'));
  expect('Kael pronoun warning', dna.brief.includes('pronoun drift'));
  expect('Tag variety line', dna.brief.includes('balanced'));
  expect('Long avg line labeled', dna.brief.includes('long avg') || dna.brief.includes('long'));
  expect('Short avg line labeled', dna.brief.includes('short avg') || dna.brief.includes('short'));
  expect('Varied span labeled', dna.brief.includes('varied'));
  expect('Uniform span labeled', dna.brief.includes('uniform'));
}

// ─── Test 5: Register breakdown ──────────────────────────────────────────

console.log('\n── Test 5: Register signals ──');
{
  const analysis = makeAnalysis({
    registerSignals: { literary: 10, introspective: 5, action: 70, expository: 15 },
  });
  const dna = buildChapterDNA(analysis);

  expect('Action register dominant when 70%', dna.brief.includes('action'));
  expect('Action before literary (sorted)', dna.brief.indexOf('action') < dna.brief.indexOf('literary') || !dna.brief.includes('literary'));
}

// ─── Test 6: Neighborhood context ────────────────────────────────────────

console.log('\n── Test 6: Neighborhood context ──');
{
  const prevTail = 'The door closed. The city was silent below.';
  const nextHead = 'Three days later, Iris stood at the window again.';
  const ctx = buildNeighborhoodContext(prevTail, nextHead, 'Ch 11', 'Ch 13');

  expect('Neighborhood header present', ctx.includes('CHAPTER NEIGHBORHOOD'));
  expect('Prev chapter label', ctx.includes('Prev chapter') || ctx.includes('Ch 11'));
  expect('Prev chapter tail text', ctx.includes('The door closed'));
  expect('Next chapter label', ctx.includes('Next chapter') || ctx.includes('Ch 13'));
  expect('Next chapter head text', ctx.includes('Three days later'));
}

{
  const ctx = buildNeighborhoodContext(undefined, undefined);
  expect('Empty string when no neighbors', ctx === '');
}

// ─── Test 7: Continuity brief ─────────────────────────────────────────────

console.log('\n── Test 7: Continuity brief ──');
{
  const brief = buildContinuityBrief(
    [{ character: 'Kael', firstChapter: 12, thisChapter: 4 }],
    [{ phrase: 'the silver key', mentions: 1 }, { phrase: 'old photograph', mentions: 1 }],
    { drift: 'both', prevTime: 'evening', thisTime: 'morning', prevPlace: 'apartment', thisPlace: 'transit bay' },
  );

  expect('Continuity header present', brief.includes('CONTINUITY SIGNALS'));
  expect('Out-of-order character', brief.includes('Kael'));
  expect('First chapter number', brief.includes('Ch12') || brief.includes('Ch 12'));
  expect('Chekhov noun present', brief.includes('silver key'));
  expect('Handoff drift type', brief.includes('both'));
  expect('Time shift visible', brief.includes('evening') && brief.includes('morning'));
  expect('Place shift visible', brief.includes('apartment') && brief.includes('transit'));
}

{
  const empty = buildContinuityBrief([], [], null);
  expect('Empty string when no signals', empty === '');
}

// ─── Test 8: Edge cases ───────────────────────────────────────────────────

console.log('\n── Test 8: Edge cases ──');
{
  const analysis = makeAnalysis({
    speakerCounts: [],
    guidance: { ...makeAnalysis().guidance, peakPosition: null },
    comparative: null,
  });
  const dna = buildChapterDNA(analysis);

  expect('Works with no speakers', dna.brief.includes('no attributed dialogue'));
  expect('Works with null peak position', !dna.brief.includes('null'));
  expect('Brief is non-empty', dna.brief.length > 20);
}

// ─── Test 9: Compact mode ─────────────────────────────────────────────────

console.log('\n── Test 9: Compact mode format ──');
{
  const voices: CharacterVoiceStat[] = [
    { name: 'Iris', gender: 'female', speeches: 12, words: 180, avgLineLength: 15, lineSpan: 25 },
    { name: 'Nora', gender: 'female', speeches: 8, words: 64, avgLineLength: 8, lineSpan: 4 },
  ];
  const tag: TagVariety = { plain: 10, coloured: 4, saidPct: 0.71, verdict: 'balanced' };
  const dna = buildChapterDNA(makeAnalysis(), voices, tag, 'Ch 12', true);

  expect('Compact: arc/role on single line', dna.brief.split('\n').length <= 3);
  expect('Compact: contains arc shape', dna.brief.includes('spike'));
  expect('Compact: contains role', dna.brief.includes('climax'));
  expect('Compact: contains peak tension', dna.brief.includes('high'));
  expect('Compact: token estimate much lower than full', dna.tokenEstimate < 150);
  expect('Compact: voice section present', dna.brief.includes('VOICE'));
  expect('Compact: Iris abbreviated', dna.brief.includes('Iris'));
  expect('Compact: Nora abbreviated', dna.brief.includes('Nora'));

  // Full mode comparison
  const full = buildChapterDNA(makeAnalysis(), voices, tag, 'Ch 12', false);
  expect('Full: more lines than compact', full.brief.split('\n').length > dna.brief.split('\n').length);
  expect('Full: more tokens than compact', full.tokenEstimate > dna.tokenEstimate);
}

// ─── Test 10: All 7 arc shapes produce distinct output ────────────────────

console.log('\n── Test 9: All arc shapes ──');
{
  const shapes: import('../src/lib/chapter-analysis').ArcShape[] = [
    'slope-up', 'slope-down', 'plateau-high', 'spike', 'double-peak', 'valley', 'flat',
  ];
  for (const shape of shapes) {
    const dna = buildChapterDNA(makeAnalysis({ arcShape: shape }));
    expect(`Arc shape "${shape}" in brief`, dna.brief.includes(shape));
  }
}

// ─── Test 10: All 7 chapter roles produce distinct output ────────────────

console.log('\n── Test 10: All chapter roles ──');
{
  const roles: import('../src/lib/chapter-analysis').ChapterRole[] = [
    'climax', 'resolution', 'buildup', 'breather', 'pivot', 'expository', 'standard',
  ];
  for (const role of roles) {
    const dna = buildChapterDNA(makeAnalysis({ chapterRole: role }));
    expect(`Chapter role "${role}" in brief`, dna.brief.includes(role));
  }
}

// ─── Test 11: 5+ speakers truncates to 4 + rest count ────────────────────

console.log('\n── Test 11: Large cast truncation ──');
{
  const analysis = makeAnalysis({
    speakerCounts: [
      { name: 'Iris', chars: 800, turns: 12 },
      { name: 'Nora', chars: 600, turns: 9 },
      { name: 'Helia', chars: 400, turns: 6 },
      { name: 'Thayne', chars: 300, turns: 4 },
      { name: 'Dahl', chars: 200, turns: 3 },
      { name: 'Qesh', chars: 100, turns: 1 },
    ],
  });
  const dna = buildChapterDNA(analysis);
  expect('First 4 speakers listed', dna.brief.includes('Iris') && dna.brief.includes('Thayne'));
  expect('+N more shown', dna.brief.includes('+2 more'));
}

// ─── Test 12: Neighborhood context — long tail truncation ────────────────

console.log('\n── Test 12: Long neighborhood truncation ──');
{
  const longText = 'X'.repeat(600); // way over the 400-char limit
  const ctx = buildNeighborhoodContext(longText, undefined, 'Ch 5');
  expect('Long prev tail is capped to 400 chars', ctx.length < 700);
  expect('Header still present after truncation', ctx.includes('CHAPTER NEIGHBORHOOD'));
}

// ─── Test 13: Continuity brief — only outOfOrder fires ───────────────────

console.log('\n── Test 13: Partial continuity (only outOfOrder) ──');
{
  const brief = buildContinuityBrief(
    [{ character: 'Varren', firstChapter: 8, thisChapter: 2 }],
    [],
    null,
  );
  expect('Out-of-order section present', brief.includes('Varren'));
  expect('No Chekhov section when empty', !brief.includes('Introduced-and-unreturned'));
  expect('No handoff section when null', !brief.includes('handoff drift'));
}

// ─── Test 14: Comparative — small differences suppressed ─────────────────

console.log('\n── Test 14: Small comparative differences suppressed ──');
{
  const analysis = makeAnalysis({
    comparative: {
      dialogueVsAvg: 1.10,   // only 10% above — should NOT show (threshold 15%)
      tensionVsAvg: 1.05,    // only 5% above — should NOT show
      lengthVsAvg: 1.10,     // only 10% — below 20% length threshold
      dialogueComparison: 'roughly on par',
      tensionTrend: 'roughly on par',
      paceComparison: 'roughly on par',
    },
  });
  const dna = buildChapterDNA(analysis);
  expect('Small differences not shown in comparative line', !dna.brief.includes('series avg'));
}

// ─── Summary ──────────────────────────────────────────────────────────────

const total = passed + failed;
const pct = Math.round(passed / total * 100);
console.log(`\n${'='.repeat(60)}`);
console.log(`chapter-dna accuracy: ${passed}/${total} (${pct}%)`);
console.log(`Target: 100% (deterministic formatting)`);
console.log('='.repeat(60));

if (failed > 0) {
  console.log('Some assertions failed.\n');
  process.exit(1);
} else {
  console.log('All assertions passed.\n');
}
