/**
 * scan-accuracy-suite.ts
 *
 * TDD accuracy suite for the /scan local heuristic engine (runLocalReview).
 * Tests precision (no false positives) and recall (true positives caught)
 * for each of the 8 prose-quality pattern detectors.
 *
 * Run:  npx tsx scripts/scan-accuracy-suite.ts
 *
 * Accuracy targets per pattern:
 *   recall    — ≥ 70% of true-positive cases are flagged
 *   precision — ≥ 80% of flagged cases are genuine (i.e., ≤ 20% false-positive rate)
 *
 * Test cases intentionally span 4 genres to prevent overfitting:
 *   Literary fiction · Fantasy/LN · Thriller/crime · Romance/contemporary
 */

import { runLocalReview } from '../src/lib/local-review';

// ─── Test framework ────────────────────────────────────────────────────────

interface Expectation {
  /** Which detector pattern */
  type: string;
  /** Substring that must appear in the flagged quote for a TP match */
  containsPhrase: string;
  /** true = expect this sentence to be flagged; false = expect it NOT to be flagged */
  shouldFlag: boolean;
  hard?: boolean;
}

interface ScanCase {
  name: string;
  source: string;
  text: string;
  expect: Expectation[];
}

async function runCase(tc: ScanCase): Promise<{ passed: number; failed: number; total: number; details: string[] }> {
  const result = await runLocalReview('test', tc.text);
  const details: string[] = [];
  let passed = 0, failed = 0;

  for (const exp of tc.expect) {
    const flags = result.flags.filter(f => f.type === exp.type);
    const matched = flags.find(f => f.quote?.includes(exp.containsPhrase));

    const ok = exp.shouldFlag ? !!matched : !matched;
    if (ok) passed++; else failed++;

    const mark = ok ? '✓' : '✗';
    const verdict = exp.shouldFlag
      ? (matched ? `flagged (conf OK)` : `MISSED — not flagged`)
      : (matched ? `FALSE POSITIVE — should not flag` : `correctly silent`);
    details.push(`  ${mark} [${exp.type}] "${exp.containsPhrase.slice(0, 50)}" → ${verdict}${exp.hard ? ' [HARD]' : ''}`);
  }
  return { passed, failed, total: passed + failed, details };
}

// ─── Test cases ────────────────────────────────────────────────────────────

