/**
 * accuracy-suite.ts
 *
 * Comprehensive accuracy test for speech detection across all intelligence modes.
 * Adapted from novel-reader's accuracy suite for glass-editor's module system.
 *
 * Run with:  npx tsx scripts/accuracy-suite.ts
 *
 * Accuracy targets per mode:
 *   low     — 60–75%
 *   default — 75–90%
 *   high    — 90–98%
 */

import { detectSpeechInChapter, type IntelligenceLevel } from '../src/lib/speech-detect';

// ─── Test framework ───────────────────────────────────────────────────────

interface Expectation {
  para: number;
  contains: string;
  speaker: string;
  /** If true, this test is considered "hard" — only counted for default/high */
  hard?: boolean;
}

interface TestCase {
  name: string;
  source: string;
  paragraphs: string[];
  knownNames: string[];
  expect: Expectation[];
}

interface ModeResult {
  passed: number;
  failed: number;
  total: number;
  details: string[];
}

function runTestForMode(tc: TestCase, mode: IntelligenceLevel): ModeResult {
  const results = detectSpeechInChapter(tc.paragraphs, tc.knownNames, { intelligenceLevel: mode });
  const details: string[] = [];
  let passed = 0, failed = 0;

  for (const exp of tc.expect) {
    const segs = results[exp.para]?.segments ?? [];
    const seg = segs.find(s => tc.paragraphs[exp.para].slice(s.start, s.end).includes(exp.contains));
    const got = seg?.speaker ?? 'UNKNOWN';
    const ok = got === exp.speaker;
    if (ok) passed++; else failed++;
    const mark = ok ? '✓' : '✗';
    details.push(`    ${mark} P${exp.para}: "${exp.contains.slice(0, 45)}${exp.contains.length > 45 ? '…' : ''}" => ${ok ? got : `expected ${exp.speaker}, got ${got}`} (${seg?.confidence?.toFixed(2) ?? '?'})${exp.hard ? ' [HARD]' : ''}`);
  }
  return { passed, failed, total: passed + failed, details };
}

// ─── Test cases from Hollow Iris ──────────────────────────────────────────

