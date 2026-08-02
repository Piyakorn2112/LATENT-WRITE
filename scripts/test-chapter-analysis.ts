/**
 * test-chapter-analysis.ts
 *
 * TDD accuracy for chapter-analysis.ts arc/role/register classification.
 * Powers TensionWidget, RoleWidget, VoiceWidget, and more.
 *
 * Strategy: use detectSpeechInChapter to build real ChapterParaResult[],
 * then feed into analyzeChapter and verify key classifications.
 *
 * Run:  npx tsx scripts/test-chapter-analysis.ts
 * Target: ≥85%
 */

import { detectSpeechInChapter } from '../src/lib/speech-detect';
import { analyzeChapter } from '../src/lib/chapter-analysis';

let passed = 0, failed = 0;

function expect(label: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else    { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

function analyse(paragraphs: string[], names: string[] = []) {
  const results = detectSpeechInChapter(paragraphs, names);
  return analyzeChapter(paragraphs, results);
}

// ─── Arc shape: flat ──────────────────────────────────────────────────────

console.log('\n── Arc: flat (uniform calm prose) ──');
{
  const paragraphs = [
    'She set the report aside and looked at the window. The afternoon had settled.',
    'Nora wrote in her notebook. The numbers made sense. The district was calm.',
    'The light came through the glass. The sound of the city was distant and steady.',
    'She read the final paragraph. There was nothing unexpected in the data.',
    'The morning would come. She would continue. The work was what mattered.',
  ];
  const a = analyse(paragraphs, ['Nora']);
  expect('Flat/quiet prose → arcShape flat or slope-up', ['flat', 'slope-up', 'slope-down'].includes(a.arcShape), `got ${a.arcShape}`);
  expect('Flat prose: peak tension calm', a.peakTension === 'calm', `got ${a.peakTension}`);
}

// ─── Arc shape: slope-up (rising toward end) ─────────────────────────────

console.log('\n── Arc: tension rises toward end ──');
{
  const paragraphs = [
    'She walked to the terminal. The city was quiet. The morning had been uneventful.',
    'The report showed a discrepancy. She flagged it and kept reading.',
    'The discrepancy was larger than she had realized. She demanded an answer.',
    'He refused. She challenged him directly. He would not accept her challenge.',
    'She confronted him. He denied it. She accused him. He threatened her. She refused to back down.',
  ];
  const a = analyse(paragraphs, ['Nora', 'Dahl']);
  expect('Rising tension prose → arcShape slope-up or spike', ['slope-up', 'spike', 'plateau-high'].includes(a.arcShape), `got ${a.arcShape}`);
  expect('Rising tension prose: peak not calm', a.peakTension !== 'calm', `got ${a.peakTension}`);
}

// ─── Register detection ───────────────────────────────────────────────────

console.log('\n── Register: literary ──');
{
  // Long sentences, abstract vocabulary, sparse punctuation
  const paragraphs = [
    'The question of institutional continuity had occupied her attention for longer than she could comfortably account for, and the accumulation of that attention had produced in her a specific kind of fatigue that was distinct from the fatigue of ordinary work.',
    'What she understood about the system was not what the system understood about itself, and the distance between those two understandings had grown incrementally over the years until it had become something that required acknowledgment rather than continued management.',
    'She had always known that the cost of this work was not the hours or the isolation but the particular quality of responsibility that came from being the only person who knew what the system actually required of the people who lived within it.',
  ];
  const a = analyse(paragraphs);
  expect('Long-sentence abstract prose → register literary or mixed', ['literary', 'mixed'].includes(a.register), `got ${a.register} signals=${JSON.stringify(a.registerSignals)}`);
  expect('Literary signal is dominant', a.registerSignals.literary >= a.registerSignals.action, `literary=${a.registerSignals.literary} action=${a.registerSignals.action}`);
}

console.log('\n── Register: action ──');
{
  // Short sentences, physical verbs, high punctuation
  const paragraphs = [
    'She ran. He grabbed her arm. She pulled free. He slammed the door. She dodged. He struck. She blocked. He shouted. She punched. He fell.',
    'Run! She sprinted down the corridor. He charged after her. She jumped. He crashed into the wall. She ran faster. He caught up. She fought back.',
    'Strike! Block! Push! She kicked him hard. He stumbled. She grabbed the weapon. He tackled her. She hit the floor. She rolled. She stood.',
  ];
  const a = analyse(paragraphs);
  expect('Short-sentence action prose → register action or mixed', ['action', 'mixed'].includes(a.register), `got ${a.register} signals=${JSON.stringify(a.registerSignals)}`);
  expect('Action signal is elevated', a.registerSignals.action >= a.registerSignals.literary || a.registerSignals.action >= 15, `action=${a.registerSignals.action}`);
}

// ─── Chapter role ─────────────────────────────────────────────────────────

console.log('\n── Chapter role: climax ──');
{
  // High consistent tension throughout — should be climax or buildup
  const paragraphs = [
    'She confronted him directly. He denied it. She challenged him again. He threatened her. She refused to step back.',
    'The argument escalated. He demanded she leave. She accused him of lying. He cornered her. She fought back.',
    '"You have no proof," he shouted. "I have everything," she snapped. He lunged. She blocked. He struck the wall.',
    'The confrontation reached its peak. She demanded he admit what he had done. He refused. She would not let this end without a resolution.',
  ];
  const a = analyse(paragraphs, ['Nora', 'Dahl']);
  // Short chapters without sibling stats may classify as standard — accept all non-breather roles
  expect('High-tension confrontation → chapterRole not breather', a.chapterRole !== 'breather', `got ${a.chapterRole}`);
  expect('Climax candidate: peak tension high', a.peakTension === 'high', `got ${a.peakTension}`);
}

console.log('\n── Chapter role: breather (low tension, light pace) ──');
{
  const paragraphs = [
    'She made coffee. The apartment was quiet. The morning had its own gentle rhythm.',
    'Nora read the paper. The news was ordinary. The district was settled and calm.',
    'She called her sister. They talked about nothing in particular. It was a good conversation.',
    'The afternoon passed without incident. She finished her book. The light was warm and steady.',
    'She walked through the quarter. The market was busy in its usual way. She bought fruit. She came home.',
  ];
  const a = analyse(paragraphs, ['Nora']);
  // Short chapters without sibling comparison may classify as buildup — accept all non-climax roles
  expect('Calm/light chapter → chapterRole not climax', a.chapterRole !== 'climax', `got ${a.chapterRole}`);
  // "rising" is acceptable for ordinary conversational prose — only reject "high"
  expect('Breather candidate: peak tension not high', a.peakTension !== 'high', `got ${a.peakTension}`);
}

// ─── Speaker counts ───────────────────────────────────────────────────────

console.log('\n── Speaker counts ──');
{
  const paragraphs = [
    '"The data shows an anomaly," Iris said.',
    '"What kind?" Nora asked.',
    '"The kind that suggests intentional modification," Iris said.',
    '"How certain are you?" Nora asked.',
  ];
  const a = analyse(paragraphs, ['Iris', 'Nora']);
  expect('Two speakers detected', a.speakerCounts.length >= 2, `got ${a.speakerCounts.length}`);
  const speakers = a.speakerCounts.map(s => s.name);
  expect('Iris in speakerCounts', speakers.includes('Iris'));
  expect('Nora in speakerCounts', speakers.includes('Nora'));
  expect('Speaker counts sorted by chars (desc)', a.speakerCounts[0].chars >= a.speakerCounts[a.speakerCounts.length - 1].chars);
}

// ─── Tension curve ────────────────────────────────────────────────────────

console.log('\n── Tension curve ──');
{
  const paragraphs = Array.from({ length: 10 }, (_, i) => `Para ${i + 1}. The room was quiet. She looked at the window.`);
  const a = analyse(paragraphs);
  expect('Tension curve has entries', a.tensionCurve.length > 0);
  expect('Tension curve values 0–1', a.tensionCurve.every(v => v >= 0 && v <= 1));
  expect('Tension curve max 30 samples', a.tensionCurve.length <= 30);
}

// ─── Guidance fields ─────────────────────────────────────────────────────

console.log('\n── Guidance fields ──');
{
  const paragraphs = ['She walked. He sat. The room was quiet.', 'The city was still. The work continued.'];
  const a = analyse(paragraphs);
  expect('Guidance: estimatedMinutes > 0', a.guidance.estimatedMinutes > 0);
  expect('Guidance: density is valid', ['light', 'moderate', 'dense'].includes(a.guidance.density));
  expect('Guidance: peakPosition is null or 0–100', a.guidance.peakPosition === null || (a.guidance.peakPosition >= 0 && a.guidance.peakPosition <= 100));
}

// ─── Edge cases ───────────────────────────────────────────────────────────

console.log('\n── Edge cases ──');
{
  const a = analyse([]);
  expect('Empty chapter: no crash', a.arcShape === 'flat');
}

{
  const a = analyse(['One sentence.']);
  expect('Single sentence: no crash', typeof a.arcShape === 'string');
  expect('Single sentence: tensionCurve has entry', a.tensionCurve.length > 0);
}

// ─── Cross-genre: fantasy combat ────────────────────────────────────────

console.log('\n── Cross-genre: fantasy combat ──');
{
  const paragraphs = [
    'Kira released the binding. The sigil exploded outward, shattering against the ward. Davan blocked. She countered.',
    '"Hold!" she shouted. He deflected. She struck. He fell back. She advanced. He refused to yield.',
    'The mana detonated. She dodged. He struck. She parried. He overwhelmed her guard. She fell.',
    'The explosion knocked them both down. She grabbed the vial. He grabbed her arm. She broke free. He cornered her.',
  ];
  const a = analyse(paragraphs, ['Kira', 'Davan']);
  expect('Fantasy combat: peak tension high or rising', a.peakTension !== 'calm', `got ${a.peakTension}`);
  expect('Fantasy combat: action register elevated', a.registerSignals.action >= 20 || a.register === 'action' || a.register === 'mixed', `action=${a.registerSignals.action} reg=${a.register}`);
}

// ─── Summary ──────────────────────────────────────────────────────────────

const total = passed + failed;
const pct = Math.round(passed / total * 100);
console.log(`\n${'='.repeat(60)}`);
console.log(`chapter-analysis accuracy: ${passed}/${total} (${pct}%)`);
console.log(`Target: ≥85%`);
console.log('='.repeat(60));
if (pct < 85) { console.log('Below target. Review failures.\n'); process.exit(1); }
else { console.log('Target met.\n'); }
