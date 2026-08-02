/**
 * probe-chip-quality.cjs — the chip task's FEEDBACK LOOP.
 *
 * Diagnostic, not a gate. `verify-assistant-tasks.cjs` answers "did the
 * contract hold"; this answers "is the chip TRUE of its moment", which is the
 * question that actually broke: a chip read "Marda seals the office" for a
 * sentence about putting the office seal in the FIRE. The contract was
 * satisfied — grounded, short, no pronoun — and the meaning was inverted.
 *
 * So it prints every chip beside the sentence it came from, and auto-flags the
 * two inversion classes that ARE mechanically detectable:
 *   NEG   the source negates ("refused", "did not") and the chip does not.
 *   VERB  the chip's main verb appears in the source only as a NOUN
 *         ("the seal" → "seals"), which is how the observed bug read.
 * Everything else a person judges by reading the two lines together.
 *
 *   ./node_modules/.bin/electron scripts/probe-chip-quality.cjs
 */
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const NODE = '/opt/homebrew/bin/node';
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const FIXTURES = path.join(ROOT, 'scripts', 'fixtures', 'assistant-tasks.json');
const assistant = require(path.join(ROOT, 'electron', 'assistant.cjs'));

const NEGATION = /\b(not|never|no longer|refused?|refuses|declined?|without|failed|nothing|neither|nor|did not|would not)\b/i;

/** Words the chip could have taken from the source as a NOUN and used as a verb. */
function nounAsVerb(label, sentence) {
  const src = ` ${sentence.toLowerCase()} `;
  const hits = [];
  for (const word of label.toLowerCase().match(/\b[a-z]+\b/g) ?? []) {
    if (word.length < 4) continue;
    const singular = word.replace(/s$/, '');
    // In the label the word carries an -s (verb-ish); in the source the same
    // stem is preceded by an article, i.e. it was a noun there.
    if (word === singular) continue;
    if (new RegExp(`\\b(the|a|an|its|his|her|their)\\s+${singular}\\b`).test(src)
        && !new RegExp(`\\b${word}\\b`).test(src)) {
      hits.push(`${singular}→${word}`);
    }
  }
  return hits;
}

async function main() {
  execFileSync(NODE, [TSX, path.join(ROOT, 'scripts', 'emit-assistant-task-fixtures.ts')], {
    cwd: ROOT, stdio: 'pipe',
    env: { ...process.env, ASSISTANT_MODEL_ID: assistant.assistantStatus().model.id },
  });
  const fixtures = JSON.parse(fs.readFileSync(FIXTURES, 'utf8'));
  await assistant.ensureLoaded();

  console.log(`\nchip quality probe — ${fixtures.timelineChips.length} chapters, prompt v${fixtures.chipPromptVersion}\n`);
  const collected = [];
  let flagged = 0;
  let over = 0;
  let total = 0;

  for (const c of fixtures.timelineChips) {
    const res = await assistant.run({
      requestId: `probe-${c.id}`, task: 'timeline-chips',
      systemPrompt: c.systemPrompt, userText: c.userText,
      schema: c.schema, maxTokens: c.maxTokens, timeoutMs: 90_000,
    });
    console.log(`── ${c.id}  (ch.${c.chapterNumber} "${c.chapterTitle}")`);
    if (!res || !res.ok) { console.log(`   NO ANSWER: ${res && res.error}\n`); continue; }
    collected.push({ id: c.id, chapterNumber: c.chapterNumber, chapterTitle: c.chapterTitle, cast: c.cast || [], labelMax: c.labelMax, candidates: c.candidates, raw: res.json });

    for (const pick of res.json.picks) {
      const cand = c.candidates.find((x) => x.rank === pick.rank);
      if (!cand) { console.log(`   [${pick.rank}] ⚠ rank not offered`); continue; }
      total++;
      const label = String(pick.label);
      const flags = [];
      if (NEGATION.test(cand.sentence) && !NEGATION.test(label)) flags.push('NEG');
      const nv = nounAsVerb(label, cand.sentence);
      if (nv.length) flags.push(`VERB(${nv.join(',')})`);
      if (label.length > c.labelMax) { flags.push(`LONG ${label.length}`); over++; }
      if (flags.some((f) => f.startsWith('NEG') || f.startsWith('VERB'))) flagged++;
      console.log(`   [${pick.rank}] "${label}"${flags.length ? `   ⚠ ${flags.join(' · ')}` : ''}`);
      console.log(`        engine: "${cand.label}"`);
      console.log(`        source: ${cand.sentence}`);
    }
    console.log('');
  }

  console.log(`meaning flags: ${flagged}/${total} raw chips · over cap: ${over}/${total}`);

  // Second stage: what the guards actually ship, via the REAL normalizer.
  const rawPath = path.join(require("node:os").tmpdir(), "chip-probe-raw.json");
  fs.writeFileSync(rawPath, JSON.stringify(collected));
  console.log(execFileSync(NODE, [TSX, path.join(ROOT, "scripts", "print-shipped-chips.ts"), rawPath], { cwd: ROOT }).toString());
  await assistant.unload();
  app.exit(0);
}

app.whenReady().then(() => main().catch((e) => { console.error(e); app.exit(1); }));
