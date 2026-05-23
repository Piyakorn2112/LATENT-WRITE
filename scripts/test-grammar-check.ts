/**
 * test-grammar-check.ts
 *
 * TDD accuracy suite for grammar-check.ts (powers StyleWatchWidget).
 * Tests: spelling, article a/an, agreement, confusables, wordy phrases, clichés.
 * Two dimensions: precision (no false positives on clean prose) and recall.
 *
 * Run:  npx tsx scripts/test-grammar-check.ts
 * Target: ≥85% overall (precision ≥90%, recall ≥80%)
 */

import { checkGrammar } from '../src/lib/grammar-check';

let passed = 0, failed = 0;

function expect(label: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else    { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

function hasKind(text: string, kind: string): boolean {
  return checkGrammar(text).some(s => s.kind === kind);
}

function hasSuggestion(text: string, containing: string): boolean {
  return checkGrammar(text).some(s => s.suggestion.toLowerCase().includes(containing.toLowerCase()));
}

function isClean(text: string, kind?: string): boolean {
  const flags = checkGrammar(text);
  if (kind) return !flags.some(s => s.kind === kind);
  return flags.filter(s => s.severity === 'error').length === 0;
}

// ─── Spelling ─────────────────────────────────────────────────────────────

console.log('\n── Spelling: known misspellings flagged ──');
{
  expect('"teh" flagged as spelling error', hasKind('He saw teh result.', 'spelling'));
  expect('"wierd" flagged', hasKind('It was a wierd feeling.', 'spelling'));
  expect('"recieve" variant flagged', hasKind('She did not recieve the message.', 'spelling'));
  expect('"beleive" flagged', hasKind('He did not beleive it.', 'spelling'));
  expect('"occured" flagged', hasKind('It had occured before.', 'spelling'));
  expect('"definately" flagged', hasKind('She was definately wrong.', 'spelling'));
  expect('"seperate" flagged', hasKind('They were seperate issues.', 'spelling'));
  expect('"untill" flagged', hasKind('She waited untill morning.', 'spelling'));
  expect('"freind" flagged', hasKind('Her freind had left.', 'spelling'));
  expect('"droped" flagged', hasKind('He droped the cup.', 'spelling'));
}

console.log('\n── Spelling: clean prose not flagged ──');
{
  expect('Clean sentence: no spelling errors', isClean('She walked to the window and looked out at the city.', 'spelling'));
  expect('Complex literary: no spelling errors', isClean('The governance report had arrived early that morning, and she had not expected its conclusions.', 'spelling'));
  expect('"separate" not flagged', isClean('They were separate issues entirely.', 'spelling'));
  expect('"receive" not flagged', isClean('She did not receive the message.', 'spelling'));
}

// ─── Article a/an ─────────────────────────────────────────────────────────

console.log('\n── Article: a/an errors flagged ──');
{
  expect('"a apple" → article error', hasKind('She bit into a apple.', 'article'));
  expect('"a hour" → article error', hasKind('It had been a hour since the meeting.', 'article'));
  expect('"a honest" → article error', hasKind('He was a honest man.', 'article'));
  expect('"an book" → article error', hasKind('She put down an book.', 'article'));
  expect('"an city" → article error', hasKind('They were visiting an city.', 'article'));
}

console.log('\n── Article: correct usage not flagged ──');
{
  expect('"an apple" correct', isClean('She bit into an apple.', 'article'));
  expect('"a book" correct', isClean('She put down a book.', 'article'));
  expect('"an hour" correct', isClean('It had been an hour since the meeting.', 'article'));
  expect('"an honest" correct', isClean('He was an honest man.', 'article'));
  expect('"a useful" correct', isClean('It was a useful result.', 'article'));  // "useful" starts with consonant sound
  expect('"a university" correct', isClean('She attended a university.', 'article'));
}

// ─── Agreement ────────────────────────────────────────────────────────────

console.log('\n── Agreement: subject-verb errors ──');
{
  expect('"he don\'t" → agreement', hasKind("He don't know.", 'agreement'));
  expect('"she have" → agreement', hasKind('She have the answer.', 'agreement'));
  expect('"we was" → agreement', hasKind('We was there.', 'agreement'));
  expect('"could of" → agreement', hasKind('She could of gone.', 'agreement'));
  expect('"has went" → agreement', hasKind('He has went home.', 'agreement'));
  expect('"they has" → agreement', hasKind('They has the data.', 'agreement'));
}

console.log('\n── Agreement: correct forms not flagged ──');
{
  expect('"he doesn\'t know" correct', isClean("He doesn't know.", 'agreement'));
  expect('"she has" correct', isClean('She has the answer.', 'agreement'));
  expect('"we were there" correct', isClean('We were there.', 'agreement'));
  expect('"could have gone" correct', isClean('She could have gone.', 'agreement'));
  expect('"he has gone" correct', isClean('He has gone home.', 'agreement'));
}

// ─── Doubled words ────────────────────────────────────────────────────────

console.log('\n── Double word detection ──');
{
  expect('"the the" flagged', hasKind('She looked at the the window.', 'double'));
  // "a a" overlaps with article rule (fires first) so double rule may be suppressed;
  // the important thing is it IS flagged as an error of some kind
  expect('"a a" flagged as some error', checkGrammar('It was a a coincidence.').length > 0);
  // Legitimate repetitions
  expect('"had had" not flagged', isClean('She had had enough.', 'double'));
}

// ─── Confusables ──────────────────────────────────────────────────────────

console.log('\n── Confusables ──');
{
  expect('"your welcome" → confusable', hasKind('Your welcome here.', 'confusable'));
  expect('"its a" → confusable', hasKind('Its a long day.', 'confusable'));
}

// ─── Wordy phrases ────────────────────────────────────────────────────────

console.log('\n── Wordy phrases (style) ──');
{
  expect('"in order to" → wordy', hasKind('She left in order to think.', 'wordy'));
  expect('"due to the fact that" → wordy', hasKind('She stayed due to the fact that it was raining.', 'wordy'));
  expect('"gave a smile" → wordy', hasKind('He gave a smile.', 'wordy'));
  expect('"came to a stop" → wordy', hasKind('The car came to a stop.', 'wordy'));
}

// ─── Clichés ──────────────────────────────────────────────────────────────

console.log('\n── Clichés (style suggestions) ──');
{
  expect('"at the end of the day" → cliché', hasKind('At the end of the day, she was right.', 'cliche'));
  expect('"cold as ice" → cliché', hasKind('Her voice was cold as ice.', 'cliche'));
}

// ─── Precision: clean prose should not trigger errors ─────────────────────

console.log('\n── Precision: clean literary prose ──');
{
  const literary = 'She set the report aside and looked at the window. The light came through the glass in the particular way it did at this hour. Nora sat across the table, waiting. The question had been forming for some time before she asked it.';
  expect('Literary prose: no error-level flags', isClean(literary));

  const thriller = 'Detective Chen turned the photograph face-down on the table. He had seen the victim\'s apartment and he knew what it meant. The killer had known them. He picked up his phone and dialled the lab.';
  expect('Thriller prose: no error-level flags', isClean(thriller));

  const fantasy = 'Kira pressed her palm against the glowing sigil. The binding pulsed and dimmed. She had studied the pattern for three years, and now the sigil refused to hold.';
  expect('Fantasy prose: no error-level flags', isClean(fantasy));
}

// ─── Cross-genre: dialect / intentional grammar in dialogue ───────────────

console.log('\n── Style: suppressed in-dialogue (context-aware) ──');
{
  // With context providing speech spans, stylistic rules should be suppressed
  // inside dialogue. We test the basic checkGrammar path (no context) as a
  // verification that the rules don't over-fire on fiction prose.
  const dialogueProse = '"I ain\'t done," she said. The room was quiet.';
  // Without speech context, "ain't" is not in the checker — should not error-flag the narration
  expect('Narration around dialogue: no error-level flags', isClean(dialogueProse));
}

// ─── Summary ──────────────────────────────────────────────────────────────

const total = passed + failed;
const pct = Math.round(passed / total * 100);
console.log(`\n${'='.repeat(60)}`);
console.log(`grammar-check accuracy: ${passed}/${total} (${pct}%)`);
console.log(`Target: ≥85%`);
console.log('='.repeat(60));
if (pct < 85) { console.log(`Below target. Review failures above.\n`); process.exit(1); }
else { console.log('Target met.\n'); }