const tests: TestCase[] = [

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 1: Original reported bug — Ch26-style governance dialogue (HIGH density)
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Governance bandwidth dialogue (reported bug)',
    source: 'Ch26-style — high dialogue density, bare alternation',
    knownNames: ['Iris', 'Nora'],
    paragraphs: [
      'Iris heard her cross it out — the sound was small but distinctive in the apartment’s quiet, the specific drag of the pen across the written line. Iris did not look up. After the crossing-out, there was a pause, and then Nora said: “What’s the governance bandwidth doing with the Virex proposal?”',
      '“Stable,” Iris said. “The committee’s preliminary review is generating the expected monitoring load.” She looked up from the terminal. “The Null Bloc’s observer is on-site. The monitoring shows the observer’s relay connection is active.”',
      '“Since when?”',
      '“Since 18:00.”',
      '“That’s interesting.” Nora was quiet for a moment, then: “What does the Null Bloc’s observer’s presence tell you about the committee’s preliminary read?”',
      '“That the Null Bloc considers the preliminary review significant enough to observe directly. Which means the Null Bloc believes the committee’s preliminary conclusions will shape the political landscape in ways that later review may not be able to adjust.”',
      '“Right,” Nora said.',
    ],
    expect: [
      { para: 0, contains: 'What’s the governance bandwidth', speaker: 'Nora' },
      { para: 1, contains: 'Stable', speaker: 'Iris' },
      { para: 1, contains: 'The committee’s preliminary review', speaker: 'Iris' },
      { para: 1, contains: 'The Null Bloc’s observer is on-site', speaker: 'Iris', hard: true },
      { para: 2, contains: 'Since when', speaker: 'Nora' },
      { para: 3, contains: 'Since 18:00', speaker: 'Iris' },
      { para: 4, contains: 'That’s interesting', speaker: 'Nora' },
      { para: 4, contains: 'What does the Null Bloc', speaker: 'Nora', hard: true },
      { para: 5, contains: 'That the Null Bloc considers', speaker: 'Iris' },
      { para: 6, contains: 'Right', speaker: 'Nora' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 2: Ch52 — evening conversation, embedded opinion + probe (LOW density)
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Evening assessment — embedded quote in narrative',
    source: 'Ch52 — low dialogue density, long narrative beats',
    knownNames: ['Iris', 'Nora', 'Thayne', 'Dahl'],
    paragraphs: [
      'Iris’s opinions were specific and technical. In the evenings, when they sat together in the apartment’s amber light, Iris would comment on the candidates she had seen on the feeds — her assessments precise, her judgments of their competence delivered with the particular authority of someone who understood the system’s constraints from inside. “Thayne understands the architecture,” Iris said one evening, her feet drawn up on the couch, the tablet balanced on her knees. “Dahl understands the consequences. The Council needs both.”',
      '“You follow the appointments closely,” Nora said. The observation was neutral.',
      'Iris looked up from her tablet. Her expression was open and unremarkable. “Everyone follows the appointments,” she said. “The Council will determine how the system is governed for the next decade. That matters to anyone who lives in a connected district.”',
    ],
    expect: [
      { para: 0, contains: 'Thayne understands the architecture', speaker: 'Iris' },
      { para: 0, contains: 'Dahl understands the consequences', speaker: 'Iris', hard: true },
      { para: 1, contains: 'You follow the appointments', speaker: 'Nora' },
      { para: 2, contains: 'Everyone follows the appointments', speaker: 'Iris' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 3: Ch52 — short exchange, Qesh appointment (LOW density)
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Qesh appointment — minimal dialogue in narrative',
    source: 'Ch52 — very low density, single exchange',
    knownNames: ['Iris', 'Nora', 'Qesh'],
    paragraphs: [
      'The apartment door opened. Iris was at the counter. The cup was in its place.',
      '“Qesh got the chair,” Nora said.',
      'Iris looked up from her tablet. “Good,” she said. The word was simple and carried the weight of a judgment made from a century of institutional experience.',
    ],
    expect: [
      { para: 1, contains: 'Qesh got the chair', speaker: 'Nora' },
      { para: 2, contains: 'Good', speaker: 'Iris' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 4: Ch75 — military source interview (HIGH density, generic speaker)
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Military source interview — generic speaker + alternation',
    source: 'Ch75 — high density, generic "officer" speaker',
    knownNames: ['Nora'],
    paragraphs: [
      '“Three Venture-class is overkill for the Drift Belt,” the officer said. The communication was encrypted. “The Drift Belt’s military threat profile doesn’t justify that level of hardware. Two frigates and a patrol complement would handle the security concerns. Three Venture-class is a statement.”',
      '“A statement to whom?” Nora asked.',
      '“To HEDA. To the Assembly. To anyone considering whether the Drift Belt’s governance future includes institutional authority or corporate authority.”',
    ],
    expect: [
      { para: 0, contains: 'Three Venture-class is overkill', speaker: 'Officer' },
      { para: 0, contains: 'The Drift Belt’s military threat', speaker: 'Officer', hard: true },
      { para: 1, contains: 'A statement to whom', speaker: 'Nora' },
      { para: 2, contains: 'To HEDA', speaker: 'Officer' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 5: Ch75 — allocation coordinator quote (embedded)
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Allocation coordinator — embedded quote + follow-up',
    source: 'Ch75 — named generic speaker, multi-quote paragraph',
    knownNames: ['Nora', 'Auren'],
    paragraphs: [
      'An allocation coordinator named Pell Auren had shown Nora the allocation boards. “We’re about eight percent slower than the lattice,” Auren said. “On a good day. On a bad day — when we get multiple requests from overlapping zones — closer to fifteen.”',
      '“Is that sustainable?” Nora asked.',
      '“It’s sustainable because the settlements decided it was worth it,” Auren said. “We lose eight percent efficiency. We gain knowledge of what we’re doing and why we’re doing it. The lattice gave us efficiency. The lattice didn’t give us understanding.”',
    ],
    expect: [
      { para: 0, contains: 'We’re about eight percent slower', speaker: 'Auren' },
      { para: 0, contains: 'On a good day', speaker: 'Auren', hard: true },
      { para: 1, contains: 'Is that sustainable', speaker: 'Nora' },
      { para: 2, contains: 'It’s sustainable', speaker: 'Auren' },
      { para: 2, contains: 'We lose eight percent efficiency', speaker: 'Auren', hard: true },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 6: Ch75 — Iris-Nora evening call (MEDIUM density)
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Evening call — lattice analysis exchange',
    source: 'Ch75 — medium density, pronoun + direct attribution',
    knownNames: ['Iris', 'Nora'],
    paragraphs: [
      '“Meridian deployed Venture-class to the Belt,” Nora said.',
      '“I saw,” Iris said. The voice was Iris’s voice transmitted across the distance. “Three ships. Calderon’s statement is playing on every feed.”',
      '“What does the lattice think?”',
      '“The lattice classifies it as a governance realignment,” Iris said. “The classification means the lattice recognizes that Meridian’s presence changes the Drift Belt’s authority structure but does not classify the change as a military threat. The classification is — accurate and insufficient.”',
      '“What implications?”',
      '“Be careful,” Nora said.',
      '“I’m always careful,” Iris said.',
    ],
    expect: [
      { para: 0, contains: 'Meridian deployed', speaker: 'Nora' },
      { para: 1, contains: 'I saw', speaker: 'Iris' },
      { para: 1, contains: 'Three ships', speaker: 'Iris', hard: true },
      { para: 2, contains: 'What does the lattice think', speaker: 'Nora' },
      { para: 3, contains: 'The lattice classifies it', speaker: 'Iris' },
      { para: 3, contains: 'The classification means', speaker: 'Iris', hard: true },
      { para: 4, contains: 'What implications', speaker: 'Nora', hard: true },
      { para: 5, contains: 'Be careful', speaker: 'Nora' },
      { para: 6, contains: 'I’m always careful', speaker: 'Iris' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 7: Ch83 — bandwidth spike dialogue (HIGH density, bare alternation)
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Bandwidth spike — rapid bare alternation',
    source: 'Ch83 — high density, rapid exchange',
    knownNames: ['Iris', 'Nora'],
    paragraphs: [
      '“The lattice spiked during the engagement,” Iris told Nora when Nora came home. The amber light was on. “The tactical coordination consumed seventeen percent of governance bandwidth for the duration of the forty-seven minutes. The predictive models paused. Not degraded — paused.”',
      '“Seventeen percent,” Nora said.',
      '“For forty-seven minutes. The recovery took ninety-three minutes. The predictive models required recalibration after the pause. Total governance interruption: two hours and twenty minutes.”',
      '“For a forty-seven-minute engagement.”',
      '“For a forty-seven-minute engagement,” Iris confirmed. “Iris thinks — I think the next engagement will be longer.”',
      '“Be careful,” Nora said.',
      '“I’m always careful,” Iris said.',
    ],
    expect: [
      { para: 0, contains: 'The lattice spiked', speaker: 'Iris' },
      { para: 0, contains: 'The tactical coordination consumed', speaker: 'Iris', hard: true },
      { para: 1, contains: 'Seventeen percent', speaker: 'Nora' },
      { para: 2, contains: 'For forty-seven minutes', speaker: 'Iris' },
      { para: 3, contains: 'For a forty-seven-minute engagement', speaker: 'Nora' },
      { para: 4, contains: 'For a forty-seven-minute engagement', speaker: 'Iris' },
      { para: 5, contains: 'Be careful', speaker: 'Nora' },
      { para: 6, contains: 'I’m always careful', speaker: 'Iris' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 8: Ch90 — siege analysis, multi-turn bare exchange (HARD)
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Siege analysis — deep bare alternation + pronoun',
    source: 'Ch90 — high density, 3-deep bare alternation',
    knownNames: ['Iris', 'Nora'],
    paragraphs: [
      'Iris provided the lattice’s perspective through the evening’s communication link.',
      '“The Spine’s Rapid Futures models are degrading faster than Calderon’s briefing acknowledged,” Iris said. “The error rate is not three point seven percent. The error rate is five point two percent and accelerating.”',
      '“How long before the models fail entirely?”',
      '“Iris calculates — I calculate three to four weeks at the current degradation rate. The Spine will need to transition to manual governance within the month.”',
      '“Is the siege winnable?” Nora asked.',
      '“For whom?”',
      '“For anyone.”',
      'Iris’s pause was the lattice processing the question. “The siege is the institution’s temporal advantage expressed through military positioning. The differential favors the institution.”',
      '“Then the siege works.”',
      '“The siege works if the metric is the Spine’s capitulation. The siege does not work if the metric is the system’s governance capacity. The victory is hollow.”',
      '“Be careful,” Nora said.',
      '“I’m always careful,” Iris said.',
    ],
    expect: [
      { para: 1, contains: 'The Spine’s Rapid Futures', speaker: 'Iris' },
      { para: 1, contains: 'The error rate is not', speaker: 'Iris', hard: true },
      { para: 2, contains: 'How long before the models', speaker: 'Nora' },
      { para: 3, contains: 'Iris calculates', speaker: 'Iris' },
      { para: 4, contains: 'Is the siege winnable', speaker: 'Nora' },
      { para: 5, contains: 'For whom', speaker: 'Iris' },
      { para: 6, contains: 'For anyone', speaker: 'Nora' },
      { para: 7, contains: 'The siege is the institution', speaker: 'Iris' },
      { para: 8, contains: 'Then the siege works', speaker: 'Nora' },
      { para: 9, contains: 'The siege works if', speaker: 'Iris' },
      { para: 10, contains: 'Be careful', speaker: 'Nora' },
      { para: 11, contains: 'I’m always careful', speaker: 'Iris' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 9: Ch65 — barge attack analysis (MEDIUM density)
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Barge attack — action beat + pronoun carry',
    source: 'Ch65 — medium density, action beats between quotes',
    knownNames: ['Iris', 'Nora', 'Mori'],
    paragraphs: [
      'Iris arrived late. She looked tired.',
      '“The barge,” Iris said. She sat on the couch and the sitting was a controlled lowering. “They used the handshake protocols.”',
      '“Mori flagged the access pathway eighteen months ago,” Nora said. She sat beside Iris on the couch.',
      '“Regulatory gaps,” Iris said. The words were quiet. “The framework wasn’t designed for an entity that would use operational data as signal intelligence.”',
    ],
    expect: [
      { para: 1, contains: 'The barge', speaker: 'Iris' },
      { para: 1, contains: 'They used the handshake', speaker: 'Iris', hard: true },
      { para: 2, contains: 'Mori flagged', speaker: 'Nora' },
      { para: 3, contains: 'Regulatory gaps', speaker: 'Iris' },
      { para: 3, contains: 'The framework wasn’t designed', speaker: 'Iris', hard: true },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 10: Ch84 — emotional bandwidth dialogue (HARD — 3rd person self-ref)
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Bandwidth fear — emotional exchange with body language',
    source: 'Ch84 — medium density, emotional beats',
    knownNames: ['Iris', 'Nora'],
    paragraphs: [
      '“I don’t know,” Iris said.',
      'The answer was honest. The answer was the honesty that the confrontation had established as the apartment’s practice.',
      '“How much bandwidth do you have?”',
      '“Enough. For now. But the ‘for now’ is the problem. The fleet operations consume bandwidth. Each spike reduces the available capacity. And the available capacity is the capacity that maintains me.” She touched her chest.',
      '“Iris is afraid this is what happens,” Iris said. The third person was the fear’s distance.',
      'Nora held her.',
      '“Did you feel it?” Nora asked. The question quiet.',
      '“Yes,” Iris said. “Three presences. And then three absences. The absences have a quality — they’re not silence, they’re the shape of what used to be sound.”',
    ],
    expect: [
      { para: 0, contains: 'I don’t know', speaker: 'Iris' },
      { para: 2, contains: 'How much bandwidth', speaker: 'Nora' },
      { para: 3, contains: 'Enough. For now', speaker: 'Iris' },
      { para: 4, contains: 'Iris is afraid', speaker: 'Iris' },
      { para: 6, contains: 'Did you feel it', speaker: 'Nora' },
      { para: 7, contains: 'Yes', speaker: 'Iris' },
      { para: 7, contains: 'Three presences', speaker: 'Iris', hard: true },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 11: Context-depth A — action subject 2 paras back (low=1 fails, default/high=3+ pass)
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Context depth: action subject 2 paras back (low fails)',
    source: 'Synthetic — extCtxDepth 1 vs 3 difference',
    knownNames: ['Iris', 'Nora'],
    paragraphs: [
      'Nora set down her pen. “Tell me about the second incident,” she said.',
      'Iris turned to the window. The amber light crossed her face in the particular way it did at this hour.',
      'The room held the quiet that followed difficult questions.',
      '“The second incident wasn’t mechanical,”',
    ],
    expect: [
      { para: 0, contains: 'Tell me about the second incident', speaker: 'Nora' },
      { para: 3, contains: 'The second incident wasn’t mechanical', speaker: 'Iris', hard: true },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 12: Context-depth B — speaker bootstrapped 4 paras back (only high=6 passes)
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Context depth: speaker 4 paras back (only high passes)',
    source: 'Synthetic — extCtxDepth 1 vs 3 vs 6 difference',
    knownNames: ['Iris', 'Nora'],
    paragraphs: [
      '“I’ve been reading the preliminary report,” Nora said.',
      '“The preliminary report is accurate,” Iris said.',
      'The afternoon light changed. The terminal continued its quiet processing.',
      'Outside, the city moved through its usual patterns. The district was calm.',
      'Iris did not speak again for a long time. She was reading, or appeared to be reading.',
      'Nora looked up from her notes. The question had been forming for some time.',
      '“How long have you known?”',
    ],
    expect: [
      { para: 0, contains: 'I’ve been reading the preliminary report', speaker: 'Nora' },
      { para: 1, contains: 'The preliminary report is accurate', speaker: 'Iris' },
      { para: 6, contains: 'How long have you known', speaker: 'Nora', hard: true },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 13: maxRecentSpeakers window — Iris monologue pushes Nora out of low's 3-slot window
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Speaker window: Nora lost after Iris monologue (low fails)',
    source: 'Synthetic — maxRecentSpeakers 3 vs 7 difference',
    knownNames: ['Iris', 'Nora'],
    paragraphs: [
      '“What do you actually want?” Nora asked.',
      '“I want to understand,” Iris said.',
      '“Understanding is not neutral,” Iris said. “Understanding is a form of proximity.”',
      '“Proximity changes both parties,” Iris said. “The observer is never unchanged.”',
      '“Is that a warning?”',
    ],
    expect: [
      { para: 0, contains: 'What do you actually want', speaker: 'Nora' },
      { para: 1, contains: 'I want to understand', speaker: 'Iris' },
      { para: 2, contains: 'Understanding is not neutral', speaker: 'Iris' },
      { para: 3, contains: 'Proximity changes both parties', speaker: 'Iris' },
      { para: 4, contains: 'Is that a warning', speaker: 'Nora', hard: true },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 14: Three-party conversation — window pressure
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: '3-party window pressure — third speaker lost in low mode',
    source: 'Synthetic — 3-party + maxRecentSpeakers 3 vs 7',
    knownNames: ['Iris', 'Nora', 'Helia'],
    paragraphs: [
      '“The lattice’s decision was not arbitrary,” Iris said.',
      '“I know it wasn’t arbitrary,” Nora said.',
      '“Arbitrary and structured are not the only options,” Helia said.',
      '“What’s the third option?” Nora asked.',
      '“Necessary,” Iris said.',
      '“Necessary for whom?” Helia said. The question was precise.',
      '“For the system,” Iris said.',
      '“The system doesn’t want. The system calculates.”',
    ],
    expect: [
      { para: 0, contains: 'The lattice’s decision', speaker: 'Iris' },
      { para: 1, contains: 'I know it wasn’t arbitrary', speaker: 'Nora' },
      { para: 2, contains: 'Arbitrary and structured', speaker: 'Helia' },
      { para: 3, contains: 'What’s the third option', speaker: 'Nora' },
      { para: 4, contains: 'Necessary', speaker: 'Iris' },
      { para: 5, contains: 'Necessary for whom', speaker: 'Helia' },
      { para: 6, contains: 'For the system', speaker: 'Iris' },
      { para: 7, contains: 'The system doesn’t want', speaker: 'Helia', hard: true },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 15: ExtCtx thread bootstrap — bare quote after 1 attribution + 3 narrative paras
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Thread bootstrap: 1 quote then 3 narrative paras (high resolves)',
    source: 'Synthetic — THREAD-INFERRED ALTERNATION A2 (high only)',
    knownNames: ['Iris', 'Nora'],
    paragraphs: [
      '“The data is incomplete,” Iris said. She set the tablet down.',
      'The apartment was quiet. The evening light had the amber quality Nora associated with Iris’s thinking.',
      'Nora watched her from across the room.',
      'The silence extended past the point where it required comment.',
      '“What kind of incomplete?”',
    ],
    expect: [
      { para: 0, contains: 'The data is incomplete', speaker: 'Iris' },
      { para: 4, contains: 'What kind of incomplete', speaker: 'Nora', hard: true },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 16: Long-distance extCtx name mention boosts Bayesian score
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'ExtCtx density boost — frequent name mention aids attribution',
    source: 'Synthetic — extCtxDensity Bayesian bonus (default/high)',
    knownNames: ['Iris', 'Nora', 'Helia'],
    paragraphs: [
      'Helia crossed the room. “The lattice’s architecture is self-modifying,” she said.',
      'Helia had understood this for longer than the others. Helia had designed the self-modification into the original architecture. The feature Helia had considered a strength was now the feature the committee was questioning.',
      '“That explains the variance,” Nora said.',
      '“The variance is within designed parameters,” Iris said.',
      '“Designed parameters are not the same as safe parameters.”',
    ],
    expect: [
      { para: 0, contains: 'The lattice’s architecture', speaker: 'Helia' },
      { para: 2, contains: 'That explains the variance', speaker: 'Nora' },
      { para: 3, contains: 'The variance is within', speaker: 'Iris' },
      { para: 4, contains: 'Designed parameters are not', speaker: 'Nora', hard: true },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 17: Ch65 — newsroom opening (generic speaker)
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Newsroom — editor instruction',
    source: 'Ch65 — single quote with named character context',
    knownNames: ['Nora', 'Kaelen'],
    paragraphs: [
      'Kaelen appeared at her desk within minutes. “The barge,” he said. “Not an accident.”',
    ],
    expect: [
      { para: 0, contains: 'The barge', speaker: 'Kaelen' },
      { para: 0, contains: 'Not an accident', speaker: 'Kaelen', hard: true },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 18: Ch15 — Ilyon/Nora "Ask" sequence
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Ch15 Gradient — Ilyon/Nora bare alternation after single anchor',
    source: 'Ch15 The Gradient — high density, 5-para bare alternation chain',
    knownNames: ['Nora', 'Ilyon'],
    paragraphs: [
      '“Ask,” Nora said.',
      '“Kairon’s governance model. The actual model, not the textbook version. How do decisions get made? Who decides? What happens when the decision-makers disagree?”',
      '“They argue. Publicly. The arguments are — messy. Inefficient. Sometimes destructive. The debates in the Assembly can last weeks and produce results that satisfy nobody entirely, because the process is designed for compromise rather than optimization, and compromise by definition means that everyone gets less than they wanted.”',
      '“And the population accepts this?”',
      '“The population participates in it. The arguing is the governance. There’s no system behind the system that resolves the arguments the population can’t resolve — no mechanism that takes over when human judgment stalls and produces the optimal outcome that the humans failed to reach. If the humans stall, the outcome stalls with them. It’s slow and it’s frustrating and it works, in the specific sense that the population retains the capacity to make its own mistakes and to learn from them.”',
    ],
    expect: [
      { para: 0, contains: 'Ask', speaker: 'Nora' },
      { para: 1, contains: 'Kairon’s governance model', speaker: 'Ilyon' },
      { para: 2, contains: 'They argue. Publicly', speaker: 'Nora' },
      { para: 3, contains: 'And the population accepts this', speaker: 'Ilyon' },
      { para: 4, contains: 'The population participates in it', speaker: 'Nora' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 19: Ch15 — "What does the Gradient want?" + "Come to a gathering"
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Ch15 Gradient — Nora/Ilyon "want" exchange + invitation',
    source: 'Ch15 The Gradient — high density, direct + bare 7-para sequence',
    knownNames: ['Nora', 'Ilyon'],
    paragraphs: [
      '“What does the Gradient want?” Nora asked.',
      '“The Gradient wants what every civic movement wants — voice. Participation. A seat at the table where the decisions that affect our lives are made. We are not revolutionaries. We do not want to dismantle the system — the system does demonstrable good, it maintains life, it manages complexity that no human governance structure could match. What we want is to be inside the process rather than outside it. We want the system to be accountable to the people it serves, rather than the other way around.”',
      '“Is that realistic?”',
      '“Is it realistic to ask a system that has been making decisions without input for longer than anyone alive can remember to suddenly accept input? No. Not if you’re assessing realism as probability of success within the current framework. But realism as probability of success is the system’s definition of realism — a definition that evaluates every proposed change by the likelihood that the system will permit it, which is circular, because the system permits what the system evaluates as permissible, and the system’s evaluation criteria were designed for the system’s perpetuation.” She smiled the sharp smile. “The Gradient isn’t interested in the system’s definition of realistic. We’re interested in the human definition, which is: is it right? Is it necessary? And are we willing to do the work even if the outcome is not guaranteed?”',
      '“Come to a gathering,” Ilyon said, as they were finishing. “Not a meeting — we don’t have meetings in the way that political organizations have meetings. We have conversations. In small groups. In spaces where the environmental systems are — less attentive.” She smiled. “The less-calibrated spaces are the free spaces, on this planet. Where the system’s attention is lighter, people talk more honestly. It’s another architecture lesson.”',
      '“When?”',
      '“Friday evening. Lower level of the cultural exchange building. The room with the old amphitheater seating — you know it.”',
    ],
    expect: [
      { para: 0, contains: 'What does the Gradient want', speaker: 'Nora' },
      { para: 1, contains: 'The Gradient wants what every civic movement', speaker: 'Ilyon' },
      { para: 2, contains: 'Is that realistic', speaker: 'Nora', hard: true },
      { para: 3, contains: 'Is it realistic to ask a system', speaker: 'Ilyon' },
      { para: 4, contains: 'Come to a gathering', speaker: 'Ilyon' },
      { para: 4, contains: 'The less-calibrated spaces are the free spaces', speaker: 'Ilyon', hard: true },
      { para: 5, contains: 'When', speaker: 'Nora', hard: true },
      { para: 6, contains: 'Friday evening', speaker: 'Ilyon' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 20: Ch15 — Iris/Nora café "They're not wrong"
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Ch15 Café — Iris "they\'re not wrong" + Nora challenge',
    source: 'Ch15 The Gradient — heavy dialogue, philosophical exchange',
    knownNames: ['Iris', 'Nora'],
    paragraphs: [
      '“They’re not wrong,” Iris said, when Nora finished. “The Gradient. They’re not wrong about the cost. They’re not wrong about the absence of choice. They’re not wrong about any of it.” She paused. The pause was characteristic but longer than usual, as though the words that followed required more space than ordinary words. “What they don’t know — what almost nobody knows — is that the cost they’re describing is not a design flaw. It’s the design. The system was built to absorb human variability. It was built to make human judgment unnecessary, not as a side effect but as a goal. And the person who built it—” She stopped. Her hands, which had been resting on the table, moved to her cup, wrapping around it with the tight, two-handed grip that Nora associated with Iris at her most careful. “The person who built it did so because they believed — genuinely, completely, with the kind of conviction that only comes from experience — that human judgment, given enough time and enough power, would produce outcomes worse than any system’s worst failure. And they were not wrong about that either.”',
      '“You’re defending the system.”',
      '“I’m describing the system. There’s a difference. Defending would mean I agree with its conclusions. Describing means I understand its premises.” She looked at Nora over the rim of her cup, and the look was the serious one, the one with the sad warmth, the one that contained more truth than Iris was saying. “The Gradient sees the cost and wants to redistribute it. That’s reasonable. That’s human. But the cost is structural. Moving it from one place to another doesn’t reduce it — it changes who bears it and how. The question the Gradient hasn’t asked yet is whether they’re willing to bear a cost that’s different from the one they’re currently bearing, and whether the different cost might be worse. Not because the system is right — but because the problem the system was built to solve is real, and the problem doesn’t go away just because the solution is flawed.”',
      'The conversation settled between them like sediment in water — suspended, still moving, but beginning to find its level.',
      '“Who built the system, Iris?” Nora asked, very quietly.',
      'Iris looked at her. The look lasted three seconds. In those three seconds, Nora saw the answer form behind Iris’s eyes and then be set aside, placed back in the space where Iris kept the things she was not yet ready to say.',
      '“Someone who is tired,” Iris said. “Someone who has been holding the shape of this world for longer than you can imagine. Someone who pays the cost you were told about tonight, personally, physically, every day, and who cannot stop paying it because the alternative is a world that forgets why it was built.”',
    ],
    expect: [
      { para: 0, contains: 'They’re not wrong', speaker: 'Iris' },
      { para: 0, contains: 'The person who built it did so', speaker: 'Iris', hard: true },
      { para: 1, contains: 'You’re defending the system', speaker: 'Nora' },
      { para: 2, contains: 'I’m describing the system', speaker: 'Iris' },
      { para: 2, contains: 'The Gradient sees the cost', speaker: 'Iris', hard: true },
      { para: 4, contains: 'Who built the system, Iris', speaker: 'Nora' },
      { para: 6, contains: 'Someone who is tired', speaker: 'Iris' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 21: Ch14 — Varren transit delay exchange
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Ch14 Questions — Varren transit delays',
    source: 'Ch14 Questions — low density, split attribution + bare alternation',
    knownNames: ['Nora', 'Varren'],
    paragraphs: [
      '“Two months ago,” he said, sitting across from her in the common dining area with the careful posture of someone discussing something they suspected they should not discuss, “the morning capsule from the residential tier to the lecture complex was late three times in a week. The first time by approximately twenty seconds. The second by forty-five. The third by nearly a minute. Then the delays stopped and the system returned to its normal performance, and nobody talked about it because the delays were within the tolerance that the official parameters defined as acceptable, and because the return to normal made the delays feel like they had been normal all along.”',
      '“Did anyone report it?”',
      '“There’s nothing to report. The parameters were met. You can feel that something is off, but feeling is not data, and the system runs on data. What the system doesn’t measure, the system doesn’t see.”',
    ],
    expect: [
      { para: 0, contains: 'Two months ago', speaker: 'Varren' },
      { para: 0, contains: 'the morning capsule from the residential tier', speaker: 'Varren', hard: true },
      { para: 1, contains: 'Did anyone report it', speaker: 'Nora' },
      { para: 2, contains: 'There’s nothing to report', speaker: 'Varren' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 22: Ch14 — Sable building temperature patterns
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Ch14 Questions — Sable building temperature patterns',
    source: 'Ch14 Questions — medium density, action beats + bare alternation',
    knownNames: ['Nora', 'Sable'],
    paragraphs: [
      '“The building temperatures,” Sable said. They were walking — not the secondary corridors that Iris had shown Nora, but the main academic quarter corridors, because Sable’s temperament was to conduct her observations in public spaces, where the act of noticing was itself a kind of statement. “Have you noticed the building temperatures?”',
      '“Variations.”',
      '“Not variations. Patterns. The variations aren’t random — they follow a rhythm that correlates with the campus’s activity levels. When the population is highest, the temperature control is most stable. When the population drops — evenings, weekends, the lecture-break intervals — the variations increase. As though the system is prioritizing its calibration effort and directing it toward the moments when the most people are watching.”',
      '“That could be an efficiency design. Concentrate resources where they’re needed most.”',
      '“It could be. It could also be a system that has learned to hide its problems where the fewest observers will notice them.” Sable’s expression was not conspiratorial — it was analytical, the expression of a person who preferred explanations over mysteries.',
    ],
    expect: [
      { para: 0, contains: 'The building temperatures', speaker: 'Sable' },
      { para: 0, contains: 'Have you noticed the building temperatures', speaker: 'Sable', hard: true },
      { para: 1, contains: 'Variations', speaker: 'Nora' },
      { para: 2, contains: 'Not variations. Patterns', speaker: 'Sable' },
      { para: 3, contains: 'That could be an efficiency design', speaker: 'Nora' },
      { para: 4, contains: 'It could be. It could also be', speaker: 'Sable' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 23: Ch14 — Mareth office "Is the system failing?" (11 paras)
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Ch14 Questions — Mareth office: "Is the system failing?"',
    source: 'Ch14 Questions — high density, 11-para multi-turn Nora/Mareth',
    knownNames: ['Nora', 'Mareth'],
    paragraphs: [
      '“You’ve been walking through the institutional district,” he said. Not a question.',
      '“You know that?”',
      '“I know because I know the expression on your face. Every cohort produces one student who walks through the institutional district and comes back with that expression — the expression of someone who has seen the machine’s moving parts and is now trying to decide whether the machine is working as designed or whether the design has limits that the machine’s public-facing components do not acknowledge.” He drank from the cold cup without noticing or caring that its contents were cold. “I have been teaching here for twenty-two years. The expression has not changed.”',
      '“What do you tell them? The students with the expression.”',
      '“I tell them the truth, which is that the expression is correct. The institutional district is where the system’s operational complexity is most visible, and the complexity includes tensions that the system’s public narrative does not address. This is not a secret. This is the nature of institutions — they are run by people, and people disagree, and the disagreements are managed rather than resolved, and the management is imperfect because the people doing the managing are the same imperfect people who are doing the disagreeing.” He set down the cup. “What specifically are you asking?”',
      '“Is the system failing?”',
      '“The system is old,” he said, slowly. “And old things develop characteristics that are not failures in the engineering sense — they are not broken components or violated specifications. They are the natural consequences of extended operation. A bridge that has carried traffic for a century develops stresses that the original design did not anticipate, not because the design was poor but because the design was for a specific set of conditions, and conditions change.” He looked at her with the tired, warm eyes. “The question isn’t whether the system works. The question is who it works for, and what it costs the people closest to its machinery.”',
      '“Is there a difference?”',
      '“Maintained implies a system that is self-correcting — that identifies problems and resolves them, returning to the original specification. Held implies a system that is compensating — that absorbs problems without resolving them, distributing the stress across the structure rather than eliminating it. The difference is invisible until the moment of failure.”',
      '“Who are the people closest to the machinery?”',
      '“That,” he said, “is a question worth continuing to ask.”',
    ],
    expect: [
      { para: 0, contains: 'You’ve been walking through the institutional district', speaker: 'Mareth' },
      { para: 1, contains: 'You know that', speaker: 'Nora' },
      { para: 2, contains: 'I know because I know the expression', speaker: 'Mareth' },
      { para: 2, contains: 'I have been teaching here for twenty-two years', speaker: 'Mareth', hard: true },
      { para: 3, contains: 'What do you tell them', speaker: 'Nora' },
      { para: 4, contains: 'I tell them the truth', speaker: 'Mareth' },
      { para: 4, contains: 'What specifically are you asking', speaker: 'Mareth', hard: true },
      { para: 5, contains: 'Is the system failing', speaker: 'Nora' },
      { para: 6, contains: 'The system is old', speaker: 'Mareth' },
      { para: 6, contains: 'The question isn’t whether the system works', speaker: 'Mareth', hard: true },
      { para: 7, contains: 'Is there a difference', speaker: 'Nora' },
      { para: 8, contains: 'Maintained implies a system that is self-correcting', speaker: 'Mareth' },
      { para: 9, contains: 'Who are the people closest to the machinery', speaker: 'Nora' },
      { para: 10, contains: 'is a question worth continuing to ask', speaker: 'Mareth' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 24: Ch12 — "Can I ask you something else?" / "Everything."
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Ch12 What Iris Knows — "Can I ask" through "Everything"',
    source: 'Ch12 — medium density, narrative break + bare sequence',
    knownNames: ['Iris', 'Nora'],
    paragraphs: [
      '“Can I ask you something else?” Nora said.',
      '“You can ask.”',
      '“The system — the one that runs things, the one that manages the planet. You talk about it — not the way people talk about governments or institutions. You talk about it the way people talk about families they grew up in. With love and frustration and this impossible combination of understanding and resentment that only comes from having been inside something your entire life.”',
      'Iris looked at her. The look was long and warm and sad, and the sadness was not the melodramatic sadness of a revelation but the quiet sadness of recognition — the look of a person who has been seen truly and who finds the seeing simultaneously relieving and terrifying.',
      '“Yes,” Iris said. “That’s exactly what it’s like.”',
      '“What is? What is the system to you?”',
      '“Everything.” The word came out like an exhale — not a dramatic revelation but a simple, physical release, the truth emerging the way breath emerges, naturally, because it has to, because the body can only hold it for so long before the holding becomes more painful than the release.',
    ],
    expect: [
      { para: 0, contains: 'Can I ask you something else', speaker: 'Nora' },
      { para: 1, contains: 'You can ask', speaker: 'Iris' },
      { para: 2, contains: 'The system — the one that runs things', speaker: 'Nora' },
      { para: 4, contains: 'Yes', speaker: 'Iris' },
      { para: 4, contains: 'That’s exactly what it’s like', speaker: 'Iris', hard: true },
      { para: 5, contains: 'What is? What is the system to you', speaker: 'Nora', hard: true },
      { para: 6, contains: 'Everything', speaker: 'Iris' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CASE 25: Ch13 — transit bay breakdown + Iris sensitivity reveal (10 paras)
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'Ch13 Consequences — transit bay + sensitivity disclosure',
    source: 'Ch13 — high density, bare alternation + vocative edge case',
    knownNames: ['Iris', 'Nora'],
    paragraphs: [
      '“Are you all right?” Nora asked.',
      '“I’m fine.” The words were delivered with the appropriate emphasis and the appropriate casual tone and were not, even slightly, convincing.',
      '“You’re not fine.”',
      '“I am fine. The bay had a—” She paused. Her jaw tightened. Nora watched the muscles in Iris’s jaw move beneath the skin and felt, with a certainty that was not logical but that was absolute, that whatever was happening to Iris was connected to whatever had happened to the transit bay.',
      '“Iris.”',
      '“It’s fine. These things happen. Within tolerance.” She pushed herself off the wall — a visible effort, the body straightening through what looked like determination rather than ease.',
      'The silence that followed was not the comfortable silence of their usual conversations. It was the silence of a person who has been seen in a way they did not expect and who is now deciding, in the space of seconds, whether to deny the seeing or to accept it.',
      '“I’m sensitive,” she said. “To the planet’s infrastructure. More sensitive than most people. When something goes wrong, I — feel it. The way you might feel a change in air pressure or a shift in the floor’s vibration. It’s physical. It’s not pleasant.” She met Nora’s eyes. “It’s also not something I explain to people.”',
      '“You’re explaining it to me.”',
      '“I’m explaining part of it. The part that doesn’t require you to understand things I can’t explain yet.”',
    ],
    expect: [
      { para: 0, contains: 'Are you all right', speaker: 'Nora' },
      { para: 1, contains: 'I’m fine', speaker: 'Iris' },
      { para: 2, contains: 'You’re not fine', speaker: 'Nora' },
      { para: 3, contains: 'I am fine. The bay had a', speaker: 'Iris' },
      { para: 4, contains: 'Iris', speaker: 'Nora', hard: true },
      { para: 5, contains: 'It’s fine. These things happen', speaker: 'Iris' },
      { para: 7, contains: 'I’m sensitive', speaker: 'Iris' },
      { para: 7, contains: 'It’s also not something I explain', speaker: 'Iris', hard: true },
      { para: 8, contains: 'You’re explaining it to me', speaker: 'Nora' },
      { para: 9, contains: 'I’m explaining part of it', speaker: 'Iris' },
    ],
  },

  // ── Regression: step 2.3 must not carry stale cross-paragraph narrative subject ──
  {
    name: 'Ch22 Transit — stale subject carry: Kael narrative, Nora speaks',
    source: 'Ch22 — step 2.3 must not carry cross-paragraph narrative subject into dialogue',
    knownNames: ['Nora', 'Iris', 'Kael'],
    paragraphs: [
      'Kael was aboard. The quiet figure whose observation Nora had noticed on Ananke was here performing the same function: watching, assessing, cataloging. He stood at corridor junctions the way a person stands who has been trained to occupy intersection points — positions that maximize visual coverage of the spaces that meet at the junction, the body’s placement communicating not threat but vigilance, the specific posture of a person whose professional mandate was the safety of the people around him and whose expression of that mandate was not active protection but passive awareness, the readiness to respond inscribed in the alignment of his shoulders and the placement of his weight on the balls of his feet.',
      'The Meridian liaison — a man in his thirties named Dorin, whose charm was professional-grade and whose smile had the practised warmth of a person who had learned that warmth was an asset — circulated through the common areas with the social energy of a pollinating insect, touching every conversation briefly, depositing a phrase or a question or a laugh that left the conversation slightly different than he had found it. Nora watched him work and recognized the technique — the same technique Orin Kael had used at the campus engagement event, the charm that was real because the person wielding it genuinely enjoyed people, even as the enjoyment served a purpose that extended beyond the enjoyment itself.',
      'The days passed. Nora and Iris fell into a pattern that the shared cabin made inevitable and that the transit’s specific temporal quality made deeper than four days would normally allow. Transit had a permission structure — the liminal nature of travel, the between-ness of it, the way being in motion between two places temporarily suspended the social contracts of both places—and this permission structure allowed conversations that the routines of Ananke had not accommodated.',
      'They talked at night, lying in their bunks with the cabin lights dimmed to the ship’s approximation of twilight — a deep blue-grey that softened the edges of the room and turned the space between the bunks into a corridor of shadow that voices could cross more easily than looks. Nora talked about Kairon. She talked about growing up in a mid-ring district where the buildings were old enough to lean and the market noise started before dawn and her mother, who managed a community resource exchange, had taught her by example that the most political act a person could perform was the daily act of showing up to help. She talked about her father, who had left when she was eleven — not dramatically, not badly, but with the quiet departure of a person who had loved his family but had loved the idea of elsewhere slightly more, and whose absence had shaped Nora’s understanding of commitment as something that required not just feeling but the willingness to stay when staying was difficult.',
      '“I watched people after that,” she said, lying on her back and speaking to the ceiling that was also the bottom of Iris’s bunk. “Not to judge them. To understand the gap between what they said and what they did. My mother would say one thing and mean another, and I learned to read the gap. Everyone has a gap. The gap is where the truth lives.”',
    ],
    expect: [
      { para: 4, contains: 'I watched people after that', speaker: 'Nora', hard: true },
    ],
  },

  // ── The Last Wanderer Ch4 — Spire of Echoes exposition exchange ───────
  {
    name: 'Last Wanderer Ch4 — Spire of Echoes exposition: Marcus/Kael',
    source: 'Ch4 — genderMap possession fix: "her theory", "his chest" must classify Kael=F, Marcus=M',
    knownNames: ['Marcus', 'Kael'],
    paragraphs: [
      '“The forgetting isn’t natural,” she began, spreading a hand-drawn map across the reading table. The map showed the continent, but it was covered in concentric circles radiating from a point far to the north. “It started from a single source. Here — the Spire of Echoes.”',
      'Marcus leaned forward. “I’ve heard of it. An ancient structure, pre-dating even the oldest cities. Nobody knew who built it or what it was for.”',
      '“Nobody remembered,” Kael corrected. “But I found records. Before the forgetting, there were scholars who studied the Spire. They believed it was a kind of... resonance device. It amplified and transmitted something across vast distances.”',
      '“Transmitted what?”',
      'Kael tapped the vial at her hip. “Memory itself. The theory is that the Spire was built to preserve collective memory — the shared knowledge of civilization. It was supposed to be a safeguard, a backup for humanity’s wisdom. But something went wrong.”',
      '“It reversed,” Marcus said, understanding dawning.',
      '“Exactly. Instead of preserving memory, it began consuming it. Drawing it out of people’s minds and... storing it? Destroying it? We don’t know. But the effect spread outward from the Spire like ripples in a pond.”',
      'Marcus stood and began pacing. His mind, so long occupied with simple survival, was racing now. “That explains the pattern. The northern territories forgot first. Then the central cities. The southern coast was last.”',
      'Kael nodded. “And there are still people in the far south who remember fragments. Bits and pieces, like leaves caught in an eddy before being swept away.”',
      '“But why do we still remember? Why are we immune?”',
      'Kael reached for the vial again, holding it up so the light passed through. The liquid inside shifted, casting strange patterns on the wall. “I don’t think we are immune. I think we’re resistant. And I think this is why.”',
      'She uncorked the vial, and immediately Marcus felt something — a warmth in his chest, a sharpening of his senses. The light seemed brighter, the dust motes in the air more defined, and for a brief, dizzying moment, he could have sworn he heard the distant echo of voices.',
      '“What is that?” he breathed.',
      '“I found it in a sealed chamber beneath the ruins of Thessaly. There were dozens of these vials, stored in a case with inscriptions I couldn’t fully translate. But the gist was clear: this substance was created alongside the Spire. It’s a counteragent. A way to resist the forgetting.”',
      '“And you think if we reach the Spire...”',
      '“I think if we can introduce this substance into the Spire’s mechanism, we might be able to reverse the process. Restore what was taken.”',
      'Marcus stared at her. Three years of solitude, of walking through empty streets and sleeping in abandoned houses, of carrying the crushing weight of being possibly the last person who remembered the world as it was.',
      'And now this stranger with her glass vial and her hand-drawn map was offering something he’d given up on long ago.',
      'Hope.',
      '“When do we leave?” he asked.',
      'Kael smiled — a real smile this time, bright and fierce. “Tomorrow. At dawn.”',
    ],
    expect: [
      { para: 0, contains: 'The forgetting isn’t natural', speaker: 'Kael', hard: true },
      { para: 0, contains: 'It started from a single source', speaker: 'Kael', hard: true },
      { para: 1, contains: 'I’ve heard of it', speaker: 'Marcus' },
      { para: 2, contains: 'Nobody remembered', speaker: 'Kael' },
      { para: 2, contains: 'But I found records', speaker: 'Kael', hard: true },
      { para: 3, contains: 'Transmitted what', speaker: 'Marcus', hard: true },
      { para: 4, contains: 'Memory itself', speaker: 'Kael' },
      { para: 5, contains: 'It reversed', speaker: 'Marcus' },
      { para: 6, contains: 'Exactly', speaker: 'Kael', hard: true },
      { para: 7, contains: 'That explains the pattern', speaker: 'Marcus' },
      { para: 8, contains: 'And there are still people', speaker: 'Kael' },
      { para: 9, contains: 'But why do we still remember', speaker: 'Marcus', hard: true },
      { para: 10, contains: 'I don’t think we are immune', speaker: 'Kael' },
      { para: 12, contains: 'What is that', speaker: 'Marcus', hard: true },
      { para: 13, contains: 'I found it in a sealed chamber', speaker: 'Kael', hard: true },
      { para: 14, contains: 'And you think if we reach', speaker: 'Marcus', hard: true },
      { para: 15, contains: 'I think if we can introduce', speaker: 'Kael', hard: true },
      { para: 19, contains: 'When do we leave', speaker: 'Marcus', hard: true },
      { para: 20, contains: 'Tomorrow. At dawn', speaker: 'Kael' },
    ],
  },

  // ── Ch22 — Nora narrative into dialogue (HIGH mode prevChapterContext fix) ────
  {
    name: 'Ch22 — Nora narrative into dialogue: prevChapterContext fix',
    source: 'Ch22 — HIGH mode must prioritize current-paragraph subject over stale cross-chapter context',
    knownNames: ['Iris', 'Nora'],
    paragraphs: [
      'They talked at night, lying in their bunks with the cabin lights dimmed to the ship’s approximation of twilight — a deep blue-grey that softened the edges of the room and turned the space between the bunks into a corridor of shadow that voices could cross more easily than looks. Nora talked about Kairon. She talked about growing up in a mid-ring district where the buildings were old enough to lean and the market noise started before dawn and her mother, who managed a community resource exchange, had taught her by example that the most political act a person could perform was the daily act of showing up to help. She talked about her father, who had left when she was eleven — not dramatically, not badly, but with the quiet departure of a person who had loved his family but had loved the idea of elsewhere slightly more, and whose absence had shaped Nora’s understanding of commitment as something that required not just feeling but the willingness to stay when staying was difficult.',
      '“I watched people after that,” she said, lying on her back and speaking to the ceiling that was also the bottom of Iris’s bunk. “Not to judge them. To understand the gap between what they said and what they did. My mother would say one thing and mean another, and I learned to read the gap. Everyone has a gap. The gap is where the truth lives.”',
    ],
    expect: [
      { para: 1, contains: 'I watched people after that', speaker: 'Nora', hard: true },
      { para: 1, contains: 'Not to judge them', speaker: 'Nora' },
      { para: 1, contains: 'Everyone has a gap', speaker: 'Nora', hard: true },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // STRESS TEST: Context window sizes per mode
  // These cases specifically test extCtxDepth (low=1, default=3, high=6)
  // and maxRecentSpeakers (low=3, default=7, high=10) boundaries.
  // ═══════════════════════════════════════════════════════════════════════

  // ── STRESS 1: Exactly 1 narrative para gap (low boundary) ──
  {
    name: 'Stress: 1-para gap — low context boundary',
    source: 'Stress test — extCtxDepth=1 should just reach attribution in prior para',
    knownNames: ['Iris', 'Nora'],
    paragraphs: [
      '“The readings are anomalous,” Iris said.',
      'The room was quiet.',
      '“Define anomalous.”',
    ],
    expect: [
      { para: 0, contains: 'The readings are anomalous', speaker: 'Iris' },
      { para: 2, contains: 'Define anomalous', speaker: 'Nora' },
    ],
  },

  // ── STRESS 2: 2-para narrative gap (low fails, default/high pass) ──
  {
    name: 'Stress: 2-para gap — low misses, default resolves',
    source: 'Stress test — extCtxDepth=1 cannot reach 2 paras back',
    knownNames: ['Iris', 'Nora'],
    paragraphs: [
      '“The system is recalibrating,” Iris said.',
      'The light shifted. Nora set down her cup.',
      'The terminal hummed softly in the corner.',
      '“How long will it take?”',
    ],
    expect: [
      { para: 0, contains: 'The system is recalibrating', speaker: 'Iris' },
      { para: 3, contains: 'How long will it take', speaker: 'Nora', hard: true },
    ],
  },

  // ── STRESS 3: 5-para narrative gap (only high=6 passes) ──
  {
    name: 'Stress: 5-para gap — only high resolves',
    source: 'Stress test — extCtxDepth=6 needed to reach speaker 5 paras back',
    knownNames: ['Iris', 'Nora'],
    paragraphs: [
      '“The lattice needs attention,” Iris said.',
      'The evening deepened.',
      'Nora moved through the apartment.',
      'The sounds of the district filtered through the window.',
      'The terminal blinked with unread notifications.',
      'Iris was still at her desk, fingers hovering over the keys.',
      '“What kind of attention?”',
    ],
    expect: [
      { para: 0, contains: 'The lattice needs attention', speaker: 'Iris' },
      { para: 6, contains: 'What kind of attention', speaker: 'Nora', hard: true },
    ],
  },

  // ── STRESS 4: maxRecentSpeakers=3 overflow with 4 speakers ──
  {
    name: 'Stress: 4-speaker rotation — low window overflow',
    source: 'Stress test — maxRecentSpeakers=3 drops earliest speaker',
    knownNames: ['Iris', 'Nora', 'Helia', 'Thayne'],
    paragraphs: [
      '“The proposal is incomplete,” Iris said.',
      '“I disagree,” Nora said.',
      '“The timeline is ambitious,” Helia said.',
      '“Ambition is the point,” Thayne said.',
      '“Then we proceed.”',
    ],
    expect: [
      { para: 0, contains: 'The proposal is incomplete', speaker: 'Iris' },
      { para: 1, contains: 'I disagree', speaker: 'Nora' },
      { para: 2, contains: 'The timeline is ambitious', speaker: 'Helia' },
      { para: 3, contains: 'Ambition is the point', speaker: 'Thayne' },
      { para: 4, contains: 'Then we proceed', speaker: 'Iris', hard: true },
    ],
  },

  // ── STRESS 5: Long monologue with maxRecentSpeakers test ──
  {
    name: 'Stress: 5-para monologue — speaker window retention',
    source: 'Stress test — 5 consecutive same-speaker quotes, then alternation',
    knownNames: ['Iris', 'Nora'],
    paragraphs: [
      '“First,” Nora said.',
      '“Second point,” Iris said.',
      '“Third,” Iris said.',
      '“Fourth,” Iris said.',
      '“Fifth,” Iris said.',
      '“Sixth,” Iris said.',
      '“Is that all?”',
    ],
    expect: [
      { para: 0, contains: 'First', speaker: 'Nora' },
      { para: 1, contains: 'Second point', speaker: 'Iris' },
      { para: 6, contains: 'Is that all', speaker: 'Nora', hard: true },
    ],
  },

  // ── STRESS 6: Real-size paragraph with dense action beats ──
  {
    name: 'Stress: long paragraph with 3 embedded quotes',
    source: 'Stress test — multi-quote paragraph with action beats between',
    knownNames: ['Iris', 'Nora'],
    paragraphs: [
      'Iris crossed the room with the particular deliberateness that Nora had come to recognize as the deliberateness of a person managing the weight of knowledge that the conversation had not yet earned. She sat down across from Nora, placed her hands flat on the table — a gesture that communicated openness through the physical language of someone who had learned to use physical language as a tool — and said: “The system is not what you think it is.” She paused, measuring the effect. “It was never what anyone thought it was.” And then, more quietly: “Including the people who built it.”',
      '“What is it, then?”',
    ],
    expect: [
      { para: 0, contains: 'The system is not what you think', speaker: 'Iris' },
      { para: 0, contains: 'It was never what anyone thought', speaker: 'Iris', hard: true },
      { para: 0, contains: 'Including the people who built it', speaker: 'Iris', hard: true },
      { para: 1, contains: 'What is it, then', speaker: 'Nora' },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CROSS-GENRE CASES — added to prevent overfitting to Hollow Iris corpus
  // ═══════════════════════════════════════════════════════════════════════

  // ── FANTASY: possessive-leading action beat + bare alternation ───────────
  {
    name: 'Fantasy — possessive action beat leads to speech',
    source: 'Cross-genre: fantasy prose, possessive-leading clause + bare alternation',
    knownNames: ['Kira', 'Davan'],
    paragraphs: [
      '“The binding will not hold,” Kira said. She pressed her palm against the glowing sigil. “Not at this resonance. We need to anchor it from the outside.”',
      '“How long do we have?” Davan asked.',
      'Kira’s concentration broke for just a moment — the sigil pulsed, dimmed. “Less time than I thought. Minutes, not hours.”',
      '“Then I will hold the outer anchor,” Davan said. “Tell me what you need.”',
      '“Silence,” Kira said. “And do not let go no matter what you hear.”',
    ],
    expect: [
      { para: 0, contains: 'The binding will not hold', speaker: 'Kira' },
      { para: 0, contains: 'Not at this resonance', speaker: 'Kira', hard: true },
      { para: 1, contains: 'How long do we have', speaker: 'Davan' },
      { para: 2, contains: 'Less time than I thought', speaker: 'Kira' },
      { para: 3, contains: 'Then I will hold the outer anchor', speaker: 'Davan' },
      { para: 3, contains: 'Tell me what you need', speaker: 'Davan', hard: true },
      { para: 4, contains: 'Silence', speaker: 'Kira' },
      { para: 4, contains: 'do not let go no matter what you hear', speaker: 'Kira', hard: true },
    ],
  },

  // ── CRIME/THRILLER: detective exchange, pronoun + direct attribution ──────
  {
    name: 'Crime thriller — detective exchange with embedded narrative',
    source: 'Cross-genre: crime fiction, pronoun carry + action beats',
    knownNames: ['Chen', 'Priya'],
    paragraphs: [
      'Detective Chen set the photograph on the table between them. “When did you last see him?” he asked.',
      'Priya looked at the photograph for a long moment before answering. “Three weeks ago,” she said. “At the warehouse on Meridian Street. He was with two other men I did not recognize.”',
      '“Did he speak to you?”',
      '“He told me to forget I had seen him. He said it like — like he was afraid. Not of me. Of whoever was watching.”',
      '“And you are only telling us this now,” Chen said. It was not a question.',
      '“I needed to know my daughter was safe first,” Priya said.',
    ],
    expect: [
      { para: 0, contains: 'When did you last see him', speaker: 'Chen' },
      { para: 1, contains: 'Three weeks ago', speaker: 'Priya' },
      { para: 1, contains: 'He was with two other men', speaker: 'Priya', hard: true },
      { para: 2, contains: 'Did he speak to you', speaker: 'Chen' },
      { para: 3, contains: 'He told me to forget', speaker: 'Priya' },
      { para: 3, contains: 'Not of me', speaker: 'Priya', hard: true },
      { para: 4, contains: 'you are only telling us this now', speaker: 'Chen' },
      { para: 5, contains: 'I needed to know my daughter', speaker: 'Priya' },
    ],
  },

  // ── ROMANCE/CONTEMPORARY: emotional exchange with vocative + beats ────────
  {
    name: 'Contemporary romance — emotional exchange with pauses',
    source: 'Cross-genre: contemporary romance, vocative + body language beats',
    knownNames: ['Theo', 'Mara'],
    paragraphs: [
      'Mara set her phone face-down on the table. “You have been avoiding me,” she said.',
      'Theo set down his cup. He did not deny it. “I needed time to think,” he said.',
      'She looked at him. “About what?” she asked.',
      'Theo looked at the table before answering. “About whether any of this is fair to you.” He met her eyes, and the meeting was the hardest part. “You deserve more than what I can offer right now.”',
      'Mara said his name softly. “Theo.”',
      '”What you are asking,” Mara said, “is whether I get to choose. And my answer has always been yes.”',
    ],
    expect: [
      { para: 0, contains: 'You have been avoiding me', speaker: 'Mara' },
      { para: 1, contains: 'I needed time to think', speaker: 'Theo' },
      { para: 2, contains: 'About what', speaker: 'Mara' },
      { para: 3, contains: 'About whether any of this is fair', speaker: 'Theo' },
      { para: 3, contains: 'You deserve more than what I can offer', speaker: 'Theo', hard: true },
      { para: 4, contains: 'Theo', speaker: 'Mara', hard: true },
      { para: 5, contains: 'is whether I get to choose', speaker: 'Mara' },
    ],
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────

const modes: IntelligenceLevel[] = ['low', 'default', 'high'];
const modeTargets: Record<IntelligenceLevel, { min: number; max: number }> = {
  low:     { min: 60, max: 78 },
  default: { min: 75, max: 92 },
  high:    { min: 90, max: 100 },
};

console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║  Speech Detection Accuracy Suite (glass-editor)           ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

const summaries: Record<IntelligenceLevel, { passed: number; total: number }> = {
  low: { passed: 0, total: 0 },
  default: { passed: 0, total: 0 },
  high: { passed: 0, total: 0 },
};

for (const tc of tests) {
  console.log(`\n── ${tc.name} ──`);
  console.log(`   Source: ${tc.source}`);

  for (const mode of modes) {
    const result = runTestForMode(tc, mode);
    summaries[mode].passed += result.passed;
    summaries[mode].total += result.total;

    const pct = result.total > 0 ? Math.round((result.passed / result.total) * 100) : 0;
    const tag = result.failed === 0 ? '✓' : '✗';
    console.log(`  [${mode.toUpperCase().padEnd(7)}] ${tag} ${result.passed}/${result.total} (${pct}%)`);

    for (const d of result.details) {
      if (d.includes('✗')) console.log(d);
    }
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log('ACCURACY SUMMARY\n');

let allPass = true;
for (const mode of modes) {
  const { passed, total } = summaries[mode];
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
  const target = modeTargets[mode];
  const inRange = pct >= target.min && pct <= target.max;
  const status = inRange ? '✓ IN RANGE' : pct > target.max ? '★ ABOVE TARGET' : '✗ BELOW TARGET';
  if (pct < target.min) allPass = false;
  console.log(`  ${mode.toUpperCase().padEnd(7)}  ${passed}/${total}  ${pct}%  (target: ${target.min}–${target.max}%)  ${status}`);
}

console.log('\n' + '═'.repeat(60));
if (allPass) {
  console.log('All modes meet accuracy targets.\n');
} else {
  console.log('Some modes are below target. Review failing cases above.\n');
  process.exit(1);
}
