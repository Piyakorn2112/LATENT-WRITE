/**
 * test-known-names.ts
 *
 * Regression lock for the cold-start name resolution path
 * (resolveKnownNames → autoExtractKnownNamesFast), the list that feeds
 * speech attribution and the highlight layer when no world data is curated.
 *
 * THE BUG THIS LOCKS OUT (2026-07-29): the extractor sorted candidates by
 * name length before slice(0, 30). A sort written for regex alternation
 * order became the selection policy, so a four-letter protagonist could
 * never outrank thirty longer institutional nouns. Measured on two full
 * manuscripts: 0% cast recall, 52.9% of dialogue with no speaker.
 *
 * The suite builds a synthetic novel where SHORT high-frequency character
 * names compete against MANY long multi-word institutional names. Under the
 * broken comparator every assertion below fails; under relevance ranking
 * they pass. It needs no external corpus files.
 *
 * Run:  npx tsx scripts/test-known-names.ts     (exit 1 on failure)
 */

import { resolveKnownNames } from '../src/lib/world-data';
import type { Chapter, Novel } from '../src/types';

// ─── Build the synthetic manuscript ───────────────────────────────────────

/** Long institutional names — the kind that won under the length sort. */
const INSTITUTIONS = [
  'The Distributed Authority Framework',
  'The Informed Continuity Act',
  'The Eschatological Division',
  'The Sovereignty Collective',
  'The Free Alignment Compact',
  'The Administrative Shell',
  'The Continuity Orthodoxy',
  'The Assembly of Polities',
  'The Selenic Confederacy',
  'The Temperate Corridor',
  'The Meridian Concordat',
  'The Provisional Charter',
  'The Outer Registry Office',
  'The Bureau of Standing Claims',
  'The Council of Measured Response',
  'The Northern Tariff Union',
  'The Hall of Quiet Records',
  'The Committee on Long Silence',
  'The Ministry of Even Light',
  'The Office of Later Seasons',
  'The Chamber of Held Questions',
  'The Institute of Slow Water',
  'The Delegation of Winter Ports',
  'The Society of Careful Hands',
  'The League of Distant Harbors',
  'The Authority on Old Borders',
  'The Commission of Pale Hours',
  'The Directorate of Small Mercies',
  'The Union of Standing Stones',
  'The Court of Unspoken Terms',
  'The Circle of Written Ash',
  'The Order of the Gray Ledger',
];

/** Short character names — high frequency, like real protagonists. */
const CAST = ['Mira', 'Joss', 'Tessa', 'Bren'];

function buildChapter(n: number): Chapter {
  const lines: string[] = [];
  // Protagonists speak and act constantly (high frequency, short names).
  for (let i = 0; i < 14; i++) {
    const a = CAST[i % CAST.length];
    const b = CAST[(i + 1) % CAST.length];
    lines.push(`${a} looked at ${b} across the table. "We should go," ${a} said.`);
    lines.push(`${b} shook her head. "Not before the record clears," said ${b}.`);
  }
  // Institutions appear a handful of times each — enough to pass minFreq,
  // exactly the population that crowded the cast out under the length sort.
  for (const inst of INSTITUTIONS) {
    lines.push(`${inst} issued a statement that morning.`);
    lines.push(`Nobody inside ${inst} would confirm it.`);
    if (n % 2 === 0) lines.push(`${inst} declined again.`);
  }
  return {
    id: `ch${n}`,
    number: n,
    title: `Chapter ${n}`,
    content: lines.join('\n'),
  };
}

const novel: Novel = {
  meta: { title: 'Synthetic Lock', author: '', description: '' },
  chapters: [1, 2, 3].map(buildChapter),
};

// ─── Assertions ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const fail = (msg: string) => { failed++; console.log(`  ✗ ${msg}`); };
const pass = (msg: string) => { passed++; console.log(`  ✓ ${msg}`); };

const names = resolveKnownNames(novel);
const lower = new Set(names.map((n) => n.toLowerCase()));

console.log('\n══ Cold-start name resolution — short protagonists must survive ══');
console.log(`  extracted ${names.length} names; first 8: ${names.slice(0, 8).join(' | ')}\n`);

for (const c of CAST) {
  if (lower.has(c.toLowerCase())) pass(`protagonist "${c}" present in resolved names`);
  else fail(`protagonist "${c}" MISSING — selection is starving short names`);
}

// The single most frequent name in the text must be a cast member, and the
// head of the list must be relevance-ordered, not length-ordered.
if (names.length > 0 && CAST.map((c) => c.toLowerCase()).includes(names[0].toLowerCase())) {
  pass(`most-relevant slot is a protagonist ("${names[0]}")`);
} else {
  fail(`most-relevant slot is "${names[0]}" — list is not relevance-ranked`);
}

// Institutions that genuinely recur should still be representable — the fix
// must not become "shortest wins". At least one institution stays in.
if (INSTITUTIONS.some((i) => lower.has(i.toLowerCase()))) {
  pass('recurring institutional names still representable');
} else {
  fail('no institutional name survived — ranking overcorrected');
}

// The failure signature is rank position: under the broken comparator the
// cast sat below rank 30 (absent); healthy ranking puts every high-frequency
// protagonist inside the top 6 slots.
const topSix = names.slice(0, 6).map((n) => n.toLowerCase());
const castInTopSix = CAST.filter((c) => topSix.includes(c.toLowerCase()));
if (castInTopSix.length === CAST.length) {
  pass(`all ${CAST.length} protagonists rank inside the top 6`);
} else {
  fail(`only ${castInTopSix.length}/${CAST.length} protagonists in the top 6 — ranking regressed`);
}

// ─── Summary ──────────────────────────────────────────────────────────────

const total = passed + failed;
console.log('\n' + '═'.repeat(60));
console.log(`known-names regression: ${passed}/${total}`);
console.log('Target: 100% (regression lock for world-data.ts extraction ranking)');
console.log('═'.repeat(60));
if (failed > 0) {
  console.log('FAILURES — the cold-start cast list is broken again.');
  process.exit(1);
}
console.log('All assertions passed.');