const tests: ScanCase[] = [

  // ═══════════════════════════════════════════════════════════════════════
  // OVER-EXPLANATION — action/image followed by explicit gloss
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'over-explanation — literary and thriller',
    source: 'Literary + thriller — explicit gloss phrases',
    text: [
      'She set down the cup. That is to say, she had made her decision.',
      'He nodded once across the table. In other words, he agreed to the terms.',
      'The folder was left open on the desk, which explained why she had seen the name.',
      'He turned toward the window, which was why she understood the conversation was over.',
      'She walked out without looking back, as if to say the argument had ended.',
      '',
      'She set down the cup and walked to the window.',
      'He nodded at the arrangement, which looked different in the morning light.',
      'The door was left ajar — a deliberate choice, nothing more.',
    ].join('\n\n'),
    expect: [
      { type: 'over-explanation', containsPhrase: 'That is to say', shouldFlag: true },
      { type: 'over-explanation', containsPhrase: 'In other words', shouldFlag: true },
      { type: 'over-explanation', containsPhrase: 'which explained', shouldFlag: true },
      { type: 'over-explanation', containsPhrase: 'which was why she understood', shouldFlag: true },
      { type: 'over-explanation', containsPhrase: 'as if to say', shouldFlag: true },
      // True negatives
      { type: 'over-explanation', containsPhrase: 'walked to the window', shouldFlag: false },
      { type: 'over-explanation', containsPhrase: 'which looked different', shouldFlag: false },
      { type: 'over-explanation', containsPhrase: 'left ajar', shouldFlag: false },
    ],
  },

  {
    name: 'over-explanation — fantasy and romance',
    source: 'Fantasy + romance — "which meant that she/he" pattern',
    text: [
      'The stone pulsed once and went dark, which meant that she had failed the binding.',
      'He lowered his sword, meaning that the duel was over before it had begun.',
      'She pressed her lips together and said nothing else, which was her way of closing the conversation.',
      '',
      'She pressed her lips together and said nothing else.',
      'The stone pulsed once and went dark — the binding had failed.',
    ].join('\n\n'),
    expect: [
      { type: 'over-explanation', containsPhrase: 'which meant that she had failed', shouldFlag: true },
      { type: 'over-explanation', containsPhrase: 'meaning that the duel', shouldFlag: true },
      // TN: "what she meant" pattern absent; plain narration
      { type: 'over-explanation', containsPhrase: 'said nothing else.', shouldFlag: false },
      { type: 'over-explanation', containsPhrase: 'the binding had failed', shouldFlag: false },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // AI-REGISTER — indirect introspection phrasing
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'ai-register — literary fiction',
    source: 'Literary — AI-typical inner-state phrasing',
    text: [
      "She couldn't help but notice the way the light had changed.",
      'Something she could not quite name had shifted between them.',
      'It made her realize how much time she had been wasting.',
      'She was the kind of person who never asked for directions.',
      'There was something about the way he held the envelope.',
      'For the first time in years, the city felt manageable.',
      'Part of her wanted to refuse the assignment entirely.',
      '',
      'She noticed the light had changed.',
      'He realized the door was unlocked.',
      'The city felt manageable that morning.',
    ].join('\n\n'),
    expect: [
      { type: 'ai-register', containsPhrase: "couldn't help but", shouldFlag: true },
      { type: 'ai-register', containsPhrase: "could not quite name", shouldFlag: true },
      { type: 'ai-register', containsPhrase: 'made her realize', shouldFlag: true },
      { type: 'ai-register', containsPhrase: 'kind of person who', shouldFlag: true },
      { type: 'ai-register', containsPhrase: 'something about the way', shouldFlag: true },
      { type: 'ai-register', containsPhrase: 'first time in years', shouldFlag: true },
      { type: 'ai-register', containsPhrase: 'Part of her wanted', shouldFlag: true },
      // TN: direct observation / simple verb
      { type: 'ai-register', containsPhrase: 'She noticed the light', shouldFlag: false },
      { type: 'ai-register', containsPhrase: 'He realized the door', shouldFlag: false },
      { type: 'ai-register', containsPhrase: 'felt manageable that morning', shouldFlag: false },
    ],
  },

  {
    name: 'ai-register — fantasy and thriller cross-genre',
    source: 'Fantasy + thriller — "filed it under", "wasn\'t sure when"',
    text: [
      'She filed it under things she would deal with later.',
      'He was not sure exactly when the investigation had shifted.',
      'Part of him had always suspected the evidence was staged.',
      'She had always never quite trusted the alliance entirely.',
      '',
      'She categorized the evidence by date and cross-referenced it against the lattice records.',
      'He crossed the courtyard without looking back.',
    ].join('\n\n'),
    expect: [
      { type: 'ai-register', containsPhrase: 'filed it under', shouldFlag: true },
      { type: 'ai-register', containsPhrase: 'sure exactly when', shouldFlag: true, hard: true },
      { type: 'ai-register', containsPhrase: 'Part of him had always', shouldFlag: true },
      // TN: "categorizing the lattice" is explicitly exempt
      { type: 'ai-register', containsPhrase: 'categorized the evidence', shouldFlag: false },
      { type: 'ai-register', containsPhrase: 'crossed the courtyard', shouldFlag: false },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ACQUISITION-BACKSTORY — dense past-perfect dump mid-scene
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'acquisition-backstory — true positive (4+ had-verb + temporal)',
    source: 'Literary — dense past-perfect cluster with backstory anchor',
    text: [
      'She had studied under three masters before she turned twenty. She had traveled the northern provinces long before anyone trusted her name. She had learned silence as a child in a place where it was necessary. She had earned the position herself, growing up without the advantages the others had assumed she carried.',
      '',
      'She set the file down and began to read.',
    ].join('\n\n'),
    expect: [
      { type: 'acquisition-backstory', containsPhrase: 'long before anyone trusted', shouldFlag: true },
      { type: 'acquisition-backstory', containsPhrase: 'set the file down', shouldFlag: false },
    ],
  },

  {
    name: 'acquisition-backstory — true negatives (threshold not met)',
    source: 'Synthetic — 3 had-verbs (below threshold) and temporal without enough had-verbs',
    text: [
      'She had watched the city change over the years. She had noticed each new building. She stood now at the window.',
      '',
      'She had grown up here. She had learned the streets. She had memorized the routes. The city was still hers.',
    ].join('\n\n'),
    expect: [
      // para 1: 2 had-verbs + temporal "years" → below threshold of 4 had-verbs → no flag
      { type: 'acquisition-backstory', containsPhrase: 'watched the city change', shouldFlag: false },
      // para 2: 3 had-verbs + temporal "grown up" — still below 4 → no flag
      { type: 'acquisition-backstory', containsPhrase: 'had learned the streets', shouldFlag: false, hard: true },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // BELIEF-ELABORATION — states belief then justifies it
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'belief-elaboration — literary and thriller',
    source: 'Literary + thriller — belief + justification',
    text: [
      'She believed that the committee was wrong, because they had never faced real consequences for their decisions.',
      'He thought that honesty was the only viable path, since deception only extended the problem.',
      'She had always known that power corrupted institutions over time, since she had witnessed it directly.',
      '',
      'She believed in the mission and committed herself to it.',
      'He thought carefully before answering the inspector.',
      'She had always known the shortcut through the quarter.',
    ].join('\n\n'),
    expect: [
      { type: 'belief-elaboration', containsPhrase: 'believed that the committee', shouldFlag: true },
      { type: 'belief-elaboration', containsPhrase: 'thought that honesty', shouldFlag: true },
      { type: 'belief-elaboration', containsPhrase: 'always known that power corrupted', shouldFlag: true },
      // TN: "believed in" / "thought" without "that" / "known" without "that"
      { type: 'belief-elaboration', containsPhrase: 'believed in the mission', shouldFlag: false },
      { type: 'belief-elaboration', containsPhrase: 'thought carefully', shouldFlag: false },
      { type: 'belief-elaboration', containsPhrase: 'always known the shortcut', shouldFlag: false },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CROWD-QUANTIFICATION — specific numbers on undramatic groups
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'crowd-quantification — undramatic vs dramatic contexts',
    source: 'Literary + fantasy — number + crowd noun, dramatic exempt',
    text: [
      'Hundreds of people filled the plaza that evening, waiting for news.',
      'Several students remained in the corridor, talking in low voices.',
      'Dozens of figures lined the battlements, watching the horizon for movement.',
      'A number of citizens stood in the square as the announcement finished.',
      '',
      'Hundreds of soldiers were killed in the ambush before dawn.',
      'She looked out at the empty courtyard.',
      'A few words were enough to settle the matter.',
    ].join('\n\n'),
    expect: [
      { type: 'crowd-quantification', containsPhrase: 'Hundreds of people', shouldFlag: true },
      { type: 'crowd-quantification', containsPhrase: 'Several students', shouldFlag: true },
      { type: 'crowd-quantification', containsPhrase: 'Dozens of figures', shouldFlag: true },
      { type: 'crowd-quantification', containsPhrase: 'number of citizens', shouldFlag: true },
      // TN: "killed" is dramatic exempt
      { type: 'crowd-quantification', containsPhrase: 'were killed in the ambush', shouldFlag: false },
      // TN: no crowd noun
      { type: 'crowd-quantification', containsPhrase: 'empty courtyard', shouldFlag: false },
      { type: 'crowd-quantification', containsPhrase: 'few words were enough', shouldFlag: false },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // EMOTION-LABEL — abstract emotion word without physical grounding
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'emotion-label — no physical grounding in paragraph',
    source: 'Literary + romance — emotion-label without anchor',
    text: [
      'She felt sadness when the letter arrived. The news was difficult to process. Several days passed without resolution.',
      '',
      'Mara experienced loneliness that first winter in the city. The apartment was empty. The silence was total.',
      '',
      'He was angry when the verdict was announced. The decision had been unjust. He left the room immediately.',
    ].join('\n\n'),
    expect: [
      { type: 'emotion-label', containsPhrase: 'felt sadness', shouldFlag: true },
      { type: 'emotion-label', containsPhrase: 'experienced loneliness', shouldFlag: true },
      { type: 'emotion-label', containsPhrase: 'was angry when', shouldFlag: true },
    ],
  },

  {
    name: 'emotion-label — physical grounding exempts the paragraph',
    source: 'Literary — physical anchor in same paragraph suppresses flag',
    text: [
      'She felt grief when she read the name. Her chest tightened. She set the paper down and did not pick it up again.',
      '',
      'He was devastated by the news. His hands did not stop shaking for an hour. He stood at the window without moving.',
      '',
      'The sorrow sat in her like a weight. She pressed both palms flat on the table until the feeling passed.',
    ].join('\n\n'),
    expect: [
      // TN: "chest" is physical ground → suppresses emotion-label
      { type: 'emotion-label', containsPhrase: 'felt grief', shouldFlag: false },
      // TN: "hands" → physical ground
      { type: 'emotion-label', containsPhrase: 'was devastated', shouldFlag: false },
      // TN: "palms" → physical ground
      { type: 'emotion-label', containsPhrase: 'sorrow sat', shouldFlag: false },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ANNOTATION — image shown then explained with "the way you" / "which meant"
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'annotation — reader-addressed simile and gloss verbs',
    source: 'Literary + fantasy — comma + "the way you" / "which meant"',
    text: [
      'She pressed her palm against the glass, the way you press against something you cannot change.',
      'The letter sat on the desk for three days, the way you keep something you cannot yet throw away.',
      'The room fell silent after the announcement, which meant the vote had already been decided.',
      'She lowered her staff toward the ground, as if to acknowledge the authority standing before her.',
      '',
      'She moved the way she always did, efficiently and without looking back.',
      'He walked the way he had been taught, heel to toe along the edge.',
      'The silence grew, which was different from the quiet that usually settled here.',
    ].join('\n\n'),
    expect: [
      { type: 'annotation', containsPhrase: 'the way you press', shouldFlag: true },
      { type: 'annotation', containsPhrase: 'the way you keep', shouldFlag: true },
      { type: 'annotation', containsPhrase: 'which meant the vote', shouldFlag: true },
      { type: 'annotation', containsPhrase: 'as if to acknowledge', shouldFlag: true },
      // TN: "the way she" is exempt (third-person anchor, not gloss)
      { type: 'annotation', containsPhrase: 'the way she always did', shouldFlag: false },
      { type: 'annotation', containsPhrase: 'the way he had been taught', shouldFlag: false },
      // TN: "which was different" — not a gloss verb (not "meant/signified/proved")
      { type: 'annotation', containsPhrase: 'which was different', shouldFlag: false },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // NIA — Named Intermediate Abstraction: vague quality-naming
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'nia — core NIA patterns across genres',
    source: 'Literary + fantasy + thriller — "something about", "a certain", "slightly off"',
    text: [
      'Something about the way she spoke made him pause mid-sentence.',
      'There was a certain weight in the room that had not been there before.',
      'The quality of silence in the apartment was different from the silence outside.',
      'The table was slightly off, as though someone had moved it an inch and forgotten.',
      'Something in the silence told her the calculation had already been made.',
      'There was a sense of wrongness she could not place or name.',
      '',
      'She opened the door and stepped inside without hesitating.',
      'He crossed the room to the window and looked down at the street.',
    ].join('\n\n'),
    expect: [
      { type: 'nia', containsPhrase: 'Something about the way', shouldFlag: true },
      { type: 'nia', containsPhrase: 'a certain weight', shouldFlag: true },
      { type: 'nia', containsPhrase: 'quality of silence', shouldFlag: true },
      { type: 'nia', containsPhrase: 'slightly off', shouldFlag: true },
      { type: 'nia', containsPhrase: 'Something in the silence', shouldFlag: true },
      { type: 'nia', containsPhrase: 'sense of wrongness', shouldFlag: true },
      // TN: no NIA pattern
      { type: 'nia', containsPhrase: 'opened the door', shouldFlag: false },
      { type: 'nia', containsPhrase: 'crossed the room', shouldFlag: false },
    ],
  },

  {
    name: 'nia — exempt cases (material kind-of, concrete slightly-different)',
    source: 'Synthetic — NIA_EXEMPT and NIA_SOFTENER_EXEMPT should suppress flags',
    text: [
      'She fitted the frame with a kind of wood that resisted moisture.',
      'She used a kind of metal alloy for the housing.',
      '',
      'The ambient temperature was slightly different from the previous reading.',
      'The pace was slightly different from the prescribed register.',
    ].join('\n\n'),
    expect: [
      // TN: "a kind of wood" is in NIA_EXEMPT
      { type: 'nia', containsPhrase: 'a kind of wood', shouldFlag: false },
      { type: 'nia', containsPhrase: 'a kind of metal', shouldFlag: false, hard: true },
      // TN: "slightly different temperature" is in NIA_SOFTENER_EXEMPT
      { type: 'nia', containsPhrase: 'slightly different from the previous', shouldFlag: false, hard: true },
      { type: 'nia', containsPhrase: 'slightly different from the prescribed', shouldFlag: false, hard: true },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // CROSS-GENRE — romance, LN/isekai, crime to prevent overfitting
  // ═══════════════════════════════════════════════════════════════════════
  {
    name: 'cross-genre romance — AI register and over-explanation',
    source: 'Romance — typical AI-patterned prose in contemporary fiction',
    text: [
      "She couldn't help but feel that this was different from everything before.",
      'There was something about the way he looked at her that she could not quite name.',
      'He turned away from the window, which was how she knew the decision had been made.',
      '',
      'She turned to face him across the kitchen.',
      'He walked to the door and stopped.',
    ].join('\n\n'),
    expect: [
      { type: 'ai-register', containsPhrase: "couldn't help but feel", shouldFlag: true },
      { type: 'ai-register', containsPhrase: 'something about the way he looked', shouldFlag: true },
      { type: 'over-explanation', containsPhrase: 'which was how she knew', shouldFlag: false, hard: true },
      // "which was how" — not in OVER_EXPLAIN_PHRASES list → should NOT flag
      { type: 'ai-register', containsPhrase: 'turned to face him', shouldFlag: false },
    ],
  },

  {
    name: 'cross-genre fantasy/LN — crowd-quantification and nia',
    source: 'Fantasy/LN — guild hall, crowd, vague quality naming',
    text: [
      'Hundreds of adventurers gathered at the guild board that morning.',
      'There were dozens of voices calling out requests at once.',
      'Something in the aura of the room felt wrong, a kind of pressure she had not felt before.',
      '',
      'Three hundred soldiers were executed after the siege ended.',
      'The guild hall was loud.',
    ].join('\n\n'),
    expect: [
      { type: 'crowd-quantification', containsPhrase: 'Hundreds of adventurers', shouldFlag: true },
      { type: 'crowd-quantification', containsPhrase: 'dozens of voices', shouldFlag: true },
      { type: 'nia', containsPhrase: 'Something in the aura', shouldFlag: true },
      // TN: "executed" is DRAMATIC_EXEMPT
      { type: 'crowd-quantification', containsPhrase: 'were executed after', shouldFlag: false },
    ],
  },

  {
    name: 'cross-genre thriller — belief-elaboration and emotion-label',
    source: 'Thriller — detective reasoning, emotion without physical anchor',
    text: [
      'He had always understood that the evidence was fabricated, since no legitimate chain of custody existed.',
      'She felt fear when she reviewed the final entry. The file closed. The case number changed.',
      '',
      'He had always understood the procedure and followed it without question.',
      'She felt her pulse settle as the pattern became clear. Her hands steadied.',
    ].join('\n\n'),
    expect: [
      { type: 'belief-elaboration', containsPhrase: 'understood that the evidence was fabricated', shouldFlag: true },
      { type: 'emotion-label', containsPhrase: 'felt fear when', shouldFlag: true },
      // TN: "understood" without "that" + justification
      { type: 'belief-elaboration', containsPhrase: 'understood the procedure', shouldFlag: false },
      // TN: "pulse" and "hands" are physical ground
      { type: 'emotion-label', containsPhrase: 'pulse settle', shouldFlag: false },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ADDITIONAL TESTS (+50%) — edge cases, more genres, boundary conditions
  // ═══════════════════════════════════════════════════════════════════════

  // ── over-explanation: "meaning that", "what he meant", sentence-length edge ──
  {
    name: 'over-explanation — additional phrases + short-sentence filter',
    source: 'Edge cases: "meaning that", "what she meant", + sentence < 15 chars ignored',
    text: [
      'He turned the device off, meaning that he was done with the problem.',
      'She kept her expression flat — what she meant was that the answer had already been given.',
      'The report disappeared from the terminal, which was why they had moved on to the next item.',
      '',
      'No.', // too short (< 15 chars) — should NOT trigger any pattern
      'She walked out.',  // clean, short but above threshold
    ].join('\n\n'),
    expect: [
      { type: 'over-explanation', containsPhrase: 'meaning that he was done', shouldFlag: true },
      { type: 'over-explanation', containsPhrase: 'what she meant was that', shouldFlag: true },
      { type: 'over-explanation', containsPhrase: 'which was why they had moved', shouldFlag: true },
      { type: 'over-explanation', containsPhrase: 'She walked out', shouldFlag: false },
    ],
  },

  // ── ai-register: "she had never quite" and "they were not sure" ──
  {
    name: 'ai-register — had-never-quite and were-not-sure variants',
    source: 'Edge cases: additional ai-register constructions',
    text: [
      'She had never quite managed to name what it was she feared.',
      'They were not sure exactly when the arrangement had shifted.',
      'Part of them had always feared the outcome, even before it arrived.',
      '',
      'She crossed the room and took her seat at the table.',
      'The data confirmed what the committee had submitted.',
    ].join('\n\n'),
    expect: [
      { type: 'ai-register', containsPhrase: 'had never quite managed', shouldFlag: true },
      { type: 'ai-register', containsPhrase: 'not sure exactly when', shouldFlag: true },
      { type: 'ai-register', containsPhrase: 'Part of them had always feared', shouldFlag: true },
      { type: 'ai-register', containsPhrase: 'took her seat', shouldFlag: false },
      { type: 'ai-register', containsPhrase: 'committee had submitted', shouldFlag: false },
    ],
  },

  // ── acquisition-backstory: exactly 4 matching had-verbs + "back then" ──
  // Note: HAD_VERB_RE matches [a-z]+(?:ed|en|t) — "known" ends in "n" → no match;
  // use only verbs ending in -ed, -en, or -t (walked, carried, learned, studied, felt, kept)
  {
    name: 'acquisition-backstory — threshold boundary: exactly 4 regex-matching had-verbs',
    source: 'Boundary: 4 had+[past participle ending in -ed/-en/-t] + "back then" temporal',
    text: [
      'She had walked this road every morning back then, before the city changed. She had learned the schedule by heart. She had earned her position slowly. She had carried it forward ever since.',
      '',
      'She had walked the corridor. She had learned the route. She had studied the map.',
    ].join('\n\n'),
    expect: [
      { type: 'acquisition-backstory', containsPhrase: 'back then', shouldFlag: true },
      // Para 2: only 3 matching had-verbs → below threshold → no flag
      { type: 'acquisition-backstory', containsPhrase: 'studied the map', shouldFlag: false, hard: true },
    ],
  },

  // ── crowd-quantification: "a number of" and dramatic "dead" exempt ──
  {
    name: 'crowd-quantification — "a number of" + dead/wounded drama exemption',
    source: 'Edge cases: "a number of individuals", "dozens dead" exempted',
    text: [
      'A number of individuals had gathered in the lobby that afternoon.',
      'Scores of citizens waited outside the administrative building.',
      '',
      'Dozens were found dead in the lower district.',
      'Hundreds of civilians were wounded in the aftermath.',
    ].join('\n\n'),
    expect: [
      { type: 'crowd-quantification', containsPhrase: 'number of individuals', shouldFlag: true },
      { type: 'crowd-quantification', containsPhrase: 'Scores of citizens', shouldFlag: true },
      // "dead" and "wounded" are dramatic exempt
      { type: 'crowd-quantification', containsPhrase: 'Dozens were found dead', shouldFlag: false },
      { type: 'crowd-quantification', containsPhrase: 'were wounded', shouldFlag: false },
    ],
  },

  // ── emotion-label: "was filled with" pattern + "happiness" noun form ──
  {
    name: 'emotion-label — was-filled-with and happiness noun',
    source: 'Edge cases: "was filled with" verb form, "happiness" and "sadness" noun forms',
    text: [
      'He was filled with regret when the decision was announced. The corridor was empty. No one spoke.',
      '',
      'Mara experienced happiness when she heard the result. The room was still. The time had passed.',
      '',
      'She felt the grief in her chest when the letter arrived. Her throat closed.',
    ].join('\n\n'),
    expect: [
      { type: 'emotion-label', containsPhrase: 'filled with regret', shouldFlag: true },
      { type: 'emotion-label', containsPhrase: 'experienced happiness', shouldFlag: true },
      // TN: "chest" is physical ground → suppresses
      { type: 'emotion-label', containsPhrase: 'grief in her chest', shouldFlag: false },
    ],
  },

  // ── annotation: "which proved" and "this was the reason" gloss verbs ──
  {
    name: 'annotation — "which proved" and "this was the reason" gloss patterns',
    source: 'Edge cases: less common gloss verbs in annotation pattern',
    text: [
      'She set down the report without marking it, which proved she had already decided.',
      'He did not look at her when she entered the room, the way you avoid someone who already knows.',
      '',
      'She set the document aside. The decision had been made.',
      'He avoided her gaze. The conversation was over.',
    ].join('\n\n'),
    expect: [
      { type: 'annotation', containsPhrase: 'which proved she had already', shouldFlag: true },
      { type: 'annotation', containsPhrase: 'the way you avoid someone', shouldFlag: true },
      { type: 'annotation', containsPhrase: 'decision had been made', shouldFlag: false },
      { type: 'annotation', containsPhrase: 'conversation was over', shouldFlag: false },
    ],
  },

  // ── NIA: "in a way he" and quality-of-connection patterns ──
  // containsPhrase must match the QUOTE field which uses the original casing — use mid-sentence fragments
  {
    name: 'NIA — "in a way he" and quality-of-connection patterns',
    source: 'Additional NIA constructions: spatial/relational quality naming',
    text: [
      'He arrived in a way he had not predicted, and the silence seemed to settle around it.',
      'There was a quality of connection between them that neither could account for.',
      'Something in the air told her that the arrangement had already been settled.',
      '',
      'He crossed the room and stood at the window.',
      'The report sat on the desk beside the terminal.',
    ].join('\n\n'),
    expect: [
      { type: 'nia', containsPhrase: 'way he had not predicted', shouldFlag: true },
      { type: 'nia', containsPhrase: 'quality of connection', shouldFlag: true },
      { type: 'nia', containsPhrase: 'Something in the air', shouldFlag: true },
      { type: 'nia', containsPhrase: 'crossed the room', shouldFlag: false },
      { type: 'nia', containsPhrase: 'desk beside the terminal', shouldFlag: false },
    ],
  },

  // ── sci-fi cross-genre: all patterns tested in a tech/space register ──
  // Pattern notes: ai-register needs pronoun+verb; belief-elaboration needs she/he/they;
  // crowd-quantification needs noun immediately after number+of; annotation needs comma+'as if to'
  {
    name: 'Cross-genre sci-fi — all pattern types in space/tech register',
    source: 'Cross-genre: science fiction — tests 6 patterns in unfamiliar register',
    text: [
      'She could not help but notice the way the navigation array had shifted its baseline.',
      'She thought that the jump coordinates were locked, since the telemetry confirmed it twice.',
      'Several hundred members of the crew stood at attention in the launch bay.',
      'She pressed her palm to the cold console, the way you brace before impact.',
      'Something about the way the AI paused before responding told her what she needed to know.',
      'She felt fear when the proximity sensor activated. The corridor was silent. The hatch sealed.',
      '',
      'The ship held its orbit. The stars were fixed.',
      'She confirmed the coordinate lock and waited.',
    ].join('\n\n'),
    expect: [
      { type: 'ai-register', containsPhrase: 'could not help but notice', shouldFlag: true },
      { type: 'belief-elaboration', containsPhrase: 'thought that the jump coordinates', shouldFlag: true },
      { type: 'crowd-quantification', containsPhrase: 'hundred members of the crew', shouldFlag: true, hard: true },
      { type: 'annotation', containsPhrase: 'way you brace before impact', shouldFlag: true },
      { type: 'nia', containsPhrase: 'Something about the way the AI', shouldFlag: true },
      { type: 'emotion-label', containsPhrase: 'felt fear when the proximity', shouldFlag: true },
      { type: 'ai-register', containsPhrase: 'held its orbit', shouldFlag: false },
      { type: 'over-explanation', containsPhrase: 'confirmed the coordinate lock', shouldFlag: false },
    ],
  },

  // ── historical fiction cross-genre ──
  // "as if to declare" → annotation type (not over-explanation); "quality of silence" matches NIA_QUALITY_RE
  {
    name: 'Cross-genre historical fiction — patterns in period register',
    source: 'Cross-genre: historical — backstory + annotation + NIA in period prose',
    text: [
      'She had apprenticed under the guild master for seven years before the war. She had learned the trade at his feet, back then, when the city still had its old quarter intact. She had mastered every technique the tradition offered. She had earned her mark through patience, not talent.',
      '',
      'He set his quill down without blotting the ink, as if to declare the correspondence closed.',
      'There was a quality of silence in the hall that afternoon that she had not felt before.',
      '',
      'She dipped the quill and continued writing.',
      'The afternoon was quiet.',
    ].join('\n\n'),
    expect: [
      { type: 'acquisition-backstory', containsPhrase: 'back then, when the city', shouldFlag: true },
      { type: 'annotation', containsPhrase: 'as if to declare', shouldFlag: true },
      { type: 'nia', containsPhrase: 'quality of silence', shouldFlag: true },
      { type: 'over-explanation', containsPhrase: 'continued writing', shouldFlag: false },
    ],
  },
];

// ─── Runner ────────────────────────────────────────────────────────────────

type PatternResult = { tp: number; fp: number; fn: number; tn: number };

const patternStats: Record<string, PatternResult> = {
  'over-explanation':      { tp: 0, fp: 0, fn: 0, tn: 0 },
  'ai-register':           { tp: 0, fp: 0, fn: 0, tn: 0 },
  'acquisition-backstory': { tp: 0, fp: 0, fn: 0, tn: 0 },
  'belief-elaboration':    { tp: 0, fp: 0, fn: 0, tn: 0 },
  'crowd-quantification':  { tp: 0, fp: 0, fn: 0, tn: 0 },
  'emotion-label':         { tp: 0, fp: 0, fn: 0, tn: 0 },
  'annotation':            { tp: 0, fp: 0, fn: 0, tn: 0 },
  'nia':                   { tp: 0, fp: 0, fn: 0, tn: 0 },
};

const RECALL_TARGET    = 70;  // TP / (TP + FN) ≥ 70%
const PRECISION_TARGET = 80;  // TP / (TP + FP) ≥ 80%

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  /scan Local Heuristic Accuracy Suite                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  let totalPassed = 0, totalFailed = 0;

  for (const tc of tests) {
    console.log(`── ${tc.name} ──`);
    console.log(`   ${tc.source}`);
    const { passed, failed, total, details } = await runCase(tc);
    totalPassed += passed; totalFailed += failed;

    const pct = total > 0 ? Math.round(passed / total * 100) : 0;
    const mark = failed === 0 ? '✓' : '✗';
    console.log(`  ${mark} ${passed}/${total} (${pct}%)`);
    for (const d of details) {
      if (d.includes('✗')) console.log(d);
    }

    // Accumulate per-pattern stats
    const result = await runLocalReview('test', tc.text);
    for (const exp of tc.expect) {
      const flags = result.flags.filter(f => f.type === exp.type);
      const matched = !!flags.find(f => f.quote?.includes(exp.containsPhrase));
      const stats = patternStats[exp.type];
      if (!stats) continue;
      if (exp.shouldFlag) {
        if (matched) stats.tp++; else stats.fn++;
      } else {
        if (matched) stats.fp++; else stats.tn++;
      }
    }
  }

  // ─── Per-pattern summary ─────────────────────────────────────────────

  console.log('\n' + '═'.repeat(68));
  console.log('PER-PATTERN ACCURACY\n');
  console.log(`${'Pattern'.padEnd(24)} ${'Recall'.padEnd(10)} ${'Precision'.padEnd(11)} ${'TP/FN/FP/TN'}`);
  console.log('─'.repeat(68));

  let allPatternsMeet = true;
  for (const [type, s] of Object.entries(patternStats)) {
    const recall    = s.tp + s.fn > 0 ? Math.round(s.tp / (s.tp + s.fn) * 100) : 100;
    const precision = s.tp + s.fp > 0 ? Math.round(s.tp / (s.tp + s.fp) * 100) : 100;
    const recallOk    = recall    >= RECALL_TARGET;
    const precisionOk = precision >= PRECISION_TARGET;
    const statusR = recallOk    ? '✓' : '✗';
    const statusP = precisionOk ? '✓' : '✗';
    if (!recallOk || !precisionOk) allPatternsMeet = false;
    console.log(
      `  ${type.padEnd(22)} ${statusR}${String(recall).padStart(3)}%      ${statusP}${String(precision).padStart(3)}%        ${s.tp}/${s.fn}/${s.fp}/${s.tn}`
    );
  }

  // ─── Overall summary ────────────────────────────────────────────────────

  const total = totalPassed + totalFailed;
  const overallPct = total > 0 ? Math.round(totalPassed / total * 100) : 0;
  console.log('\n' + '═'.repeat(68));
  console.log(`OVERALL: ${totalPassed}/${total} (${overallPct}%) expectations passed`);
  console.log(`Targets: recall ≥ ${RECALL_TARGET}%, precision ≥ ${PRECISION_TARGET}% per pattern`);
  console.log('═'.repeat(68));
  if (!allPatternsMeet) {
    console.log('\nSome patterns are below target. Review failing cases above.\n');
    process.exit(1);
  } else {
    console.log('\nAll patterns meet accuracy targets.\n');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
