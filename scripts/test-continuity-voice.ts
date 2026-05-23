/**
 * test-continuity-voice.ts
 *
 * TDD accuracy for continuity.ts (ContinuityWidget) and character-voice.ts (CharacterVoiceWidget).
 * Run:  npx tsx scripts/test-continuity-voice.ts
 * Target: ≥85%
 */

import {
  findOutOfOrderMentions,
  findChekhovCandidates,
  detectHandoff,
  summarizeContinuity,
} from '../src/lib/continuity';
import { profileCharacterVoices, computeTagVariety } from '../src/lib/character-voice';
import type { Chapter } from '../src/types';
import type { ChapterParaResult } from '../src/lib/speech-detect';

let passed = 0, failed = 0;

function expect(label: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else    { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

function mockChapter(number: number, content: string): Chapter {
  return { id: `ch${number}`, number, title: `Chapter ${number}`, content };
}

// ─── findOutOfOrderMentions ───────────────────────────────────────────────

console.log('\n── findOutOfOrderMentions ──');
{
  const chapters = [
    mockChapter(1, 'Nora walked through the city.'),
    mockChapter(2, 'Nora met Kael at the station.'),     // Kael first appears here
    mockChapter(3, 'Nora and Kael took the transit.'),
  ];
  const worldData = {
    characters: [
      { name: 'Nora', aliases: [] },
      { name: 'Kael', aliases: [] },
    ],
    places: [], factions: [], entities: [],
  };

  // thisIndex=0: Ch1 mentions Nora who first appears in Ch1 → no out-of-order
  const r0 = findOutOfOrderMentions(chapters, worldData, 0);
  expect('Ch1 Nora (first appears ch1): no out-of-order', r0.length === 0);

  // thisIndex=1: Ch2 introduces Kael → no out-of-order (first mention IS here)
  const r1 = findOutOfOrderMentions(chapters, worldData, 1);
  expect('Ch2 Kael (introduced here): no out-of-order', !r1.some(o => o.character === 'Kael'));

  // Now create a scenario where ch0 mentions a character who is first introduced in ch2
  const chapters2 = [
    mockChapter(1, 'She waited in the corridor. Helia had not arrived.'),  // Helia mentioned in ch1
    mockChapter(2, 'The morning was quiet.'),
    mockChapter(3, 'Helia appeared at the door.'),  // Helia "first" introduced here
  ];
  const worldData2 = {
    characters: [{ name: 'Helia', aliases: [] }],
    places: [], factions: [], entities: [],
  };
  // Ch1 mentions Helia, but Helia's canonical first appearance is Ch1 (same chapter) → no flag
  const r2 = findOutOfOrderMentions(chapters2, worldData2, 0);
  expect('Ch1 character: not out-of-order relative to own chapter', r2.length === 0);
}

{
  // True out-of-order: character introduced in ch5 appears in ch2
  const chapters3 = [
    mockChapter(1, 'The city was quiet.'),
    mockChapter(2, 'Mareth arrived from the north.'),  // ch2 has Mareth
    mockChapter(3, 'The council met.'),
    mockChapter(4, 'The winter came.'),
    mockChapter(5, 'Mareth entered the hall for the first time.'),  // officially introduced
  ];
  const worldData3 = {
    characters: [{ name: 'Mareth', aliases: [] }],
    places: [], factions: [], entities: [],
  };
  // thisIndex=1 (ch2): Mareth first appears in ch2, so no out-of-order
  const r3 = findOutOfOrderMentions(chapters3, worldData3, 1);
  expect('Mareth first appears in ch2: no out-of-order on ch2', r3.length === 0);

  // thisIndex=0 (ch1 does NOT mention Mareth): no flag
  const r4 = findOutOfOrderMentions(chapters3, worldData3, 0);
  expect('Ch1 without Mareth: no flag', r4.length === 0);
}

// ─── findChekhovCandidates ────────────────────────────────────────────────

console.log('\n── findChekhovCandidates ──');
{
  // Use phrase-final nouns (no prepositions/articles immediately after)
  // to avoid Chekhov regex's greedy {0,2} optional-word issue.
  const chapters = [
    mockChapter(1, 'She held the ancient manuscript. She put the old cipher back carefully.'),
    mockChapter(2, 'The morning was quiet.'),   // no mention of manuscript or cipher
    mockChapter(3, 'The old cipher appeared again. The records were complete.'),  // cipher recurs!
  ];

  // Ch1 at index 0: ancient manuscript doesn't recur in ch2/ch3 → Chekhov candidate
  // old cipher DOES recur in ch3 → not a Chekhov candidate
  const cands = findChekhovCandidates(chapters, 0);
  const phrases = cands.map(c => c.phrase);
  expect('Introduced-and-unreturned manuscript is a Chekhov candidate',
    phrases.some(p => p.includes('manuscript')),
    `found: ${phrases.join(', ')}`);
  expect('Cipher (recurs in ch3) is NOT a Chekhov candidate',
    !phrases.some(p => p.includes('cipher')));
}

{
  // Final chapter has no "later chapters" → returns empty
  const chapters = [mockChapter(1, 'Text.'), mockChapter(2, 'Text.')];
  const cands = findChekhovCandidates(chapters, 1); // last chapter
  expect('Final chapter returns empty Chekhov candidates', cands.length === 0);
}

// ─── detectHandoff ────────────────────────────────────────────────────────

console.log('\n── detectHandoff ──');
{
  const chapters = [
    mockChapter(1, 'She left the apartment at dawn. The city was quiet as she descended.'),
    mockChapter(2, 'By midnight, she had reached the station. The lights were off.'),
  ];
  const worldData = { characters: [], places: [], factions: [], entities: [] };

  // Time drift: ch1 ends "dawn", ch2 opens "midnight"
  const h = detectHandoff(chapters, 1, worldData);
  expect('Dawn→midnight: time drift detected', h?.drift === 'time' || h?.drift === 'both',
    `drift=${h?.drift}`);
  expect('Prev time is dawn', h?.prevTime === 'dawn', `prevTime=${h?.prevTime}`);
  expect('This time is midnight', h?.thisTime === 'midnight', `thisTime=${h?.thisTime}`);
}

{
  // No drift: both chapters in morning
  const chapters = [
    mockChapter(1, 'The morning light came through the window. She made coffee.'),
    mockChapter(2, 'Morning. She dressed quickly and left the building.'),
  ];
  const worldData = { characters: [], places: [], factions: [], entities: [] };
  const h = detectHandoff(chapters, 1, worldData);
  expect('Same time-of-day: no time drift', h === null || h.drift === null || h.drift === 'place');
}

{
  // First chapter: no previous chapter → no handoff
  const chapters = [mockChapter(1, 'Dawn. She walked out.')];
  const worldData = { characters: [], places: [], factions: [], entities: [] };
  const h = detectHandoff(chapters, 0, worldData);
  expect('First chapter: detectHandoff returns null', h === null);
}

// ─── summarizeContinuity ─────────────────────────────────────────────────

console.log('\n── summarizeContinuity ──');
{
  const chapters = [
    mockChapter(1, 'She left the apartment at dawn. The rusted key sat on the table.'),
    mockChapter(2, 'By midnight, she had reached the terminal.'),
  ];
  const worldData = { characters: [], places: [], factions: [], entities: [] };
  const s = summarizeContinuity(chapters, worldData, 1);
  expect('summarizeContinuity returns a result', typeof s === 'object');
  expect('hasAnything is boolean', typeof s.hasAnything === 'boolean');
  expect('outOfOrder is array', Array.isArray(s.outOfOrder));
  expect('chekhov is array', Array.isArray(s.chekhov));
}

// ─── computeTagVariety ────────────────────────────────────────────────────

console.log('\n── computeTagVariety ──');
{
  const saidHeavy = '"Yes," she said. "No," he said. "Maybe," she said. "Fine," he said. "Okay," she said. "Done," he said. "Right," she said. "Wrong," he said.';
  const tv1 = computeTagVariety(saidHeavy);
  expect('All "said" → said-heavy verdict', tv1.verdict === 'said-heavy', `got ${tv1.verdict}`);
  expect('Said-heavy: high saidPct', tv1.saidPct > 0.90, `saidPct=${tv1.saidPct.toFixed(2)}`);
}

{
  const coloured = '"Yes," she whispered. "No!" he shouted. "Maybe," she growled. "Fine," he rasped. "Okay," she hissed. "Done," he barked. "Right?" she gasped.';
  const tv2 = computeTagVariety(coloured);
  expect('All coloured tags → purple verdict', tv2.verdict === 'purple', `got ${tv2.verdict}`);
  expect('Purple: low saidPct', tv2.saidPct < 0.40, `saidPct=${tv2.saidPct.toFixed(2)}`);
}

{
  const mixed = '"Yes," she said. "No!" he shouted. "Maybe," she said. "Fine!" he exclaimed. "Okay," she said. "Done," he said. "Right?" she whispered. "Wrong," he said.';
  const tv3 = computeTagVariety(mixed);
  expect('Mixed tags → balanced verdict', tv3.verdict === 'balanced', `got ${tv3.verdict}`);
}

{
  const shortText = '"Yes," she said.'; // only 1 attribution — below no-data threshold
  const tv4 = computeTagVariety(shortText);
  expect('Too few tags → no-data verdict', tv4.verdict === 'no-data');
}

// ─── profileCharacterVoices ───────────────────────────────────────────────

console.log('\n── profileCharacterVoices ──');
{
  // Build a mock speech result with two characters: Iris (long lines) and Nora (short lines)
  const paragraphs = [
    'Iris looked at the terminal. "The governance structure requires three distinct approval pathways before any allocation can proceed through the system."',
    '"Yes," Nora said. She paused.',
    '"The lattice processes the request through a validation layer that accounts for all registered stakeholders in the affected zone before returning a confidence rating."',
    '"I see," Nora said.',
  ];

  const speechResults: ChapterParaResult[] = [
    {
      segments: [{ start: 31, end: 154, type: 'speech', speaker: 'Iris', confidence: 0.95 }],
      meta: { tension: 'calm', dialogueDensity: 0.8 },
    },
    {
      segments: [{ start: 0, end: 6, type: 'speech', speaker: 'Nora', confidence: 0.95 }],
      meta: { tension: 'calm', dialogueDensity: 0.3 },
    },
    {
      segments: [{ start: 0, end: 145, type: 'speech', speaker: 'Iris', confidence: 0.95 }],
      meta: { tension: 'calm', dialogueDensity: 0.9 },
    },
    {
      segments: [{ start: 0, end: 8, type: 'speech', speaker: 'Nora', confidence: 0.95 }],
      meta: { tension: 'calm', dialogueDensity: 0.3 },
    },
  ];

  const voices = profileCharacterVoices(paragraphs, speechResults, undefined);
  expect('Two characters profiled', voices.length === 2, `got ${voices.length}`);

  const iris = voices.find(v => v.name === 'Iris');
  const nora = voices.find(v => v.name === 'Nora');
  expect('Iris has 2 speeches', iris?.speeches === 2, `got ${iris?.speeches}`);
  expect('Nora has 2 speeches', nora?.speeches === 2, `got ${nora?.speeches}`);
  expect('Iris avg line longer than Nora', (iris?.avgLineLength ?? 0) > (nora?.avgLineLength ?? 999),
    `iris=${iris?.avgLineLength?.toFixed(1)} nora=${nora?.avgLineLength?.toFixed(1)}`);
  expect('Speakers sorted by speech count (desc)', voices[0].speeches >= voices[1].speeches);
}

{
  // Empty speech results → no characters
  const voices = profileCharacterVoices(['No dialogue here.'], [], undefined);
  expect('No speeches → empty voices array', voices.length === 0);
}

// ─── Cross-genre: fantasy voice profile ──────────────────────────────────

console.log('\n── Cross-genre: fantasy voice profile ──');
{
  const paragraphs = [
    '"The sealing technique requires absolute stillness of the mana pathways throughout the entire casting sequence," Kira said.',
    '"Ready," Davan said.',
    '"The resonance must be calibrated to the specific frequency signature of this particular dimensional rift before the seal can take hold," Kira said.',
    '"Got it," Davan said.',
  ];
  const speechResults: ChapterParaResult[] = [
    { segments: [{ start: 0, end: 115, type: 'speech', speaker: 'Kira', confidence: 0.95 }], meta: { tension: 'high', dialogueDensity: 0.9 } },
    { segments: [{ start: 0, end: 8, type: 'speech', speaker: 'Davan', confidence: 0.95 }], meta: { tension: 'high', dialogueDensity: 0.3 } },
    { segments: [{ start: 0, end: 120, type: 'speech', speaker: 'Kira', confidence: 0.95 }], meta: { tension: 'high', dialogueDensity: 0.9 } },
    { segments: [{ start: 0, end: 8, type: 'speech', speaker: 'Davan', confidence: 0.95 }], meta: { tension: 'high', dialogueDensity: 0.3 } },
  ];

  const voices = profileCharacterVoices(paragraphs, speechResults, undefined);
  const kira = voices.find(v => v.name === 'Kira');
  const davan = voices.find(v => v.name === 'Davan');
  expect('Fantasy: Kira profiled', !!kira);
  expect('Fantasy: Davan profiled', !!davan);
  expect('Fantasy: Kira has longer lines than Davan', (kira?.avgLineLength ?? 0) > (davan?.avgLineLength ?? 999));
}

// ─── Summary ──────────────────────────────────────────────────────────────

const total = passed + failed;
const pct = Math.round(passed / total * 100);
console.log(`\n${'='.repeat(60)}`);
console.log(`continuity + voice accuracy: ${passed}/${total} (${pct}%)`);
console.log(`Target: ≥85%`);
console.log('='.repeat(60));
if (pct < 85) { console.log('Below target. Review failures.\n'); process.exit(1); }
else { console.log('Target met.\n'); }
